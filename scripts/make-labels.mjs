/**
 * One-off generator: turn the collected chess.com labels into a data file.
 *
 * Only ZERO-count games are emitted as labels here, and that restriction is the
 * point. chess.com's post-game summary is unlimited but over-counts relative to
 * full Game Review, so "0 brilliancies" is exact and complete while "1" only
 * tells you a star exists somewhere — not that it's on the move we flagged. A
 * pile of exact negatives is worth more than a pile of maybes, especially for a
 * detector whose problem is false positives.
 *
 *   node scripts/make-labels.mjs > scripts/labels-louismcdade.mjs
 */
import { writeFileSync } from "node:fs";

const USER = "louismcdade";

// gameId -> brilliancies chess.com reports for LouisMcdade's side.
// "review" = confirmed in full Game Review (authoritative about WHICH move).
// "summary" = post-game highlights (exact only when the count is 0).
//
// `half` is the fit/test split, and it is written down HERE, by hand, on purpose.
// A split computed at runtime is a split that silently re-rolls every time the
// set grows — and a re-rollable split is one you can keep re-rolling until the
// numbers look good, which defeats the entire point of holding data back. Frozen
// in source, any change to it shows up in a diff and has to be argued for.
//
// The assignment rule was: order the 14 exact-negative games by chess.com game id
// (which is chronological, and knows nothing about what the detector flags) and
// alternate fit/test down the list. Interleaving by date rather than splitting at
// a date also keeps the halves from differing by rating or era.
//
// The two Game-Review-confirmed POSITIVES are not split. Two examples cannot be
// halved into anything that measures recall; instead both sit in the guard set
// with the classical fixtures, where their only job is to fail loudly if a new
// rule kills a known brilliancy.
const LABELS = {
  // — confirmed by full Game Review — guard set, never used for fitting —
  "168334603690": { n: 1, src: "review", move: "6...Bxf2+", half: "guard" },
  "169999249810": { n: 1, src: "review", move: "24.Ne6", half: "guard" },
  // Resolved in Game Review 2026-07-28. This one was worth a whole review on its
  // own: we flagged TWO moves and chess.com stars exactly one, so a single
  // lookup produced a confirmed positive AND a confirmed false positive.
  // 16...Qxc3 is starred (direct offer). 31...Rc5+ is not (discovered offer) —
  // consistent with the discovered pattern, though Légal's Mate already showed
  // that pattern can't be promoted to a rule.
  "169869209718": { n: 1, src: "review", move: "16...Qxc3", half: "guard" },
  // — summary, zero: exact and complete. Ordered by id; fit/test alternating. —
  "59328109305": { n: 0, src: "summary", half: "fit" },
  "69023093493": { n: 0, src: "summary", half: "test" },
  "69169474795": { n: 0, src: "summary", half: "fit" },
  "71922350989": { n: 0, src: "summary", half: "test" },
  "75090176179": { n: 0, src: "summary", half: "fit" },
  "75729696237": { n: 0, src: "summary", half: "test" },
  "78155551321": { n: 0, src: "summary", half: "fit" },
  "123030583107": { n: 0, src: "summary", half: "test" },
  "123984651203": { n: 0, src: "summary", half: "fit" },
  "167769830480": { n: 0, src: "summary", half: "test" },
  "169135347664": { n: 0, src: "summary", half: "fit" },
  "170905472716": { n: 0, src: "summary", half: "test" },
  "171329245690": { n: 0, src: "summary", half: "fit" },
  "171473275764": { n: 0, src: "summary", half: "test" },
  // — summary, one: a star exists, but not necessarily on the move we flag —
  "172078598998": { n: 1, src: "summary", guess: "15...Nxd3+", half: "unscored" },
  "170344245882": { n: 1, src: "summary", guess: "41.Qf6+", half: "unscored" },
  "72012130191": { n: 1, src: "summary", guess: "23...Nd4+", half: "unscored" },
  "166907239486": { n: 1, src: "summary", guess: "11.Nxd5", half: "unscored" },
};


// A game is scoreable only when we know WHICH move chess.com starred: zero-count
// games (nothing is starred) and Game-Review-confirmed games. A summary count of
// 1 tells us a star exists but not where, so it stays null.
const expected = (lab) => {
  if (lab.n === 0) return "[]";
  if (lab.src === "review" && lab.move) {
    const m = lab.move.match(/^(\d+)\.+(.+)$/);
    return `[{ moveNumber: ${m[1]}, san: "${m[2]}" }]`;
  }
  return "null";
};

async function getJson(url) {
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}

const months = (await getJson(`https://api.chess.com/pub/player/${USER}/games/archives`)).archives;
const found = new Map();

for (let i = months.length - 1; i >= 0 && found.size < Object.keys(LABELS).length; i--) {
  let games;
  try {
    ({ games } = await getJson(months[i]));
  } catch {
    continue;
  }
  for (const g of games ?? []) {
    const id = String(g.url).split("/").pop();
    if (!LABELS[id] || found.has(id)) continue;
    const userColor = (g.white?.username ?? "").toLowerCase() === USER ? "w" : "b";
    const moves = (g.pgn.split(/\n\n/)[1] ?? "")
      .replace(/\{[^}]*\}/g, "")
      .replace(/\d+\.\.\./g, "")
      .replace(/\s+/g, " ")
      .trim();
    found.set(id, {
      url: g.url,
      userColor,
      opp: userColor === "w" ? g.black?.username : g.white?.username,
      pgn: moves,
    });
  }
}

const missing = Object.keys(LABELS).filter((id) => !found.has(id));
if (missing.length) console.error("NOT FOUND in archives:", missing.join(", "));

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

let out = `/**
 * chess.com's own labels for LouisMcdade's games — the ground truth this project
 * exists to approximate, and the only labels here that weren't written by us.
 *
 * Collected from chess.com Game Review and post-game summaries. The summary
 * over-counts relative to Game Review, so a count of 0 is exact and a count of 1
 * only means a star exists somewhere in the game. Games with a nonzero count are
 * therefore recorded but NOT turned into positive fixtures: claiming the star is
 * on the move we happened to flag would be assuming what we're trying to test.
 *
 * \`half\` is the fit/test split — see the note above LABELS in make-labels.mjs
 * for how it was assigned and why it is frozen in source rather than computed.
 *
 *   fit       may be looked at freely when inventing a rule.
 *   test      held back. Look at it to REPORT a number, not to choose one.
 *   guard     confirmed positives; never fitted on, only used to catch a rule
 *             that destroys a known brilliancy.
 *   unscored  a star exists but its location is unknown, so the game cannot be
 *             scored either way.
 *
 * Generated by scripts/make-labels.mjs. Edit LABELS there, not this file.
 */
export const chesscomLabels = [
`;

for (const [id, lab] of Object.entries(LABELS)) {
  const g = found.get(id);
  if (!g) continue;
  const note =
    lab.n === 0
      ? "chess.com: zero brilliancies for this side. Exact — anything we flag here is a false positive."
      : `chess.com: ${lab.n} brilliancy (${lab.src}).${lab.move ? ` Confirmed move: ${lab.move}.` : lab.guess ? ` We flag ${lab.guess}; unconfirmed which move chess.com starred.` : ""}${lab.note ? ` ${lab.note}` : ""}`;
  out += `  {
    id: "${id}",
    url: "${g.url}",
    name: "vs ${g.opp} — ${lab.n === 0 ? "no brilliancy" : `${lab.n} brilliancy`} (chess.com)",
    userColor: "${g.userColor}",
    count: ${lab.n},
    source: "${lab.src}",
    half: "${lab.half}",
    // ${note}
    expected: ${expected(lab)},${lab.n > 0 && lab.src !== "review" ? " // unknown which move — not scoreable as a positive" : ""}
    pgn:
${wrap(g.pgn)},
  },
`;
}
out += "];\n";

writeFileSync("scripts/labels-louismcdade.mjs", out);
console.error(`wrote ${found.size} labelled games`);
