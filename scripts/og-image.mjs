/**
 * Render the social card, public/og.png, at the 1200x630 every unfurler expects.
 *
 * This is the hero shot the app already produces, taken at the card's aspect
 * ratio instead of a browser's — cropping shots.mjs output to 1.91:1 loses
 * either the headline or the board, and both are the point.
 *
 * Prereq: the dev server must be running (npm run dev).
 *
 *   node scripts/og-image.mjs
 */
import { chromium } from "playwright";

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
// 1200x630 at DPR 1, so the PNG is exactly the size og:image:width/height
// declare. A 600px-wide viewport at 2x would come out the same dimensions but
// would trip the mobile breakpoint and card the phone layout instead.
const page = await browser.newPage({
  viewport: { width: 1200, height: 630 },
  deviceScaleFactor: 1,
  colorScheme: "light",
});
page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));

await page.goto("http://localhost:5173/", { waitUntil: "networkidle" });
await page.waitForSelector(".board .piece");
await page.waitForTimeout(600); // let the pen circle finish drawing

await page.screenshot({ path: "public/og.png" });
console.log("✓ public/og.png (1200x630)");

await browser.close();
