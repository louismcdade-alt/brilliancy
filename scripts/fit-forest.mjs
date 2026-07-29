/**
 * Random forest — NOT a candidate to ship. An upper bound, to answer one question.
 *
 * The shallow tree reached F1 0.337 held out against the hand-written rule's
 * 0.314, which is not a win worth acting on. That leaves two very different
 * explanations, and everything after this depends on which is true:
 *
 *   the MODEL is the limit    a greedy depth-5 tree is too crude to find
 *                             structure the features do contain, and a stronger
 *                             learner would do better.
 *   the FEATURES are the limit  nothing in {sacrifice, evals, margin, shape,
 *                             fresh, standing, accepted} separates the remaining
 *                             positives, and no model can conjure it.
 *
 * A forest is the cheapest way to tell them apart: 200 bagged trees, feature
 * subsampling, far more capacity than a depth-5 tree, and no interpretability
 * whatsoever. If it cannot beat ~0.34 the ceiling is the features, and the next
 * work is extracting new ones rather than fitting harder. If it reaches 0.5 there
 * is structure worth chasing with something readable.
 *
 * It is deliberately unshippable: a forest cannot be transcribed into
 * brilliancy.ts and cannot tell a user why their move was flagged, which is the
 * product's whole claim. Read it as a thermometer.
 *
 *   node scripts/fit-forest.mjs [--trees 200] [--depth 8] [--min-leaf 5]
 */
import { loadRows, FEATURES, shippingRule, evaluate, line, pct } from "./lib/dataset.mjs";
import { buildTree, classWeights, purity } from "./lib/tree.mjs";

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? Number(process.argv[i + 1]) : d;
};
const TREES = arg("trees", 200);
const DEPTH = arg("depth", 8);
const MIN_LEAF = arg("min-leaf", 5);

/** Seeded PRNG so a re-run reproduces the forest exactly. */
let seed = 20260729;
const rand = () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
};

const rows = loadRows();
const train = rows.filter((r) => r.half === "fit");
const test = rows.filter((r) => r.half === "test");
const W = classWeights(train);
const perSplit = Math.max(1, Math.round(Math.sqrt(FEATURES.length)));

console.log(`rows ${rows.length} (${rows.filter((r) => r.label === 1).length} positive)`);
console.log(`forest: ${TREES} trees, depth ${DEPTH}, min leaf ${MIN_LEAF}, ${perSplit} features per split\n`);

const forest = [];
for (let i = 0; i < TREES; i++) {
  const boot = Array.from({ length: train.length }, () => train[Math.floor(rand() * train.length)]);
  forest.push(buildTree(boot, { features: FEATURES, W, maxDepth: DEPTH, minLeaf: MIN_LEAF, featuresPerSplit: perSplit, rand }));
  if ((i + 1) % 50 === 0) console.error(`  …${i + 1}/${TREES} trees`);
}

/** Mean leaf purity across the forest — a score to rank by, not a decision. */
const score = (r) => forest.reduce((a, t) => a + purity(t, r), 0) / forest.length;

// Operating point swept on the fit half's unbiased rows, exactly as for the tree.
const trainRandom = train.filter((r) => r.sample === "random");
let chosen = null;
for (let c = 0.02; c <= 0.9; c += 0.01) {
  const s = evaluate(trainRandom, (r) => score(r) >= c);
  if (s.F1 !== null && (!chosen || s.F1 > chosen.f1)) chosen = { cut: c, f1: s.F1 };
}
console.log(`chosen cut: mean purity ≥ ${chosen.cut.toFixed(2)} (fit-half random F1 ${chosen.f1.toFixed(3)})\n`);
const rule = (r) => score(r) >= chosen.cut;

console.log("FIT HALF — trained on, not a measurement");
console.log(line("  shipping rule", evaluate(train, shippingRule)));
console.log(line("  forest", evaluate(train, rule)));

console.log("\nTEST HALF — held out");
console.log(line("  shipping rule", evaluate(test, shippingRule)));
console.log(line("  forest", evaluate(test, rule)));

// The precision/recall curve matters more than the single operating point: it
// shows whether the forest can reach a genuinely better trade anywhere, not just
// where F1 happens to peak.
console.log("\nHELD-OUT TRADE-OFF CURVE");
console.log("  cut     randTP  FP        P       R      F1");
for (const c of [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7]) {
  const s = evaluate(test, (r) => score(r) >= c);
  console.log(`  ${c.toFixed(2)}    ${String(s.tpRandom).padStart(5)} ${String(s.fp).padStart(4)}   ${pct(s.P).padStart(6)}  ${pct(s.R).padStart(6)}  ${s.F1 === null ? " n/a" : s.F1.toFixed(3)}`);
}
