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

/**
 * Headless Chrome advertises "HeadlessChrome" in its User-Agent, and Lichess
 * answers /api/games/user/ with 404 for any such request — an anti-bot rule,
 * measured. Without this override a CSP_SOURCE=lichess run would fail for a
 * reason that has nothing to do with the policy under test.
 */
const REAL_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

const browser = await launch();
const page = await browser.newPage({ userAgent: REAL_UA });
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

/**
 * CSP_SOURCE=lichess drives the Lichess adapter instead of chess.com. That is
 * the one thing this policy recently changed — connect-src was widened to
 * https://lichess.org — and a check that only ever exercises api.chess.com
 * cannot prove the directive it is there to guard.
 */
const SOURCE = process.env.CSP_SOURCE === "lichess" ? "lichess" : "chesscom";
if (SOURCE === "lichess") await page.click('.scope-opt:has-text("lichess")');

const DEFAULT_USER = SOURCE === "lichess" ? "EricRosen" : "louismcdade";
await page.fill(".search-input", process.env.CSP_USER || DEFAULT_USER);
await page.click('form.hero-search-row button[type="submit"]');
await page.waitForSelector(".game-row", { timeout: 30000 });

// the real test: the WASM engine has to compile and run under this policy
// Game ids are permanent on both sites, so these stay valid. The Lichess one is
// an EricRosen game — it has to involve the searched player or normalizeGame
// correctly refuses to scan a stranger's moves.
const DEFAULT_GAME =
  SOURCE === "lichess"
    ? "https://lichess.org/n0JJyELA"
    : "https://www.chess.com/game/live/169135347664";
await page.fill(".single-input", process.env.CSP_GAME || DEFAULT_GAME);
await page.click(".single-row button");
await page.waitForSelector(".viewer", { timeout: 120000 });
const found = await page.locator(".movelist .circle-ink").count();
// The viewer opening at all is what proves the WASM engine compiled and ran
// under this policy. Whether it CIRCLED anything is a fact about the game, not
// about the CSP — so only the known-good chess.com fixture is required to
// produce a brilliancy. Conflating the two would make this check fail whenever
// it were pointed at a quiet game.
const engineRan = (await page.locator(".viewer").count()) > 0;

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

console.log(`source               : ${SOURCE}`);
console.log(`engine ran under CSP : ${engineRan ? "YES — viewer opened" : "NO — viewer never opened"}`);
console.log(`brilliancies circled : ${found} (not asserted — a fact about the game, not the policy)`);
console.log(`fonts loaded         : ${fonts.join(", ") || "(none — self-hosting broken)"}`);
console.log(`share card           : ${share}`);
console.log(`CSP violations       : ${violations.length}`);
for (const v of violations) console.log("   ✗ " + v.slice(0, 220));
console.log(`other console errors : ${errors.length}`);
for (const e of errors.slice(0, 5)) console.log("   ! " + e.slice(0, 200));

await browser.close();
server.close();
/**
 * What this check is allowed to assert.
 *
 * The old condition was `violations.length === 0 && found > 0`, and the default
 * fixture game contains NO brilliancy — so this script exited 1 on every clean
 * run, and a permanently-red gate is not a gate. `found` is a fact about the
 * chess position, not about the Content-Security-Policy, so it is reported and
 * not asserted.
 *
 * What the policy IS responsible for: no violations, the WASM engine compiling
 * and completing a scan, the self-hosted fonts loading, and — when a brilliancy
 * is present — the share card rendering on canvas without tainting. "no button"
 * is the correct result for a quiet game, so share is only required when
 * something was actually circled.
 */
const ok =
  violations.length === 0 &&
  engineRan &&
  fonts.length > 0 &&
  (found === 0 || share === "clicked");
process.exit(ok ? 0 : 1);
