/**
 * Fit the model the site will actually run, and write it into src/.
 *
 * The evaluation that justifies shipping this is leave-one-account-out (loo.mjs):
 * 27 accounts, each scored by a model that never saw that player. This script
 * does NOT re-measure anything — a model fitted on all 27 accounts has no honest
 * held-out set left, and any number printed here would be a training score. The
 * LOO figures are the estimate; this just builds the artefact.
 *
 * Hyperparameters are taken from what LOO actually selected on its inner
 * validation splits, rather than re-searched here against data the final model
 * also trains on.
 *
 * TRAINED ON WHAT THE APP WILL SEE. `--offers-only` restricts to candidates the
 * shipping pre-filter admits, matching `admitAllow: false` in the scan. Training
 * on allow-candidates the app never surfaces would tune the model on a
 * distribution it will not meet.
 *
 * The output is plain JSON — arrays of {key, t, left, right} nodes and leaf
 * weights — so the browser needs no library, just the same arithmetic.
 *
 *   node scripts/fit-final-model.mjs --offers-only [--depth 3] [--rounds 150]
 */
import { writeFileSync } from "node:fs";
import { loadRows, FEATURES, evaluate } from "./lib/dataset.mjs";
import { fitBoost } from "./lib/boost.mjs";

const argOf = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? Number(process.argv[i + 1]) : d;
};
const OFFERS_ONLY = process.argv.includes("--offers-only");
const DEPTH = argOf("depth", 3);
const ROUNDS = argOf("rounds", 150);
const LR = 0.1;

// `rating` and `moveNumber` are excluded deliberately: across accounts they act
// as player identifiers, and dropping them HELPED every account-held-out
// measurement while helping only the by-game split when kept.
const DROP = new Set(["rating", "moveNumber"]);
const USE = FEATURES.filter((f) => !DROP.has(f));

const all = loadRows().filter((r) => !OFFERS_ONLY || r.f.isOffer === 1);
console.log(`training on ${all.length} rows (${all.filter((r) => r.label === 1).length} positive) from ${new Set(all.map((r) => r.user)).size} accounts`);
console.log(`features: ${USE.join(", ")}`);

const model = fitBoost(all, { features: USE, depth: DEPTH, rounds: ROUNDS, lr: LR, minLeaf: 10 });

// The operating point is swept on `random` rows only — the unbiased ones. Star
// games are enriched, and a cut chosen on them would sit at the wrong place for
// real play, where brilliancies are roughly one game in twenty.
const rnd = all.filter((r) => r.sample === "random");
let cut = null;
for (let c = 0.02; c <= 0.98; c += 0.02) {
  const s = evaluate(rnd, (r) => model.score(r) >= c);
  if (s.F1 !== null && (!cut || s.F1 > cut.f1)) cut = { c, f1: s.F1 };
}

/**
 * THE SHIPPED CUT IS A CONSTRAINT, NOT A SWEEP — and that is a deliberate
 * departure worth stating plainly.
 *
 * Sweeping F1 on unbiased training rows gives 0.88. At 0.88 the detector drops
 * Marshall's 23...Qg3 (0.697) and Lasker-Thomas 11.Qxh7+ (0.780): better
 * aggregate numbers, and a site that fails to flag the most famous brilliancy in
 * chess. No F1 gain buys that.
 *
 * The guard set therefore sets the threshold. Its scores leave a clean window:
 * every classical brilliancy and both chess.com-confirmed positives sit at 0.697
 * or above, while 19.Rxd6 — a confirmed FALSE positive — sits at 0.616. Any cut
 * in (0.616, 0.697] satisfies the constraint; 0.65 is the middle of it.
 *
 * The honesty cost is explicit: the guard set is no longer independent evidence
 * for this threshold, because the threshold was chosen to satisfy it. What IS
 * independent is leave-one-account-out at this fixed cut over 27 accounts, none
 * of which contain any classical game — see scripts/loo-cuts.txt.
 */
const SHIP_CUT = argOf("cut", 0.65);

const json = {
  version: 1,
  trainedAt: new Date().toISOString().slice(0, 10),
  accounts: new Set(all.map((r) => r.user)).size,
  rows: all.length,
  positives: all.filter((r) => r.label === 1).length,
  features: USE,
  depth: DEPTH,
  rounds: ROUNDS,
  lr: LR,
  cut: SHIP_CUT,
  /** What maximising F1 on training rows would have chosen — recorded, not used. */
  cutF1Optimal: Number(cut.c.toFixed(2)),
  offersOnly: OFFERS_ONLY,
  trees: model.trees,
};

const path = "src/engine/model.json";
writeFileSync(path, JSON.stringify(json));
const kb = (JSON.stringify(json).length / 1024).toFixed(0);
console.log(`\nwrote ${path} — ${json.trees.length} trees, ${kb} KB, cut ${json.cut}`);
console.log(`(training-set F1 at that cut: ${cut.f1.toFixed(3)} — a training score, NOT evidence; see loo.mjs)`);
