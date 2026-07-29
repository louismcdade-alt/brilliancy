/**
 * Generator: turn chess.com's own brilliant-move list into the project's labels.
 *
 *   node scripts/make-labels.mjs
 *
 * WHAT CHANGED, 2026-07-29. This script used to carry a hand-maintained table of
 * counts read off post-game summaries one game at a time, and it could only emit
 * a label when the count was 0 (exact) — a nonzero count meant "a star is
 * somewhere in this game", which is not a label. chess.com's Advanced Stats now
 * publishes every starred move with its location, so the table is gone and the
 * labels are derived: see scripts/brilliant-moves-louismcdade.mjs for the source,
 * its provenance, and why it covers RATED games only.
 *
 * The consequence is the whole point. Because the list is exhaustive over rated
 * games, every rated game is now scoreable — the ones with no star are complete
 * negatives and the nine with a star are exact positives. That takes the labelled
 * set from 27 games to 293, and from 0 usable positives to 9.
 *
 * FIT / TEST SPLIT. Sort by chess.com game id (chronological, and blind to what
 * the detector does) and alternate, fit first — the same rule the hand-frozen
 * split used. Two changes:
 *
 *   1. It is COMPUTED here rather than written out by hand. The hazard a frozen
 *      split protects against is a split that silently re-rolls as the set grows,
 *      letting you re-roll until the numbers flatter you. Alternating down an
 *      id-sorted list is immune to that by construction: ids are chronological, so
 *      new games only ever append, and appending cannot change the parity — and
 *      therefore the half — of any game already in the list. Freezing 293 rows by
 *      hand would buy nothing and rot on the first re-run.
 *   2. Stars and non-stars are alternated in SEPARATE passes, so the nine
 *      positives are spread across both halves instead of landing wherever the
 *      id ordering happens to put them.
 *
 * Disclosed up front, because it decides how a number should be read: this rule
 * puts all three of the currently-detected positives in the FIT half. Held-out
 * recall is consequently 0/4 today. That is a real limitation of a 9-positive
 * dataset, not a reason to re-cut the split — a split chosen after seeing which
 * cut gives a better test number is not a test.
 *
 * The two Game-Review positives from UNRATED games stay in `guard`, as before.
 * Their games' negatives are unknown (the list does not cover unrated games), so
 * they can only ever catch a rule that destroys a known brilliancy.
 */
import { writeFileSync } from "node:fs";
import {
  brilliantMoves,
  unratedReviewMoves,
  plyToMove,
  parseMove,
} from "./brilliant-moves-louismcdade.mjs";

const USER = "louismcdade";

async function getJson(url) {
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}

/** SAN tokens in play order, index 0 = white's first move (chess.com's ply). */
function sanList(pgn) {
  return pgn
    .replace(/\{[^}]*\}/g, "")
    .replace(/^\[.*$/gm, "")
    .replace(/\d+\.(\.\.)?/g, " ")
    .split(/\s+/)
    .filter((t) => t && !/^(1-0|0-1|1\/2-1\/2|\*)$/.test(t));
}

const months = (await getJson(`https://api.chess.com/pub/player/${USER}/games/archives`)).archives;
const games = new Map();

for (const month of months) {
  let batch;
  try {
    ({ games: batch } = await getJson(month));
  } catch {
    continue;
  }
  for (const g of batch ?? []) {
    if (g.rules !== "chess") continue;
    const id = String(g.url).split("/").pop();
    const userColor = (g.white?.username ?? "").toLowerCase() === USER ? "w" : "b";
    games.set(id, {
      id,
      url: g.url,
      rated: !!g.rated,
      userColor,
      opp: userColor === "w" ? g.black?.username : g.white?.username,
      date: new Date(g.end_time * 1000).toISOString().slice(0, 10),
      pgn: (g.pgn.split(/\n\n/)[1] ?? "").replace(/\{[^}]*\}/g, "").replace(/\d+\.\.\./g, "").replace(/\s+/g, " ").trim(),
    });
  }
}

// ── Resolve every star against the real game, and refuse to emit a label we
//    cannot verify. An off-by-one in the ply convention or a stale id would
//    otherwise poison the entire negative set silently.
const starsByGame = new Map();
const problems = [];
for (const star of brilliantMoves) {
  const g = games.get(star.id);
  if (!g) {
    problems.push(`${star.id}: not in archives`);
    continue;
  }
  if (!g.rated) problems.push(`${star.id}: listed as brilliant but the game is unrated`);
  const { moveNumber, color } = plyToMove(star.ply);
  const { san } = parseMove(star.move);
  const actual = sanList(g.pgn)[star.ply];
  if (color !== g.userColor) problems.push(`${star.id}: ply ${star.ply} is ${color} but ${USER} played ${g.userColor}`);
  if (actual !== san) problems.push(`${star.id}: ply ${star.ply} is ${actual}, list says ${san}`);
  starsByGame.set(star.id, [{ moveNumber, san }]);
}
for (const rev of unratedReviewMoves) {
  const g = games.get(rev.id);
  if (!g) {
    problems.push(`${rev.id}: not in archives`);
    continue;
  }
  const { moveNumber, san } = parseMove(rev.move);
  const idx = 2 * (moveNumber - 1) + (g.userColor === "w" ? 0 : 1);
  if (sanList(g.pgn)[idx] !== san) problems.push(`${rev.id}: move ${rev.move} is not ${sanList(g.pgn)[idx]}`);
}
if (problems.length) {
  console.error("REFUSING to write labels — unverified stars:");
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}

// ── Halves. Stars and non-stars alternated separately, fit first, id-sorted.
const byId = (a, b) => (a.id.length - b.id.length) || a.id.localeCompare(b.id);
// LIVE games only — and the reason has changed, so read it before "fixing" this.
// It was originally caution: nothing on the page said whether daily games were
// indexed. They ARE — other accounts' lists contain /analysis/game/daily/ entries.
// The exclusion stays anyway, because LouisMcdade has exactly one rated daily
// game (two moves long, no candidates) and the split below is assigned by walking
// an id-sorted list. Inserting a game in the MIDDLE of that list flips the half of
// every game after it, which is precisely the silent re-roll the split is designed
// to prevent. Appending later games is safe; inserting an old one is not. A
// two-move game is not worth re-rolling 292 assignments for.
const rated = [...games.values()].filter((g) => g.rated && g.url.includes("/game/live/"));
const half = new Map();
for (const group of [
  rated.filter((g) => starsByGame.has(g.id)),
  rated.filter((g) => !starsByGame.has(g.id)),
]) {
  group.sort(byId).forEach((g, i) => half.set(g.id, i % 2 === 0 ? "fit" : "test"));
}
for (const rev of unratedReviewMoves) half.set(rev.id, "guard");

const emit = [
  ...rated.sort(byId),
  ...unratedReviewMoves.map((r) => games.get(r.id)),
];

const wrap = (s, indent = "      ") => {
  const out = [];
  let line = "";
  for (const tok of s.split(" ")) {
    if (line.length + tok.length > 78) {
      out.push(line.trimEnd());
      line = "";
    }
    line += tok + " ";
  }
  if (line.trim()) out.push(line.trimEnd());
  return out.map((l) => `${indent}"${l} "`).join(" +\n").replace(/ "$/, '"');
};

const expectedFor = (g) => {
  const stars = starsByGame.get(g.id);
  if (stars) return `[${stars.map((m) => `{ moveNumber: ${m.moveNumber}, san: "${m.san}" }`).join(", ")}]`;
  const rev = unratedReviewMoves.find((r) => r.id === g.id);
  if (rev) {
    const m = parseMove(rev.move);
    return `[{ moveNumber: ${m.moveNumber}, san: "${m.san}" }]`;
  }
  return "[]";
};

const noteFor = (g) => {
  if (starsByGame.has(g.id)) {
    const star = brilliantMoves.find((s) => s.id === g.id);
    return `chess.com stars ${star.move} here (Advanced Stats, all-time list). Complete: any OTHER move we flag in this game is a false positive.`;
  }
  const rev = unratedReviewMoves.find((r) => r.id === g.id);
  if (rev) {
    return `chess.com Game Review stars ${rev.move}. UNRATED, so the all-time list does not cover this game — the rest of it is unlabelled, not negative.`;
  }
  return "chess.com's all-time list has no brilliancy in this game. Exact — anything we flag here is a false positive.";
};

let out = `/**
 * chess.com's own labels for LouisMcdade's games — the ground truth this project
 * exists to approximate, and the only labels here that weren't written by us.
 *
 * Derived from chess.com's all-time Brilliant Moves list (Advanced Stats), which
 * publishes every starred move with its location. That list is exhaustive over
 * RATED games, so a rated game with no entry is a complete negative: everything
 * the detector flags in it is a false positive, and nothing has to be read by
 * hand to establish that. See scripts/brilliant-moves-louismcdade.mjs.
 *
 * The two \`guard\` games at the end are UNRATED and come from full Game Review.
 * Their positives are solid; their negatives are unknown, because the all-time
 * list does not cover unrated games.
 *
 * \`half\` is the fit/test split — see the note at the top of make-labels.mjs for
 * the rule, why it is computed rather than hand-frozen, and what it costs.
 *
 *   fit    may be looked at freely when inventing a rule.
 *   test   held back. Look at it to REPORT a number, not to choose one.
 *   guard  confirmed positives; never fitted on, only used to catch a rule that
 *          destroys a known brilliancy.
 *
 * Generated by scripts/make-labels.mjs — regenerate it, don't edit it.
 */
export const chesscomLabels = [
`;

for (const g of emit) {
  const stars = starsByGame.get(g.id);
  const rev = unratedReviewMoves.find((r) => r.id === g.id);
  const count = stars ? stars.length : rev ? 1 : 0;
  out += `  {
    id: "${g.id}",
    url: "${g.url}",
    name: "vs ${g.opp} — ${count === 0 ? "no brilliancy" : `${count} brilliancy`} (chess.com)",
    userColor: "${g.userColor}",
    rated: ${g.rated},
    date: "${g.date}",
    count: ${count},
    source: "${rev ? "review" : "advanced-stats"}",
    half: "${half.get(g.id)}",
    // ${noteFor(g)}
    expected: ${expectedFor(g)},
    pgn:
${wrap(g.pgn)},
  },
`;
}
out += "];\n";

writeFileSync("scripts/labels-louismcdade.mjs", out);

const counts = { fit: 0, test: 0, guard: 0 };
for (const g of emit) counts[half.get(g.id)]++;
console.error(
  `wrote ${emit.length} labelled games — ${counts.fit} fit / ${counts.test} test / ${counts.guard} guard, ` +
    `${brilliantMoves.length + unratedReviewMoves.length} positives`,
);
