/**
 * Greedy CART, shared by fit-tree.mjs and fit-forest.mjs.
 *
 * Class-weighted Gini, because positives are ~10% of candidates and an
 * unweighted tree scores best by calling everything negative.
 *
 * `featuresPerSplit` exists for the forest: sampling a subset of features at each
 * node is what decorrelates the trees. Left null, every feature is considered and
 * the result is an ordinary single tree.
 */

export function classWeights(data) {
  const pos = data.filter((r) => r.label === 1).length;
  const neg = data.length - pos;
  return { 1: pos ? data.length / (2 * pos) : 0, 0: neg ? data.length / (2 * neg) : 0 };
}

function thresholds(data, key) {
  const vals = [...new Set(data.map((r) => r.f[key]))].sort((a, b) => a - b);
  if (vals.length < 2) return [];
  if (vals.length <= 12) return vals.slice(0, -1).map((v, i) => (v + vals[i + 1]) / 2);
  const out = [];
  for (let q = 1; q < 24; q++) {
    const i = Math.floor((q / 24) * vals.length);
    const v = vals[i];
    const nxt = vals[Math.min(vals.length - 1, i + 1)];
    if (v !== nxt) out.push((v + nxt) / 2);
  }
  return [...new Set(out)];
}

export function buildTree(data, opts) {
  const { features, W, maxDepth = 5, minLeaf = 10, featuresPerSplit = null, rand = Math.random } = opts;
  const wsum = (d) => d.reduce((a, r) => a + W[r.label], 0);
  const wpos = (d) => d.reduce((a, r) => a + (r.label === 1 ? W[1] : 0), 0);
  const gini = (d) => {
    const t = wsum(d);
    if (!t) return 0;
    const p = wpos(d) / t;
    return 2 * p * (1 - p);
  };

  const pick = () => {
    if (!featuresPerSplit) return features;
    const pool = [...features];
    const out = [];
    while (out.length < featuresPerSplit && pool.length) out.push(...pool.splice(Math.floor(rand() * pool.length), 1));
    return out;
  };

  function bestSplit(d) {
    const base = gini(d);
    const total = wsum(d);
    let best = null;
    for (const key of pick()) {
      for (const t of thresholds(d, key)) {
        const L = d.filter((r) => r.f[key] <= t);
        const R = d.filter((r) => r.f[key] > t);
        if (L.length < minLeaf || R.length < minLeaf) continue;
        const gain = base - ((wsum(L) / total) * gini(L) + (wsum(R) / total) * gini(R));
        if (!best || gain > best.gain) best = { key, t, gain, L, R };
      }
    }
    return best && best.gain > 1e-9 ? best : null;
  }

  function build(d, depth) {
    const t = wsum(d);
    const p = t ? wpos(d) / t : 0;
    const leaf = { leaf: true, p, n: d.length, pos: d.filter((r) => r.label === 1).length };
    if (depth >= maxDepth || d.length < 2 * minLeaf || p === 0 || p === 1) return leaf;
    const s = bestSplit(d);
    if (!s) return leaf;
    return { leaf: false, key: s.key, t: s.t, left: build(s.L, depth + 1), right: build(s.R, depth + 1) };
  }

  return build(data, 0);
}

export const leafOf = (node, r) => (node.leaf ? node : leafOf(r.f[node.key] <= node.t ? node.left : node.right, r));

/** Raw purity, not the class-weighted one — see the note in fit-tree.mjs. */
export const purity = (tree, r) => {
  const l = leafOf(tree, r);
  return l.n ? l.pos / l.n : 0;
};

export function printTree(node, indent = "", label = "") {
  if (node.leaf) {
    console.log(`${indent}${label}→ ${node.pos}/${node.n} positive`);
    return;
  }
  const t = Math.abs(node.t) > 999 ? node.t.toExponential(1) : node.t.toFixed(1);
  console.log(`${indent}${label}${node.key} <= ${t} ?`);
  printTree(node.left, indent + "    ", "yes ");
  printTree(node.right, indent + "    ", "no  ");
}
