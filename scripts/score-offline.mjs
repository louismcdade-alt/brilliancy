/**
 * Score rule variants against the labels — from the harvest cache, no engine.
 *
 * test-harness.mjs is the instrument of record, but a full pass is now 294 games
 * of real search. The harvest already ran every candidate through the engine and
 * wrote down the raw numbers the rules consume — `playedEval`, `evalLoss`,
 * `quietAlt`, `sacrifice`, `fresh`, `standing`, `shape`, `accepted` — so any rule
 * built out of those can be re-scored here instantly. That covers both axes:
 *
 *   ADMISSION  which moves are eligible at all (the sacrifice pre-filter).
 *   GATES      sound / strong / necessary, recomputed from the raw evals rather
 *              than read off `rejectedBy`. `rejectedBy` is baked at scan time and
 *              means whatever the gates meant then, so using it to evaluate a new
 *              gate would compare a rule against itself — the numbers below are
 *              recomputed from scratch for exactly that reason.
 *
 * What this cannot do: score anything needing a search that wasn't run — a deeper
 * depth, a wider MULTI_PV, or a feature nobody has extracted yet. Those cost a
 * re-harvest.
 *
 *   node scripts/score-offline.mjs
 */
import { readFileSync } from "node:fs";
import { chesscomLabels } from "./labels-louismcdade.mjs";

const USER = process.argv[2] ?? "louismcdade";
const cache = JSON.parse(readFileSync(`scripts/harvest-${USER}.json`, "utf8"));
const labelled = new Map(chesscomLabels.map((g) => [g.id, g]));

// Mirrors src/engine/brilliancy.ts. Kept as literals rather than imported: this
// script exists to try values OTHER than the shipping ones.
const STILL_GOOD = 20;
const MAX_EVAL_LOSS = 120;
const NECESSARY_MARGIN = 50;
const REJECT_SHAPES = ["promotion"];

const margin = (c) => (c.quietAlt === null ? null : c.playedEval - c.quietAlt);

/** Which moves are eligible. Refuted 2026-07-29 — kept so it stays refuted. */
const ADMISSION = {
  base: (c) => c.admitted === "offer",
  "+allow": (c) => c.admitted === "offer" || c.fresh >= 2 || c.standing >= 2,
};

/**
 * Gate variants. `live` must reproduce the shipping detector exactly; the rest
 * exist to price the `necessary` gate, which is where the recall is going.
 */
const GATES = {
  live: (c) => {
    const m = margin(c);
    return c.playedEval >= STILL_GOOD && c.evalLoss <= MAX_EVAL_LOSS && m !== null && m >= NECESSARY_MARGIN;
  },
  "necessary≥0": (c) => {
    const m = margin(c);
    return c.playedEval >= STILL_GOOD && c.evalLoss <= MAX_EVAL_LOSS && m !== null && m >= 0;
  },
  "necessary≥−50": (c) => {
    const m = margin(c);
    return c.playedEval >= STILL_GOOD && c.evalLoss <= MAX_EVAL_LOSS && m !== null && m >= -50;
  },
  "necessary≥−200": (c) => {
    const m = margin(c);
    return c.playedEval >= STILL_GOOD && c.evalLoss <= MAX_EVAL_LOSS && m !== null && m >= -200;
  },
  "no necessary": (c) => c.playedEval >= STILL_GOOD && c.evalLoss <= MAX_EVAL_LOSS,
  "no necessary, loss≤200": (c) => c.playedEval >= STILL_GOOD && c.evalLoss <= 200,
  "sound only": (c) => c.playedEval >= STILL_GOOD,
};

const flags = (adm, gate, c) => ADMISSION[adm](c) && GATES[gate](c) && !REJECT_SHAPES.includes(c.shape);

const zero = () => ({ tp: 0, fp: 0, fn: 0 });
const pct = (x) => (x === null ? "  n/a" : `${(100 * x).toFixed(1)}%`.padStart(6));
const P = (s) => (s.tp + s.fp === 0 ? null : s.tp / (s.tp + s.fp));
const R = (s) => (s.tp + s.fn === 0 ? null : s.tp / (s.tp + s.fn));

function run(adm, gate) {
  const s = { fit: zero(), test: zero(), guard: zero() };
  const missed = [];
  for (const g of cache.games) {
    const lab = labelled.get(g.id);
    if (!lab) continue;
    const stars = new Set((lab.expected ?? []).map((m) => `${m.moveNumber} ${m.san}`));
    const hit = new Set();
    for (const c of g.candidates) {
      const k = `${c.moveNumber} ${c.san}`;
      if (!flags(adm, gate, c)) continue;
      hit.add(k);
      stars.has(k) ? s[lab.half].tp++ : s[lab.half].fp++;
    }
    for (const k of stars) {
      if (!hit.has(k)) {
        s[lab.half].fn++;
        missed.push(`${lab.half}:${g.id} ${k}`);
      }
    }
  }
  return { s, missed };
}

const fitGuard = (s) => ({
  tp: s.fit.tp + s.guard.tp,
  fp: s.fit.fp + s.guard.fp,
  fn: s.fit.fn + s.guard.fn,
});

console.log(`cache ${cache.scannedAt} · depth ${cache.depth} · ${cache.games.length} games\n`);
console.log("FIT + GUARD — look at this freely; it is where a rule gets chosen.");
console.log("rule                              TP  FP  FN        P       R");
for (const adm of Object.keys(ADMISSION)) {
  for (const gate of Object.keys(GATES)) {
    const { s } = run(adm, gate);
    const f = fitGuard(s);
    console.log(
      `${(adm + " / " + gate).padEnd(32)} ${String(f.tp).padStart(2)} ${String(f.fp).padStart(3)} ${String(f.fn).padStart(3)}   ${pct(P(f))}  ${pct(R(f))}`,
    );
  }
}

console.log("\nHELD-OUT (test half) — a measurement, not a menu.");
console.log("rule                              TP  FP  FN        P       R");
for (const adm of Object.keys(ADMISSION)) {
  for (const gate of Object.keys(GATES)) {
    const { s } = run(adm, gate);
    console.log(
      `${(adm + " / " + gate).padEnd(32)} ${String(s.test.tp).padStart(2)} ${String(s.test.fp).padStart(3)} ${String(s.test.fn).padStart(3)}   ${pct(P(s.test))}  ${pct(R(s.test))}`,
    );
  }
}

// Which positives each variant still misses, so recall is a list of moves rather
// than a percentage — a rule that gains recall by flagging everything is obvious
// here and invisible in the summary.
console.log("\nPositives still missed, per gate (admission = base):");
for (const gate of Object.keys(GATES)) {
  const { missed } = run("base", gate);
  console.log(`  ${gate.padEnd(24)} ${missed.length ? missed.join("  ") : "none"}`);
}
