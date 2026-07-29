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
 * ONE PASS NOW (2026-07-29). This used to be two: scan automatically, then read
 * post-game summary counts by hand into harvest-counts.mjs to resolve them.
 * chess.com's all-time Brilliant Moves list made the manual half redundant —
 * labels-louismcdade.mjs now carries an exact `expected` list for every rated
 * game, so a scan resolves itself. The hand-read counts are no longer consulted
 * at all; they disagreed with chess.com's own list once (170905472716), which is
 * reason enough not to mix them in.
 *
 * ALLOW-CANDIDATES ARE ADMITTED HERE AND ONLY HERE. The scan runs with
 * `admitAllow: true`, so moves that expose nothing new but leave material on the
 * table get searched and recorded. The app does not do this and nothing flags on
 * it — the point is to find out what a rule admitting them would cost, using 366
 * confirmed negatives to price it. It roughly doubles the number of searches:
 * 381 offer candidates become ~896.
 *
 * Scan results are cached to JSON. The cache records a SCHEMA version, so adding
 * a feature column invalidates it rather than silently reporting a dataset with
 * the new columns blank.
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

const USER = process.argv[2] ?? "louismcdade";
const LIMIT = Number(process.argv[3] ?? 100);
const DEPTH = Number(process.env.DEPTH) || 14;
const RESCAN = process.argv.includes("--rescan");

const CACHE = `scripts/harvest-${USER}.json`;
const CSV = `scripts/dataset-${USER}.csv`;

/** chess.com's numeric game id, the key every label file in this repo uses. */
const gameId = (url) => String(url).split("/").pop();

/** Bump when a feature column is added, so stale caches rescan instead of lying. */
const SCHEMA = 2;

/** Every labelled game, keyed by chess.com's numeric id. */
const knownCounts = new Map();
/** Games where we know WHICH move was starred — these give a positive directly. */
const knownMove = new Map();
for (const g of chesscomLabels) {
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
          // admitAllow — same argument one level earlier: a dataset that only
          // contains moves the pre-filter admits cannot price the pre-filter.
          await bril.scanGame(
            { ...game, timeClass: "blitz", timeControl: "", rated: true, endTime: 0,
              result: "win", resultReason: "", oppUsername: "opponent" },
            { depth, rejectShapes: [], admitAllow: true, onCandidate: (c) => seen.push(c) },
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
            admitted: c.admitted,
            fresh: c.fresh,
            freshSquare: c.freshSquare,
            standing: c.standing,
            standingSquare: c.standingSquare,
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
  writeFileSync(CACHE, JSON.stringify({ user: USER, schema: SCHEMA, depth: DEPTH, limit: LIMIT, scannedAt: new Date().toISOString(), games: out }, null, 1));
  return out;
}

let games;
const cached = !RESCAN && existsSync(CACHE) ? JSON.parse(readFileSync(CACHE, "utf8")) : null;
// Reuse the cache only if it covers what was asked for. Without the length check
// a later `... 396` silently reports on a cached 60 and looks like the account
// simply has fewer games than it does.
if (cached && (cached.limit ?? 0) >= LIMIT && cached.depth === DEPTH && cached.schema === SCHEMA) {
  games = cached.games;
  console.error(`using cached scan of ${games.length} games (${cached.scannedAt}); --rescan to redo\n`);
} else {
  if (cached) console.error(`cache holds ${cached.games.length} games at depth ${cached.depth} (schema ${cached.schema ?? 1}); rescanning ${LIMIT} at depth ${DEPTH} for schema ${SCHEMA}`);
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
    // `moves` only ever comes from a full Game Review, so it is checked FIRST and
    // is the only path that can produce a positive. The old "count 1 with exactly
    // one candidate ⇒ that's the star" shortcut is gone: it inherited the
    // summary's noise, and it manufactured three positives that had to be
    // withdrawn.
    if (moves) label = moves.has(`${c.moveNumber} ${c.san}`) ? 1 : 0;
    else if (known.unresolved) label = null; // disputed reads ⇒ no label at all
    else if (known.count === 0) label = 0; // unanimous zero: nothing here is starred
    if (label === null) continue;
    label ? pos++ : neg++;
    rows.push({ gameId: id, userColor: g.userColor, ...c, margin: c.quietAlt === null ? "" : c.playedEval - c.quietAlt, label });
  }
  if (!moves && (known.unresolved || known.count > 0)) unresolved.push(g);
}

// ─── dataset ─────────────────────────────────────────────────────────────────
const COLS = ["gameId","userColor","moveNumber","san","sacrifice","sacSquare","playedEval","evalLoss","quietAlt","margin","shape","accepted","admitted","fresh","standing","rejectedBy","label"];
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
  console.log(`These are UNRATED games. chess.com's all-time list only covers rated ones,`);
  console.log(`so nothing here is labelled either way. The summary count is not an answer —`);
  console.log(`it is non-deterministic and it has been wrong in both directions. Only a full`);
  console.log(`Game Review resolves one, which Diamond makes unlimited. Add confirmed moves`);
  console.log(`to unratedReviewMoves in scripts/brilliant-moves-louismcdade.mjs and re-run.\n`);
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
