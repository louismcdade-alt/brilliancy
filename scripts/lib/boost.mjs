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

function thresholds(rows, key) {
  const vals = [...new Set(rows.map((r) => r.f[key]))].sort((a, b) => a - b);
  if (vals.length < 2) return [];
  if (vals.length <= 12) return vals.slice(0, -1).map((v, i) => (v + vals[i + 1]) / 2);
  const out = [];
  for (let q = 1; q < 20; q++) {
    const i = Math.floor((q / 20) * vals.length);
    const a = vals[i];
    const b = vals[Math.min(vals.length - 1, i + 1)];
    if (a !== b) out.push((a + b) / 2);
  }
  return [...new Set(out)];
}

function buildStump(rows, features, maxDepth, minLeaf, lambda, gamma) {
  const G = (rs) => rs.reduce((a, r) => a + r._g, 0);
  const H = (rs) => rs.reduce((a, r) => a + r._h, 0);
  const leafWeight = (rs) => -G(rs) / (H(rs) + lambda);
  const objective = (rs) => (G(rs) * G(rs)) / (H(rs) + lambda);

  function build(rs, depth) {
    if (depth >= maxDepth || rs.length < 2 * minLeaf) return { leaf: true, w: leafWeight(rs) };
    const parent = objective(rs);
    let best = null;
    for (const key of features) {
      for (const t of thresholds(rs, key)) {
        const L = rs.filter((r) => r.f[key] <= t);
        const R = rs.filter((r) => r.f[key] > t);
        if (L.length < minLeaf || R.length < minLeaf) continue;
        const gain = 0.5 * (objective(L) + objective(R) - parent) - gamma;
        if (gain > 0 && (!best || gain > best.gain)) best = { key, t, gain, L, R };
      }
    }
    if (!best) return { leaf: true, w: leafWeight(rs) };
    return { leaf: false, key: best.key, t: best.t, left: build(best.L, depth + 1), right: build(best.R, depth + 1) };
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
