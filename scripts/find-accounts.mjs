/**
 * Find chess.com accounts worth harvesting brilliancies from.
 *
 * The constraint that makes this necessary: the all-time Brilliant Moves list is
 * built from Advanced Stats, a PAID feature, so it exists only for premium
 * accounts. Free accounts are unusable no matter how many games they have, and at
 * the ratings this project cares about most of them are free — eight of Louis's
 * nine most frequent opponents are `basic`.
 *
 * So candidates are sourced from clubs (public API, no scraping), then filtered:
 *
 *   premium   the list exists at all.
 *   rating    within a band, so a rule can be checked for rating dependence
 *             rather than fitted to one skill level and assumed universal.
 *   games     enough rated games that a sample of negatives is meaningful.
 *
 * Everything here is public API. The one page load per account happens later, in
 * brilliant-list.mjs, and only for accounts that clear these filters.
 *
 *   node scripts/find-accounts.mjs --club team-england --min 800 --max 1600 --take 20
 *   node scripts/find-accounts.mjs --club chess-com-developer-community --take 30
 *
 * Output is a plain list of usernames, ready to pipe into brilliant-list.mjs.
 */
import { getJson } from "./lib/chesscom.mjs";

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};

const CLUB = arg("club", "team-england");
const MIN = Number(arg("min", 0));
const MAX = Number(arg("max", 4000));
const TAKE = Number(arg("take", 20));
const MIN_GAMES = Number(arg("min-games", 50));
const SCAN = Number(arg("scan", 300)); // how many club members to check

/** Best available live rating, and how many rated live games back it. */
function liveProfile(stats) {
  let best = null;
  let games = 0;
  for (const key of ["chess_rapid", "chess_blitz", "chess_bullet"]) {
    const s = stats[key];
    if (!s?.last?.rating) continue;
    const played = (s.record?.win ?? 0) + (s.record?.loss ?? 0) + (s.record?.draw ?? 0);
    games += played;
    if (!best || s.last.rating > best.rating) best = { rating: s.last.rating, key };
  }
  return best ? { ...best, games } : null;
}

console.error(`club ${CLUB} — checking up to ${SCAN} members for premium, rating ${MIN}–${MAX}, ≥${MIN_GAMES} games`);

const club = await getJson(`https://api.chess.com/pub/club/${CLUB}/members`);
// Ordered by activity: weekly first, then monthly, then all-time. Active members
// are the ones whose archives are worth scanning.
const members = [...(club.weekly ?? []), ...(club.monthly ?? []), ...(club.all_time ?? [])]
  .map((m) => m.username)
  .filter((u, i, a) => a.indexOf(u) === i)
  .slice(0, SCAN);

const found = [];
let checked = 0;
for (const user of members) {
  if (found.length >= TAKE) break;
  checked++;
  try {
    const profile = await getJson(`https://api.chess.com/pub/player/${user}`);
    if (profile.status === "basic") continue;
    const stats = await getJson(`https://api.chess.com/pub/player/${user}/stats`);
    const live = liveProfile(stats);
    if (!live || live.rating < MIN || live.rating > MAX || live.games < MIN_GAMES) continue;
    found.push({ user, rating: live.rating, key: live.key, games: live.games, status: profile.status });
    console.error(`  ✓ ${user.padEnd(22)} ${String(live.rating).padStart(4)} ${live.key.replace("chess_", "").padEnd(7)} ${String(live.games).padStart(5)} games  ${profile.status}`);
  } catch {
    /* private or missing profile — skip */
  }
}

console.error(`\n${found.length} usable of ${checked} checked\n`);
console.log(found.map((f) => f.user).join(" "));
