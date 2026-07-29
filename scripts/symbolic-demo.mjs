/**
 * Symbolic regression, demonstrated on the real labelled data.
 *
 * Searches the space of small arithmetic expressions over the detector's
 * features for one that separates starred moves from unstarred ones — the same
 * idea as PySR or gplearn, in about a hundred lines and with no dependencies.
 *
 * The point is NOT to produce a rule to ship. It is to make visible what too
 * little data does to a method like this, which is much easier to see than to be
 * told. The demo reports every distinct formula that achieves the best score, and
 * when there are only a handful of positives you get dozens of completely
 * different "perfect" answers. That is what underdetermination looks like: the
 * search is not finding the rule, it is finding the many rules the data cannot
 * tell apart.
 *
 * Read the output as a thermometer for the DATASET, not as a result.
 *
 *   node scripts/symbolic-demo.mjs
 *   node scripts/symbolic-demo.mjs --iters 200000
 */
import { readFileSync, existsSync } from "node:fs";

const ITERS = Number((process.argv.find((a) => a.startsWith("--iters=")) ?? "").split("=")[1]) || 60000;

// ─── data ────────────────────────────────────────────────────────────────────
const FEATURES = ["sacrifice", "playedEval", "evalLoss", "margin", "isDirect", "isAccepted"];

function load(path, rows) {
  if (!existsSync(path)) return;
  const [hdr, ...lines] = readFileSync(path, "utf8").trim().split("\n");
  const cols = hdr.split(",");
  for (const line of lines) {
    if (!line.trim()) continue;
    const r = Object.fromEntries(line.split(",").map((v, i) => [cols[i], v]));
    if (r.margin === "" || r.margin === undefined) continue; // no quiet alternative measured
    rows.push({
      label: Number(r.label),
      san: `${r.moveNumber}.${r.san}`,
      sacrifice: Number(r.sacrifice),
      playedEval: Number(r.playedEval),
      evalLoss: Number(r.evalLoss),
      margin: Number(r.margin),
      isDirect: r.shape === "direct" ? 1 : 0,
      isAccepted: r.accepted === "true" ? 1 : 0,
    });
  }
}

const rows = [];
load("scripts/dataset-louismcdade.csv", rows);
load("scripts/dataset-annotated.csv", rows);

const pos = rows.filter((r) => r.label === 1);
const neg = rows.filter((r) => r.label === 0);
console.log(`data: ${rows.length} labelled candidates — ${pos.length} positive, ${neg.length} negative\n`);
if (!pos.length || !neg.length) {
  console.log("Need both classes present. Collect more labels first.");
  process.exit(0);
}

// ─── expression search ───────────────────────────────────────────────────────
// Grammar: EXPR -> feature | const | EXPR (+|-|*) EXPR
// A candidate rule is EXPR > 0, so the search is really looking for a decision
// surface expressed as a formula rather than as a threshold on one column.
const CONSTS = [0, 1, 2, 5, 10, 20, 50, 100, 200, 500];
const pick = (a) => a[Math.floor(Math.random() * a.length)];

function randExpr(depth) {
  if (depth <= 0 || Math.random() < 0.35) {
    return Math.random() < 0.75
      ? { t: "f", v: pick(FEATURES) }
      : { t: "c", v: pick(CONSTS) };
  }
  return { t: "o", op: pick(["+", "-", "*"]), a: randExpr(depth - 1), b: randExpr(depth - 1) };
}

const evalExpr = (e, row) =>
  e.t === "f" ? row[e.v] : e.t === "c" ? e.v :
  e.op === "+" ? evalExpr(e.a, row) + evalExpr(e.b, row) :
  e.op === "-" ? evalExpr(e.a, row) - evalExpr(e.b, row) :
                 evalExpr(e.a, row) * evalExpr(e.b, row);

const show = (e) =>
  e.t === "f" ? e.v : e.t === "c" ? String(e.v) : `(${show(e.a)} ${e.op} ${show(e.b)})`;

const size = (e) => (e.t === "o" ? 1 + size(e.a) + size(e.b) : 1);

/** Balanced accuracy — plain accuracy is meaningless at 3 positives vs 67 negatives. */
function score(e) {
  let tp = 0, fn = 0, tn = 0, fp = 0;
  for (const r of rows) {
    const yes = evalExpr(e, r) > 0;
    if (r.label === 1) yes ? tp++ : fn++;
    else yes ? fp++ : tn++;
  }
  const sens = tp + fn ? tp / (tp + fn) : 0;
  const spec = tn + fp ? tn / (tn + fp) : 0;
  return { bal: (sens + spec) / 2, tp, fn, tn, fp };
}

// Collect everything that fits WELL, not only exact ties with the leader.
// Counting exact ties measures the search's luck, not the data's power: random
// search rarely lands on the same score twice, so it reported "1 formula at the
// top" and made an underdetermined problem look decided. What matters is how
// many genuinely different formulas the data cannot tell apart.
// Keep a wide net, then narrow RELATIVE to whatever the search actually reached.
// An absolute cutoff is wrong twice over: too high and a run that peaks below it
// collects nothing, too low and it fills with junk. What we want is "everything
// essentially as good as the best", and the best is only known at the end.
const KEEP = 0.85;
const pool = new Map(); // formula string -> {expr, score}
let bestBal = 0;
for (let i = 0; i < ITERS; i++) {
  const e = randExpr(3);
  const s = score(e);
  if (s.bal > bestBal) bestBal = s.bal;
  if (s.bal >= KEEP) {
    const k = show(e);
    if (!pool.has(k)) pool.set(k, { e, s });
  }
}
// One specificity step is 1/62 here, so a tighter epsilon than that only ever
// counts exact ties and understates how many rules the data cannot separate.
const EPS = 0.025;
const best = new Map([...pool].filter(([, v]) => v.s.bal >= bestBal - EPS));

// ─── report ──────────────────────────────────────────────────────────────────
const found = [...best.values()].sort((a, b) => size(a.e) - size(b.e));
console.log(`searched ${ITERS.toLocaleString()} expressions`);
console.log(`best balanced accuracy: ${(bestBal * 100).toFixed(1)}%`);
console.log(`number of DISTINCT formulas achieving it: ${found.length}\n`);

console.log("the simplest few:");
for (const { e, s } of found.slice(0, 8)) {
  console.log(`  ${show(e)} > 0`.padEnd(58) + `tp ${s.tp} fn ${s.fn} fp ${s.fp} tn ${s.tn}`);
}

console.log("");
if (found.length > 3) {
  console.log(`⚠ ${found.length} different formulas score identically. They disagree with each`);
  console.log(`  other about moves you have not labelled, and nothing in this data says`);
  console.log(`  which is right. That is a verdict on the DATASET, not a result.`);
  console.log(`  Rough guide: you want ~10 labelled examples per free parameter, so a`);
  console.log(`  4-term formula wants 40+ positives. You have ${pos.length}.`);
} else {
  console.log(`Only ${found.length} formula(s) at the top — the data is starting to constrain`);
  console.log(`the search. Worth re-running with a proper fit/test split.`);
}
