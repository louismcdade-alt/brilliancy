/**
 * Backfill the SEARCH-FREE features into an existing harvest cache — no engine.
 *
 * Adding a feature normally means re-scanning, and the last full harvest took
 * about two hours of search. But several features need no search at all — they
 * are counts over positions we can replay from the PGN — so the games are
 * re-fetched from the public archive API, replayed, and the numbers written into
 * the cached candidates in place. Minutes instead of hours.
 *
 * Covers:
 *   regain2/4/6                       material relative to before the move, 2/4/6
 *                                     plies later in the game actually played.
 *   kingRing, kingRingDelta, kingMoves  pressure on the enemy king after it.
 *
 * Anything needing an engine opinion (evals, quiet alternatives, whether the
 * opponent's BEST reply takes the material) cannot come through here and costs a
 * real re-harvest.
 *
 * The computation runs the REAL `materialBalance` from src/engine/see.ts in the
 * browser, not a copy of it in node. Two hand-rolled reimplementations of SEE
 * were deleted from this project for drifting from the module they mirrored; a
 * backfill that disagreed with the engine would poison the dataset in exactly the
 * way that is hardest to notice.
 *
 * Prereq: the dev server must be running (npm run dev).
 *
 *   node scripts/backfill-features.mjs
 */
import { chromium } from "playwright";
import { readFileSync, writeFileSync } from "node:fs";
import { fetchArchive } from "./lib/chesscom.mjs";

const CACHE = "scripts/harvest-multi.json";
const cache = JSON.parse(readFileSync(CACHE, "utf8"));
const games = Object.values(cache.games);
const users = [...new Set(games.map((g) => g.user))];

console.error(`fetching archives for ${users.length} accounts…`);
const pgns = new Map();
for (const u of users) {
  const archive = await fetchArchive(u);
  for (const [id, g] of archive) if (!pgns.has(id)) pgns.set(id, g.pgn);
  console.error(`  ${u}: ${archive.size} games`);
}

async function launch() {
  for (const channel of ["msedge", "chrome"]) {
    try {
      return await chromium.launch({ channel, headless: true });
    } catch {
      /* next */
    }
  }
  return chromium.launch({ headless: true });
}

const browser = await launch();
const page = await browser.newPage();
page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
await page.goto("http://localhost:5173/", { waitUntil: "networkidle" });

let done = 0;
let missing = 0;
let touched = 0;
const BATCH = 40;

for (let i = 0; i < games.length; i += BATCH) {
  const slice = games.slice(i, i + BATCH);
  const input = slice
    .map((g) => ({
      id: g.id,
      pgn: pgns.get(g.id) ?? null,
      userColor: g.userColor,
      moves: g.candidates.map((c) => ({ moveNumber: c.moveNumber, san: c.san })),
    }))
    .filter((x) => x.pgn);
  missing += slice.length - input.length;

  const out = await page.evaluate(async (rows) => {
    const { materialBalance } = await import("/src/engine/see.ts");
    const { kingPressure } = await import("/src/engine/king.ts");
    const { parseGame } = await import("/src/chess/replay.ts");
    return rows.map((r) => {
      let moves;
      try {
        moves = parseGame(r.pgn);
      } catch {
        return { id: r.id, values: null };
      }
      const values = {};
      for (const want of r.moves) {
        // Locate the candidate's ply by (moveNumber, san) on the player's side —
        // the same identity the labels and the harness key on.
        const ply = moves.findIndex(
          (m) => m.moveNumber === want.moveNumber && m.san === want.san && m.color === r.userColor,
        );
        if (ply < 0) continue;
        const base = materialBalance(moves[ply].fenBefore, r.userColor);
        const at = (k) => {
          const m = moves[Math.min(ply + k, moves.length - 1)];
          return Math.round((materialBalance(m.fenAfter, r.userColor) - base) * 10) / 10;
        };
        values[`${want.moveNumber} ${want.san}`] = {
          regain2: at(2), regain4: at(4), regain6: at(6),
          regainPlies: moves.length - 1 - ply,
          ...kingPressure(moves[ply].fenBefore, moves[ply].fenAfter, r.userColor),
        };
      }
      return { id: r.id, values };
    });
  }, input);

  const byId = new Map(out.map((o) => [o.id, o.values]));
  for (const g of slice) {
    const values = byId.get(g.id);
    if (!values) continue;
    for (const c of g.candidates) {
      const v = values[`${c.moveNumber} ${c.san}`];
      if (!v) continue;
      Object.assign(c, v);
      touched++;
    }
  }
  done += slice.length;
  if (done % 200 < BATCH) console.error(`  …${done}/${games.length} games`);
}

await browser.close();
cache.schema = 4;
writeFileSync(CACHE, JSON.stringify(cache, null, 1));

const total = games.reduce((n, g) => n + g.candidates.length, 0);
console.log(`backfilled ${touched}/${total} candidates across ${games.length} games`);
if (missing) console.log(`${missing} games had no PGN in the archive and were skipped`);
