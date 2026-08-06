/**
 * Pressing Stop must KEEP what the scan already found.
 *
 * "I saw one, let me stop and look at it" is the whole reason that button gets
 * pressed — the gallery renders mid-scan (App.tsx) precisely so a card appears
 * while it is still running. Stopping used to drop scanState back to "idle",
 * which unrendered the gallery, the near-miss tier and the "Circled" count while
 * leaving `brilliancies` in state — so the game rows below went on showing
 * "!! 1" against a game whose brilliancy nothing on the page would display, and
 * the only way back to it was rescanning the whole window.
 *
 * The check that matters is the CONTRADICTION: whatever the page decides to show
 * after a stop, the row badges, the Circled cell and the gallery have to agree
 * with each other. This drives the real App with the chess.com API mocked and
 * the REAL engine, so it fails on the wiring rather than on a string.
 *
 * Prereq: the dev server must be running (npm run dev).
 *
 *   node scripts/verify-stop-scan.mjs
 */
import { chromium } from "playwright";

const BASE = process.env.BASE_URL || "http://localhost:5173/";
const USER = "testplayer";

// Légal's Mate: one brilliancy (5.Nxe5!!), and verify-detect.mjs is what keeps
// that true. Six copies under different ids, so the first card lands in the
// gallery while five games of engine work are still queued behind it — that is
// the window this test needs to press Stop in.
const PGN = "1. e4 e5 2. Bc4 d6 3. Nf3 Bg4 4. Nc3 g6 5. Nxe5 Bxd1 6. Bxf7+ Ke7 7. Nd5#";
const IDS = ["101", "202", "303", "404", "505", "606"];

const rawGame = (id) => ({
  url: `https://www.chess.com/game/live/${id}`,
  uuid: `uuid-${id}`,
  pgn: PGN,
  rules: "chess",
  time_class: "blitz",
  time_control: "300",
  rated: true,
  end_time: 1700000000 + Number(id),
  white: { username: USER, rating: 1500, result: "win" },
  black: { username: "opponent", rating: 1500, result: "checkmated" },
});

const GAMES = IDS.map(rawGame);
const ARCHIVE = `https://api.chess.com/pub/player/${USER}/games/2023/11`;

const json = (route, body) =>
  route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

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

let failed = 0;
const check = (ok, label, detail) => {
  console.log(`${ok ? "  ✓" : "  ✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failed++;
};

const browser = await launch();
const page = await browser.newPage();
page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));

await page.route("**/api.chess.com/pub/**", (route) => {
  const url = route.request().url();
  if (url.endsWith(`/player/${USER}`)) return json(route, { username: USER, joined: 1600000000 });
  if (url.endsWith("/stats")) return json(route, {});
  if (url.endsWith("/games/archives")) return json(route, { archives: [ARCHIVE] });
  if (url === ARCHIVE) return json(route, { games: GAMES });
  return route.fulfill({ status: 404, body: "{}" });
});

await page.goto(BASE, { waitUntil: "networkidle" });

// ── 1. load the mocked profile ───────────────────────────────────────────────
await page.fill(".search-input", USER);
await page.click('form.hero-search-row button[type="submit"]');
await page.waitForSelector(".analyze-panel", { timeout: 20_000 });

// ── 2. scan, and stop as soon as the gallery has something in it ─────────────
console.log("→ scanning six games (real engine), stopping at the first card…");
await page.click("button.btn-bril");
await page.waitForSelector(".spec-grid .spec", { timeout: 180_000 });
const midScan = await page.locator(".spec-grid .spec").count();
console.log(`   ${midScan} card(s) on screen mid-scan`);
await page.click(".analyze-panel button:has-text('Stop')");

// Back out of "running": the progress panel is replaced by the controls panel.
await page.waitForSelector(".analyze-panel .scope-row", { timeout: 60_000 });
// One frame for the post-loop state writes to land.
await page.waitForTimeout(500);

// ── 3. nothing on the page may contradict anything else on it ────────────────
const cards = await page.locator(".spec-grid .spec").count();
const circled = (
  await page
    .locator(".summary-cell", { hasText: "Circled" })
    .locator(".summary-num")
    .textContent()
).trim();
// Each row prints "!!N"; sum them, since the scan may have reached two games.
const badges = await page.locator(".game-bril-count").allTextContents();
const badgeTotal = badges.reduce((s, t) => s + Number(t.replace(/[^\d]/g, "") || 0), 0);
const rowLabels = (await page.locator(".game-row").evaluateAll((els) =>
  els.map((e) => e.getAttribute("aria-label") ?? ""),
)).filter((l) => /brilliant/.test(l));

console.log(`   gallery ${cards} · Circled ${JSON.stringify(circled)} · row badges ${badgeTotal}`);

check(cards >= 1, "the gallery still shows what the scan found", `${cards} cards`);
check(
  badgeTotal === cards,
  "the game rows and the gallery agree on the count",
  `${badgeTotal} in badges, ${cards} in the gallery`,
);
check(
  rowLabels.length > 0 === cards > 0,
  "no row announces a brilliant move the page will not render",
  `${rowLabels.length} labelled rows, ${cards} cards`,
);
check(
  circled === String(cards),
  'the "Circled" cell shows the count rather than reverting to a dash',
  `shows ${JSON.stringify(circled)}`,
);

// ── 4. ...and it must not claim to have finished ─────────────────────────────
const button = (await page.locator("button.btn-bril").textContent()).trim();
check(
  button !== "Scan again",
  'the button does not read "Scan again" after a stop (the window was not covered)',
  `reads ${JSON.stringify(button)}`,
);
const notes = (await page.locator(".empty-note").allTextContents()).join(" ");
check(
  !/nothing even reached the engine/.test(notes),
  "no note claims the engine saw nothing",
  notes.slice(0, 80),
);
check(
  /stopped/i.test(await page.locator("section[aria-labelledby='h-brilliancies']").innerText()),
  "the section says the scan was stopped, not that it finished",
);

// The assertive region is the only place a screen-reader user is told anything
// about a scan's outcome; a stop is an outcome.
const region = (await page.locator('.sr-only[aria-live="assertive"]').textContent()).trim();
check(/stopped/i.test(region), "the assertive region announces the stop", JSON.stringify(region));
check(
  !/scan complete/i.test(region),
  "...and does not tell a screen reader the scan completed",
  JSON.stringify(region),
);

await browser.close();
console.log(failed ? `\n✗ FAIL — ${failed} check(s)` : "\n✓ PASS — a stopped scan keeps what it found");
process.exit(failed ? 1 : 0);
