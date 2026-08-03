/**
 * Serve the production build with the real security headers applied, then drive a
 * full session through it. A Content-Security-Policy that blocks your own engine
 * is worse than no CSP at all, so this proves the policy and the app agree before
 * either reaches a host.
 *
 * Prereq: npm run build
 *
 *   node scripts/csp-check.mjs
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { chromium } from "playwright";

const DIST = new URL("../dist/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const PORT = 4399;

// Kept byte-identical to public/_headers and vercel.json on purpose — if they
// drift, this test stops testing what actually ships.
const CSP =
  "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; " +
  "style-src 'self' 'unsafe-inline'; font-src 'self'; " +
  "img-src 'self' data: https://images.chesscomfiles.com; " +
  "connect-src 'self' https://api.chess.com https://lichess.org; form-action 'none'; " +
  "frame-ancestors 'none'; base-uri 'self'; object-src 'none'";

const TYPES = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".wasm": "application/wasm", ".woff2": "font/woff2", ".svg": "image/svg+xml",
  ".nnue": "application/octet-stream", ".png": "image/png", ".json": "application/json",
};

const server = createServer(async (req, res) => {
  const url = (req.url || "/").split("?")[0];
  const rel = normalize(url === "/" ? "index.html" : url.replace(/^\/+/, ""));
  try {
    const buf = await readFile(join(DIST, rel));
    res.setHeader("Content-Type", TYPES[extname(rel)] || "application/octet-stream");
    res.setHeader("Content-Security-Policy", CSP);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.end(buf);
  } catch {
    res.statusCode = 404;
    res.end("not found");
  }
});
await new Promise((r) => server.listen(PORT, r));
console.log(`serving dist/ with production CSP on http://localhost:${PORT}\n`);

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
const violations = [];
const errors = [];
page.on("console", (m) => {
  const t = m.text();
  if (/Content Security Policy|Refused to/i.test(t)) violations.push(t);
  else if (m.type() === "error") errors.push(t);
});
page.on("pageerror", (e) => errors.push(String(e.message)));

await page.goto(`http://localhost:${PORT}/`, { waitUntil: "networkidle" });
await page.waitForSelector(".board .piece");

await page.fill(".search-input", process.env.CSP_USER || "louismcdade");
await page.click('form.hero-search-row button[type="submit"]');
await page.waitForSelector(".game-row", { timeout: 30000 });

// the real test: the WASM engine has to compile and run under this policy
await page.fill(".single-input", process.env.CSP_GAME || "https://www.chess.com/game/live/169135347664");
await page.click(".single-row button");
await page.waitForSelector(".viewer", { timeout: 120000 });
const found = await page.locator(".movelist .circle-ink").count();

// and the share card has to render on canvas without tainting
const share = await page.evaluate(async () => {
  try {
    const btn = [...document.querySelectorAll("button")].find((b) => /share image/i.test(b.textContent));
    if (!btn) return "no button";
    btn.click();
    await new Promise((r) => setTimeout(r, 4000));
    return "clicked";
  } catch (e) {
    return "threw: " + e.message;
  }
});

const fonts = await page.evaluate(() =>
  [...new Set([...document.fonts].filter((f) => f.status === "loaded").map((f) => f.family))],
);

console.log(`engine ran under CSP : ${found > 0 ? "YES — move circled" : "NO — nothing found"}`);
console.log(`fonts loaded         : ${fonts.join(", ") || "(none — self-hosting broken)"}`);
console.log(`share card           : ${share}`);
console.log(`CSP violations       : ${violations.length}`);
for (const v of violations) console.log("   ✗ " + v.slice(0, 220));
console.log(`other console errors : ${errors.length}`);
for (const e of errors.slice(0, 5)) console.log("   ! " + e.slice(0, 200));

await browser.close();
server.close();
process.exit(violations.length === 0 && found > 0 ? 0 : 1);
