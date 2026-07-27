/**
 * Turn a diag-account.mjs run into a checklist for collecting chess.com labels.
 *
 * The point is to make labels CHEAP. chess.com's full Game Review is limited to
 * one a day on a free account, but the post-game summary is unlimited — and the
 * summary is known to over-count (it reported 2 brilliancies on a game whose
 * Game Review showed 1). So a summary reading of **0 is exact**: nothing starred
 * means nothing starred. Since this detector's problem is false positives, a
 * pile of cheap zeroes is worth more than a trickle of expensive ones.
 *
 * Games we already have labels for are marked DONE so nobody checks them twice.
 *
 *   node scripts/label-checklist.mjs <diag-output.txt>
 */
import { readFileSync } from "node:fs";

// Labels already collected, keyed by chess.com game id.
//   count  — brilliancies chess.com reports for Louis's side
//   source — "review" (full Game Review, authoritative on WHICH move) or
//            "summary" (post-game highlights; exact only when the count is 0)
const KNOWN = {
  "168334603690": { count: 1, source: "review", note: "6...Bxf2+ starred" },
  "169999249810": { count: 1, source: "review", note: "24.Ne6 starred; 19.Rxd6 not" },
  "171473275764": { count: 0, source: "summary" },
  "169135347664": { count: 0, source: "summary" },
  "170905472716": { count: 0, source: "summary" },
  "171329245690": { count: 0, source: "summary" },
  "170344245882": { count: 1, source: "summary", note: "which move unknown" },
  "172078598998": { count: 1, source: "summary", note: "likely 15...Nxd3+" },
  "169869209718": { count: 1, source: "summary", note: "we flag 2 — at least one is wrong" },
};

const lines = readFileSync(process.argv[2], "utf8").split(/\r?\n/);

// diag-account prints three lines per flag: move, url, fen
const games = new Map();
for (let i = 0; i < lines.length; i++) {
  const m = lines[i].match(/^(\d+)(\.\.\.|\.)(\S+)\s+offers\s+(\S+)\s+\(([\d.]+)\)\s+eval=(-?\d+)/);
  if (!m) continue;
  const url = (lines[i + 1] ?? "").trim();
  const id = url.split("/").pop();
  if (!id) continue;
  const discovered = /\[discovered\]/.test(lines[i]);
  if (!games.has(id)) games.set(id, { url, moves: [] });
  games.get(id).moves.push({
    label: `${m[1]}${m[2]}${m[3]}`,
    offered: m[4],
    value: m[5],
    eval: Number(m[6]),
    discovered,
  });
}

const fmtEval = (cp) =>
  Math.abs(cp) > 90000 ? "mate" : `${cp >= 0 ? "+" : ""}${(cp / 100).toFixed(1)}`;

const todo = [];
const done = [];
for (const [id, g] of games) (KNOWN[id] ? done : todo).push([id, g]);

// Most informative first: the biggest evals are where we most suspect ourselves,
// and a single-flag game gives an unambiguous answer from the count alone.
todo.sort((a, b) => {
  const ea = Math.max(...a[1].moves.map((m) => m.eval));
  const eb = Math.max(...b[1].moves.map((m) => m.eval));
  return eb - ea;
});

console.log(`${games.size} games flagged in total — ${done.length} already labelled, ${todo.length} to check.\n`);
console.log("For each: open the game on chess.com and read the post-game summary");
console.log("(Highlights). Reply with just the number and the Brilliant count.\n");
console.log("A 0 is a complete answer. A 1 on a single-flag game confirms that move.\n");

todo.forEach(([, g], i) => {
  const n = String(i + 1).padStart(2);
  const moves = g.moves
    .map((m) => `${m.label} (offers ${m.offered.split("@")[0]}, ${fmtEval(m.eval)}${m.discovered ? ", discovered" : ""})`)
    .join("  ·  ");
  console.log(`${n}. ${g.url}`);
  console.log(`    we flag: ${moves}`);
});

if (done.length) {
  console.log(`\n─── already labelled, skip these ───`);
  for (const [id, g] of done) {
    const k = KNOWN[id];
    console.log(`  ${g.url}  →  ${k.count} brilliant (${k.source})${k.note ? " — " + k.note : ""}`);
  }
}
