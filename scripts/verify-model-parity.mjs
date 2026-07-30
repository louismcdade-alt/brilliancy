/**
 * Does the browser score a candidate exactly as training scored it?
 *
 * The model is arithmetic over a feature vector, and the vector is built twice —
 * once in scripts/lib/dataset.mjs for training, once in src/engine/score.ts for
 * the app. If those two ever disagree the site ships a model reading different
 * numbers than it learned, every published precision figure becomes fiction, and
 * NOTHING FAILS: no exception, no red test, just quietly worse output. That is
 * the single most dangerous failure mode in this pipeline, so it gets its own
 * check.
 *
 * Method: take real cached candidates, score them in node from the training-side
 * vector, score the same candidates in the browser through the shipping module,
 * and require agreement to 1e-9.
 *
 * Prereq: the dev server must be running (npm run dev).
 *
 *   node scripts/verify-model-parity.mjs
 */
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import { loadRows } from "./lib/dataset.mjs";

const model = JSON.parse(readFileSync("src/engine/model.json", "utf8"));
const cache = JSON.parse(readFileSync("scripts/harvest-multi.json", "utf8"));

// Training-side scoring, from the same rows the model was fitted on.
const walk = (n, f) => (n.leaf ? n.w : walk(f[n.key] <= n.t ? n.left : n.right, f));
const scoreFromRow = (r) => {
  let sum = 0;
  for (const t of model.trees) sum += model.lr * walk(t, r.f);
  return 1 / (1 + Math.exp(-sum));
};

// Pick a spread: some flagged, some not, across several accounts.
const rows = loadRows().filter((r) => r.f.isOffer === 1);
const sample = [];
const seen = new Set();
for (const r of rows) {
  if (sample.length >= 60) break;
  if (seen.has(r.user) && sample.length % 3 !== 0) continue;
  seen.add(r.user);
  const g = Object.values(cache.games).find((x) => x.id === r.gameId);
  const c = g?.candidates.find((x) => `${x.moveNumber}${g.userColor === "w" ? "." : "…"}${x.san}` === r.move);
  if (!c) continue;
  sample.push({ key: `${r.gameId} ${r.move}`, expected: scoreFromRow(r), candidate: c });
}

const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage();
page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
await page.goto("http://localhost:5173/", { waitUntil: "networkidle" });

const got = await page.evaluate(async (rows) => {
  const { brilliancyScore, SCORE_CUT } = await import("/src/engine/score.ts");
  return {
    cut: SCORE_CUT,
    scores: rows.map((r) => ({
      key: r.key,
      // `quietAlt: null` in the cache means MultiPV found no quiet alternative;
      // the live Candidate carries -Infinity for that, so restore it here or the
      // browser sees a different `margin` than training did.
      score: brilliancyScore({ ...r.candidate, quietAlt: r.candidate.quietAlt === null ? -Infinity : r.candidate.quietAlt }),
    })),
  };
}, sample.map((s) => ({ key: s.key, candidate: s.candidate })));

await browser.close();

let worst = 0;
let bad = 0;
for (let i = 0; i < sample.length; i++) {
  const d = Math.abs(sample[i].expected - got.scores[i].score);
  if (d > worst) worst = d;
  if (d > 1e-9) {
    bad++;
    if (bad <= 5) console.log(`MISMATCH ${sample[i].key}: training ${sample[i].expected.toFixed(9)} vs browser ${got.scores[i].score.toFixed(9)}`);
  }
}

console.log(`\n${sample.length} candidates compared · max difference ${worst.toExponential(2)}`);
console.log(`cut: model.json ${model.cut}, browser ${got.cut}`);
if (bad || got.cut !== model.cut) {
  console.log(`\n✗ PARITY BROKEN — ${bad} mismatched`);
  process.exit(1);
}
console.log("\n✓ browser scores identically to training");
