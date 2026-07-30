/**
 * What does the SHIPPING detector return on the guard games?
 *
 * test-harness.mjs reconstructs verdicts from candidate fields so it can A/B
 * several gate configurations from one engine pass. That makes it blind to the
 * learned scorer, which is what `scanGame` now actually uses — so a green
 * harness says nothing about what the site will show. This runs scanGame with
 * its real defaults and reports the moves it returns.
 *
 * The guard set is famous sacrifices plus two chess.com-confirmed brilliancies.
 * A rule that cuts one of these is wrong however well it scores in aggregate;
 * that is what the set is for.
 *
 * Prereq: the dev server must be running (npm run dev).
 *
 *   node scripts/verify-model-guard.mjs
 */
import { chromium } from "playwright";
import { fixtures } from "./fixtures.mjs";

const guard = fixtures.filter((f) => (f.half ?? "guard") === "guard");

const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage();
page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
await page.goto("http://localhost:5173/", { waitUntil: "networkidle" });

let misses = 0;
let extras = 0;

for (const fx of guard) {
  const found = await page.evaluate(
    async ({ pgn, userColor, depth }) => {
      const bril = await import("/src/engine/brilliancy.ts");
      const { brilliancyScore } = await import("/src/engine/score.ts");
      const scores = [];
      const out = await bril.scanGame(
        { id: "g", url: "", pgn, userColor, timeClass: "blitz", timeControl: "300", rated: true,
          endTime: 0, result: "win", resultReason: "", oppUsername: "opp" },
        { depth, onCandidate: (c) => scores.push({ m: `${c.moveNumber}.${c.san}`, s: brilliancyScore(c) }) },
      );
      return { flagged: out.map((b) => `${b.moveNumber}.${b.san}`), scores };
    },
    { pgn: fx.pgn, userColor: fx.userColor, depth: 14 },
  );

  const want = fx.expected.map((m) => `${m.moveNumber}.${m.san}`);
  const missing = want.filter((w) => !found.flagged.includes(w));
  const extra = found.flagged.filter((f) => !want.includes(f));
  misses += missing.length;
  extras += extra.length;

  const ok = missing.length === 0;
  console.log(`${ok ? "✓" : "✗"} ${fx.name}`);
  console.log(`    flagged: ${found.flagged.join(", ") || "—"}`);
  if (missing.length) console.log(`    MISSED:  ${missing.join(", ")}`);
  if (extra.length) console.log(`    extra:   ${extra.join(", ")}`);
  for (const s of found.scores) console.log(`      score ${s.s.toFixed(3)}  ${s.m}`);
}

console.log(`\n${misses} expected move(s) missed, ${extras} unexpected flag(s)`);
await browser.close();
process.exit(misses > 1 ? 1 : 0); // 24.Ne6 is a documented standing miss
