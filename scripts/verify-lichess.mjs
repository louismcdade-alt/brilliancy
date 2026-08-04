/**
 * Drive the Lichess path through the real app and report what the browser
 * actually got back.
 *
 * This exists because the Lichess adapter was written and typechecked without
 * ever being run against the live API from a page. `/api/games/user/{u}` is the
 * one endpoint the whole feature stands on, and a curl of it proves less than it
 * looks: a bare curl with no User-Agent 404s regardless, and CORS only exists in
 * a browser. So the check has to be a page making the request.
 *
 * Prereq: the dev server must be running (npm run dev).
 *
 *   node scripts/verify-lichess.mjs
 *   LICHESS_USER=DrNykterstein node scripts/verify-lichess.mjs
 */
import { chromium } from "playwright";

const USER = process.env.LICHESS_USER || "EricRosen";
// LICHESS_BASE predates the shared BASE_URL and still wins, so any invocation
// written against it keeps working; BASE_URL is what `npm run verify` sets for
// all three gates at once. Default unchanged.
const BASE = process.env.LICHESS_BASE || process.env.BASE_URL || "http://localhost:5173/";

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
 * Headless Chrome puts "HeadlessChrome" in its User-Agent, and Lichess answers
 * any such request to /api/games/user/ with a 404 — an anti-bot rule, measured:
 * same URL 30s apart, real-Chrome UA 200, HeadlessChrome UA 404, real-Chrome UA
 * 200 again. That single character difference is what made this endpoint look
 * broken for two sessions. Overriding the UA is not cheating the test: a real
 * visitor's browser sends the real string, so this makes the harness measure
 * what the site actually does rather than what a robot is refused.
 */
const REAL_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

const browser = await launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, userAgent: REAL_UA });

const errors = [];
const calls = [];
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
page.on("console", (m) => {
  if (m.type() === "error") errors.push(`console: ${m.text()}`);
});
// The game rows are <button>s, not links — there is no href in the DOM to read.
// So take an id out of the NDJSON the page already fetched: it costs no extra
// request, which matters because this endpoint throttles hard enough that one
// spare call is the difference between a clean run and a 20-minute wait.
let sampleId = null;
page.on("response", async (res) => {
  const url = res.url();
  if (!url.includes("lichess.org")) return;
  calls.push({ url: url.replace("https://lichess.org", ""), status: res.status() });
  if (url.includes("/api/games/user/") && res.status() === 200 && !sampleId) {
    try {
      const first = (await res.text()).split("\n").find((l) => l.trim());
      sampleId = first ? JSON.parse(first).id : null;
    } catch {
      /* leave null; the check below reports it */
    }
  }
});

let failed = 0;
const check = (ok, label, detail = "") => {
  console.log(`${ok ? "  ok  " : " FAIL "} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failed++;
};

await page.goto(BASE, { waitUntil: "networkidle" });

// ---- profile + game list -------------------------------------------------
console.log(`\nLichess adapter, account @${USER}`);
await page.click('.scope-opt:has-text("lichess")');
await page.fill(".search-input", USER);
await page.click('form.hero-search-row button[type="submit"]');

let listed = 0;
try {
  await page.waitForSelector(".game-row", { timeout: 45000 });
  listed = await page.locator(".game-row").count();
} catch {
  /* leave listed at 0 and let the checks below say so */
}

// `.error-box` is the class both the search failure and the games failure use;
// matching on [role=alert] alone would have silently passed, because the scan
// error box was the one of the three that had no role.
const errorBox = await page.locator(".error-box, .single-error").allTextContents();
check(listed > 0, "fetchRecentGames returned games", `${listed} rows`);
check(errorBox.length === 0, "no error banner", errorBox.join(" | ") || "none");

// The rows are the adapter's normalisation, so read one rather than trusting a
// count: a row that renders "undefined" or "NaN" still counts as a row.
if (listed > 0) {
  const row = await page.locator(".game-row").first().innerText();
  const flat = row.replace(/\s+/g, " ").trim();
  console.log(`       first row: ${flat}`);
  check(!/undefined|NaN|Invalid/i.test(flat), "first row has no undefined/NaN");
}

// ---- single game by URL --------------------------------------------------
// Take an id from the list we just loaded, so this can't go stale the way a
// hardcoded game id would.
const href = sampleId ? `https://lichess.org/${sampleId}` : null;
if (href) {
  console.log(`\nSingle game by URL: ${href}`);
  await page.fill(".single-input", href);
  await page.click(".single-row button");
  let viewer = false;
  try {
    await page.waitForSelector(".viewer, .single-note, .error", { timeout: 120000 });
    viewer = (await page.locator(".viewer").count()) > 0;
  } catch {
    /* fall through */
  }
  const note = await page.locator(".single-note").allTextContents();
  // A game with no brilliancy is a legitimate outcome here — what is being
  // tested is that /game/export parsed into a scannable game, not that the
  // detector found something. Either the viewer opened or the app said
  // "nothing found"; only an error or a timeout is a failure.
  check(viewer || note.some((t) => /nothing|no brilliant/i.test(t)),
    "fetchGameByUrl resolved to a scannable game",
    viewer ? "viewer opened" : note.join(" | ") || "no outcome");
} else {
  check(false, "could not read a game href from the list to test fetchGameByUrl");
}

// ---- what the network actually did --------------------------------------
console.log("\nLichess requests made by the page:");
for (const c of calls) console.log(`  ${String(c.status).padEnd(4)} ${c.url}`);
const bad = calls.filter((c) => c.status >= 400);
check(bad.length === 0, "no 4xx/5xx from lichess.org", bad.map((b) => `${b.status} ${b.url}`).join(", ") || "none");
check(errors.length === 0, "no page/console errors", errors.slice(0, 3).join(" | ") || "none");

await browser.close();
console.log(failed === 0 ? "\nPASS — the Lichess path works end to end.\n" : `\n${failed} CHECK(S) FAILED\n`);
process.exit(failed === 0 ? 0 : 1);
