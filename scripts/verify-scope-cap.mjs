/**
 * Does "Everything" admit where it stopped?
 *
 * The scope note under the segmented control is the only place the app says the
 * window it just loaded is not the player's whole history. It was wired to a
 * single hardcoded number (`games.length >= 1000`), which is a chess.com fact:
 * the Lichess adapter caps its export at 500, so on Lichess the clause could
 * never fire and "Everything" quietly meant "the last 500", with the note
 * cheerfully reading "Brilliancies are rare — a single month often has none."
 *
 * Both APIs are MOCKED here, on purpose. The thing under test is what the page
 * says about a cap, and that needs an account whose history is known exactly —
 * five thousand games, or exactly five hundred. Live accounts cannot give that,
 * and Lichess's export throttle makes a five-case run against the real API a
 * twenty-minute coin flip. The mocks answer the same URLs the adapters build,
 * honour `max`, and go through the same normalizeGame.
 *
 * The two boundary cases (exactly at the cap, nothing beyond it) are the ones
 * that matter most: a length comparison cannot tell "we truncated you" from
 * "that is all you have", and telling a 500-game account it was capped is the
 * same kind of small lie in the other direction.
 *
 * Prereq: the dev server must be running (npm run dev).
 *
 *   node scripts/verify-scope-cap.mjs
 */
import { chromium } from "playwright";

// Override to aim at a second dev server while 5173 is taken by a hand-driven
// one — vite picks 5174 for the second `npm run dev`. Default unchanged.
const BASE = process.env.BASE_URL || "http://localhost:5173/";

async function launch() {
  for (const channel of ["msedge", "chrome"]) {
    try {
      return await chromium.launch({ channel, headless: true });
    } catch {
      /* next */
    }
  }
  return await chromium.launch({ headless: true });
}

// Same reason as verify-lichess.mjs: "HeadlessChrome" in the UA is enough for
// some hosts to behave differently. Nothing here reaches the network, but the
// app should be exercised as a real browser sees it.
const REAL_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

const PGN = '[Event "Mock"]\n[Result "1-0"]\n\n1. e4 e5 2. Nf3 Nc6 3. Bb5 1-0';
const NOW = Math.floor(Date.now() / 1000);

/** One Lichess export line, newest first as the real endpoint returns them. */
function lichessGame(user, i) {
  return JSON.stringify({
    id: `g${String(i).padStart(7, "0")}`,
    rated: true,
    variant: "standard",
    speed: "blitz",
    createdAt: (NOW - i * 600) * 1000,
    lastMoveAt: (NOW - i * 600) * 1000,
    status: "resign",
    clock: { initial: 300, increment: 0 },
    players: {
      white: { user: { name: user, id: user.toLowerCase() }, rating: 2000 },
      black: { user: { name: "MockOpponent", id: "mockopponent" }, rating: 1990 },
    },
    winner: "white",
    pgn: PGN,
  });
}

function chesscomGame(user, i) {
  return {
    url: `https://www.chess.com/game/live/${1000000 + i}`,
    uuid: `uuid-${i}`,
    pgn: PGN,
    time_control: "300",
    time_class: "blitz",
    rules: "chess",
    rated: true,
    end_time: NOW - i * 600,
    white: { username: user, rating: 2000, result: "win" },
    black: { username: "MockOpponent", rating: 1990, result: "resigned" },
  };
}

/**
 * Serve both APIs from a per-case game count.
 *
 * chess.com is spread over months of 250 so the archive walk does real work —
 * the adapter stops mid-list when it has enough, and "did it stop because it ran
 * out of history or because it hit the limit" is exactly the distinction under
 * test.
 */
const MONTH_SIZE = 250;

async function installMocks(page, { lichessTotal, chesscomTotal, user }) {
  await page.route("https://lichess.org/api/user/*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        id: user.toLowerCase(),
        username: user,
        url: `https://lichess.org/@/${user}`,
        createdAt: (NOW - 86400 * 900) * 1000,
        seenAt: (NOW - 3600) * 1000,
        perfs: { blitz: { games: lichessTotal, rating: 2000 } },
      }),
    }),
  );

  await page.route("https://lichess.org/api/games/user/*", (route) => {
    const max = Number(new URL(route.request().url()).searchParams.get("max")) || 40;
    const n = Math.min(max, lichessTotal);
    const lines = [];
    for (let i = 0; i < n; i++) lines.push(lichessGame(user, i));
    route.fulfill({
      status: 200,
      contentType: "application/x-ndjson",
      body: lines.join("\n") + (lines.length ? "\n" : ""),
    });
  });

  // Registered FIRST because Playwright gives priority to the route registered
  // LAST, and this is the loosest pattern of the three chess.com ones.
  await page.route("https://api.chess.com/pub/player/*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        username: user,
        player_id: 1,
        url: `https://www.chess.com/member/${user}`,
        joined: NOW - 86400 * 900,
        last_online: NOW - 3600,
      }),
    }),
  );

  await page.route("https://api.chess.com/pub/player/*/stats", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        chess_blitz: { last: { rating: 2000 }, record: { win: 10, loss: 5, draw: 1 } },
      }),
    }),
  );

  const months = Math.ceil(chesscomTotal / MONTH_SIZE);
  await page.route("https://api.chess.com/pub/player/*/games/archives", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      // Oldest first, which is the order chess.com returns and the order the
      // adapter walks backwards through.
      body: JSON.stringify({
        archives: Array.from(
          { length: months },
          (_, m) => `https://api.chess.com/pub/player/${user.toLowerCase()}/games/2020/${String(m + 1).padStart(2, "0")}`,
        ),
      }),
    }),
  );

  await page.route("https://api.chess.com/pub/player/*/games/*/*", (route) => {
    const m = Number(route.request().url().split("/").pop()) - 1;
    // Month 0 is the oldest, so its games are the furthest back in time.
    const start = chesscomTotal - (m + 1) * MONTH_SIZE;
    const count = Math.min(MONTH_SIZE, chesscomTotal - m * MONTH_SIZE);
    const games = [];
    for (let i = 0; i < count; i++) games.push(chesscomGame(user, Math.max(0, start) + i));
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ games }),
    });
  });
}

let failed = 0;
const check = (ok, label, detail = "") => {
  console.log(`${ok ? "  ok  " : " FAIL "} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failed++;
};

const browser = await launch();

/** Load a player, pick "Everything", and return the scope note it settles on. */
async function noteAtEverything({ site, lichessTotal, chesscomTotal }) {
  const user = "MockPlayer";
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, userAgent: REAL_UA });
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
  await installMocks(page, { lichessTotal, chesscomTotal, user });
  await page.goto(BASE, { waitUntil: "domcontentloaded" });

  await page.click(`.scope-seg-sm .scope-opt:has-text("${site === "lichess" ? "Lichess" : "Chess.com"}")`);
  await page.fill(".search-input", user);
  await page.click('form.hero-search-row button[type="submit"]');
  await page.waitForSelector(".game-row", { timeout: 60000 });
  // The opening view loads GAMES_TO_LOAD; every case here widens to something
  // different, so a changed row count is a reliable "the refetch landed".
  // Waiting only on the note losing the word "loading" would race the very first
  // React commit, where it has not gained it yet.
  const opening = await page.locator(".game-row").count();

  const scopeSeg = page.locator('[aria-label="How far back to scan"]');
  await scopeSeg.locator('.scope-opt:has-text("Everything")').click();
  await page.waitForFunction(
    (n) => document.querySelectorAll(".game-row").length !== n,
    opening,
    { timeout: 180000 },
  );
  // The note reads "loading games…" while the widened fetch is in flight; the
  // sentence under test only exists after it lands.
  await page.waitForFunction(
    () => {
      const t = document.querySelector(".scope-note")?.textContent ?? "";
      return t.length > 0 && !t.includes("loading");
    },
    null,
    { timeout: 180000 },
  );
  const note = (await page.locator(".scope-note").first().innerText()).replace(/\s+/g, " ").trim();
  const rows = await page.locator(".game-row").count();
  await page.close();
  return { note, rows, pageErrors };
}

console.log("\nScope cap notice — what 'Everything' admits\n");

// ---- Lichess, far more history than the adapter will fetch ----------------
{
  const { note, rows, pageErrors } = await noteAtEverything({
    site: "lichess",
    lichessTotal: 5000,
    chesscomTotal: 0,
  });
  console.log(`  lichess / 5000 available → ${rows} rows`);
  console.log(`    note: ${note}`);
  check(rows === 500, "Lichess 'Everything' loads the adapter's 500", `${rows} rows`);
  check(/capped at the most recent 500 games/i.test(note),
    "note names the 500-game cap", note);
  check(!/brilliancies are rare/i.test(note),
    "note does NOT fall through to the 'rare' sentence");
  check(pageErrors.length === 0, "no page errors", pageErrors.join(" | ") || "none");
}

// ---- Lichess, exactly at the cap: not truncated, must not claim it --------
{
  const { note, rows } = await noteAtEverything({
    site: "lichess",
    lichessTotal: 500,
    chesscomTotal: 0,
  });
  console.log(`\n  lichess / exactly 500 available → ${rows} rows`);
  console.log(`    note: ${note}`);
  check(rows === 500, "all 500 loaded", `${rows} rows`);
  check(!/capped/i.test(note),
    "a player with exactly 500 games is NOT told they were capped", note);
}

// ---- Lichess, well under the cap -----------------------------------------
{
  const { note, rows } = await noteAtEverything({
    site: "lichess",
    lichessTotal: 120,
    chesscomTotal: 0,
  });
  console.log(`\n  lichess / 120 available → ${rows} rows`);
  console.log(`    note: ${note}`);
  check(rows === 120, "all 120 loaded", `${rows} rows`);
  check(!/capped/i.test(note), "no cap claimed on a short history", note);
}

// ---- chess.com, more history than MAX_SCAN_GAMES --------------------------
{
  const { note, rows } = await noteAtEverything({
    site: "chesscom",
    lichessTotal: 0,
    chesscomTotal: 1500,
  });
  console.log(`\n  chess.com / 1500 available → ${rows} rows`);
  console.log(`    note: ${note}`);
  check(rows === 1000, "chess.com 'Everything' stops at MAX_SCAN_GAMES", `${rows} rows`);
  check(/capped at the most recent 1000 games/i.test(note),
    "note names the 1000-game cap", note);
}

// ---- chess.com, exactly MAX_SCAN_GAMES of history -------------------------
{
  const { note, rows } = await noteAtEverything({
    site: "chesscom",
    lichessTotal: 0,
    chesscomTotal: 1000,
  });
  console.log(`\n  chess.com / exactly 1000 available → ${rows} rows`);
  console.log(`    note: ${note}`);
  check(rows === 1000, "all 1000 loaded", `${rows} rows`);
  check(!/capped/i.test(note),
    "a player with exactly 1000 games is NOT told they were capped", note);
}

await browser.close();
console.log(failed === 0 ? "\nPASS — the cap notice tells the truth on both sources.\n" : `\n${failed} CHECK(S) FAILED\n`);
process.exit(failed === 0 ? 0 : 1);
