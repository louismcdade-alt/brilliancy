/**
 * Security check: what does a real session actually talk to?
 *
 * Loads the app against the PRODUCTION build, runs a profile load and a single
 * game analysis, and reports every network request grouped by origin, plus any
 * request that carries a body or cookies. The claim on the tin is "nothing
 * leaves the page" — this is the evidence for or against it.
 *
 * Prereq: npm run build && npm run preview  (port 4173)
 *
 *   node scripts/net-audit.mjs
 */
import { chromium } from "playwright";

const BASE = process.env.AUDIT_URL || "http://localhost:4173";
const USER = process.env.AUDIT_USER || "louismcdade";
const GAME = process.env.AUDIT_GAME || "https://www.chess.com/game/live/169135347664";

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

const reqs = [];
page.on("request", (r) => {
  reqs.push({
    url: r.url(),
    method: r.method(),
    origin: new URL(r.url()).origin,
    hasBody: Boolean(r.postData()),
    body: r.postData() ? r.postData().slice(0, 200) : null,
    resource: r.resourceType(),
  });
});
page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
page.on("console", (m) => {
  if (m.type() === "error") console.log("CONSOLE ERROR:", m.text().slice(0, 200));
});

await page.goto(BASE, { waitUntil: "networkidle" });
await page.fill(".search-input", USER);
await page.click('form.hero-search-row button[type="submit"]');
await page.waitForSelector(".game-row", { timeout: 30000 });
await page.fill(".single-input", GAME);
await page.click(".single-row button");
await page.waitForSelector(".viewer", { timeout: 120000 });

const byOrigin = new Map();
for (const r of reqs) {
  if (!byOrigin.has(r.origin)) byOrigin.set(r.origin, []);
  byOrigin.get(r.origin).push(r);
}

console.log(`\nOrigins contacted during a full session (${reqs.length} requests)\n`);
const self = new URL(BASE).origin;
for (const [origin, list] of [...byOrigin].sort((a, b) => b[1].length - a[1].length)) {
  const tag = origin === self ? "SELF " : "THIRD";
  console.log(`  [${tag}] ${origin}  — ${list.length} request(s)`);
  const kinds = [...new Set(list.map((r) => r.resource))].join(", ");
  console.log(`           resource types: ${kinds}`);
  if (origin !== self) {
    for (const r of list.slice(0, 4)) console.log(`           ${r.method} ${r.url.slice(0, 110)}`);
    if (list.length > 4) console.log(`           …and ${list.length - 4} more`);
  }
}

const withBody = reqs.filter((r) => r.hasBody);
console.log(`\nRequests carrying a body (i.e. sending data out): ${withBody.length}`);
for (const r of withBody) console.log(`  ${r.method} ${r.url}\n    ${r.body}`);

await browser.close();
