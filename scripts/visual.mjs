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

const USER = process.env.SMOKE_USER || "DanielNaroditsky";
const browser = await launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 1700 } });
page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));

await page.goto("http://localhost:5173/", { waitUntil: "networkidle" });
await page.waitForSelector(".board .piece");
await page.screenshot({ path: "scripts/shot-hero.png" });
console.log("✓ hero shot");

await page.fill(".search-input", USER);
await page.click('button[type="submit"]');
await page.waitForSelector(".game-row", { timeout: 25000 });
console.log(`✓ loaded @${USER}`);

// open the game viewer
await page.locator(".game-row").first().click();
await page.waitForSelector(".viewer .board .piece", { timeout: 10000 });
await page.screenshot({ path: "scripts/shot-viewer.png" });
console.log("✓ viewer shot");
await page.keyboard.press("Escape");

// run a real scan and capture whatever brilliancies appear
console.log("→ scanning for brilliancies (best effort, up to 160s)…");
await page.click('button:has-text("Find brilliancies")');
try {
  await page.waitForSelector(".spec", { timeout: 160000 });
  const n = await page.locator(".spec").count();
  console.log(`✓ ${n} specimen card(s) rendered`);
} catch {
  console.log("… no specimens within the time cap (scan may still be running)");
}
await page.locator(".section", { hasText: "Brilliancies" }).first().scrollIntoViewIfNeeded();
await page.screenshot({ path: "scripts/shot-brilliancies.png", fullPage: true });

await browser.close();
