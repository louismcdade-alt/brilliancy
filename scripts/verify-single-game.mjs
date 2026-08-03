/**
 * What "Or analyse one game" does to chess.com when the link doesn't match.
 *
 * The single-game lookup has no get-by-id endpoint to call, so it walks monthly
 * archives. Three things about that walk are worth pinning down, and none of
 * them can be seen from a screenshot:
 *
 *   1. how many requests a link that matches NOTHING costs (it used to cost one
 *      per archive — ~152 on a heavy account, each one a month of full PGNs),
 *   2. what the user is told when chess.com rate-limits us mid-walk (it used to
 *      be "that game isn't among your games", a claim about the player derived
 *      from our own failure), and
 *   3. that bounding the walk did not stop it finding games it used to find.
 *
 * All three are network behaviour, so this drives the real adapter with `fetch`
 * replaced by a scripted chess.com. No dev server, no live API: the point is to
 * count requests and force a 429 on demand, and neither is reproducible against
 * the real thing.
 *
 *   node scripts/verify-single-game.mjs
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import ts from "typescript";

const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, "..", "src", "api", "chesscom.ts");

// The adapter is TypeScript with only `import type` at the top, so stripping the
// types leaves a module with no runtime imports — which is why it can be handed
// straight to a data: URL instead of needing a build step or the dev server.
const js = ts.transpileModule(readFileSync(SRC, "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText;
const api = await import(
  `data:text/javascript;base64,${Buffer.from(js, "utf8").toString("base64")}`
);

const BASE = "https://api.chess.com/pub";
const USER = "hikaru";

/** One archive-shaped game. Only the fields normalizeGame reads matter. */
function game(id, month) {
  return {
    url: `https://www.chess.com/game/live/${id}`,
    pgn: `[Event "Live Chess"]\n[Date "${month}"]\n\n1. e4 e5 1/2-1/2`,
    rules: "chess",
    time_class: "blitz",
    time_control: "180",
    rated: true,
    end_time: 1700000000,
    white: { username: USER, result: "agreed", rating: 3200 },
    black: { username: "magnuscarlsen", result: "agreed", rating: 2850 },
  };
}

/**
 * A scripted chess.com. `months` is how many monthly archives the account has;
 * `at` maps a month index (0 = oldest, matching the API's own ordering) to the
 * game ids in it. `status` lets a month answer 429/500 instead of 200.
 */
function stubFetch({ months, at = {}, status = () => 200 }) {
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    if (String(url).endsWith("/games/archives")) {
      const archives = Array.from(
        { length: months },
        (_, i) => `${BASE}/player/${USER}/games/${2000 + Math.floor(i / 12)}/${String((i % 12) + 1).padStart(2, "0")}`,
      );
      return json(200, { archives });
    }
    const idx = calls.filter((c) => !c.endsWith("/games/archives")).length - 1;
    const monthIndex = monthIndexOf(String(url), months);
    const code = status(monthIndex, idx);
    if (code !== 200) return json(code, {});
    return json(200, { games: (at[monthIndex] ?? []).map((id) => game(id, monthIndex)) });
  };
  return { calls, months: () => calls.filter((c) => !c.endsWith("/games/archives")) };
}

function monthIndexOf(url, months) {
  const m = /\/games\/(\d{4})\/(\d{2})$/.exec(url);
  if (!m) return -1;
  const i = (Number(m[1]) - 2000) * 12 + Number(m[2]) - 1;
  return i < months ? i : -1;
}

function json(status, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  };
}

let failed = 0;
const check = (ok, label, detail = "") => {
  console.log(`${ok ? "  ok  " : " FAIL "} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failed++;
};

/** Run fetchGameByUrl and report outcome + request count without throwing. */
async function lookup(stub, input) {
  try {
    const g = await api.fetchGameByUrl(USER, input);
    return { game: g, error: null, requests: stub.calls.length, monthRequests: stub.months().length };
  } catch (e) {
    return {
      game: null,
      error: e instanceof Error ? e.message : String(e),
      requests: stub.calls.length,
      monthRequests: stub.months().length,
    };
  }
}

console.log("\nA link that can't be a chess.com game id costs no requests");
for (const input of [
  "https://lichess.org/q7ZvsdUF",
  "https://lichess.org/q7ZvsdUFhAsd/black",
  "q7ZvsdUF",
  "https://www.chess.com/games/archive/hikaru",
]) {
  const stub = stubFetch({ months: 152 });
  const r = await lookup(stub, input);
  check(
    r.requests === 0 && !r.game,
    `"${input}"`,
    `${r.requests} request(s), ${r.error ? `error: ${r.error}` : "returned null"}`,
  );
}

console.log("\nA rate-limited walk says so, instead of blaming the player");
{
  const stub = stubFetch({ months: 152, at: { 0: ["4242424242"] }, status: () => 429 });
  const r = await lookup(stub, "https://www.chess.com/game/live/4242424242");
  check(/rate-limit/i.test(r.error ?? ""), "429 surfaces the adapter's message", r.error ?? "no error thrown");
  check(
    r.monthRequests <= 3,
    "and stops rather than 429ing every archive",
    `${r.monthRequests} monthly archive request(s)`,
  );
}

console.log("\nThe walk is bounded, and says what window it covered");
{
  const stub = stubFetch({ months: 152 });
  const r = await lookup(stub, "https://www.chess.com/game/live/4242424242");
  check(r.monthRequests <= 24, "at most 24 monthly archives fetched", `${r.monthRequests}`);
  check(
    /\b24\b/.test(r.error ?? "") || /month/i.test(r.error ?? ""),
    "the miss names the window it searched",
    r.error ?? "returned null (asserts the game isn't theirs)",
  );
}

console.log("\nWhen the whole history WAS searched, the definitive answer stands");
{
  const stub = stubFetch({ months: 6 });
  const r = await lookup(stub, "https://www.chess.com/game/live/4242424242");
  check(!r.game && !r.error, "6-month account, absent id → null", r.error ?? "null");
  check(r.monthRequests === 6, "and every month was actually read", `${r.monthRequests}`);
}

console.log("\nGames that used to be found are still found");
{
  // Newest-first: index 151 is the newest month, so index 141 is the eleventh
  // archive the walk reaches — inside the window, but well outside "last 30".
  const stub = stubFetch({ months: 152, at: { 141: ["9999", "123984651203"] } });
  const r = await lookup(stub, "https://www.chess.com/game/live/123984651203");
  check(r.game?.url === "https://www.chess.com/game/live/123984651203", "found eleven months back", r.error ?? String(r.game?.url));
}
{
  const stub = stubFetch({ months: 20, at: { 3: ["55555555"] } });
  const r = await lookup(stub, "55555555");
  check(r.game?.url?.endsWith("/55555555"), "bare id, oldest month of a short history", r.error ?? String(r.game?.url));
}
{
  const stub = stubFetch({ months: 4, at: { 2: ["17622413"] } });
  const r = await lookup(stub, "https://www.chess.com/game/daily/17622413/");
  check(r.game?.url?.endsWith("/17622413"), "daily link with a trailing slash", r.error ?? String(r.game?.url));
}

console.log("\nOne unreadable month doesn't lose the search");
{
  const stub = stubFetch({
    months: 12,
    at: { 9: ["77777777"] },
    // The newest month 500s; the game is in the one before it.
    status: (monthIndex) => (monthIndex === 11 ? 500 : 200),
  });
  const r = await lookup(stub, "77777777");
  check(r.game?.url?.endsWith("/77777777"), "survives a single 500", r.error ?? String(r.game?.url));
}
{
  const stub = stubFetch({ months: 152, status: (m) => (m > 100 ? 500 : 200) });
  const r = await lookup(stub, "88888888");
  check(
    r.monthRequests <= 4,
    "but a wall of 500s aborts instead of grinding on",
    `${r.monthRequests} monthly archive request(s)`,
  );
}

console.log("\nA short numeric id is not a suffix match for a longer one");
{
  const stub = stubFetch({ months: 4, at: { 3: ["123984651203"] } });
  const r = await lookup(stub, "651203");
  check(!r.game, "651203 does not match /game/live/123984651203", r.game ? `matched ${r.game.url}` : "no match");
}

console.log(
  failed === 0
    ? "\nPASS — the single-game lookup is bounded, honest about failure, and still finds games.\n"
    : `\n${failed} CHECK(S) FAILED\n`,
);
process.exit(failed === 0 ? 0 : 1);
