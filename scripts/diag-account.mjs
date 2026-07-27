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

const out = await page.evaluate(
  async ({ user, limit, depth }) => {
    const api = await import("/src/api/chesscom.ts");
    const bril = await import("/src/engine/brilliancy.ts");

    const games = await api.fetchRecentGames(user, limit);
    const rows = [];
    for (const g of games) {
      let found;
      try {
        found = await bril.scanGame(g, { depth });
      } catch (e) {
        rows.push({ err: String(e), url: g.url });
        continue;
      }
      for (const b of found) {
        rows.push({
          url: g.url,
          color: g.userColor,
          moveNumber: b.moveNumber,
          san: b.san,
          sacPiece: b.sacPiece,
          sacSquare: b.sacSquare,
          movedTo: b.to,
          sacrifice: b.sacrifice,
          evalAfter: b.evalAfter,
          evalLoss: b.evalLoss,
          fenBefore: b.fenBefore,
        });
      }
    }
    return { count: games.length, rows };
  },
  { user: USER, limit: LIMIT, depth: DEPTH },
);

console.log(`${USER}: scanned ${out.count} games at depth ${DEPTH}\n`);
for (const r of out.rows) {
  if (r.err) {
    console.log("ERR", r.url, r.err);
    continue;
  }
  // Worth calling out: the piece offered isn't the piece that moved. Legitimate
  // (a move can leave something else en prise) but it's also the shape that used
  // to produce nonsense, so it stays visible in the output.
  const indirect = r.sacSquare && r.sacSquare !== r.movedTo ? "  [discovered]" : "";
  console.log(
    `${r.moveNumber}${r.color === "w" ? "." : "..."}${r.san}  offers ${r.sacPiece ?? "?"}@${r.sacSquare ?? "?"} (${r.sacrifice})  eval=${r.evalAfter}  loss=${r.evalLoss}${indirect}`,
  );
  console.log(`    ${r.url}`);
  console.log(`    ${r.fenBefore}`);
}
console.log(`\n${out.rows.length} flagged`);

await browser.close();
