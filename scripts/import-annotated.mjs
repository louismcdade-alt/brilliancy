/**
 * Import human-annotated games and harvest the moves marked `!!` as POSITIVES.
 *
 * The two label sources this project has are trustworthy for opposite classes,
 * which is the whole reason to run both:
 *
 *   chess.com zero-count games  reliable NEGATIVES. Nothing in the game is
 *                               starred, so every candidate is a confirmed no.
 *                               Useless for positives — the counts are noisy and
 *                               over-report (see harvest-counts.mjs).
 *   annotated `!!`              reliable POSITIVES. A human deliberately marked
 *                               that move brilliant.
 *
 * CRITICAL: an annotated game does NOT give negatives. Annotators are selective —
 * they mark what they want to talk about, and silence is not a verdict. Labelling
 * the other candidates 0 would invent negatives out of an annotator's editorial
 * choices, which is the same mistake as reading a noisy summary count as truth.
 * So this script emits positives only, and leaves everything else unlabelled.
 *
 * Caveat worth keeping in view: annotation-tradition `!!` is not chess.com's `!!`.
 * It is arguably the better target — chess.com's label is itself an approximation
 * of this tradition — but it is a different one, and these games are masters
 * rather than 400-rated blitz, so the position distribution differs too.
 *
 * Prereq: the dev server must be running (npm run dev).
 *
 *   node scripts/import-annotated.mjs path/to/games.pgn [more.pgn ...]
 *   DEPTH=18 node scripts/import-annotated.mjs games.pgn
 */
import { chromium } from "playwright";
import { readFileSync, writeFileSync } from "node:fs";

const FILES = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const DEPTH = Number(process.env.DEPTH) || 14;
const OUT = "scripts/dataset-annotated.csv";

if (!FILES.length) {
  console.error("Usage: node scripts/import-annotated.mjs <file.pgn> [...]");
  process.exit(1);
}

/**
 * Split a PGN file into games and pull out the `!!` moves.
 *
 * Done by hand rather than with chess.js because loadPgn discards annotations —
 * the very thing we are here for. Handles both spellings: a `!!` suffix glued to
 * the SAN, and the language-independent NAG `$3`.
 */
function parseAnnotated(text) {
  const games = [];
  // Games are separated by a blank line before the next [Event tag.
  const chunks = text.split(/\n\s*\n(?=\[Event )/);
  for (const chunk of chunks) {
    const headerEnd = chunk.lastIndexOf("]");
    if (headerEnd < 0) continue;
    const headers = chunk.slice(0, headerEnd + 1);
    const movetext = chunk.slice(headerEnd + 1);
    const tag = (name) => (headers.match(new RegExp(`\\[${name}\\s+"([^"]*)"`)) ?? [])[1] ?? "?";

    // Strip comments and variations before counting move numbers, or a `!!`
    // inside a sideline would be attributed to the main line.
    let clean = movetext.replace(/\{[^}]*\}/g, " ").replace(/;[^\n]*/g, " ");
    let prev;
    do {
      prev = clean;
      clean = clean.replace(/\([^()]*\)/g, " ");
    } while (clean !== prev);

    // Walk the main line, tracking move number and side, recording annotated moves.
    const brilliant = [];
    // Move numbers are frequently glued to the move — "29.fxe4!!" is one token in
    // real PGN, not two. Splitting on whitespace alone silently drops every such
    // move, which made this importer report zero annotations on a file that
    // demonstrably had one.
    const tokens = clean.replace(/(\d+)\s*\.(\.\.)?/g, " $1.$2 ").split(/\s+/).filter(Boolean);
    let moveNumber = 0;
    let white = true;
    let lastSan = null;
    for (const tok of tokens) {
      const num = tok.match(/^(\d+)\.(\.\.)?$/);
      if (num) {
        moveNumber = Number(num[1]);
        white = !num[2];
        continue;
      }
      if (/^(1-0|0-1|1\/2-1\/2|\*)$/.test(tok)) continue;
      // A bare NAG applies to the move before it.
      if (/^\$\d+$/.test(tok)) {
        if (tok === "$3" && lastSan) brilliant.push({ ...lastSan });
        continue;
      }
      const m = tok.match(/^([KQRBNOa-h][^!?]*?)([!?]*)$/);
      if (!m) continue;
      const san = m[1].replace(/[+#]?$/, (s) => s); // keep check/mate marks
      lastSan = { moveNumber, color: white ? "w" : "b", san };
      if (m[2] === "!!") brilliant.push({ ...lastSan });
      // In `12. e4 e5`, the number token precedes White; Black follows without one.
      if (white) white = false;
      else moveNumber = 0;
    }

    if (!brilliant.length) continue;
    games.push({
      name: `${tag("White")}–${tag("Black")} ${tag("Event")} ${tag("Date")}`.trim(),
      pgn: movetext.replace(/\s+/g, " ").trim(),
      brilliant,
    });
  }
  return games;
}

const all = [];
for (const f of FILES) {
  const found = parseAnnotated(readFileSync(f, "utf8"));
  console.error(`${f}: ${found.length} games carrying a !!  (${found.reduce((n, g) => n + g.brilliant.length, 0)} marked moves)`);
  all.push(...found);
}
if (!all.length) {
  console.error("No annotated moves found. This file has no !! or $3 markers.");
  process.exit(1);
}

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

const browser = await launch();
const page = await browser.newPage();
page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
await page.goto("http://localhost:5173/", { waitUntil: "networkidle" });

const rows = [];
/** `!!` moves our sacrifice pre-filter never even considered — a blind spot. */
const preFilterMisses = [];

for (const g of all) {
  // Each annotated move is judged from ITS OWN side, so a game with a !! for
  // each player is scanned twice.
  for (const color of [...new Set(g.brilliant.map((b) => b.color))]) {
    let candidates;
    try {
      candidates = await page.evaluate(
        async ({ pgn, userColor, depth }) => {
          const bril = await import("/src/engine/brilliancy.ts");
          const seen = [];
          await bril.scanGame(
            { id: "x", url: "", pgn, timeClass: "classical", timeControl: "", rated: true,
              endTime: 0, userColor, result: "win", resultReason: "", oppUsername: "opp" },
            { depth, rejectShapes: [], onCandidate: (c) => seen.push(c) },
          );
          return seen;
        },
        { pgn: g.pgn, userColor: color, depth: DEPTH },
      );
    } catch (e) {
      console.error(`ERR ${g.name} — ${String(e).split(/\r?\n/)[0]}`);
      continue;
    }

    const want = g.brilliant.filter((b) => b.color === color);
    const key = (m) => `${m.moveNumber} ${m.san}`;
    const seenKeys = new Set(candidates.map(key));

    for (const b of want) {
      if (!seenKeys.has(key(b))) {
        preFilterMisses.push({ game: g.name, move: `${b.moveNumber}${color === "w" ? "." : "..."}${b.san}` });
      }
    }

    for (const c of candidates) {
      // POSITIVES ONLY. An unannotated candidate is unknown, not negative.
      if (!want.some((b) => key(b) === key(c))) continue;
      rows.push({
        source: "annotated",
        game: g.name.replace(/,/g, ";"),
        userColor: color,
        moveNumber: c.moveNumber,
        san: c.san,
        sacrifice: c.sacrifice,
        playedEval: c.playedEval,
        evalLoss: c.evalLoss,
        quietAlt: isFinite(c.quietAlt) ? c.quietAlt : "",
        margin: isFinite(c.quietAlt) ? c.playedEval - c.quietAlt : "",
        shape: c.shape,
        accepted: c.accepted,
        rejectedBy: c.rejectedBy,
        label: 1,
      });
    }
  }
}

const COLS = ["source","game","userColor","moveNumber","san","sacrifice","playedEval","evalLoss","quietAlt","margin","shape","accepted","rejectedBy","label"];
writeFileSync(OUT, [COLS.join(","), ...rows.map((r) => COLS.map((k) => String(r[k] ?? "")).join(","))].join("\n") + "\n");

console.log(`\n${rows.length} annotated positives written to ${OUT}`);
const wouldFlag = rows.filter((r) => r.rejectedBy === null || r.rejectedBy === "null").length;
console.log(`of those, the detector currently flags ${wouldFlag} and rejects ${rows.length - wouldFlag}`);
if (preFilterMisses.length) {
  console.log(`\n${preFilterMisses.length} annotated !! never reached the engine — the SACRIFICE`);
  console.log(`pre-filter does not see these at all, which no gate tuning can fix:`);
  for (const m of preFilterMisses) console.log(`   ${m.move.padEnd(12)} ${m.game}`);
}

await browser.close();
