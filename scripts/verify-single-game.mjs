/**
 * What the assertive live region says when a scan finishes — the sentence a
 * screen-reader user gets as THE answer to "find my brilliancies".
 *
 * The region is fed two numbers that come from different places: the gallery's
 * accumulated list (which keeps brilliancies from earlier scans of other games)
 * and the count of games the run that just finished actually covered. Analysing
 * one pasted game after a 30-game sweep pulls them apart, and the region used to
 * multiply them together into a sentence that was true of neither: "3 brilliant
 * moves found in 1 game".
 *
 * Driving that needs a profile, thirty games and a scan, so the API, the engine
 * and the detector are all replaced with route-served stub modules — Vite serves
 * each source file over HTTP in dev, so intercepting the request for
 * `/src/engine/brilliancy.ts` swaps the module the real App imports. Everything
 * else on the page (the state machine, the gallery, the summary strip and the
 * live region itself) is the shipping code.
 *
 * Needs the dev server on http://localhost:5173.
 */
import { chromium } from "playwright";
import { Chess } from "chess.js";

const URL = "http://localhost:5173/";

// Légal's Mate — a real game so the viewer that scanOneGame opens can replay it.
const PGN = "1. e4 e5 2. Bc4 d6 3. Nf3 Bg4 4. Nc3 g6 5. Nxe5 Bxd1 6. Bxf7+ Ke7 7. Nd5#";
const board = new Chess();
for (const m of ["e4", "e5", "Bc4", "d6", "Nf3", "Bg4", "Nc3", "g6"]) board.move(m);
const FEN_BEFORE = board.fen();
board.move("Nxe5");
const FEN_AFTER = board.fen();

function game(id, opp) {
  return {
    source: "chesscom",
    id,
    url: `https://www.chess.com/game/live/${id}`,
    pgn: PGN,
    timeClass: "blitz",
    timeControl: "300",
    rated: true,
    endTime: 1700000000,
    userColor: "w",
    result: "win",
    resultReason: "checkmated",
    userRating: 1500,
    oppUsername: opp,
    oppRating: 1490,
    userAccuracy: 88.5,
  };
}

/** One flagged move, shaped exactly like the detector's output minus `game`. */
const MOVE = {
  ply: 8,
  moveNumber: 5,
  san: "Nxe5",
  fenBefore: FEN_BEFORE,
  fenAfter: FEN_AFTER,
  from: "f3",
  to: "e5",
  evalAfter: 194,
  evalLoss: -16,
  sacrifice: 5.8,
  sacSquare: "d1",
  sacPiece: "q",
  mateIn: null,
  mateSoonPlies: 5,
  kingMoves: 1,
  kingRingDelta: 2,
  regain6: 3,
  regainPlies: 6,
  score: 0.82,
  quietMargin: 140,
};

// Thirty games in the window, two of which hold a brilliancy; plus two games
// that only exist to be pasted into "analyse one game" — one with a brilliancy,
// one without.
const WINDOW = Array.from({ length: 30 }, (_, i) => game(`g${i + 1}`, `opp${i + 1}`));
const PASTED_HIT = game("pasted-hit", "someone");
const PASTED_MISS = game("pasted-miss", "someone-else");
const FOUND_IN = { g1: 1, g2: 1, "pasted-hit": 1 };

const stubApi = `
const WINDOW = ${JSON.stringify(WINDOW)};
const PASTED = { "hit": ${JSON.stringify(PASTED_HIT)}, "miss": ${JSON.stringify(PASTED_MISS)} };
export function isNotFound() { return false; }
export function safeUrl(u) { return typeof u === "string" ? u : undefined; }
export async function fetchProfile(username) {
  return { source: "chesscom", username, name: "Stub Player", isOnline: false };
}
export async function fetchStats() { return {}; }
export async function fetchArchiveMonths() { return []; }
export async function fetchRecentGames(_u, max) { return WINDOW.slice(0, max); }
export async function fetchGameByUrl(_u, raw) { return raw.includes("miss") ? PASTED.miss : PASTED.hit; }
`;

const stubEngine = `export const engine = { init: async () => {} };`;

const stubDetector = `
const FOUND_IN = ${JSON.stringify(FOUND_IN)};
const MOVE = ${JSON.stringify(MOVE)};
export async function scanGame(game) {
  const n = FOUND_IN[game.id] || 0;
  return Array.from({ length: n }, () => ({ ...MOVE, game }));
}
`;

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
const page = await browser.newPage({ viewport: { width: 1280, height: 1400 } });
page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));

const serve = (body) => (route) =>
  route.fulfill({ status: 200, contentType: "text/javascript", body });
await page.route("**/src/api/chesscom.ts*", serve(stubApi));
await page.route("**/src/engine/engine.ts*", serve(stubEngine));
await page.route("**/src/engine/brilliancy.ts*", serve(stubDetector));

await page.goto(URL, { waitUntil: "networkidle" });

const live = page.locator('[aria-live="assertive"]');
const announcement = async () => (await live.first().textContent())?.trim() ?? "";

const failures = [];
function check(label, actual, expected) {
  if (actual === expected) {
    console.log(`✓ ${label}\n    ${actual}`);
  } else {
    failures.push(label);
    console.log(`✗ ${label}\n    expected: ${expected}\n    actual:   ${actual}`);
  }
}

// --- 1. the whole window, the case the sentence was written for ---
await page.fill(".search-input", "stubplayer");
await page.click('button[type="submit"]');
await page.waitForSelector(".game-row", { timeout: 20000 });
await page.click("button.btn-bril");
await page.waitForSelector(".spec", { timeout: 30000 });
await page.waitForFunction(
  () => (document.querySelector('[aria-live="assertive"]')?.textContent || "").includes("complete"),
  null,
  { timeout: 30000 },
);
check(
  "full scan of 30 games, 2 found",
  await announcement(),
  "Scan complete. 2 brilliant moves found in 30 games.",
);

async function analyseOne(url) {
  await page.fill(".single-input", url);
  await page.click(".single-row button.btn-ghost");
  await page.waitForSelector(".overlay", { timeout: 20000 });
  await page.keyboard.press("Escape");
  await page.waitForSelector(".overlay", { state: "detached", timeout: 5000 });
}

// --- 2. one pasted game with nothing in it, after that scan ---
await analyseOne("https://www.chess.com/game/live/pasted-miss");
check(
  "one pasted game, nothing found, 2 still on screen",
  await announcement(),
  "Scan complete. No brilliant moves in that game. 2 moves are shown in total, including earlier scans.",
);

// --- 3. one pasted game WITH a brilliancy: the numbers disagree ---
await analyseOne("https://www.chess.com/game/live/pasted-hit");
check(
  "one pasted game, 1 found, 3 on screen",
  await announcement(),
  "Scan complete. 1 brilliant move in that game. 3 moves are shown in total, including earlier scans.",
);

// The announcement must not contradict the page: the gallery and the Circled
// cell deliberately keep showing everything found for this profile.
const cards = await page.locator(".spec").count();
const circled = (await page.locator(".summary-cell", { hasText: "Circled" }).textContent())?.trim();
check("gallery still shows the accumulated list", `${cards}`, "3");
check("Circled cell still shows the accumulated total", circled, "Circled3");

await browser.close();

if (failures.length) {
  console.log(`\n✗ FAIL — ${failures.length} of 5: ${failures.join("; ")}`);
  process.exit(1);
}
console.log("\n✓ PASS — the live region names the scan and the total separately");
