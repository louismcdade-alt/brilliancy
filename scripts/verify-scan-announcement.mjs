/**
 * The assertive live region has to describe the scan that just finished.
 *
 * It is the only place a screen-reader user is handed the result as a sentence:
 * everything else (the gallery, the "Circled" cell) is on screen to be read at
 * leisure, and this one interrupts to say what happened. So the numbers in it
 * have to be about the run that just happened, not about whatever happens to be
 * accumulated in state — analysing a single pasted game after a sweep left the
 * region announcing the sweep's total "found in 1 game", which is a false
 * sentence spoken as the answer.
 *
 * Drives the real App with the chess.com API mocked and the REAL engine, so it
 * fails on the wiring (which state the region reads) rather than on a string.
 *
 * Prereq: the dev server must be running (npm run dev).
 *
 *   node scripts/verify-scan-announcement.mjs
 */
import { chromium } from "playwright";

const BASE = "http://localhost:5173/";
const USER = "testplayer";

// Légal's Mate, twice under different ids. One brilliancy each (5.Nxe5!!), and
// scripts/verify-detect.mjs is the check that keeps that true — if the detector
// ever stops flagging it, that test goes red first and explains why.
const PGN = "1. e4 e5 2. Bc4 d6 3. Nf3 Bg4 4. Nc3 g6 5. Nxe5 Bxd1 6. Bxf7+ Ke7 7. Nd5#";
const MOVES_PER_GAME = 1;

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

const GAMES = [rawGame("101"), rawGame("202")];
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

const region = page.locator('.sr-only[aria-live="assertive"]');

/** Wait for the assertive region to say something other than what it said last. */
async function nextAnnouncement(previous) {
  await page
    .waitForFunction(
      ([prev]) => {
        const el = document.querySelector('.sr-only[aria-live="assertive"]');
        const now = (el?.textContent ?? "").trim();
        return now.length > 0 && now !== prev ? now : false;
      },
      [previous],
      { timeout: 180_000 },
    )
    .catch(() => {
      throw new Error(`the assertive region never changed from ${JSON.stringify(previous)}`);
    });
  return (await region.textContent()).trim();
}

let failed = 0;
const check = (ok, label, detail) => {
  console.log(`${ok ? "  ✓" : "  ✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failed++;
};

await page.goto(BASE, { waitUntil: "networkidle" });

// ── 1. load the mocked profile ───────────────────────────────────────────────
await page.fill(".search-input", USER);
await page.click('form.hero-search-row button[type="submit"]');
await page.waitForSelector(".analyze-panel", { timeout: 20_000 });

// ── 2. scan both games ───────────────────────────────────────────────────────
console.log("→ scanning both games (real engine, ~20s)…");
await page.click("button.btn-bril:has-text('Find brilliancies')");
const afterSweep = await nextAnnouncement("");
console.log(`   region: ${JSON.stringify(afterSweep)}`);

check(
  /\b2 brilliant moves\b/.test(afterSweep),
  "sweep announces the 2 moves it found",
  afterSweep,
);
check(/\b2 games\b/.test(afterSweep), "sweep announces the 2 games it covered");

// ── 3. analyse ONE of them again, on its own ─────────────────────────────────
console.log("→ analysing one pasted game (real engine, ~10s)…");
await page.fill(".single-input", GAMES[0].url);
await page.click("button.btn-ghost:has-text('Analyse')");
const afterSingle = await nextAnnouncement(afterSweep);
console.log(`   region: ${JSON.stringify(afterSingle)}`);

const shown = await page.locator(".spec-grid .spec").count();
check(shown === 2, "the gallery still shows both brilliancies", `${shown} cards`);

/**
 * The defect, precisely: a count attached to a one-game clause that is not the
 * number found in that one game. "3 brilliant moves found in 1 game" is the
 * sentence this exists to stop, whatever the surrounding wording becomes.
 */
const perGame = afterSingle.match(
  /(\d+) brilliant (?:move|moves)[^.]*? in (?:this game|1 game)/i,
);
check(
  perGame !== null && Number(perGame[1]) === MOVES_PER_GAME,
  "the one-game clause names what THIS game had",
  perGame ? `claims ${perGame[1]}, actually ${MOVES_PER_GAME}` : "no one-game clause at all",
);

// ...and it must not contradict the gallery behind it by dropping the total.
check(
  new RegExp(`\\b${shown}\\b[^.]*total|total[^.]*\\b${shown}\\b`, "i").test(afterSingle),
  "the announcement still accounts for the total on screen",
  afterSingle,
);

await browser.close();
console.log(failed ? `\n✗ FAIL — ${failed} check(s)` : "\n✓ PASS — the region describes the scan that just ran");
process.exit(failed ? 1 : 0);
