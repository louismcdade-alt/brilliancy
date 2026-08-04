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
// Nothing is offered in six moves of Ruy Lopez, so the prefilter never even
// calls the engine — this is the "no brilliancies here" branch of the sentence.
const QUIET_PGN = "1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7 6. Re1 b5";

const rawGame = (id, pgn = PGN) => ({
  url: `https://www.chess.com/game/live/${id}`,
  uuid: `uuid-${id}`,
  pgn,
  rules: "chess",
  time_class: "blitz",
  time_control: "300",
  rated: true,
  end_time: 1700000000 + Number(id),
  white: { username: USER, rating: 1500, result: "win" },
  black: { username: "opponent", rating: 1500, result: "checkmated" },
});

const GAMES = [rawGame("101"), rawGame("202"), rawGame("303", QUIET_PGN)];
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

let failed = 0;
const check = (ok, label, detail) => {
  console.log(`${ok ? "  ✓" : "  ✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failed++;
};

/**
 * Wait for the assertive region to say something other than what it said last.
 *
 * "Unchanged" is itself a failure worth reporting rather than throwing on:
 * aria-live only speaks on a CHANGE, so a scan that leaves the sentence byte-
 * identical is a scan a screen reader is never told finished — which is exactly
 * what analysing a game with nothing in it used to do, when the sentence was
 * built from the accumulated total and the total hadn't moved.
 */
async function nextAnnouncement(previous, label) {
  const changed = await page
    .waitForFunction(
      ([prev]) => {
        const el = document.querySelector('.sr-only[aria-live="assertive"]');
        const now = (el?.textContent ?? "").trim();
        return now.length > 0 && now !== prev ? now : false;
      },
      [previous],
      { timeout: 180_000 },
    )
    .then(() => true)
    .catch(() => false);
  check(changed, `${label} is announced at all (the region text changed)`);
  return (await region.textContent()).trim();
}

await page.goto(BASE, { waitUntil: "networkidle" });

// ── 1. load the mocked profile ───────────────────────────────────────────────
await page.fill(".search-input", USER);
await page.click('form.hero-search-row button[type="submit"]');
await page.waitForSelector(".analyze-panel", { timeout: 20_000 });

// ── 2. sweep all three ───────────────────────────────────────────────────────
console.log("→ scanning all three games (real engine, ~20s)…");
await page.click("button.btn-bril:has-text('Find brilliancies')");
const afterSweep = await nextAnnouncement("", "the sweep");
console.log(`   region: ${JSON.stringify(afterSweep)}`);

check(/\b2 brilliant moves\b/.test(afterSweep), "sweep announces the 2 moves it found", afterSweep);
check(/\b3 games\b/.test(afterSweep), "sweep announces the 3 games it covered");

/**
 * The defect, precisely: a count attached to a one-game clause that is not the
 * number found in that one game. "3 brilliant moves found in 1 game" is the
 * sentence this exists to stop, whatever the surrounding wording becomes.
 */
function checkOneGameScan(text, expected, shown) {
  const perGame = text.match(/(\d+|no) brilliant (?:move|moves)[^.]*? in (?:this game|1 game)/i);
  const claimed = perGame ? (/no/i.test(perGame[1]) ? 0 : Number(perGame[1])) : null;
  check(
    claimed === expected,
    "the one-game clause names what THIS game had",
    perGame ? `claims ${claimed}, actually ${expected}` : "no one-game clause at all",
  );
  // ...and it must not contradict the gallery behind it by dropping the total.
  check(
    expected === shown ||
      new RegExp(`\\b${shown}\\b[^.]*total|total[^.]*\\b${shown}\\b`, "i").test(text),
    "the announcement still accounts for the total on screen",
    text,
  );
}

// ── 3. analyse ONE of them again, on its own ─────────────────────────────────
console.log("→ analysing one pasted game with a brilliancy in it…");
await page.fill(".single-input", GAMES[0].url);
await page.click("button.btn-ghost:has-text('Analyse')");
const afterSingle = await nextAnnouncement(afterSweep, "the single-game scan");
console.log(`   region: ${JSON.stringify(afterSingle)}`);

const shown = await page.locator(".spec-grid .spec").count();
check(shown === 2, "the gallery still shows both brilliancies", `${shown} cards`);
checkOneGameScan(afterSingle, MOVES_PER_GAME, shown);

// ── 4. ...and one with nothing in it, with the gallery still full ────────────
await page.keyboard.press("Escape"); // the viewer opens over the page each time
console.log("→ analysing the quiet game…");
await page.fill(".single-input", GAMES[2].url);
await page.click("button.btn-ghost:has-text('Analyse')");
const afterQuiet = await nextAnnouncement(afterSingle, "the quiet game's scan");
console.log(`   region: ${JSON.stringify(afterQuiet)}`);
checkOneGameScan(afterQuiet, 0, await page.locator(".spec-grid .spec").count());

await browser.close();
console.log(failed ? `\n✗ FAIL — ${failed} check(s)` : "\n✓ PASS — the region describes the scan that just ran");
process.exit(failed ? 1 : 0);
