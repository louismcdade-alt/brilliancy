/**
 * Leave-one-account-out — the evaluation that matches deployment.
 *
 * Every real user of the site is an account the detector has never seen, so the
 * split that predicts their experience holds out a whole PLAYER, not a random
 * half of games. The 5-account version of this table produced the day's central
 * finding: the same hand-written rule spans F1 0.18–0.56 across accounts, which
 * dwarfs every model difference measured on aggregate splits. This script exists
 * to redo that table at ~27 accounts, where the mean has a chance of meaning
 * something.
 *
 * One process, rows loaded once, folds looped in memory — the first version
 * shelled out per fold and re-ran a hyperparameter grid each time, which at 27
 * accounts was hours of overhead around minutes of work.
 *
 * Per fold:
 *   - hand rule and hybrid rule: evaluated directly (no fitting).
 *   - boosted: hyperparameters picked on an inner quarter of the TRAINING
 *     accounts' games, cut swept on training random rows, then the held-out
 *     account is read once. `rating` and `moveNumber` are excluded — with this
 *     many accounts they are close to player identifiers, and the 8-account run
 *     showed they pay only when the same player is on both sides of the split.
 *
 * Only accounts with a random sample are held out (precision needs an unbiased
 * denominator on the far side); accounts without one still always train.
 *
 *   node scripts/loo.mjs [--cache path] [--grid small|full]
 */
import { loadRows, FEATURES, shippingRule, evaluate, pct } from "./lib/dataset.mjs";
import { fitBoost } from "./lib/boost.mjs";

const argOf = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : d;
};
const CACHE = argOf("cache", "scripts/harvest-multi.json");
const GRID =
  argOf("grid", "full") === "small"
    ? [{ depth: 3, rounds: 150, lr: 0.1, minLeaf: 10 }]
    : [
        { depth: 2, rounds: 150, lr: 0.1, minLeaf: 10 },
        { depth: 3, rounds: 150, lr: 0.1, minLeaf: 10 },
        { depth: 3, rounds: 300, lr: 0.1, minLeaf: 10 },
      ];

const DROP = new Set(["rating", "moveNumber"]);
const USE = FEATURES.filter((f) => !DROP.has(f));

const hybridRule = (r) =>
  r.f.isOffer === 1 && r.f.isPromotion === 0 && r.f.playedEval >= -77.5 &&
  r.f.evalLoss <= 95.5 && r.f.hasQuietAlt === 1 && r.f.margin >= 50;

/**
 * `--offers-only` restricts to candidates the SHIPPING pre-filter admits.
 *
 * The harvest ran with `admitAllow: true` so the dataset could price that rule;
 * the app does not. Evaluating on rows the app will never see would report a
 * recall it cannot deliver, so the configuration being shipped has to be the
 * configuration being measured.
 */
const OFFERS_ONLY = process.argv.includes("--offers-only");
const rows = loadRows(CACHE).filter((r) => !OFFERS_ONLY || r.f.isOffer === 1);
const byUser = new Map();
for (const r of rows) {
  if (!byUser.has(r.user)) byUser.set(r.user, { rows: 0, pos: 0, random: 0 });
  const s = byUser.get(r.user);
  s.rows++;
  if (r.label === 1) s.pos++;
  if (r.sample === "random") s.random++;
}
const holdable = [...byUser.entries()].filter(([, s]) => s.random > 0 && s.pos > 0).map(([u]) => u).sort();

console.log(`${rows.length} rows · ${rows.filter((r) => r.label === 1).length} positive · ${byUser.size} accounts · ${holdable.length} holdable\n`);

const innerVal = (id) => {
  let h = 0x811c9dc5;
  for (const ch of `${id}v`) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % 4 === 0;
};

function fitPick(train) {
  const inner = train.filter((r) => !innerVal(r.gameId));
  const val = train.filter((r) => innerVal(r.gameId));
  let pick = null;
  for (const cfg of GRID) {
    const model = fitBoost(inner, { features: USE, ...cfg });
    const rnd = inner.filter((r) => r.sample === "random");
    let cut = null;
    for (let c = 0.02; c <= 0.98; c += 0.02) {
      const s = evaluate(rnd, (r) => model.score(r) >= c);
      if (s.F1 !== null && (!cut || s.F1 > cut.f1)) cut = { c, f1: s.F1 };
    }
    if (!cut) continue;
    const v = evaluate(val, (r) => model.score(r) >= cut.c);
    if (v.F1 !== null && (!pick || v.F1 > pick.f1)) pick = { cfg, f1: v.F1 };
  }
  const cfg = pick?.cfg ?? GRID[0];
  // Refit on all training rows with the chosen config; re-sweep the cut there.
  const model = fitBoost(train, { features: USE, ...cfg });
  const rnd = train.filter((r) => r.sample === "random");
  let cut = 0.5;
  let bestF1 = null;
  for (let c = 0.02; c <= 0.98; c += 0.02) {
    const s = evaluate(rnd, (r) => model.score(r) >= c);
    if (s.F1 !== null && (bestF1 === null || s.F1 > bestF1)) {
      bestF1 = s.F1;
      cut = c;
    }
  }
  return { model, cut, cfg };
}

/**
 * `--cuts a,b,c` also reports the boosted model at FIXED thresholds.
 *
 * The per-fold cut is swept to maximise F1 on training rows, which knows nothing
 * about the guard set — and at that cut the shipped model dropped Marshall's
 * 23...Qg3 and Lasker-Thomas 11.Qxh7+, two of the most famous brilliancies in
 * chess. Keeping those is a product constraint, not a metric, so the honest way
 * to price it is to measure the fixed cut that keeps them rather than to quote
 * numbers from a cut nobody will ship.
 */
const FIXED_CUTS = (argOf("cuts", "") || "").split(",").filter(Boolean).map(Number);

const f1s = { hand: [], hybrid: [], boost: [] };
const fixed = new Map(FIXED_CUTS.map((c) => [c, { tp: 0, fn: 0, tpRandom: 0, fp: 0, f1s: [] }]));
const pooled = {
  hand: { tp: 0, fn: 0, tpRandom: 0, fp: 0 },
  hybrid: { tp: 0, fn: 0, tpRandom: 0, fp: 0 },
  boost: { tp: 0, fn: 0, tpRandom: 0, fp: 0 },
};
const addTo = (acc, s) => {
  acc.tp += s.tp;
  acc.fn += s.fn;
  acc.tpRandom += s.tpRandom;
  acc.fp += s.fp;
};

console.log("account                pos  |   hand F1   hybrid F1  boost F1   (boost cfg)");
for (const user of holdable) {
  const train = rows.filter((r) => r.user !== user);
  const test = rows.filter((r) => r.user === user);
  const hand = evaluate(test, shippingRule);
  const hyb = evaluate(test, hybridRule);
  const { model, cut, cfg } = fitPick(train);
  const boost = evaluate(test, (r) => model.score(r) >= cut);
  f1s.hand.push(hand.F1 ?? 0);
  f1s.hybrid.push(hyb.F1 ?? 0);
  f1s.boost.push(boost.F1 ?? 0);
  addTo(pooled.hand, hand);
  addTo(pooled.hybrid, hyb);
  addTo(pooled.boost, boost);
  for (const c of FIXED_CUTS) {
    const s2 = evaluate(test, (r) => model.score(r) >= c);
    const acc = fixed.get(c);
    addTo(acc, s2);
    acc.f1s.push(s2.F1 ?? 0);
  }
  const f = (x) => (x.F1 === null ? "  n/a" : x.F1.toFixed(3));
  console.log(
    `${user.padEnd(22)} ${String(byUser.get(user).pos).padStart(3)}  |    ${f(hand)}      ${f(hyb)}     ${f(boost)}    (d${cfg.depth}/${cfg.rounds})`,
  );
}

const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const P = (s) => (s.tpRandom + s.fp ? s.tpRandom / (s.tpRandom + s.fp) : null);
const R = (s) => (s.tp + s.fn ? s.tp / (s.tp + s.fn) : null);
console.log(`\nmean F1 across accounts:   hand ${mean(f1s.hand).toFixed(3)}   hybrid ${mean(f1s.hybrid).toFixed(3)}   boost ${mean(f1s.boost).toFixed(3)}`);
console.log("\nPOOLED across held-out accounts (every row scored by a model that never saw its player):");
for (const [name, s] of Object.entries(pooled)) {
  console.log(`  ${name.padEnd(8)} TP ${String(s.tp).padStart(3)}  FN ${String(s.fn).padStart(3)}  randTP ${String(s.tpRandom).padStart(3)}  FP ${String(s.fp).padStart(3)}   P ${pct(P(s)).padStart(6)}  R ${pct(R(s)).padStart(6)}`);
}
for (const [c, s] of fixed) {
  console.log(`  cut ${c.toFixed(2)}  TP ${String(s.tp).padStart(3)}  FN ${String(s.fn).padStart(3)}  randTP ${String(s.tpRandom).padStart(3)}  FP ${String(s.fp).padStart(3)}   P ${pct(P(s)).padStart(6)}  R ${pct(R(s)).padStart(6)}   meanF1 ${mean(s.f1s).toFixed(3)}`);
}
