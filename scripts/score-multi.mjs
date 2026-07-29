/**
 * Score the detector against the multi-account dataset.
 *
 * THE ONE THING THIS FILE EXISTS TO GET RIGHT: precision and recall come from
 * DIFFERENT ROWS, because the dataset is case-control sampled.
 *
 *   recall     from every labelled positive, star games included. Enrichment
 *              cannot bias it — a starred move is starred however it was found.
 *   precision  from `sample: "random"` rows ONLY. Star games are chosen precisely
 *              because they contain a brilliancy, so they are packed with
 *              near-misses that would never appear at that rate in real play.
 *              Pooling them inflates precision by construction.
 *
 * Rows from an account whose list is incomplete carry only their positives — the
 * harvester drops the rest rather than call an unlisted move a negative. Those
 * accounts therefore contribute to recall and not to precision, which is exactly
 * what their evidence supports.
 *
 *   node scripts/score-multi.mjs
 *   node scripts/score-multi.mjs --by-rating
 */
import { readFileSync } from "node:fs";

const cache = JSON.parse(readFileSync("scripts/harvest-multi.json", "utf8"));
const BY_RATING = process.argv.includes("--by-rating");

const STILL_GOOD = 20;
const MAX_EVAL_LOSS = 120;
const NECESSARY_MARGIN = 50;
const REJECT_SHAPES = ["promotion"];

const margin = (c) => (c.quietAlt === null ? null : c.playedEval - c.quietAlt);

const ADMISSION = {
  base: (c) => c.admitted === "offer",
  "+allow": (c) => c.admitted === "offer" || c.fresh >= 2 || c.standing >= 2,
};
const GATES = {
  live: (c) => {
    const m = margin(c);
    return c.playedEval >= STILL_GOOD && c.evalLoss <= MAX_EVAL_LOSS && m !== null && m >= NECESSARY_MARGIN;
  },
  "necessary≥0": (c) => {
    const m = margin(c);
    return c.playedEval >= STILL_GOOD && c.evalLoss <= MAX_EVAL_LOSS && m !== null && m >= 0;
  },
  "necessary≥−200": (c) => {
    const m = margin(c);
    return c.playedEval >= STILL_GOOD && c.evalLoss <= MAX_EVAL_LOSS && m !== null && m >= -200;
  },
  "no necessary": (c) => c.playedEval >= STILL_GOOD && c.evalLoss <= MAX_EVAL_LOSS,

  /**
   * PRE-REGISTERED 2026-07-29, written before the held-out half was read.
   *
   * The decision tree and the hand-written rule are wrong in opposite
   * directions. The tree, free to use `margin`, never splits on it at any depth
   * — yet margin is where our precision comes from. Meanwhile the tree puts the
   * soundness and strength cuts at −77cp and 95cp, far looser than our +20 and
   * 120, and still reaches 69% recall. Neither rule has tried keeping `margin`
   * while relaxing the other two.
   *
   * Hypothesis: our `sound` gate is the one costing recall for nothing. +20
   * demands the position be better than equal AFTER giving material away, which
   * is a strong claim about a sacrifice; the tree says the real boundary is
   * closer to "not already lost". Prediction: `loose sound` gains recall at
   * roughly flat precision, and `hybrid` sits between the two.
   */
  "loose sound": (c) => {
    const m = margin(c);
    return c.playedEval >= -77.5 && c.evalLoss <= MAX_EVAL_LOSS && m !== null && m >= NECESSARY_MARGIN;
  },
  "loose strong": (c) => {
    const m = margin(c);
    return c.playedEval >= STILL_GOOD && c.evalLoss <= 95.5 && m !== null && m >= NECESSARY_MARGIN;
  },
  hybrid: (c) => {
    const m = margin(c);
    return c.playedEval >= -77.5 && c.evalLoss <= 95.5 && m !== null && m >= NECESSARY_MARGIN;
  },
};

const flags = (adm, gate, c) => ADMISSION[adm](c) && GATES[gate](c) && !REJECT_SHAPES.includes(c.shape);

const band = (r) => (r === null || r === undefined ? "unknown" : `${Math.floor(r / 400) * 400}–${Math.floor(r / 400) * 400 + 399}`);

/**
 * FIT / TEST SPLIT — a pure function of the game id, and that is the point.
 *
 * The Louis label file splits by walking an id-sorted list and alternating, which
 * is stable there because ids are chronological and games only ever get appended.
 * That guarantee does NOT hold here: growing the random sample inserts games from
 * anywhere in an account's history, and a single insertion flips the half of
 * every game after it. Re-running the harvester with `--negatives 300` instead of
 * 40 would have silently re-cut the split — the exact hazard the frozen split
 * exists to prevent, arriving through the back door.
 *
 * Hashing the id removes the failure mode instead of documenting it: a game's
 * half depends on nothing but its own id, so the assignment cannot be disturbed
 * by what else is in the dataset, and there is nothing to freeze because there is
 * nothing that could drift. Re-rolling it would mean editing this function, which
 * shows up in a diff.
 *
 * Split by GAME, never by candidate — a game's starred move and the near-misses
 * around it must not straddle the halves, or the test half is scoring positions
 * it has already seen.
 */
const half = (id) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % 2 === 0 ? "fit" : "test";
};

/**
 * Recall uses every game; precision uses random games ONLY — and that means both
 * of its terms, not just the false positives.
 *
 * The first version of this counted `tp` across all games and `fp` across random
 * ones, which reads as a reasonable way to "use all the data" and is nonsense:
 * the numerator then comes from a population deliberately enriched with positives
 * and the denominator from an unenriched one, so precision climbs with the
 * enrichment ratio. It reported 97.9% where the honest figure is far lower. If
 * you change anything here, keep `tpRandom` and `fp` from the same games.
 */
function score(adm, gate, filter = () => true) {
  let tp = 0, fn = 0, tpRandom = 0, fp = 0, prefilterFn = 0;
  for (const g of Object.values(cache.games)) {
    if (!filter(g)) continue;
    const stars = new Set(g.expected.map((m) => `${m.moveNumber} ${m.san}`));
    const hit = new Set();
    const seen = new Set();
    for (const c of g.candidates) {
      const k = `${c.moveNumber} ${c.san}`;
      seen.add(k);
      if (!flags(adm, gate, c)) continue;
      if (stars.has(k)) {
        tp++;
        hit.add(k);
        if (g.sample === "random") tpRandom++;
      } else if (g.sample === "random") fp++;
    }
    for (const k of stars) {
      if (!hit.has(k)) {
        fn++;
        if (!seen.has(k)) prefilterFn++;
      }
    }
  }
  return { tp, fp, fn, tpRandom, prefilterFn };
}

const pct = (x) => (x === null ? "  n/a" : `${(100 * x).toFixed(1)}%`.padStart(6));
const P = (s) => (s.tpRandom + s.fp === 0 ? null : s.tpRandom / (s.tpRandom + s.fp));
const R = (s) => (s.tp + s.fn === 0 ? null : s.tp / (s.tp + s.fn));

const games = Object.values(cache.games);
const randomGames = games.filter((g) => g.sample === "random").length;
const starGames = games.filter((g) => g.sample === "star").length;
const positives = games.reduce((n, g) => n + g.expected.length, 0);
console.log(`${games.length} games (${starGames} star, ${randomGames} random) · ${positives} labelled positives`);
console.log(`precision from random games only (${randomGames}); recall from all\n`);

const row = (label, s) =>
  `${label.padEnd(26)} ${String(s.tp).padStart(3)} ${String(s.fn).padStart(4)}  | ${String(s.tpRandom).padStart(6)} ${String(s.fp).padStart(3)}   ${pct(P(s))}  ${pct(R(s))}   ${s.prefilterFn}`;

console.log("ALL GAMES");
console.log("rule                       TP   FN  |  randTP  FP        P       R   (pre-filter FN)");
for (const adm of Object.keys(ADMISSION))
  for (const gate of Object.keys(GATES)) console.log(row(`${adm} / ${gate}`, score(adm, gate)));

// The fit half is where a rule gets chosen; the test half is the only place a
// number means anything. Printed separately and never pooled.
for (const h of ["fit", "test"]) {
  console.log(`\n${h.toUpperCase()} HALF${h === "test" ? " — held out; a measurement, not a menu" : " — look freely"}`);
  console.log("rule                       TP   FN  |  randTP  FP        P       R   (pre-filter FN)");
  for (const adm of Object.keys(ADMISSION))
    for (const gate of Object.keys(GATES))
      console.log(row(`${adm} / ${gate}`, score(adm, gate, (g) => half(g.id) === h)));
}

if (BY_RATING) {
  console.log("\nSHIPPING RULE BY RATING BAND — does chess.com's label mean the same thing");
  console.log("at every level, or has this project been fitting one skill band?\n");
  console.log("band        games   TP   FP   FN        P       R");
  const bands = [...new Set(games.map((g) => band(g.rating)))].sort();
  for (const b of bands) {
    const s = score("base", "live", (g) => band(g.rating) === b);
    const n = games.filter((g) => band(g.rating) === b).length;
    console.log(`${b.padEnd(11)} ${String(n).padStart(5)} ${String(s.tp).padStart(4)} ${String(s.fp).padStart(4)} ${String(s.fn).padStart(4)}   ${pct(P(s))}  ${pct(R(s))}`);
  }
}
