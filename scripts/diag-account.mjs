/**
 * Run the real detector over a real chess.com account and dump what it flags,
 * including which piece is actually being offered and where. Use it to eyeball
 * precision on live games — the fixtures can only tell you about the positions
 * someone already thought to label.
 *
 * Prereq: the dev server must be running (npm run dev).
 *
 *   node scripts/diag-account.mjs magnuscarlsen 40
 *   DEPTH=18 node scripts/diag-account.mjs hikaru 10
 *
 * For *why* something was rejected rather than what survived, see explain.mjs.
 */
import { chromium } from "playwright";

const USER = process.argv[2] ?? "magnuscarlsen";
const LIMIT = Number(process.argv[3] ?? 10);
const DEPTH = Number(process.env.DEPTH) || 14;

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

// Fetch the game list once, then scan ONE GAME PER page.evaluate call.
//
// The first version of this did all N games inside a single evaluate. That is
// fine for 40 games and fragile for 400: the whole run lives or dies on one
// long-lived call, node buffers stdout until it exits, and when a 400-game sweep
// died silently it left a zero-byte file and nothing to debug. Driving the loop
// from node instead means output streams as it goes, a crash costs one game, and
// progress is visible while it runs.
const games = await page.evaluate(
  async ({ user, limit }) => {
    const api = await import("/src/api/chesscom.ts");
    const list = await api.fetchRecentGames(user, limit);
    return list.map((g) => ({ id: g.id, url: g.url, userColor: g.userColor, pgn: g.pgn }));
  },
  { user: USER, limit: LIMIT },
);

console.log(`${USER}: scanning ${games.length} games at depth ${DEPTH}
`);

let flagged = 0;
let failed = 0;
for (let i = 0; i < games.length; i++) {
  const g = games[i];
  let rows;
  try {
    rows = await page.evaluate(
      async ({ game, depth }) => {
        const bril = await import("/src/engine/brilliancy.ts");
        // rejectShapes:[] on purpose. This script exists to show what is
        // out there before the rules trim it — a diagnostic that only prints what
        // already survives every gate can't tell you what a gate is costing you.
        // The shape is printed instead, so the trimmed ones stay visible.
        const shapes = new Map();
        const found = await bril.scanGame(game, {
          depth,
          rejectShapes: [],
          onCandidate: (c) => shapes.set(`${c.moveNumber} ${c.san}`, c.shape),
        });
        return found.map((b) => ({
          moveNumber: b.moveNumber,
          san: b.san,
          sacPiece: b.sacPiece,
          sacSquare: b.sacSquare,
          sacrifice: b.sacrifice,
          evalAfter: b.evalAfter,
          evalLoss: b.evalLoss,
          fenBefore: b.fenBefore,
          shape: shapes.get(`${b.moveNumber} ${b.san}`) ?? "direct",
        }));
      },
      {
        game: {
          ...g,
          timeClass: "blitz", timeControl: "", rated: true, endTime: 0,
          result: "win", resultReason: "", oppUsername: "opponent",
        },
        depth: DEPTH,
      },
    );
  } catch (e) {
    failed++;
    console.log(`ERR ${g.url} — ${String(e).split(/\r?\n/)[0]}`);
    continue;
  }

  for (const r of rows) {
    flagged++;
    // The shape comes from the detector, not from re-deriving it here. This line
    // used to compute "discovered" itself from sacSquare !== movedTo, which was
    // the same rule spelled a second time — and it had no idea promotions were a
    // category at all.
    const indirect = r.shape === "direct" ? "" : `  [${r.shape}, CUT]`;
    console.log(
      `${r.moveNumber}${g.userColor === "w" ? "." : "..."}${r.san}  offers ${r.sacPiece ?? "?"}@${r.sacSquare ?? "?"} (${r.sacrifice})  eval=${r.evalAfter}  loss=${r.evalLoss}${indirect}`,
    );
    console.log(`    ${g.url}`);
    console.log(`    ${r.fenBefore}`);
  }

  if ((i + 1) % 25 === 0) {
    console.error(`  …${i + 1}/${games.length} scanned, ${flagged} flagged`);
  }
}

console.log(`
${flagged} flagged across ${games.length} games${failed ? ` (${failed} failed)` : ""}`);

await browser.close();
