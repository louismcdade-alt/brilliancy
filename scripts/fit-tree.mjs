/**
 * Fit a shallow decision tree to chess.com's Brilliant label.
 *
 * WHY A TREE, and not something stronger. The thing being approximated is not a
 * natural phenomenon — it is a classifier somebody at chess.com wrote, almost
 * certainly as thresholds on engine numbers ("the move must still be winning",
 * "it must not be obvious", "material must be given up"). A shallow tree is that
 * same object: axis-aligned thresholds combined by AND and OR. Matching the model
 * class to the generating process is worth more than model capacity here:
 *
 *   1. It reads out as if-statements. The detector IS a stack of if-statements in
 *      brilliancy.ts; a fitted tree can be transcribed into it and reviewed by a
 *      human. A model that cannot be read cannot be argued with, and every rule
 *      this project has adopted or refused was decided by argument.
 *   2. It handles non-monotonic structure, which we know is present. 24.Ne6 sits
 *      BETWEEN two negatives on both margin and eval loss, so no single threshold
 *      on either can separate it — but a conjunction of thresholds can.
 *   3. It is sample-efficient. A depth-5 tree here has ~10 free parameters
 *      against 329 positives, comfortably inside the ten-per-parameter guide.
 *   4. It is invariant to feature scaling and fine with mixed types — centipawns,
 *      pawns, booleans, categoricals — with no normalisation step to get wrong.
 *
 * Considered and rejected. LOGISTIC REGRESSION assumes log-odds move
 * monotonically with each feature; the sandwiched positives say otherwise.
 * SYMBOLIC REGRESSION was tried (symbolic-demo.mjs) and returned six unrelated
 * formulas fitting equally well. A NEURAL NET needs orders more data and would
 * break the product's claim that you can see why a move was flagged. RANDOM
 * FOREST is not a candidate to ship for the same reason — it runs in
 * fit-forest.mjs purely as an upper bound on what these features support.
 *
 *   node scripts/fit-tree.mjs [--depth 5] [--min-leaf 10]
 */
import { loadRows, FEATURES, shippingRule, evaluate, line, pct } from "./lib/dataset.mjs";
import { buildTree, classWeights, purity, printTree } from "./lib/tree.mjs";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? Number(process.argv[i + 1]) : fallback;
};
const MAX_DEPTH = arg("depth", 5);
const MIN_LEAF = arg("min-leaf", 10);

const rows = loadRows();
const train = rows.filter((r) => r.half === "fit");
const test = rows.filter((r) => r.half === "test");
const W = classWeights(train);
const tree = buildTree(train, { features: FEATURES, W, maxDepth: MAX_DEPTH, minLeaf: MIN_LEAF });

console.log(`rows ${rows.length}  (${rows.filter((r) => r.label === 1).length} positive)`);
console.log(`fit  ${train.length} rows, ${train.filter((r) => r.label === 1).length} positive`);
console.log(`test ${test.length} rows, ${test.filter((r) => r.label === 1).length} positive`);
console.log(`\nFITTED TREE (depth ${MAX_DEPTH}, min leaf ${MIN_LEAF}), trained on the FIT half only:\n`);
printTree(tree);

/**
 * The tree is used as a RANKER, and the class-weighted 0.5 boundary is NOT the
 * decision rule. Class weighting is what lets it find structure at a 10% base
 * rate, but a leaf clearing weighted 0.5 was 27% positive in training, which is
 * ~8% precision in real play. Training data is also enriched with star games, so
 * even raw purity overstates a leaf's worth. So: leaves ranked by purity, and the
 * cut-off swept on the fit half's `random` rows, which are the unbiased ones.
 * Enriched data teaches which questions to ask; unbiased data decides how sure
 * the answer has to be. The test half sees neither choice.
 */
const score = (r) => purity(tree, r);
const trainRandom = train.filter((r) => r.sample === "random");
let chosen = null;
console.log("\nOPERATING POINT — swept on the fit half's random rows only:");
console.log("  leaf purity ≥   randTP  FP        P       R      F1");
for (const c of [...new Set(train.map(score))].sort((a, b) => b - a)) {
  const s = evaluate(trainRandom, (r) => score(r) >= c);
  if (s.P === null) continue;
  const all = evaluate(train, (r) => score(r) >= c);
  console.log(`  ${c.toFixed(3).padStart(10)}   ${String(s.tpRandom).padStart(5)} ${String(s.fp).padStart(4)}   ${pct(s.P).padStart(6)}  ${pct(all.R).padStart(6)}  ${s.F1 === null ? " n/a" : s.F1.toFixed(3)}`);
  if (s.F1 !== null && (!chosen || s.F1 > chosen.f1)) chosen = { cut: c, f1: s.F1 };
}
console.log(`\nchosen cut: leaf purity ≥ ${chosen.cut.toFixed(3)}`);
const rule = (r) => score(r) >= chosen.cut;

console.log("\nFIT HALF — what it was trained on, so not a measurement");
console.log(line("  shipping rule", evaluate(train, shippingRule)));
console.log(line("  tree", evaluate(train, rule)));

console.log("\nTEST HALF — held out, and the only numbers that mean anything");
console.log(line("  shipping rule", evaluate(test, shippingRule)));
console.log(line("  tree", evaluate(test, rule)));
