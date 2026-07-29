/**
 * Fit a shallow decision tree to chess.com's Brilliant label.
 *
 * WHY A TREE, and not something stronger. The thing being approximated is not a
 * natural phenomenon — it is a classifier somebody at chess.com wrote, almost
 * certainly as thresholds on engine numbers ("the move must still be winning",
 * "it must not be obvious", "material must be given up"). A shallow tree is that
 * same object: axis-aligned thresholds combined by AND and OR. Matching the model
 * class to the generating process is worth more than model capacity here, for
 * four concrete reasons:
 *
 *   1. It reads out as if-statements. The detector IS a stack of if-statements in
 *      brilliancy.ts; a fitted tree can be transcribed into it and reviewed by a
 *      human. A model that cannot be read cannot be argued with, and every rule
 *      this project has adopted or refused was decided by argument.
 *   2. It handles non-monotonic structure, which we know is present. 24.Ne6 sits
 *      BETWEEN two negatives on both margin and eval loss, so no single threshold
 *      on either can separate it — but a conjunction of thresholds can.
 *   3. It is sample-efficient. 379 positives is small. A depth-2 tree has ~3 free
 *      parameters; the rough guide of ten examples per parameter is comfortably
 *      met, which is not true of anything with a hidden layer.
 *   4. It is invariant to feature scaling and fine with mixed types — evals in
 *      centipawns, material in pawns, booleans, categoricals — no normalisation
 *      step to get wrong.
 *
 * What was considered and rejected. LOGISTIC REGRESSION assumes the log-odds move
 * monotonically with each feature; the sandwiched positives say they do not.
 * SYMBOLIC REGRESSION was already tried (scripts/symbolic-demo.mjs) and returned
 * six structurally unrelated formulas that fit equally well — the data does not
 * constrain a continuous functional form. A NEURAL NET would need orders more
 * data, and would be unshippable in a detector whose entire value proposition is
 * that you can read why a move was flagged. RANDOM FOREST / BOOSTING would likely
 * score better and cannot be transcribed into the codebase or explained in the
 * UI; worth revisiting only as an upper bound on what the features support.
 *
 * CLASS IMBALANCE. Positives are ~10% of candidates, so an unweighted tree scores
 * best by calling everything negative. Splits are chosen on class-weighted Gini
 * (each class carries equal total weight), and a leaf predicts positive when its
 * weighted positive share exceeds 0.5.
 *
 * ENRICHMENT. Star games are over-sampled by construction, so the class prior in
 * training is not the class prior in the world. That biases where a leaf's 0.5
 * boundary falls, not which questions the tree asks — and every number reported
 * below comes from the held-out half with precision computed on random games
 * only, exactly as in score-multi.mjs. Train on what teaches, measure on what is
 * representative.
 *
 *   node scripts/fit-tree.mjs [--depth 3] [--min-leaf 25]
 */
import { readFileSync } from "node:fs";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? Number(process.argv[i + 1]) : fallback;
};
const MAX_DEPTH = arg("depth", 3);
const MIN_LEAF = arg("min-leaf", 25);

const cache = JSON.parse(readFileSync("scripts/harvest-multi.json", "utf8"));

/** Same id hash as score-multi.mjs — the split must agree across both scripts. */
const half = (id) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % 2 === 0 ? "fit" : "test";
};

// ── rows ────────────────────────────────────────────────────────────────────
const rows = [];
for (const g of Object.values(cache.games)) {
  const stars = new Set(g.expected.map((m) => `${m.moveNumber} ${m.san}`));
  for (const c of g.candidates) {
    const k = `${c.moveNumber} ${c.san}`;
    const label = stars.has(k) ? 1 : 0;
    // An unlisted move in a game whose list is incomplete is unknown, not
    // negative — the harvester's rule, repeated here because this script reads
    // the cache rather than the CSV.
    if (!label && g.trustNegatives === false) continue;
    rows.push({
      label,
      half: half(g.id),
      sample: g.sample,
      gameId: g.id,
      move: `${c.moveNumber}${g.userColor === "w" ? "." : "…"}${c.san}`,
      f: {
        sacrifice: c.sacrifice,
        playedEval: c.playedEval,
        evalLoss: c.evalLoss,
        // No quiet alternative is a real state, not a missing value. Encoded as a
        // large negative margin so the tree can isolate it with a threshold
        // instead of us inventing an imputation rule.
        margin: c.quietAlt === null ? -100000 : c.playedEval - c.quietAlt,
        hasQuietAlt: c.quietAlt === null ? 0 : 1,
        fresh: c.fresh ?? 0,
        standing: c.standing ?? 0,
        accepted: c.accepted === null ? -1 : c.accepted ? 1 : 0,
        isDirect: c.shape === "direct" ? 1 : 0,
        isPromotion: c.shape === "promotion" ? 1 : 0,
        isOffer: c.admitted === "offer" ? 1 : 0,
        moveNumber: c.moveNumber,
        rating: g.rating ?? 0,
      },
    });
  }
}

const FEATURES = Object.keys(rows[0].f);
const train = rows.filter((r) => r.half === "fit");
const test = rows.filter((r) => r.half === "test");

// ── tree ────────────────────────────────────────────────────────────────────
/** Class weights: each class carries equal total weight regardless of size. */
function weights(data) {
  const pos = data.filter((r) => r.label === 1).length;
  const neg = data.length - pos;
  return { 1: pos ? data.length / (2 * pos) : 0, 0: neg ? data.length / (2 * neg) : 0 };
}
const W = weights(train);
const wsum = (data) => data.reduce((a, r) => a + W[r.label], 0);
const wpos = (data) => data.reduce((a, r) => a + (r.label === 1 ? W[1] : 0), 0);

function gini(data) {
  const t = wsum(data);
  if (!t) return 0;
  const p = wpos(data) / t;
  return 2 * p * (1 - p);
}

/** Candidate thresholds: distinct quantiles, so cost does not blow up on evals. */
function thresholds(data, key) {
  const vals = [...new Set(data.map((r) => r.f[key]))].sort((a, b) => a - b);
  if (vals.length <= 12) return vals.slice(0, -1).map((v, i) => (v + vals[i + 1]) / 2);
  const out = [];
  for (let q = 1; q < 24; q++) {
    const v = vals[Math.floor((q / 24) * vals.length)];
    const nxt = vals[Math.min(vals.length - 1, Math.floor((q / 24) * vals.length) + 1)];
    if (v !== nxt) out.push((v + nxt) / 2);
  }
  return [...new Set(out)];
}

function bestSplit(data) {
  const base = gini(data);
  const total = wsum(data);
  let best = null;
  for (const key of FEATURES) {
    for (const t of thresholds(data, key)) {
      const L = data.filter((r) => r.f[key] <= t);
      const R = data.filter((r) => r.f[key] > t);
      if (L.length < MIN_LEAF || R.length < MIN_LEAF) continue;
      const g = (wsum(L) / total) * gini(L) + (wsum(R) / total) * gini(R);
      const gain = base - g;
      if (!best || gain > best.gain) best = { key, t, gain, L, R };
    }
  }
  return best && best.gain > 1e-9 ? best : null;
}

function build(data, depth = 0) {
  const t = wsum(data);
  const p = t ? wpos(data) / t : 0;
  const leaf = {
    leaf: true,
    predict: p > 0.5 ? 1 : 0,
    p,
    n: data.length,
    pos: data.filter((r) => r.label === 1).length,
  };
  if (depth >= MAX_DEPTH || data.length < 2 * MIN_LEAF || p === 0 || p === 1) return leaf;
  const s = bestSplit(data);
  if (!s) return leaf;
  return { leaf: false, key: s.key, t: s.t, left: build(s.L, depth + 1), right: build(s.R, depth + 1) };
}

const tree = build(train);

/**
 * A leaf's SCORE, and why the 0.5 boundary above is not the decision rule.
 *
 * Class weighting is what lets the tree find structure at a 10% base rate, but it
 * also means "weighted p > 0.5" is not "probably brilliant" — the first depth-2
 * fit flagged a leaf that was 27% positive in training, which on random games is
 * about 8% precision. Worse, training data is ENRICHED with star games, so even
 * the raw 27% overstates what that leaf is worth in real play.
 *
 * So the tree is used as a RANKER — leaves ordered by purity — and the cut-off is
 * chosen on the fit half's `random` rows only, which are the unbiased ones. That
 * separates the two jobs honestly: the enriched data teaches the tree which
 * questions to ask, the unbiased data decides how sure it has to be. The test
 * half is untouched by both.
 */
const leafOf = (node, r) => (node.leaf ? node : leafOf(r.f[node.key] <= node.t ? node.left : node.right, r));
const score = (r) => {
  const l = leafOf(tree, r);
  return l.n ? l.pos / l.n : 0; // raw purity, not the weighted one
};

function print(node, indent = "", label = "") {
  if (node.leaf) {
    const verdict = node.predict ? "BRILLIANT" : "not";
    console.log(`${indent}${label}→ ${verdict.padEnd(10)} (${node.pos}/${node.n} positive, weighted p=${node.p.toFixed(2)})`);
    return;
  }
  const t = Math.abs(node.t) > 999 ? node.t.toExponential(1) : node.t.toFixed(1);
  console.log(`${indent}${label}${node.key} <= ${t} ?`);
  print(node.left, indent + "    ", "yes ");
  print(node.right, indent + "    ", "no  ");
}

// ── evaluate ────────────────────────────────────────────────────────────────
function evaluate(data, predictFn) {
  let tp = 0, fn = 0, tpRandom = 0, fp = 0;
  for (const r of data) {
    const yes = predictFn(r);
    if (r.label === 1) {
      if (yes) { tp++; if (r.sample === "random") tpRandom++; } else fn++;
    } else if (yes && r.sample === "random") fp++;
  }
  const P = tpRandom + fp ? tpRandom / (tpRandom + fp) : null;
  const R = tp + fn ? tp / (tp + fn) : null;
  return { tp, fn, tpRandom, fp, P, R, F1: P && R ? (2 * P * R) / (P + R) : null };
}

// The shipping rule, expressed over the same rows, as the thing to beat.
const shipping = (r) =>
  r.f.isOffer === 1 &&
  r.f.isPromotion === 0 &&
  r.f.playedEval >= 20 &&
  r.f.evalLoss <= 120 &&
  r.f.hasQuietAlt === 1 &&
  r.f.margin >= 50;

const pct = (x) => (x === null ? "n/a" : `${(100 * x).toFixed(1)}%`);
const line = (name, s) =>
  `${name.padEnd(22)} TP ${String(s.tp).padStart(3)}  FN ${String(s.fn).padStart(3)}  | randTP ${String(s.tpRandom).padStart(3)}  FP ${String(s.fp).padStart(3)}   P ${pct(s.P).padStart(6)}  R ${pct(s.R).padStart(6)}  F1 ${s.F1 === null ? " n/a" : s.F1.toFixed(3)}`;

console.log(`rows ${rows.length}  (${rows.filter((r) => r.label === 1).length} positive)`);
console.log(`fit  ${train.length} rows, ${train.filter((r) => r.label === 1).length} positive`);
console.log(`test ${test.length} rows, ${test.filter((r) => r.label === 1).length} positive`);
console.log(`\nFITTED TREE (depth ${MAX_DEPTH}, min leaf ${MIN_LEAF}), trained on the FIT half only:\n`);
print(tree);

// ── choose the operating point on the FIT half's unbiased rows ───────────────
const cuts = [...new Set(train.map(score))].sort((a, b) => b - a);
const trainRandom = train.filter((r) => r.sample === "random");
let chosen = null;
console.log("\nOPERATING POINT — swept on the fit half's random rows only:");
console.log("  leaf purity ≥        randTP  FP        P       R      F1");
for (const c of cuts) {
  const s = evaluate(trainRandom, (r) => score(r) >= c);
  const all = evaluate(train, (r) => score(r) >= c);
  if (s.P === null) continue;
  console.log(
    `  ${c.toFixed(3).padStart(8)}          ${String(s.tpRandom).padStart(5)} ${String(s.fp).padStart(4)}   ${pct(s.P).padStart(6)}  ${pct(all.R).padStart(6)}  ${s.F1 === null ? " n/a" : s.F1.toFixed(3)}`,
  );
  // Chosen by F1 on the unbiased subset. Recall comes from all rows, precision
  // from random ones, so the F1 driving this choice uses the random rows for both
  // — deliberately conservative rather than mixing populations again.
  if (s.F1 !== null && (!chosen || s.F1 > chosen.f1)) chosen = { cut: c, f1: s.F1 };
}
console.log(`\nchosen cut: leaf purity ≥ ${chosen.cut.toFixed(3)}`);

const treeRule = (r) => score(r) >= chosen.cut;

console.log("\nFIT HALF — what it was trained on, so not a measurement");
console.log(line("  shipping rule", evaluate(train, shipping)));
console.log(line("  tree", evaluate(train, treeRule)));

console.log("\nTEST HALF — held out, and the only numbers that mean anything");
console.log(line("  shipping rule", evaluate(test, shipping)));
console.log(line("  tree", evaluate(test, treeRule)));
