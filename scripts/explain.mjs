/**
 * Explain what the detector thought about every sacrifice candidate in a game —
 * including the ones it rejected, and which gate rejected them. This is the tool
 * for chasing a *false negative*: chess.com gave a move !!, we didn't, and the
 * question is which threshold said no.
 *
 * Prereq: the dev server must be running (npm run dev).
 *
 *   node scripts/explain.mjs --fixture "Levitsky"        # by fixture name substring
 *   node scripts/explain.mjs --user louis --game 3       # nth most recent game
 *   node scripts/explain.mjs --url https://www.chess.com/game/live/123 --user louis
 */
import { chromium } from "playwright";
import { fixtures } from "./fixtures.mjs";

const argv = process.argv.slice(2);
const arg = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const DEPTH = Number(arg("depth") ?? process.env.DEPTH) || 14;

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

const browser = await launch();
const page = await browser.newPage();
page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
await page.goto("http://localhost:5173/", { waitUntil: "networkidle" });

/** Games to explain: either a fixture, or games pulled from a chess.com account. */
let targets = [];
const fixtureName = arg("fixture");
const user = arg("user");

if (fixtureName) {
  const fx = fixtures.filter((f) => f.name.toLowerCase().includes(fixtureName.toLowerCase()));
  if (!fx.length) {
    console.error(`No fixture matching "${fixtureName}".`);
    process.exit(1);
  }
  targets = fx.map((f) => ({ name: f.name, pgn: f.pgn, userColor: f.userColor, url: "" }));
} else if (user && arg("url")) {
  // One specific game. chess.com has no get-game-by-id endpoint, so walk the
  // monthly archives newest-first until it turns up — one cheap request per
  // month, and no engine cost until we've found it. This is the path that
  // matters when someone says "Game Review starred a move in THIS game": the
  // game is usually nowhere near the most recent 30.
  const wanted = arg("url");
  const id = wanted.split("/").pop();
  targets = await page.evaluate(
    async ({ user, id }) => {
      const api = await import("/src/api/chesscom.ts");
      const months = await api.fetchArchiveMonths(user);
      for (let i = months.length - 1; i >= 0; i--) {
        const res = await fetch(months[i], { headers: { Accept: "application/json" } });
        if (!res.ok) continue;
        const { games = [] } = await res.json();
        const hit = games.find((g) => String(g.url ?? "").endsWith(id));
        if (!hit) continue;
        const userColor = (hit.white?.username ?? "").toLowerCase() === user.toLowerCase() ? "w" : "b";
        const opp = userColor === "w" ? hit.black : hit.white;
        return [{
          name: `vs ${opp?.username ?? "?"}  (${months[i].slice(-7)})`,
          pgn: hit.pgn,
          userColor,
          url: hit.url,
        }];
      }
      return [];
    },
    { user, id },
  );
  if (!targets.length) {
    console.error(`Game ${id} not found in @${user}'s archives.`);
    process.exit(1);
  }
} else if (user) {
  const limit = Number(arg("games") ?? 10);
  targets = await page.evaluate(
    async ({ user, limit }) => {
      const api = await import("/src/api/chesscom.ts");
      const games = await api.fetchRecentGames(user, limit);
      return games.map((g) => ({ name: `vs ${g.oppUsername}`, pgn: g.pgn, userColor: g.userColor, url: g.url }));
    },
    { user, limit },
  );
  if (!targets.length) {
    console.error("No games matched.");
    process.exit(1);
  }
} else {
  console.error("Pass --fixture <name>, or --user <name> [--games N | --url <game url>].");
  process.exit(1);
}

console.log(`Explaining ${targets.length} game(s) at depth ${DEPTH}\n`);

for (const t of targets) {
  const rows = await page.evaluate(
    async ({ pgn, userColor, depth }) => {
      const mod = await import("/src/engine/brilliancy.ts");
      const game = {
        id: "x", url: "", pgn, timeClass: "blitz", timeControl: "300", rated: true,
        endTime: 0, userColor, result: "win", resultReason: "", oppUsername: "opponent",
      };
      const seen = [];
      await mod.scanGame(game, { depth, onCandidate: (c) => seen.push(c) });
      return seen;
    },
    { pgn: t.pgn, userColor: t.userColor, depth: DEPTH },
  );

  console.log(`── ${t.name}${t.url ? `  ${t.url}` : ""}`);
  if (!rows.length) {
    console.log("    (no move even reached the engine — nothing cleared the sacrifice filter)\n");
    continue;
  }
  for (const c of rows) {
    const verdict = c.rejectedBy ? `REJECTED by ${c.rejectedBy}` : "BRILLIANT";
    const alt = c.quietAlt === null || !isFinite(c.quietAlt) ? "none" : `${c.quietAlt}cp`;
    console.log(
      `    ${String(c.moveNumber).padStart(3)}.${c.san.padEnd(8)} ${verdict.padEnd(22)}` +
        ` sac ${String(c.sacrifice).padEnd(4)}on ${String(c.sacSquare ?? "?").padEnd(3)}` +
        ` eval ${String(c.playedEval).padStart(6)}cp  loss ${String(c.evalLoss).padStart(5)}cp  best quiet alt ${alt}`,
    );
  }
  console.log("");
}

await browser.close();
