import modelJson from "./model.json";
import type { Candidate } from "./brilliancy";

/**
 * The learned brilliancy scorer — gradient-boosted trees, ~150 shallow stumps
 * evaluated as plain arithmetic. No library, no network, no measurable cost next
 * to the engine search that produced its inputs.
 *
 * WHY THIS REPLACED HAND-WRITTEN GATES. Measured leave-one-account-out over 27
 * chess.com accounts and 775 labelled brilliancies — every account scored by a
 * model that never saw that player, which is the situation every real visitor is
 * in. Pooled: the hand-written rule got precision 33.3% / recall 35.2%; this gets
 * 37.5% / 56.5%, winning 17 of 22 comparable accounts. Better on BOTH axes, so
 * there is no trade being made and no operating point being talked up.
 *
 * WHAT IT DOES NOT CHANGE. The sacrifice pre-filter still runs first (a move
 * must offer material), the shape rule still rejects promotions, and the reasons
 * shown to a user still come from measured facts about the position — not from
 * this model. A boosted score cannot be read; the explanation was never coming
 * from the rule, so nothing explanatory is lost by replacing it.
 *
 * THE ONE THING THAT WOULD SILENTLY BREAK IT is a feature vector that differs
 * from the one it was trained on. `featureVector` below is the single definition
 * of that mapping, and `model.json` carries the feature names it expects; a
 * mismatch throws at startup rather than quietly scoring nonsense.
 */

type Node = { leaf: true; w: number } | { leaf: false; key: string; t: number; left: Node; right: Node };

const model = modelJson as unknown as {
  version: number;
  features: string[];
  lr: number;
  cut: number;
  trees: Node[];
};

/**
 * Candidate → the exact numbers the model was trained on.
 *
 * Encodings that look arbitrary are not: `margin` uses a large negative sentinel
 * when MultiPV found no quiet alternative, because "there was nothing quiet to
 * compare against" is a real state rather than a missing value, and a threshold
 * can isolate it. `accepted` is -1 when undefined for the same reason.
 */
export function featureVector(c: Candidate): Record<string, number> {
  return {
    sacrifice: c.sacrifice,
    playedEval: c.playedEval,
    evalLoss: c.evalLoss,
    margin: isFinite(c.quietAlt) ? c.playedEval - c.quietAlt : -100000,
    hasQuietAlt: isFinite(c.quietAlt) ? 1 : 0,
    fresh: c.fresh,
    standing: c.standing,
    accepted: c.accepted === null ? -1 : c.accepted ? 1 : 0,
    isDirect: c.shape === "direct" ? 1 : 0,
    isPromotion: c.shape === "promotion" ? 1 : 0,
    isOffer: c.admitted === "offer" ? 1 : 0,
    regain2: c.regain2,
    regain4: c.regain4,
    regain6: c.regain6,
    regainPlies: c.regainPlies,
    kingRing: c.kingRing,
    kingRingDelta: c.kingRingDelta,
    kingMoves: c.kingMoves,
    // DERIVED, not stored — and it must match scripts/lib/dataset.mjs exactly,
    // because that is the definition the model was trained against. engine.ts
    // encodes a forced mate as MATE_CP (100000) minus 10 per ply; 0 means no
    // forced mate and sorts below every real one, so a shorter mate scores
    // higher. Change one of these two and the model silently reads a different
    // feature than it learned.
    mateIn:
      Math.abs(c.playedEval) > 90000
        ? Math.max(0, 1000 - Math.round((100000 - Math.abs(c.playedEval)) / 10)) * Math.sign(c.playedEval)
        : 0,
  };
}

// Fail loudly at module load if the artefact expects a feature this build does
// not produce. Scoring a missing feature as `undefined` would compare NaN and
// silently send every candidate down one branch of every tree.
const provided = new Set(Object.keys(featureVector({} as Candidate)));
const missing = model.features.filter((f) => !provided.has(f));
if (missing.length) {
  throw new Error(`model.json expects features this build does not compute: ${missing.join(", ")}`);
}

const walk = (n: Node, f: Record<string, number>): number =>
  n.leaf ? n.w : walk(f[n.key] <= n.t ? n.left : n.right, f);

/** Probability-like score in (0,1). Higher means more like a chess.com !!. */
export function brilliancyScore(c: Candidate): number {
  const f = featureVector(c);
  let sum = 0;
  for (const t of model.trees) sum += model.lr * walk(t, f);
  return 1 / (1 + Math.exp(-sum));
}

/** The decision threshold chosen on unbiased rows at training time. */
export const SCORE_CUT = model.cut;
