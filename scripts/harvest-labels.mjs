/**
 * Harvest a labelled dataset from a chess.com account.
 *
 * This exists because the project's bottleneck is not modelling, it is LABELS.
 * As of 2026-07-28 there were ~46 labelled candidates and only 10 positives, of
 * which 3 were actual chess.com labels. Nothing — decision tree, symbolic
 * regression, hand-tuned threshold — can be honestly fitted on that.
 *
 * WHY NOT label-checklist.mjs: that script parses diag-account output, which
 * prints only moves we FLAGGED. A game where chess.com starred something and we
 * rejected it looks clean there. That is exactly how 24.Ne6 hid — it was
 * rejected by the `necessary` gate, so it never appeared in any flag list. This
 * script records every move that reached the engine, flagged or not, which is
 * the only way false negatives become visible.
 *
 * Two passes, because one half of labelling is free and the other is not:
 *
 *   1. SCAN (this script, expensive but automatic) — run the real detector over
 *      N games and record every candidate with its full feature vector.
 *   2. COUNT (you, cheap but manual) — open the unresolved games on chess.com and
 *      read the post-game summary's Brilliant count into harvest-counts.mjs.
 *
 * Re-run afterwards and it resolves what it can, writes the dataset, and prints a
 * shorter checklist. Scan results are cached to JSON so step 2 never costs engine
 * time twice.
 *
 * Prereq: the dev server must be running (npm run dev).
 *
 *   node scripts/harvest-labels.mjs louismcdade 250
 *   node scripts/harvest-labels.mjs louismcdade 250 --rescan   # ignore the cache
 *   DEPTH=18 node scripts/harvest-labels.mjs louismcdade 100
 */
import { chromium } from "playwright";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { chesscomLabels } from "./labels-louismcdade.mjs";
import { COUNTS } from "./harvest-counts.mjs";

const USER = process.argv[2] ?? "louismcdade";
const LIMIT = Number(process.argv[3] ?? 100);
const DEPTH = Number(process.env.DEPTH) || 14;
const RESCAN = process.argv.includes("--rescan");

const CACHE = `scripts/harvest-${USER}.json`;
const CSV = `scripts/dataset-${USER}.csv`;

/** chess.com's numeric game id, the key every label file in this repo uses. */
const gameId = (url) => String(url).split("/").pop();

/** Counts from both sources. labels-louismcdade.mjs is richer, so it wins. */
const knownCounts = new Map(Object.entries(COUNTS).map(([id, n]) => [id, { count: n, source: "summary" }]));
/** Games where we know WHICH move was starred — these give a positive directly. */
const knownMove = new Map();
/** Games where the two sources disagree about the count. Never silently merged. */
const conflicts = [];
for (const g of chesscomLabels) {
  const fromCounts = knownCounts.get(g.id);
  // A disagreement means one of the two readings is wrong, and picking the
  // "richer" source silently would bake a bad label into the dataset for good.
  // Labels are the scarce resource here; a wrong one is worse than a missing one.
  if (fromCounts && fromCounts.count !== g.count) {
    conflicts.push({ id: g.id, counts: fromCounts.count, labels: g.count, source: g.source });
  }
  knownCounts.set(g.id, { count: g.count, source: g.source });
  if (g.expected?.length) knownMove.set(g.id, new Set(g.expected.map((m) => `${m.moveNumber} ${m.san}`)));
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

/** Scan games and record EVERY candidate. Cached — this is the expensive half. */
async function scan() {
  const browser = await launch();
  const page = await browser.newPage();
  page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
  await page.goto("http://localhost:5173/", { waitUntil: "networkidle" });

  const games = await page.evaluate(
    async ({ user, limit }) => {
      const api = await import("/src/api/chesscom.ts");
      const list = await api.fetchRecentGames(user, limit);
      return list.map((g) => ({ id: g.id, url: g.url, userColor: g.userColor, pgn: g.pgn }));
    },
    { user: USER, limit: LIMIT },
  );

  console.error(`scanning ${games.length} games at depth ${DEPTH}…`);
  const out = [];
  for (let i = 0; i < games.length; i++) {
    const g = games[i];
    try {
      const candidates = await page.evaluate(
        async ({ game, depth }) => {
          const bril = await import("/src/engine/brilliancy.ts");
          const seen = [];
          // rejectShapes:[] — a harvester must record what the RULES would drop,
          // or the dataset can only ever confirm the rules it was built under.
          await bril.scanGame(
            { ...game, timeClass: "blitz", timeControl: "", rated: true, endTime: 0,
              result: "win", resultReason: "", oppUsername: "opponent" },
            { depth, rejectShapes: [], onCandidate: (c) => seen.push(c) },
          );
          return seen.map((c) => ({
            moveNumber: c.moveNumber,
            san: c.san,
            sacrifice: c.sacrifice,
            sacSquare: c.sacSquare,
            playedEval: c.playedEval,
            evalLoss: c.evalLoss,
            quietAlt: isFinite(c.quietAlt) ? c.quietAlt : null,
            shape: c.shape,
            accepted: c.accepted,
            rejectedBy: c.rejectedBy,
          }));
        },
        { game: g, depth: DEPTH },
      );
      // Key on the NUMERIC id from the URL, not the API's `id`. fetchRecentGames
      // sets `id: raw.uuid ?? raw.url`, so it is a UUID, while every label file
      // here keys on the number in the game URL. Mixing the two silently matches
      // nothing and reports a fully unlabelled dataset — which is exactly what
      // the first run of this script did.
      out.push({ id: gameId(g.url), url: g.url, userColor: g.userColor, candidates });
    } catch (e) {
      console.error(`ERR ${g.url} — ${String(e).split(/\r?\n/)[0]}`);
    }
    if ((i + 1) % 25 === 0) console.error(`  …${i + 1}/${games.length}`);
  }

  await browser.close();
  // Record the LIMIT that was asked for, not just how many games came back. The
  // account has fewer games than a round-number request, so comparing the cache
  // against `games.length` means `... 400` never matches a 398-game archive and
  // rescans every single run.
  writeFileSync(CACHE, JSON.stringify({ user: USER, depth: DEPTH, limit: LIMIT, scannedAt: new Date().toISOString(), games: out }, null, 1));
  return out;
}

let games;
const cached = !RESCAN && existsSync(CACHE) ? JSON.parse(readFileSync(CACHE, "utf8")) : null;
// Reuse the cache only if it covers what was asked for. Without the length check
// a later `... 396` silently reports on a cached 60 and looks like the account
// simply has fewer games than it does.
if (cached && (cached.limit ?? 0) >= LIMIT && cached.depth === DEPTH) {
  games = cached.games;
  console.error(`using cached scan of ${games.length} games (${cached.scannedAt}); --rescan to redo\n`);
} else {
  if (cached) console.error(`cache holds ${cached.games.length} games at depth ${cached.depth}; rescanning for ${LIMIT} at depth ${DEPTH}`);
  games = await scan();
}

// ─── resolve labels ──────────────────────────────────────────────────────────
//
// A candidate is labelled only when the count makes it UNAMBIGUOUS. Guessing
// that the star sits on the move we happened to flag would assume exactly the
// thing under test, which is the mistake this project has already avoided twice.
const rows = [];
const unresolved = [];
let pos = 0;
let neg = 0;
const preFilterMisses = [];

for (const g of games) {
  // Tolerate caches written before the id fix by re-deriving from the URL.
  const id = gameId(g.url);
  const known = knownCounts.get(id);
  const moves = knownMove.get(id);

  if (!known) {
    unresolved.push(g);
    continue;
  }

  // chess.com starred something but nothing even reached the engine: the
  // sacrifice pre-filter is blind here, and no gate tuning can reach it.
  if (known.count > 0 && g.candidates.length === 0) preFilterMisses.push(g);

  for (const c of g.candidates) {
    let label = null;
    if (known.count === 0) label = 0; // exact: nothing starred, so nothing here is
    else if (moves) label = moves.has(`${c.moveNumber} ${c.san}`) ? 1 : 0; // review-confirmed
    else if (known.count === 1 && g.candidates.length === 1) label = 1; // only one thing it could be
    if (label === null) continue;
    label ? pos++ : neg++;
    rows.push({ gameId: id, userColor: g.userColor, ...c, margin: c.quietAlt === null ? "" : c.playedEval - c.quietAlt, label });
  }
  if (known.count > 0 && !moves && g.candidates.length > 1) unresolved.push(g);
}

// ─── dataset ─────────────────────────────────────────────────────────────────
const COLS = ["gameId","userColor","moveNumber","san","sacrifice","sacSquare","playedEval","evalLoss","quietAlt","margin","shape","accepted","rejectedBy","label"];
const csv = [COLS.join(",")];
for (const r of rows) csv.push(COLS.map((k) => (r[k] === null || r[k] === undefined ? "" : String(r[k]))).join(","));
writeFileSync(CSV, csv.join("\n") + "\n");

// ─── report ──────────────────────────────────────────────────────────────────
const totalCandidates = games.reduce((n, g) => n + g.candidates.length, 0);
console.log(`${games.length} games scanned · ${totalCandidates} candidates reached the engine`);
console.log(`LABELLED: ${rows.length}  (${pos} positive, ${neg} negative)  →  ${CSV}`);
console.log(`unlabelled: ${totalCandidates - rows.length} candidates across ${unresolved.length} games\n`);

if (pos < 20) {
  console.log(`⚠  ${pos} positives. Fitting anything below ~20 will describe the sample, not the rule.\n`);
}

if (conflicts.length) {
  console.log(`── ⚠ COUNT CONFLICTS — resolve before trusting these games ──`);
  for (const c of conflicts) {
    console.log(`   https://www.chess.com/game/live/${c.id}`);
    console.log(`     harvest-counts.mjs says ${c.counts}, labels-louismcdade.mjs says ${c.labels} (${c.source})`);
  }
  console.log(`   Using the labels-louismcdade value. Recheck the summary and fix one.\n`);
}

if (preFilterMisses.length) {
  console.log(`── PRE-FILTER MISSES — chess.com starred a move we never even considered:`);
  for (const g of preFilterMisses) console.log(`   ${g.url}`);
  console.log("   No gate change can reach these; the sacrifice test itself is blind here.\n");
}

// Ordering: rank by how close a game came to producing a brilliancy, NOT by how
// cleanly a count would resolve it.
//
// The first version sorted single-candidate games first, on the argument that a
// count always resolves them. True, and nearly useless: it put moves played from
// dead-lost positions at the top (margin -100546, rejected by `sound`) because
// they happen to be alone in their game. The answer there is 0 and everyone
// already knows it. A label is only worth collecting where the detector is
// UNCERTAIN.
//
// So score each candidate by its total shortfall across the gates — the
// centipawns it would have needed to be flagged — and rank each game by its
// closest call. A flagged move scores 0. A move that missed `necessary` by 20cp
// scores 20. A move that was simply losing scores in the thousands and sinks.
const STILL_GOOD = 20;
const MAX_EVAL_LOSS = 120;
const NECESSARY_MARGIN = 50;
const shortfall = (c) => {
  const margin = c.quietAlt === null ? -Infinity : c.playedEval - c.quietAlt;
  return (
    Math.max(0, STILL_GOOD - c.playedEval) +
    Math.max(0, c.evalLoss - MAX_EVAL_LOSS) +
    (margin === -Infinity ? 500 : Math.max(0, NECESSARY_MARGIN - margin))
  );
};
const closest = (g) => (g.candidates.length ? Math.min(...g.candidates.map(shortfall)) : Infinity);
unresolved.sort((a, b) => closest(a) - closest(b));

const CHECK = unresolved.filter((g) => g.candidates.length > 0).slice(0, 40);
if (CHECK.length) {
  console.log(`── CHECK THESE (${CHECK.length} shown, best value first) ──`);
  console.log(`Open each, read the post-game summary's Brilliant count for ${USER},`);
  console.log(`then add  "<id>": <count>  to scripts/harvest-counts.mjs and re-run.\n`);
  for (const g of CHECK) {
    const n = g.candidates.length;
    const d = closest(g);
    const near = d === 0 ? "WE FLAG IT — a 0 here is a false positive" : `missed by ${d}cp`;
    const tag = n === 1 ? `1 candidate, ${near}` : `${n} candidates (a 0 labels all ${n}), ${near}`;
    console.log(`  ${g.url}`);
    console.log(`      ${tag}`);
    for (const c of g.candidates) {
      const m = c.quietAlt === null ? "n/a" : c.playedEval - c.quietAlt;
      console.log(
        `        ${c.moveNumber}${g.userColor === "w" ? "." : "…"}${c.san.padEnd(9)}` +
          `${(c.rejectedBy ? "rejected:" + c.rejectedBy : "FLAGGED").padEnd(20)} margin ${String(m).padStart(6)}  ` +
          `${c.shape.padEnd(10)} short ${String(shortfall(c)).padStart(5)}cp`,
      );
    }
  }
}
