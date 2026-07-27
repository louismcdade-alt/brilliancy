/**
 * Capture the app for a design review: hero, a loaded profile, and the board
 * viewer sitting on a real brilliancy. Writes PNGs next to this script.
 *
 * Prereq: the dev server must be running (npm run dev).
 *
 *   node scripts/shots.mjs                       # default account + game
 *   SHOT_USER=hikaru node scripts/shots.mjs
 */
import { chromium } from "playwright";

const USER = process.env.SHOT_USER || "louismcdade";
const GAME = process.env.SHOT_GAME || "https://www.chess.com/game/live/169135347664";
const DARK = process.env.SHOT_DARK === "1";

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
const page = await browser.newPage({
  viewport: { width: 1280, height: 900 },
  deviceScaleFactor: 2,
  colorScheme: DARK ? "dark" : "light",
});
page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));

const suffix = DARK ? "-dark" : "";
await page.goto("http://localhost:5173/", { waitUntil: "networkidle" });
await page.waitForSelector(".board .piece");
await page.screenshot({ path: `scripts/shot-hero${suffix}.png` });
console.log("✓ hero");

await page.fill(".search-input", USER);
await page.click('form.hero-search-row button[type="submit"]');
await page.waitForSelector(".game-row", { timeout: 30000 });
await page.screenshot({ path: `scripts/shot-profile${suffix}.png`, fullPage: false });
console.log("✓ profile");

await page.fill(".single-input", GAME);
await page.click(".single-row button");
await page.waitForSelector(".viewer", { timeout: 120000 });
await page.waitForTimeout(1200); // let the pen finish drawing
await page.screenshot({ path: `scripts/shot-viewer${suffix}.png` });
console.log("✓ viewer");

await page.click(".viewer-close");
await page.waitForSelector(".spec", { timeout: 10000 });
await page.locator(".spec").first().scrollIntoViewIfNeeded();
await page.screenshot({ path: `scripts/shot-sheets${suffix}.png` });
console.log("✓ sheets");

await browser.close();
