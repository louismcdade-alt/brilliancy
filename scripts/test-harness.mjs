/**
 * Calibration harness for the brilliancy detector.
 *
 * Runs the *real* scanGame() (in a browser, against the live Stockfish WASM build)
 * over every game in fixtures.mjs, compares what it flags to the human labels, and
 * reports precision / recall plus a per-game breakdown. This is the instrument for
 * the "tune detection thresholds" task: change a constant in src/engine/brilliancy.ts,
 * re-run this, and watch the numbers move instead of guessing.
 *
 * Prereq: the dev server must be running (npm run dev) — same as the other scripts.
 *
 *   node scripts/test-harness.mjs            # depth 14 (matches the app's SCAN_DEPTH)
 *   DEPTH=18 node scripts/test-harness.mjs   # try a deeper verification pass
 *
 * Exit code is non-zero if any game has a false positive or a missed brilliancy,
 * so it doubles as a regression gate (e.g. in CI once you trust the fixture set).
 */
import { chromium } from "playwright";
import { fixtures } from "./fixtures.mjs";

const DEPTH = Number(process.env.DEPTH) || 14;

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

// Identity of a flagged move, for matching detector output against labels.
const key = (m) => `${m.moveNumber} ${m.san}`;

const browser = await launch();
const page = await browser.newPage();
page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
await page.goto("http://localhost:5173/", { waitUntil: "networkidle" });

console.log(`Brilliancy calibration — ${fixtures.length} games at depth ${DEPTH}\n`);

let tp = 0; // detected and labeled brilliant
let fp = 0; // detected but not labeled (false positive)
let fn = 0; // labeled but not detected (missed)
let regressions = 0;

for (const fx of fixtures) {
  const detected = await page.evaluate(
    async ({ pgn, userColor, depth }) => {
      const mod = await import("/src/engine/brilliancy.ts");
      const game = {
        id: "test",
        url: "",
        pgn,
        timeClass: "blitz",
        timeControl: "300",
        rated: true,
        endTime: 0,
        userColor,
        result: "win",
        resultReason: "",
        oppUsername: "opponent",
      };
      const found = await mod.scanGame(game, { depth });
      return found.map((b) => ({
        moveNumber: b.moveNumber,
        san: b.san,
        sacrifice: b.sacrifice,
        evalAfter: b.evalAfter,
        evalLoss: b.evalLoss,
      }));
    },
    { pgn: fx.pgn, userColor: fx.userColor, depth: DEPTH },
  );

  const diverges = fx.diverges ?? [];
  // Documented divergences are neither expected nor false positives — they're
  // decisions we've already made and written down. Scoring them either way would
  // make the number lie about how the detector is doing.
  const knownKeys = new Set(diverges.map(key));
  const expectedKeys = new Set(fx.expected.map(key));
  const detectedKeys = new Set(detected.map(key));

  const hits = fx.expected.filter((m) => detectedKeys.has(key(m)));
  const missed = fx.expected.filter((m) => !detectedKeys.has(key(m)));
  const falsePos = detected.filter((m) => !expectedKeys.has(key(m)) && !knownKeys.has(key(m)));
  // A divergence that starts getting flagged is news: the note is now stale.
  const resurfaced = diverges.filter((m) => detectedKeys.has(key(m)));

  tp += hits.length;
  fn += missed.length;
  fp += falsePos.length;

  const ok = missed.length === 0 && falsePos.length === 0 && resurfaced.length === 0;
  if (!ok) regressions++;

  console.log(`${ok ? "✓" : "✗"} ${fx.name}`);
  for (const m of hits) {
    const d = detected.find((x) => key(x) === key(m));
    console.log(
      `    hit   ${m.moveNumber}.${m.san}  (sac ${d.sacrifice}, eval ${d.evalAfter}cp, loss ${d.evalLoss}cp)`,
    );
  }
  for (const m of missed) console.log(`    MISS  ${m.moveNumber}.${m.san}  — expected but not flagged`);
  for (const m of diverges) {
    const now = detectedKeys.has(key(m));
    console.log(
      `    ${now ? "NOTE!" : "known"} ${m.moveNumber}.${m.san}  — ${m.why}${now ? "  ⚠ now flagged, update the fixture" : ""}`,
    );
  }
  for (const m of falsePos)
    console.log(
      `    FALSE ${m.moveNumber}.${m.san}  (sac ${m.sacrifice}, eval ${m.evalAfter}cp, loss ${m.evalLoss}cp) — flagged but not labeled`,
    );
  console.log("");
}

const precision = tp + fp ? tp / (tp + fp) : 1;
const recall = tp + fn ? tp / (tp + fn) : 1;
const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
const pct = (x) => `${(x * 100).toFixed(1)}%`;

console.log("───────────────────────────────────────────");
console.log(`TP ${tp}   FP ${fp}   FN ${fn}`);
console.log(`Precision ${pct(precision)}   Recall ${pct(recall)}   F1 ${pct(f1)}`);
console.log(
  regressions === 0
    ? "✓ ALL GAMES PASS"
    : `✗ ${regressions} game(s) with a miss or false positive`,
);

await browser.close();
process.exit(regressions === 0 ? 0 : 1);
