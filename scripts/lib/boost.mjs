/**
 * Gradient-boosted trees, dependency-free — the XGBoost formulation.
 *
 * Why this and not another forest: the forest reaches F1 0.396 held out where a
 * single readable tree ties the hand-written rule at 0.315. That gap says the
 * signal is in the features and a greedy axis-aligned tree cannot reach it in one
 * pass. Boosting attacks exactly that failure — each tree fits what the previous
 * ones got wrong, so shallow stumps compose into a decision surface no single
 * shallow tree can express, and unlike a forest a short boosted sequence can be
 * read (and, if it earns it, transcribed).
 *
 * Logistic loss. For a row with label y and current score F:
 *
 *   p = sigmoid(F)        g = p − y        h = p(1 − p)
 *
 * A leaf's optimal weight is −G/(H + λ) and a split's gain is the usual
 *
 *   ½[ G_L²/(H_L+λ) + G_R²/(H_R+λ) − G²/(H+λ) ] − γ
 *
 * CLASS IMBALANCE is handled by weighting positives, not by resampling: at a 10%
 * base rate an unweighted fit drives every prediction towards "no". The weight
 * multiplies both g and h, which is the same thing scale_pos_weight does.
 */

const sigmoid = (x) => 1 / (1 + Math.exp(-x));

/**
 * Split finding by prefix sums over sorted order — the standard exact algorithm.
 *
 * The first version generated ~20 candidate thresholds per feature and filtered
 * the rows for each: O(features × thresholds × n) per node. Fine for one fit,
 * ruinous for leave-one-account-out at 27 accounts × a hyperparameter grid ×
 * hundreds of boosting rounds — north of five hours of pure JS. Sorting once per
 * (node, feature) and sweeping cumulative G/H makes every distinct value a
 * candidate threshold in O(n log n), which is both ~20× faster AND slightly
 * better, since no threshold is skipped by quantisation.
 */
function buildStump(rows, features, maxDepth, minLeaf, lambda, gamma) {
  function build(rs, depth) {
    let Gt = 0;
    let Ht = 0;
    for (const r of rs) {
      Gt += r._g;
      Ht += r._h;
    }
    const leaf = () => ({ leaf: true, w: -Gt / (Ht + lambda) });
    if (depth >= maxDepth || rs.length < 2 * minLeaf) return leaf();

    const parent = (Gt * Gt) / (Ht + lambda);
    let best = null;
    for (const key of features) {
      const sorted = rs.slice().sort((a, b) => a.f[key] - b.f[key]);
      let GL = 0;
      let HL = 0;
      for (let i = 0; i < sorted.length - 1; i++) {
        GL += sorted[i]._g;
        HL += sorted[i]._h;
        if (sorted[i].f[key] === sorted[i + 1].f[key]) continue;
        const nL = i + 1;
        if (nL < minLeaf || sorted.length - nL < minLeaf) continue;
        const GR = Gt - GL;
        const HR = Ht - HL;
        const gain = 0.5 * ((GL * GL) / (HL + lambda) + (GR * GR) / (HR + lambda) - parent) - gamma;
        if (gain > 0 && (!best || gain > best.gain)) {
          best = { key, t: (sorted[i].f[key] + sorted[i + 1].f[key]) / 2, gain };
        }
      }
    }
    if (!best) return leaf();
    const L = [];
    const R = [];
    for (const r of rs) (r.f[best.key] <= best.t ? L : R).push(r);
    return { leaf: false, key: best.key, t: best.t, left: build(L, depth + 1), right: build(R, depth + 1) };
  }
  return build(rows, 0);
}

const applyTree = (node, r) => (node.leaf ? node.w : applyTree(r.f[node.key] <= node.t ? node.left : node.right, r));

export function fitBoost(rows, opts = {}) {
  const {
    features,
    rounds = 200,
    depth = 3,
    lr = 0.1,
    minLeaf = 10,
    lambda = 1,
    gamma = 0,
  } = opts;

  const pos = rows.filter((r) => r.label === 1).length;
  const posWeight = pos ? (rows.length - pos) / pos : 1;

  const F = new Map(rows.map((r) => [r, 0]));
  const trees = [];

  for (let i = 0; i < rounds; i++) {
    for (const r of rows) {
      const p = sigmoid(F.get(r));
      const w = r.label === 1 ? posWeight : 1;
      r._g = w * (p - r.label);
      r._h = w * p * (1 - p);
    }
    const tree = buildStump(rows, features, depth, minLeaf, lambda, gamma);
    trees.push(tree);
    for (const r of rows) F.set(r, F.get(r) + lr * applyTree(tree, r));
  }
  for (const r of rows) {
    delete r._g;
    delete r._h;
  }

  return {
    trees,
    /** Probability-like score in (0,1); used for ranking, not as a decision. */
    score: (r) => sigmoid(trees.reduce((a, t) => a + lr * applyTree(t, r), 0)),
  };
}

/** How often each feature is split on — the closest a boosted model gets to being readable. */
export function featureUsage(model) {
  const counts = {};
  const walk = (n) => {
    if (n.leaf) return;
    counts[n.key] = (counts[n.key] ?? 0) + 1;
    walk(n.left);
    walk(n.right);
  };
  for (const t of model.trees) walk(t);
  return Object.entries(counts).sort((a, b) => b[1] - a[1]);
}
