import { chromium } from "playwright";

const URL = "http://localhost:5173/";
const USERNAME = process.env.SMOKE_USER || "Hikaru";

async function launch() {
  for (const channel of ["msedge", "chrome"]) {
    try {
      return await chromium.launch({ channel, headless: true });
    } catch {
      /* try next */
    }
  }
  return await chromium.launch({ headless: true }); // bundled, if present
}

const browser = await launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 1600 } });

const errors = [];
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});
page.on("pageerror", (e) => errors.push("PAGEERROR: " + e.message));

console.log("→ goto", URL);
await page.goto(URL, { waitUntil: "networkidle" });
await page.waitForSelector(".board .piece", { timeout: 10000 });
const pieceCount = await page.locator(".board .piece").count();
const sealText = await page.locator(".board-seal").first().textContent().catch(() => null);
console.log(`✓ hero board rendered: ${pieceCount} pieces, seal="${sealText}"`);
await page.screenshot({ path: "scripts/shot-hero.png" });

// --- engine smoke: boot the worker and run one search ---
console.log("→ booting Stockfish worker (first run downloads ~40MB net)…");
const engine = await page.evaluate(async () => {
  return await new Promise((resolve) => {
    const lines = [];
    let done = false;
    const finish = (ok, note) => {
      if (!done) {
        done = true;
        resolve({ ok, note, tail: lines.slice(-8) });
      }
    };
    let w;
    try {
      w = new Worker("/engine/stockfish-nnue-16-single.js");
    } catch (e) {
      finish(false, "ctor: " + e.message);
      return;
    }
    const timer = setTimeout(() => finish(false, "timeout"), 90000);
    w.onerror = (e) => {
      clearTimeout(timer);
      finish(false, "worker error: " + (e.message || "?"));
    };
    w.onmessage = (e) => {
      const line = typeof e.data === "string" ? e.data : (e.data && e.data.data) || "";
      lines.push(line);
      if (line.includes("uciok")) w.postMessage("isready");
      else if (line.includes("readyok")) {
        w.postMessage("position startpos");
        w.postMessage("go depth 12");
      } else if (line.startsWith("bestmove")) {
        clearTimeout(timer);
        finish(true, line.trim());
      }
    };
    w.postMessage("uci");
  });
});
console.log(engine.ok ? `✓ engine search ok: ${engine.note}` : `✗ engine FAILED: ${engine.note}`);
if (!engine.ok) console.log("  tail:", engine.tail);

// --- API + dashboard ---
console.log(`→ loading @${USERNAME}`);
await page.fill(".search-input", USERNAME);
await page.click('button[type="submit"]');
await page.waitForSelector(".profile", { timeout: 20000 });
await page.waitForSelector(".game-row", { timeout: 20000 });
const games = await page.locator(".game-row").count();
const ratingCards = await page.locator(".stat-card").count();
const name = await page.locator(".profile-name").first().textContent();
console.log(`✓ dashboard: name="${name?.trim()}", ${ratingCards} rating cards, ${games} games`);
await page.screenshot({ path: "scripts/shot-dashboard.png", fullPage: true });

console.log(errors.length ? `\n⚠ console errors:\n${errors.join("\n")}` : "\n✓ no console errors");

await browser.close();
