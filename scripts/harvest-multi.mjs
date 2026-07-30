/**
 * Build a labelled dataset across MANY chess.com accounts.
 *
 * WHY. One account is a ceiling: LouisMcdade has nine brilliancies ever, and no
 * rule can be fitted or falsified on nine examples — every threshold sweep this
 * project has run bottomed out on "not enough positives", and the last one showed
 * seven misses failing for four different reasons. chess.com's all-time Brilliant
 * Moves list is public for any member (verified logged out), so positives are now
 * limited only by how many accounts we ask about.
 *
 * CASE-CONTROL SAMPLING, AND THE TRAP IN IT. Scanning whole archives to find a
 * handful of stars is mostly wasted engine time, so each account contributes:
 *
 *   star    every rated live game the list names — one guaranteed positive each.
 *   random  a deterministic sample of that account's OTHER rated live games.
 *
 * That enrichment makes the dataset useful for fitting and makes any precision
 * computed over the whole thing MEANINGLESS — star games are massively
 * over-represented relative to real play. Every row therefore carries `sample`,
 * and precision must be computed on `random` rows alone. Recall can use both.
 * This is the one number in the pipeline most likely to be quoted wrongly, which
 * is why it is written here and enforced by the column rather than remembered.
 *
 * The sample is a stable hash of the game id, not a random draw — see
 * `stableSample`. Re-running never redraws it.
 *
 * Prereq: dev server running (npm run dev), and a list scraped for each account:
 *
 *   node scripts/brilliant-list.mjs <user>…
 *   node scripts/harvest-multi.mjs <user>… [--negatives 40] [--rescan]
 *   DEPTH=14 node scripts/harvest-multi.mjs …
 */
import { chromium } from "playwright";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fetchArchive, sanList, stableSample } from "./lib/chesscom.mjs";

const SCHEMA = 1;
const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? Number(args[i + 1]) : fallback;
};
const NEGATIVES = flag("negatives", 40);
/**
 * Cap star games per account. One correspondence player has 218 brilliancies —
 * without a cap that single account would supply more positives than everyone
 * else combined, and any rule fitted on the result would really be a rule about
 * that person's daily games.
 */
const MAX_STARS = flag("max-stars", 60);
const RESCAN = args.includes("--rescan");
const DEPTH = Number(process.env.DEPTH) || 14;
const valueIdx = new Set(["--negatives", "--max-stars"].map((f) => args.indexOf(f)).filter((i) => i >= 0).map((i) => i + 1));
const users = args.filter((a, i) => !a.startsWith("--") && !valueIdx.has(i));

const CACHE = "scripts/harvest-multi.json";
const CSV = "scripts/dataset-multi.csv";

if (!users.length) {
  console.error("usage: node scripts/harvest-multi.mjs <user>… [--negatives N] [--rescan]");
  process.exit(1);
}

const cache = !RESCAN && existsSync(CACHE) ? JSON.parse(readFileSync(CACHE, "utf8")) : { schema: SCHEMA, games: {} };
// A NEWER schema is fine — it means a backfill added columns, and extra columns
// cannot invalidate the engine numbers already paid for. Only an OLDER cache is
// missing things and must rescan. The first version tested equality, and the
// day a backfill stamped the cache 3 against this file's 1, a routine harvest
// silently threw away 1,779 games of scans and spent two hours rebuying them.
if ((cache.schema ?? 1) < SCHEMA) {
  console.error(`cache schema ${cache.schema} < ${SCHEMA} — rescanning everything`);
  cache.games = {};
}
cache.schema = Math.max(SCHEMA, cache.schema ?? 1);

async function launch() {
  for (const channel of ["msedge", "chrome"]) {
    try {
      return await chromium.launch({ channel, headless: true });
    } catch {
      /* next */
    }
  }
  return chromium.launch({ headless: true });
}

const browser = await launch();
const page = await browser.newPage();
page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
await page.goto("http://localhost:5173/", { waitUntil: "networkidle" });

const plan = [];

for (const user of users) {
  const listPath = `scripts/brilliant-lists/${user.toLowerCase()}.json`;
  if (!existsSync(listPath)) {
    console.error(`${user}: no list — run scripts/brilliant-list.mjs ${user} first`);
    continue;
  }
  const list = JSON.parse(readFileSync(listPath, "utf8"));
  const archive = await fetchArchive(user);

  // ── verify every star before a single negative is trusted ──────────────────
  // A star that doesn't resolve means the ply convention or the id is wrong, and
  // the same mistake would silently mislabel every other move in the account.
  const stars = new Map();
  const bad = [];
  for (const m of list.moves) {
    const g = archive.get(m.id);
    if (!g) {
      bad.push(`${m.id}: not in archive`);
      continue;
    }
    const san = sanList(g.pgn)[m.ply];
    if (m.color !== g.userColor) bad.push(`${m.id}: ply ${m.ply} is ${m.color}, ${user} played ${g.userColor}`);
    else if (!san) bad.push(`${m.id}: ply ${m.ply} past the end of the game`);
    else stars.set(m.id, [...(stars.get(m.id) ?? []), { moveNumber: m.moveNumber, san }]);
  }
  if (bad.length) {
    console.error(`${user}: ${bad.length} unresolvable stars — SKIPPING ACCOUNT`);
    for (const b of bad.slice(0, 5)) console.error(`   ${b}`);
    continue;
  }
  if (!list.complete) {
    console.error(`${user}: list is PARTIAL (${list.scraped}/${list.total}) — positives only, no negatives`);
  }

  // Rated only — the list does not cover unrated games. Daily IS covered: entries
  // like /analysis/game/daily/908663389 appear in it, so correspondence games are
  // labelled like any other and excluding them would discard real positives.
  const scorable = [...archive.values()].filter((g) => g.rated && g.pgn);
  // The random sample is drawn from ALL rated games, star games included — and
  // that inclusion is the whole point. Sampling only non-star games seems
  // sensible ("the stars are already covered") and quietly destroys the sample:
  // it then contains zero positives by construction, so precision computed on it
  // has a numerator that is always 0. An unbiased sample has to be allowed to
  // contain brilliancies at whatever rate they actually occur, which at these
  // ratings is roughly one game in twenty.
  //
  // A partial list still cannot license negatives at all: an unlisted game may
  // simply be one the page never rendered.
  const randomIds = new Set(list.complete ? stableSample(scorable.map((g) => g.id), NEGATIVES) : []);
  const randomGames = [...randomIds].map((id) => archive.get(id));

  // Enrichment on top of the sample: extra star games for recall and for fitting.
  // Anything already drawn at random stays in the random sample — being counted
  // twice would put it in both the biased and unbiased populations.
  const allStarGames = scorable.filter((g) => stars.has(g.id) && !randomIds.has(g.id));
  const keepStars = new Set(stableSample(allStarGames.map((g) => g.id), MAX_STARS));
  const starGames = allStarGames.filter((g) => keepStars.has(g.id));

  // `trustNegatives` is the load-bearing flag. On an incomplete list, a listed
  // game may hold a SECOND brilliancy that was never scraped, so the other
  // candidates in it are unknown rather than negative. Labelling them 0 would
  // quietly teach the model that real brilliancies are negatives — the single
  // most damaging error this pipeline can make. Positives are still safe: the
  // moves that were scraped are genuinely starred.
  for (const g of starGames)
    plan.push({ user, game: g, sample: "star", expected: stars.get(g.id), trustNegatives: list.complete });
  // A random-sample game that happens to be starred keeps its positive; that is
  // precisely the event precision needs to be able to observe.
  for (const g of randomGames)
    plan.push({ user, game: g, sample: "random", expected: stars.get(g.id) ?? [], trustNegatives: true });
  console.error(
    `${user}: ${starGames.length} star games` +
      (allStarGames.length > starGames.length ? ` (capped from ${allStarGames.length})` : "") +
      ` + ${randomGames.length} random, of ${scorable.length} rated`,
  );
}

// Refresh the metadata on games already in the cache. The cache stores candidates
// AND how the game is being used, and only the first is expensive. If a game was
// scanned as a `star` game and a later run draws it into the random sample, the
// candidates are still valid but the classification is not — and a stale `sample`
// would put a game in the wrong population, which is the one thing the precision
// calculation cannot survive.
for (const p of plan) {
  const hit = cache.games[`${p.game.id}@${DEPTH}`];
  if (!hit) continue;
  hit.sample = p.sample;
  hit.expected = p.expected;
  hit.trustNegatives = p.trustNegatives;
}

// ── scan ────────────────────────────────────────────────────────────────────
console.error(`\nscanning ${plan.length} games at depth ${DEPTH}…`);
let scanned = 0;
for (let i = 0; i < plan.length; i++) {
  const p = plan[i];
  const key = `${p.game.id}@${DEPTH}`;
  if (cache.games[key]) continue;
  try {
    // One retry after re-navigating. A Vite HMR full-reload (an edit to any
    // src/ module while a harvest is running) destroys the evaluate context and
    // killed a 3,695-game overnight run at 2,300. The state lost is nothing —
    // the page holds no state between games — so reload-and-retry is exactly
    // right, and the second failure is a real error.
    const evalOnce = () => page.evaluate(
      async ({ game, depth }) => {
        const bril = await import("/src/engine/brilliancy.ts");
        const seen = [];
        // rejectShapes:[] + admitAllow — record what the rules WOULD drop, at both
        // the admission and the shape layer, or the dataset can only ever confirm
        // the rules it was built under.
        await bril.scanGame(
          { ...game, timeControl: "", rated: true, endTime: 0, result: "win", resultReason: "", oppUsername: "opponent" },
          { depth, rejectShapes: [], admitAllow: true, onCandidate: (c) => seen.push(c) },
        );
        return seen.map((c) => ({
          moveNumber: c.moveNumber, san: c.san, sacrifice: c.sacrifice, sacSquare: c.sacSquare,
          playedEval: c.playedEval, evalLoss: c.evalLoss,
          quietAlt: isFinite(c.quietAlt) ? c.quietAlt : null,
          shape: c.shape, accepted: c.accepted, admitted: c.admitted,
          fresh: c.fresh, standing: c.standing, rejectedBy: c.rejectedBy,
        }));
      },
      { game: { id: p.game.id, url: p.game.url, pgn: p.game.pgn, userColor: p.game.userColor, timeClass: p.game.timeClass }, depth: DEPTH },
    );
    let candidates;
    try {
      candidates = await evalOnce();
    } catch (e) {
      if (!String(e).includes("Execution context was destroyed")) throw e;
      console.error("  page reloaded under us — re-navigating and retrying once");
      await page.goto("http://localhost:5173/", { waitUntil: "networkidle" });
      candidates = await evalOnce();
    }
    cache.games[key] = {
      user: p.user, id: p.game.id, url: p.game.url, userColor: p.game.userColor,
      rating: p.game.rating, timeClass: p.game.timeClass, date: p.game.date,
      sample: p.sample, expected: p.expected, trustNegatives: p.trustNegatives, candidates,
    };
    scanned++;
  } catch (e) {
    console.error(`ERR ${p.game.url} — ${String(e).split(/\r?\n/)[0]}`);
  }
  if ((i + 1) % 25 === 0) {
    console.error(`  …${i + 1}/${plan.length}`);
    writeFileSync(CACHE, JSON.stringify(cache, null, 1)); // checkpoint: a long scan must survive a crash
  }
}
await browser.close();
writeFileSync(CACHE, JSON.stringify(cache, null, 1));

// ── dataset ─────────────────────────────────────────────────────────────────
const wanted = new Set(plan.map((p) => `${p.game.id}@${DEPTH}`));
const rows = [];
const stats = {};
for (const [key, g] of Object.entries(cache.games)) {
  if (!wanted.has(key)) continue;
  const stars = new Set(g.expected.map((m) => `${m.moveNumber} ${m.san}`));
  const hit = new Set();
  const s = (stats[g.user] ??= { star: 0, random: 0, pos: 0, neg: 0, dropped: 0, missedByPrefilter: 0 });
  s[g.sample]++;
  for (const c of g.candidates) {
    const k = `${c.moveNumber} ${c.san}`;
    const label = stars.has(k) ? 1 : 0;
    if (label) hit.add(k);
    // Unlisted move in a game whose list we don't trust: unknown, not negative.
    if (!label && g.trustNegatives === false) {
      s.dropped++;
      continue;
    }
    label ? s.pos++ : s.neg++;
    rows.push({
      user: g.user, gameId: g.id, rating: g.rating, timeClass: g.timeClass, sample: g.sample,
      userColor: g.userColor, ...c,
      margin: c.quietAlt === null ? "" : c.playedEval - c.quietAlt,
      label,
    });
  }
  // A star no candidate matched never reached the engine at all — the pre-filter
  // is blind there, and no gate change can reach it.
  s.missedByPrefilter += [...stars].filter((k) => !hit.has(k)).length;
}

const COLS = ["user","gameId","rating","timeClass","sample","userColor","moveNumber","san","sacrifice","sacSquare",
  "playedEval","evalLoss","quietAlt","margin","shape","accepted","admitted","fresh","standing","rejectedBy","label"];
writeFileSync(CSV, [COLS.join(","), ...rows.map((r) => COLS.map((k) => (r[k] === null || r[k] === undefined ? "" : String(r[k]))).join(","))].join("\n") + "\n");

console.log(`\n${scanned} newly scanned · ${rows.length} labelled candidates → ${CSV}`);
console.log("\nuser                 star  rand   pos   neg   pre-filter misses");
for (const [user, s] of Object.entries(stats))
  console.log(`${user.padEnd(20)} ${String(s.star).padStart(4)} ${String(s.random).padStart(5)} ${String(s.pos).padStart(5)} ${String(s.neg).padStart(5)} ${String(s.dropped).padStart(8)}  ${s.missedByPrefilter}`);
const tot = Object.values(stats).reduce((a, s) => ({ pos: a.pos + s.pos, neg: a.neg + s.neg, miss: a.miss + s.missedByPrefilter }), { pos: 0, neg: 0, miss: 0 });
console.log(`${"TOTAL".padEnd(20)} ${"".padStart(4)} ${"".padStart(5)} ${String(tot.pos).padStart(5)} ${String(tot.neg).padStart(5)}   ${tot.miss}`);
console.log(`\n⚠ precision must be computed on sample="random" rows only — star games are enriched.`);
