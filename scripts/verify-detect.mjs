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

const browser = await launch();
const page = await browser.newPage();
page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));

await page.goto(BASE, { waitUntil: "networkidle" });

// Légal's Mate: 5.Nxe5!! offers the queen (5...Bxd1 6.Bxf7+ Ke7 7.Nd5#).
const pgn =
  "1. e4 e5 2. Bc4 d6 3. Nf3 Bg4 4. Nc3 g6 5. Nxe5 Bxd1 6. Bxf7+ Ke7 7. Nd5#";

console.log("→ running real scanGame() against Légal's Mate…");
const result = await page.evaluate(async (pgn) => {
  const mod = await import("/src/engine/brilliancy.ts");
  const game = {
    id: "test",
    url: "",
    pgn,
    timeClass: "blitz",
    timeControl: "300",
    rated: true,
    endTime: 0,
    userColor: "w",
    result: "win",
    resultReason: "checkmated",
    oppUsername: "opponent",
  };
  const found = await mod.scanGame(game, { depth: 14 });
  return found.map((b) => ({
    san: b.san,
    moveNumber: b.moveNumber,
    sacrifice: b.sacrifice,
    evalAfter: b.evalAfter,
    evalLoss: b.evalLoss,
  }));
}, pgn);

console.log("Detected brilliancies:", JSON.stringify(result, null, 2));
const hit = result.find((b) => b.san === "Nxe5");
console.log(
  hit
    ? `✓ PASS — flagged 5.Nxe5!! (sacrifice ${hit.sacrifice}, eval ${hit.evalAfter}cp, loss ${hit.evalLoss}cp)`
    : "✗ FAIL — did not flag Nxe5",
);

await browser.close();
