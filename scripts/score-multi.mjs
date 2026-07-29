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
};

const flags = (adm, gate, c) => ADMISSION[adm](c) && GATES[gate](c) && !REJECT_SHAPES.includes(c.shape);

const band = (r) => (r === null || r === undefined ? "unknown" : `${Math.floor(r / 400) * 400}–${Math.floor(r / 400) * 400 + 399}`);

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

console.log("rule                       TP   FN  |  randTP  FP        P       R   (pre-filter FN)");
for (const adm of Object.keys(ADMISSION))
  for (const gate of Object.keys(GATES)) {
    const s = score(adm, gate);
    console.log(
      `${(adm + " / " + gate).padEnd(26)} ${String(s.tp).padStart(3)} ${String(s.fn).padStart(4)}  | ${String(s.tpRandom).padStart(6)} ${String(s.fp).padStart(3)}   ${pct(P(s))}  ${pct(R(s))}   ${s.prefilterFn}`,
    );
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
