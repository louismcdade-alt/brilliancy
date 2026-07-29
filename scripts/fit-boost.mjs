/**
 * Gradient boosting, under the same protocol as everything else here.
 *
 * The question it answers: the forest reaches F1 0.396 held out and a properly
 * selected single tree ties the hand-written rule at 0.315. Is that gap the price
 * of readability, or just the price of ONE greedy tree? Boosting is the test —
 * shallow trees, but composed, so it can express surfaces a single shallow tree
 * cannot while staying far closer to something transcribable than a forest.
 *
 * PROTOCOL, and it is the part that matters more than the model:
 *
 *   1. hyperparameters are chosen on an INNER validation split — a quarter of the
 *      fit half's GAMES, held back. Fit-half score rises monotonically with
 *      capacity, so selecting on it would just pick the biggest model and call
 *      overfitting a result. This is the mistake the single-tree run made, and
 *      correcting it turned that tree's apparent win into a tie.
 *   2. the operating point is swept on `random` rows only — never on star games,
 *      which are enriched and would inflate precision by the enrichment ratio.
 *   3. the test half is read ONCE, at the end.
 *
 *   node scripts/fit-boost.mjs
 */
import { loadRows, FEATURES, shippingRule, evaluate, line, pct } from "./lib/dataset.mjs";
import { fitBoost, featureUsage } from "./lib/boost.mjs";

/**
 * `--drop a,b` removes features. Not a convenience: with only eight accounts in
 * the dataset, `rating` is close to an account identifier, and the accounts have
 * different enrichment ratios — so a model leaning on it may be learning WHO
 * played rather than what a brilliancy is. `moveNumber` is a milder version of
 * the same worry. The check is whether the result survives without them.
 */
const DROP = new Set((process.argv.includes("--drop") ? process.argv[process.argv.indexOf("--drop") + 1] : "").split(",").filter(Boolean));
const USE = FEATURES.filter((f) => !DROP.has(f));

/**
 * `--by-account` splits by PLAYER instead of by game, and it is the test that
 * actually matters for shipping. The by-game split asks "does this generalise to
 * another game?"; every real user is a new ACCOUNT, so the question is whether it
 * generalises to another person. It is also the only way to settle whether the
 * model is leaning on `rating` as an account identifier — with eight accounts it
 * can be, and the accounts differ in enrichment.
 *
 * The held-out accounts are ones with a random sample, or precision would have no
 * numerator on the far side.
 */
const BY_ACCOUNT = process.argv.includes("--by-account");
const HOLD = process.argv.includes("--holdout") ? process.argv[process.argv.indexOf("--holdout") + 1].split(",") : ["bluecane", "louismcdade"];
const HELD_OUT_ACCOUNTS = new Set(HOLD);

const rows = loadRows();
const train = BY_ACCOUNT
  ? rows.filter((r) => !HELD_OUT_ACCOUNTS.has(r.user))
  : rows.filter((r) => r.half === "fit");
const test = BY_ACCOUNT
  ? rows.filter((r) => HELD_OUT_ACCOUNTS.has(r.user))
  : rows.filter((r) => r.half === "test");

const innerVal = (id) => {
  let h = 0x811c9dc5;
  for (const ch of `${id}v`) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % 4 === 0;
};
const inner = train.filter((r) => !innerVal(r.gameId));
const val = train.filter((r) => innerVal(r.gameId));

/** Fit, then pick the cut that maximises F1 on the unbiased rows of `data`. */
function fitAndCut(data, cfg, evalOn) {
  const model = fitBoost(data, { features: USE, ...cfg });
  const rnd = data.filter((r) => r.sample === "random");
  let best = null;
  for (let c = 0.02; c <= 0.98; c += 0.02) {
    const s = evaluate(rnd, (r) => model.score(r) >= c);
    if (s.F1 !== null && (!best || s.F1 > best.f1)) best = { cut: c, f1: s.F1 };
  }
  if (!best) return null;
  return { model, cut: best.cut, score: evaluate(evalOn, (r) => model.score(r) >= best.cut) };
}

const GRID = [];
for (const depth of [2, 3, 4]) for (const rounds of [60, 150, 300]) GRID.push({ depth, rounds, lr: 0.1, minLeaf: 10 });

console.log(`rows ${rows.length} (${rows.filter((r) => r.label === 1).length} positive)`);
console.log(`fit ${train.length} · inner ${inner.length} · inner-val ${val.length} · test ${test.length}\n`);
console.log("HYPERPARAMETERS — fitted on 3/4 of the fit half, scored on the held-back quarter\n");
console.log("depth  rounds    val P     val R    val F1");

let pick = null;
for (const cfg of GRID) {
  const r = fitAndCut(inner, cfg, val);
  if (!r) continue;
  console.log(
    `  ${cfg.depth}     ${String(cfg.rounds).padStart(4)}   ${pct(r.score.P).padStart(7)}  ${pct(r.score.R).padStart(7)}   ${r.score.F1 === null ? "n/a" : r.score.F1.toFixed(3)}`,
  );
  if (r.score.F1 !== null && (!pick || r.score.F1 > pick.f1)) pick = { cfg, f1: r.score.F1 };
}
console.log(`\nchosen: depth ${pick.cfg.depth}, ${pick.cfg.rounds} rounds (inner-validation F1 ${pick.f1.toFixed(3)})\n`);

const final = fitAndCut(train, pick.cfg, test);

console.log("FEATURES IT ACTUALLY USES (split counts across all trees)");
for (const [k, n] of featureUsage(final.model).slice(0, 10)) console.log(`  ${k.padEnd(16)} ${n}`);

console.log("\nTEST HALF — held out, read once");
console.log(line("  shipping rule", evaluate(test, shippingRule)));
console.log(line("  boosted", final.score));

console.log("\nHELD-OUT TRADE-OFF CURVE");
console.log("  cut     randTP  FP        P       R      F1");
for (const c of [0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]) {
  const s = evaluate(test, (r) => final.model.score(r) >= c);
  console.log(`  ${c.toFixed(2)}    ${String(s.tpRandom).padStart(5)} ${String(s.fp).padStart(4)}   ${pct(s.P).padStart(6)}  ${pct(s.R).padStart(6)}  ${s.F1 === null ? " n/a" : s.F1.toFixed(3)}`);
}
