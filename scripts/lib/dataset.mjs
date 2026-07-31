/**
 * The labelled candidate rows, shared by every model script.
 *
 * Extracted so the tree and the forest cannot drift apart in how they read the
 * data. Two rules live here and matter more than any modelling choice:
 *
 *   - an unlisted move in a game whose brilliancy list is INCOMPLETE is unknown,
 *     not negative, and is dropped rather than labelled 0;
 *   - `sample` is carried on every row, because precision may only be computed
 *     on the unbiased `random` rows.
 */
import { readFileSync } from "node:fs";

/** Same id hash as score-multi.mjs — the split must agree across all scripts. */
export const half = (id) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % 2 === 0 ? "fit" : "test";
};

export function loadRows(path = "scripts/harvest-multi.json") {
  const cache = JSON.parse(readFileSync(path, "utf8"));
  const rows = [];
  for (const g of Object.values(cache.games)) {
    const stars = new Set(g.expected.map((m) => `${m.moveNumber} ${m.san}`));
    for (const c of g.candidates) {
      const k = `${c.moveNumber} ${c.san}`;
      const label = stars.has(k) ? 1 : 0;
      if (!label && g.trustNegatives === false) continue;
      rows.push({
        label,
        half: half(g.id),
        sample: g.sample,
        gameId: g.id,
        user: g.user,
        move: `${c.moveNumber}${g.userColor === "w" ? "." : "…"}${c.san}`,
        f: {
          sacrifice: c.sacrifice,
          playedEval: c.playedEval,
          evalLoss: c.evalLoss,
          // No quiet alternative is a real state, not a missing value. Encoded as
          // a large negative margin so a model can isolate it with a threshold
          // rather than us inventing an imputation rule.
          margin: c.quietAlt === null ? -100000 : c.playedEval - c.quietAlt,
          hasQuietAlt: c.quietAlt === null ? 0 : 1,
          fresh: c.fresh ?? 0,
          standing: c.standing ?? 0,
          accepted: c.accepted === null ? -1 : c.accepted ? 1 : 0,
          isDirect: c.shape === "direct" ? 1 : 0,
          isPromotion: c.shape === "promotion" ? 1 : 0,
          isOffer: c.admitted === "offer" ? 1 : 0,
          kingRing: c.kingRing ?? 0,
          kingRingDelta: c.kingRingDelta ?? 0,
          kingMoves: c.kingMoves ?? 0,
          // Mate distance, derived from the eval we already cache: engine.ts
          // encodes a forced mate as MATE_CP (100000) minus 10 per ply, so this
          // needs no re-scan. 0 means "no forced mate", which sorts below every
          // real mate — the shorter the mate, the larger the number.
          mateIn: Math.abs(c.playedEval) > 90000 ? Math.max(0, 1000 - Math.round((100000 - Math.abs(c.playedEval)) / 10)) * Math.sign(c.playedEval) : 0,
          // null when the harvest predates the feature; 0 reads as "a shallow
          // search already saw it", which is the honest default for unknown.
          surprise: c.surprise ?? 0,
          regainPlies: c.regainPlies ?? 0,
          regain2: c.regain2 ?? 0,
          regain4: c.regain4 ?? 0,
          regain6: c.regain6 ?? 0,
          moveNumber: c.moveNumber,
          rating: g.rating ?? 0,
        },
      });
    }
  }
  return rows;
}

export const FEATURES = [
  "sacrifice", "playedEval", "evalLoss", "margin", "hasQuietAlt", "fresh",
  "standing", "accepted", "isDirect", "isPromotion", "isOffer",
  "surprise", "regain2", "regain4", "regain6", "regainPlies", "kingRing", "kingRingDelta", "kingMoves",
  "mateIn", "moveNumber", "rating",
];

/** The shipping detector, expressed over the same rows — the thing to beat. */
export const shippingRule = (r) =>
  r.f.isOffer === 1 && r.f.isPromotion === 0 && r.f.playedEval >= 20 &&
  r.f.evalLoss <= 120 && r.f.hasQuietAlt === 1 && r.f.margin >= 50;

/**
 * Recall from every row; precision from `random` rows only, BOTH terms. Mixing
 * an enriched numerator with an unenriched denominator inflates precision by the
 * enrichment ratio — it reported 97.9% once, where the truth was near 20%.
 */
export function evaluate(data, predict) {
  let tp = 0, fn = 0, tpRandom = 0, fp = 0;
  for (const r of data) {
    const yes = predict(r);
    if (r.label === 1) {
      if (yes) { tp++; if (r.sample === "random") tpRandom++; } else fn++;
    } else if (yes && r.sample === "random") fp++;
  }
  const P = tpRandom + fp ? tpRandom / (tpRandom + fp) : null;
  const R = tp + fn ? tp / (tp + fn) : null;
  return { tp, fn, tpRandom, fp, P, R, F1: P && R ? (2 * P * R) / (P + R) : null };
}

export const pct = (x) => (x === null ? "n/a" : `${(100 * x).toFixed(1)}%`);
export const line = (name, s) =>
  `${name.padEnd(20)} TP ${String(s.tp).padStart(3)}  FN ${String(s.fn).padStart(3)}  | randTP ${String(s.tpRandom).padStart(3)}  FP ${String(s.fp).padStart(3)}   P ${pct(s.P).padStart(6)}  R ${pct(s.R).padStart(6)}  F1 ${s.F1 === null ? " n/a" : s.F1.toFixed(3)}`;
