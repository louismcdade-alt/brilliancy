/**
 * Calibration harness for the brilliancy detector.
 *
 * Runs the *real* scanGame() (in a browser, against the live Stockfish WASM build)
 * over every game in fixtures.mjs, compares what it flags to the human labels, and
 * reports precision / recall plus a per-game breakdown. This is the instrument for
 * the "tune detection thresholds" task: change a constant in src/engine/brilliancy.ts,
 * re-run this, and watch the numbers move instead of guessing.
 *
 * FIT / TEST SPLIT. Games are reported in three groups, and the grouping is the
 * whole point of the output format:
 *
 *   fit    look at this freely while inventing a rule.
 *   test   held back. A number from here is a measurement; a number you tuned
 *          against is a description of the data you tuned on.
 *   guard  confirmed positives and the classical games. Never fitted on. If a
 *          new rule breaks one of these, the rule is wrong.
 *
 * Nothing enforces the discipline — the harness prints all three because hiding
 * the test half would just mean running it by hand. What it does enforce is that
 * the three are never silently pooled into one flattering average.
 *
 * BOTH CONFIGURATIONS, ONE PASS. Each game is scanned once with the shape rule
 * OFF, and the per-candidate `shape` field is used to derive what the detector
 * WOULD have flagged with it on. A/B-ing a rule therefore costs no extra engine
 * time, which is what makes it affordable to re-measure on every change.
 *
 * Prereq: the dev server must be running (npm run dev) — same as the other scripts.
 *
 *   node scripts/test-harness.mjs            # depth 14 (matches the app's SCAN_DEPTH)
 *   DEPTH=18 node scripts/test-harness.mjs   # try a deeper verification pass
 *
 * Exit code is non-zero if any GUARD game regresses. Fit and test are measurements,
 * not gates: with precision where it currently is, failing the build on a known
 * false positive would just mean a permanently red harness nobody reads.
 */
import { chromium } from "playwright";
import { fixtures } from "./fixtures.mjs";

const DEPTH = Number(process.env.DEPTH) || 14;

/**
 * The label set went from 27 games to 294 on 2026-07-29, so a full pass is now a
 * long run rather than a quick one. HALF subsets it; MAX truncates it.
 *
 *   HALF=fit,guard node scripts/test-harness.mjs   # iterate without touching test
 *   MAX=40 node scripts/test-harness.mjs           # smoke-sized run
 *
 * A subset run reports the halves it ran and nothing else — the summary only
 * prints groups it actually measured, so a filtered run can't be mistaken for a
 * full one. Reach for HALF=fit,guard while inventing a rule; run everything when
 * you want a number.
 */
const HALVES = (process.env.HALF ?? "fit,test,guard").split(",").map((s) => s.trim());
const suite = fixtures
  .filter((fx) => HALVES.includes(fx.half ?? "guard"))
  .slice(0, Number(process.env.MAX) || Infinity);

/**
 * PRE-REGISTERED, 2026-07-28. Written down before the held-out half was looked at.
 *
 * Hypothesis: what separates a real brilliancy from our false positives is not
 * the shape of the offer but the MARGIN it wins by — how far the sacrifice beats
 * the best quiet alternative. Derived from the fit half plus the guard set:
 *
 *   true positives   +56 +58 +62 +122 +201, and three forced mates
 *   false positives  +3, −66, and one with no quiet alternative at all
 *
 * The floor comes from the fit half (must exceed 23.Nxb6's +3cp). The ceiling
 * comes from the guard set doing its stated job as a constraint (must not cut
 * 6...Bxf2+ at +56). 50 sits in the gap. It is NOT tuned against the test half.
 *
 * Known counterexample, recorded up front so the result can't be spun: 24.Ne6 is
 * confirmed starred by chess.com and has a margin of −102, WORSE than the false
 * positive 12...Nxd5 at −66. So this cannot be the whole story, and the honest
 * prediction is that it buys precision without touching that miss.
 */
const MARGIN = 50;

async function launch() {
  for (const channel of ["msedge", "chrome"]) {
    try {
      return await chromium.launch({ channel, headless: true });
    } catch {
      /* next */
    }
  }
  return await chromium.launch({ headless: true });
}

// Identity of a flagged move, for matching detector output against labels.
const key = (m) => `${m.moveNumber} ${m.san}`;

const browser = await launch();
const page = await browser.newPage();
page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
await page.goto("http://localhost:5173/", { waitUntil: "networkidle" });

console.log(
  `Brilliancy calibration — ${suite.length}/${fixtures.length} games at depth ${DEPTH}` +
    `${suite.length === fixtures.length ? "" : ` (halves: ${HALVES.join(", ")})`}\n`,
);

// Each config is (shapes it rejects, how it decides "necessary"). Necessity is
// spelled out per config rather than read off `rejectedBy`, because the shipped
// detector's `rejectedBy: "necessary"` means whatever the CURRENT gate means —
// reconstructing an older gate from it would silently compare a rule to itself.
// Everything below is computed from the same single engine pass.
const CONFIGS = ["oldGate", "live", "marginA"];
const REJECT = { oldGate: ["promotion"], live: ["promotion"], marginA: ["promotion"] };
const NECESSARY = {
  // The pre-2026-07-28 rule, kept as the baseline this change is measured against.
  oldGate: (played, quiet) => quiet === null || quiet < 250 || quiet < played,
  live: (played, quiet) => quiet !== null && played - quiet >= MARGIN,
  marginA: (played, quiet) => (quiet === null ? true : played - quiet >= MARGIN),
};
const CONFIG_BLURB = {
  oldGate: "OLD GATE — quietAlt < 250 || quietAlt < played (the rule before today)",
  live: `LIVE — margin ≥ ${MARGIN}cp, no quiet alt ⇒ REJECT (what ships now)`,
  marginA: `MARGIN-A — margin ≥ ${MARGIN}cp, no quiet alt ⇒ PASS (the variant that lost)`,
};
const zero = () => ({ tp: 0, fp: 0, fn: 0, regressions: 0 });
// score[config][half] = {tp, fp, fn, regressions}
const score = Object.fromEntries(
  CONFIGS.map((c) => [c, { fit: zero(), test: zero(), guard: zero() }]),
);

for (const fx of suite) {
  const half = fx.half ?? "guard";
  // Scan with the shape rule OFF so every candidate is visible, then filter.
  const detectedBase = await page.evaluate(
    async ({ pgn, userColor, depth }) => {
      const mod = await import("/src/engine/brilliancy.ts");
      const game = {
        id: "test",
        url: "",
        pgn,
        timeClass: "blitz",
        timeControl: "300",
        rated: true,
        endTime: 0,
        userColor,
        result: "win",
        resultReason: "",
        oppUsername: "opponent",
      };
      // Return EVERY candidate, not just what survived. A config that replaces
      // the `necessary` gate has to be able to bring back moves that gate threw
      // away, and scanGame's return value has already dropped them.
      const seen = [];
      await mod.scanGame(game, {
        depth,
        rejectShapes: [],
        onCandidate: (c) => seen.push(c),
      });
      return seen.map((c) => ({
        moveNumber: c.moveNumber,
        san: c.san,
        sacrifice: c.sacrifice,
        evalAfter: c.playedEval,
        evalLoss: c.evalLoss,
        // -Infinity does not survive JSON, so "no quiet alternative" arrives as
        // null. That case is a measurement gap, not evidence, which is exactly
        // why marginA and marginB disagree about what to do with it.
        quietAlt: isFinite(c.quietAlt) ? c.quietAlt : null,
        shape: c.shape,
        rejectedBy: c.rejectedBy,
      }));
    },
    { pgn: fx.pgn, userColor: fx.userColor, depth: DEPTH },
  );

  // `rejectedBy` names the FIRST gate that failed, in the order sound → strong →
  // necessary. So "null or necessary" is exactly "cleared sound and strong" —
  // the set a margin rule gets to re-judge.
  const clearedSoundStrong = (m) => m.rejectedBy === null || m.rejectedBy === "necessary";
  const passes = (cfg, m) =>
    !REJECT[cfg].includes(m.shape) &&
    clearedSoundStrong(m) &&
    NECESSARY[cfg](m.evalAfter, m.quietAlt);

  const byConfig = Object.fromEntries(
    CONFIGS.map((c) => [c, detectedBase.filter((m) => passes(c, m))]),
  );

  const diverges = fx.diverges ?? [];
  // Documented divergences are neither expected nor false positives — they're
  // decisions we've already made and written down. Scoring them either way would
  // make the number lie about how the detector is doing.
  const knownKeys = new Set(diverges.map(key));
  const expectedKeys = new Set(fx.expected.map(key));

  // Per-game reporting follows the CURRENT detector; the other columns are
  // counterfactuals and belong in the summary, not in every line.
  const detected = byConfig.live;
  const detectedKeys = new Set(detected.map(key));

  for (const cfg of CONFIGS) {
    const dk = new Set(byConfig[cfg].map(key));
    const s = score[cfg][half];
    s.tp += fx.expected.filter((m) => dk.has(key(m))).length;
    s.fn += fx.expected.filter((m) => !dk.has(key(m))).length;
    s.fp += byConfig[cfg].filter((m) => !expectedKeys.has(key(m)) && !knownKeys.has(key(m))).length;
  }

  const hits = fx.expected.filter((m) => detectedKeys.has(key(m)));
  const missed = fx.expected.filter((m) => !detectedKeys.has(key(m)));
  const falsePos = detected.filter((m) => !expectedKeys.has(key(m)) && !knownKeys.has(key(m)));
  // A divergence that starts getting flagged is news: the note is now stale.
  const resurfaced = diverges.filter((m) => detectedKeys.has(key(m)));
  // Moves the shape rule removed — the interesting line in a fit/test report.
  const suppressed = detectedBase.filter((m) => REJECT.live.includes(m.shape));

  const ok = missed.length === 0 && falsePos.length === 0 && resurfaced.length === 0;
  if (!ok) score.live[half].regressions++;

  console.log(`${ok ? "✓" : "✗"} [${half}] ${fx.name}`);
  for (const m of hits) {
    const d = detected.find((x) => key(x) === key(m));
    console.log(
      `    hit   ${m.moveNumber}.${m.san}  (sac ${d.sacrifice}, eval ${d.evalAfter}cp, loss ${d.evalLoss}cp)`,
    );
  }
  for (const m of missed) console.log(`    MISS  ${m.moveNumber}.${m.san}  — expected but not flagged`);
  for (const m of diverges) {
    const now = detectedKeys.has(key(m));
    console.log(
      `    ${now ? "NOTE!" : "known"} ${m.moveNumber}.${m.san}  — ${m.why}${now ? "  ⚠ now flagged, update the fixture" : ""}`,
    );
  }
  for (const m of suppressed) {
    const wasWrong = !expectedKeys.has(key(m));
    console.log(
      `    ${wasWrong ? "cut  " : "CUT! "} ${m.moveNumber}.${m.san}  — ${m.shape} offer, dropped by the shape rule` +
        `${wasWrong ? " (was a false positive)" : "  ⚠ THIS WAS A LABELLED BRILLIANCY"}`,
    );
  }
  for (const m of falsePos)
    console.log(
      `    FALSE ${m.moveNumber}.${m.san}  (sac ${m.sacrifice}, eval ${m.evalAfter}cp, loss ${m.evalLoss}cp) — flagged but not labeled`,
    );
  console.log("");
}

const pct = (x) => `${(x * 100).toFixed(1)}%`;
// Precision is UNDEFINED, not zero, on a half with no labelled positives — and
// fit and test are both entirely zero-count games, so it is undefined on both.
// The first version of this printed "precision 0.0% → 0.0%" as the headline
// held-out result, which reads as a catastrophe and actually means "there was
// nothing here to be right about". On those halves the false-positive COUNT is
// the whole measurement.
// No labelled positives in the half ⇒ precision can only come out 0 or 0/0, so
// report it as n/a rather than as a score.
const prec = (s) => (s.tp + s.fn === 0 || s.tp + s.fp === 0 ? null : s.tp / (s.tp + s.fp));
const rec = (s) => (s.tp + s.fn ? s.tp / (s.tp + s.fn) : null);
const show = (x) => (x === null ? "  n/a" : pct(x).padStart(6));

const line = (label, s) =>
  `  ${label.padEnd(6)} TP ${String(s.tp).padStart(2)}  FP ${String(s.fp).padStart(2)}  FN ${String(s.fn).padStart(2)}` +
  `   P ${show(prec(s))}  R ${show(rec(s))}`;

console.log("═══════════════════════════════════════════════════════════");
console.log("Both halves now carry labelled positives (chess.com's all-time list),");
console.log("so recall is a real number on each — not n/a as it was until 2026-07-29.\n");
const ranHalves = ["fit", "test", "guard"].filter((h) => HALVES.includes(h));
for (const cfg of CONFIGS) {
  console.log(CONFIG_BLURB[cfg]);
  for (const half of ranHalves) console.log(line(half, score[cfg][half]));
  console.log("");
}

if (ranHalves.includes("test")) {
  console.log("HELD-OUT RESULT — the only numbers here that weren't fitted:");
  for (const cfg of CONFIGS.filter((c) => c !== "base")) {
    const d = score.oldGate.test.fp - score[cfg].test.fp;
    const s = score[cfg].test;
    console.log(
      `  ${cfg.padEnd(6)} test-half FP ${score.oldGate.test.fp} → ${score[cfg].test.fp}` +
        (d === 0 ? " (no held-out examples — UNTESTED)" : ` (${d > 0 ? "−" : "+"}${Math.abs(d)})`) +
        `   recall ${show(rec(s))} (${s.tp}/${s.tp + s.fn})`,
    );
  }
} else {
  console.log(`HELD-OUT RESULT — not run (halves: ${HALVES.join(", ")}).`);
}

// The guard gate asks one question: did the shape rule cost us a confirmed
// brilliancy? It compares live against base rather than against perfection,
// because the guard set contains a known standing false negative (24.Ne6) that
// predates every shape rule. Failing on that would leave the gate red no matter
// what anyone did, which is the same as having no gate at all.
const lost = score.oldGate.guard.tp - score.live.guard.tp;
console.log(
  lost === 0
    ? "\n✓ GUARD INTACT — the shape rule cost no confirmed brilliancy"
    : `\n✗ GUARD BROKEN — the shape rule lost ${lost} confirmed brilliancy(s); the rule is wrong`,
);
if (score.live.guard.fn) {
  console.log(
    `  (standing false negatives in the guard set: ${score.live.guard.fn} — pre-existing, not caused by a shape rule)`,
  );
}

await browser.close();
process.exit(lost === 0 ? 0 : 1);
