/**
 * Is "hard to find" measurable? A cheap probe before paying for a re-harvest.
 *
 * chess.com's Brilliant is not purely about soundness — a move has to be one a
 * player might MISS. Nothing the detector measures captures that, and the
 * feature ceiling analysis said precision is feature-limited, so this is the
 * most promising gap left.
 *
 * The proxy: search the position AFTER the move at a shallow depth and again at
 * the depth the scan uses. A move whose point only appears when you look deeper
 * is, in a real sense, hard to find — at shallow depth it just looks like
 * hanging a piece. If brilliancies show a larger deep-minus-shallow swing than
 * ordinary sacrifices do, the feature is worth harvesting properly.
 *
 * Deliberately a PROBE on a balanced subset, not a harvest. A full pass is hours
 * of engine time, and the point of this script is to find out whether that is
 * worth spending — measure the cheap thing first, then decide.
 *
 * Prereq: the dev server must be running (npm run dev).
 *
 *   node scripts/probe-hardtofind.mjs [--n 80] [--shallow 6]
 */
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import { fetchArchive } from "./lib/chesscom.mjs";

const argOf = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? Number(process.argv[i + 1]) : d;
};
const N = argOf("n", 80);
const SHALLOW = argOf("shallow", 6);
const DEEP = 14;

const cache = JSON.parse(readFileSync("scripts/harvest-multi.json", "utf8"));

// Balanced sample: equal positives and negatives, and only OFFER candidates
// (what the shipping pre-filter admits). Mate scores are excluded — a move that
// is mate at depth 6 and mate at depth 14 has no swing to measure and would
// dilute the comparison with zeros.
const pool = { pos: [], neg: [] };
for (const g of Object.values(cache.games)) {
  const stars = new Set(g.expected.map((m) => `${m.moveNumber} ${m.san}`));
  for (const c of g.candidates) {
    if (c.admitted !== "offer" || Math.abs(c.playedEval) > 90000) continue;
    const bucket = stars.has(`${c.moveNumber} ${c.san}`) ? "pos" : "neg";
    if (g.trustNegatives === false && bucket === "neg") continue;
    pool[bucket].push({ user: g.user, id: g.id, userColor: g.userColor, moveNumber: c.moveNumber, san: c.san, deep: c.playedEval });
  }
}
const pick = (arr, n) => arr.filter((_, i) => i % Math.max(1, Math.floor(arr.length / n)) === 0).slice(0, n);
const sample = [...pick(pool.pos, N), ...pick(pool.neg, N)];
const labels = new Map(sample.map((s, i) => [i, i < Math.min(N, pool.pos.length) ? 1 : 0]));

console.error(`probing ${sample.length} candidates (${pool.pos.length} positives available, ${pool.neg.length} negatives)`);

const users = [...new Set(sample.map((s) => s.user))];
const pgns = new Map();
for (const u of users) {
  const archive = await fetchArchive(u);
  for (const [id, g] of archive) pgns.set(id, g.pgn);
}

const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage();
page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
await page.goto("http://localhost:5173/", { waitUntil: "networkidle" });

const results = await page.evaluate(
  async ({ rows, shallow, deep }) => {
    const { parseGame } = await import("/src/chess/replay.ts");
    const { engine } = await import("/src/engine/engine.ts");
    await engine.init();
    const out = [];
    for (const r of rows) {
      try {
        const moves = parseGame(r.pgn);
        const ply = moves.findIndex((m) => m.moveNumber === r.moveNumber && m.san === r.san && m.color === r.userColor);
        if (ply < 0) { out.push(null); continue; }
        const fenAfter = moves[ply].fenAfter;
        const s = await engine.analyze(fenAfter, shallow);
        const d = await engine.analyze(fenAfter, deep);
        // Player POV: the search is from the opponent's side after the move.
        out.push({ shallow: -s.cp, deep: -d.cp });
      } catch {
        out.push(null);
      }
    }
    return out;
  },
  { rows: sample.map((s) => ({ ...s, pgn: pgns.get(s.id) })).filter((r) => r.pgn), shallow: SHALLOW, deep: DEEP },
);

await browser.close();

const swings = { pos: [], neg: [] };
for (let i = 0; i < results.length; i++) {
  const r = results[i];
  if (!r || Math.abs(r.shallow) > 90000 || Math.abs(r.deep) > 90000) continue;
  (labels.get(i) === 1 ? swings.pos : swings.neg).push(r.deep - r.shallow);
}

const stat = (a) => {
  const s = [...a].sort((x, y) => x - y);
  const med = s[Math.floor(s.length / 2)];
  const mean = s.reduce((x, y) => x + y, 0) / s.length;
  return `n=${String(s.length).padStart(3)}  median ${String(med).padStart(6)}  mean ${mean.toFixed(0).padStart(6)}`;
};

console.log(`\nDEEP(${DEEP}) MINUS SHALLOW(${SHALLOW}), player POV — positive means the move looks BETTER the deeper you look\n`);
console.log(`  brilliancies  ${stat(swings.pos)}`);
console.log(`  negatives     ${stat(swings.neg)}`);
const share = (a, t) => `${((100 * a.filter((x) => x >= t).length) / a.length).toFixed(1)}%`;
console.log("");
for (const t of [50, 100, 200]) {
  console.log(`  swing >= +${String(t).padEnd(4)}   brilliancies ${share(swings.pos, t).padStart(6)}   negatives ${share(swings.neg, t).padStart(6)}`);
}
