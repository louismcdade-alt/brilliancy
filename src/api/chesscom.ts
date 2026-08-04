import type {
  Color,
  Game,
  GameBatch,
  GameResult,
  Profile,
  RatingRecord,
  Stats,
  TimeClass,
} from "../types";

const BASE = "https://api.chess.com/pub";

/** chess.com result codes for the non-winning side, grouped into draws vs losses. */
const DRAW_REASONS = new Set([
  "agreed",
  "repetition",
  "stalemate",
  "insufficient",
  "50move",
  "timevsinsufficient",
]);

class ApiError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

/**
 * Only let http(s) URLs through to an `href` or `src`.
 *
 * Everything we render — profile links, avatars, game links — is a string chosen
 * by a third party, and React does not sanitise URL attributes: a `javascript:`
 * value bound to an href runs on click. chess.com is not the threat here, but
 * "the API would never send that" is an assumption, and this costs one function.
 */
export function safeUrl(raw: unknown): string | undefined {
  if (typeof raw !== "string" || !raw) return undefined;
  try {
    const u = new URL(raw);
    return u.protocol === "https:" || u.protocol === "http:" ? u.href : undefined;
  } catch {
    return undefined; // not a URL at all
  }
}

/** An archive URL is only followed if it really points at the chess.com API. */
function isApiUrl(raw: unknown): raw is string {
  const safe = safeUrl(raw);
  return Boolean(safe && safe.startsWith(`${BASE}/`));
}

async function getJson<T>(url: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { headers: { Accept: "application/json" } });
  } catch {
    throw new ApiError("Couldn't reach chess.com. Check your connection.");
  }
  if (res.status === 404) throw new ApiError("not-found", 404);
  if (res.status === 429) {
    throw new ApiError("chess.com is rate-limiting requests. Try again shortly.", 429);
  }
  if (!res.ok) throw new ApiError(`chess.com returned ${res.status}.`, res.status);
  return (await res.json()) as T;
}

export function isNotFound(err: unknown): boolean {
  return err instanceof ApiError && err.status === 404;
}

export async function fetchProfile(username: string): Promise<Profile> {
  const u = username.trim().toLowerCase();
  const raw = await getJson<any>(`${BASE}/player/${encodeURIComponent(u)}`);
  let country: string | undefined;
  if (raw.country) {
    const parts = String(raw.country).split("/");
    country = parts[parts.length - 1]; // ".../country/US" -> "US"
  }
  return {
    source: "chesscom",
    username: raw.username ?? u,
    name: raw.name,
    title: typeof raw.title === "string" ? raw.title : undefined,
    avatar: safeUrl(raw.avatar),
    url: safeUrl(raw.url),
    country,
    location: raw.location,
    joined: raw.joined,
    followers: raw.followers,
    status: raw.status,
    isOnline: typeof raw.last_online === "number" && Date.now() / 1000 - raw.last_online < 300,
  };
}

function toRecord(node: any): RatingRecord | undefined {
  if (!node) return undefined;
  const rec = node.record ?? {};
  return {
    rating: node.last?.rating,
    bestRating: node.best?.rating,
    win: rec.win ?? 0,
    loss: rec.loss ?? 0,
    draw: rec.draw ?? 0,
  };
}

export async function fetchStats(username: string): Promise<Stats> {
  const u = username.trim().toLowerCase();
  const raw = await getJson<any>(`${BASE}/player/${encodeURIComponent(u)}/stats`);
  return {
    bullet: toRecord(raw.chess_bullet),
    blitz: toRecord(raw.chess_blitz),
    rapid: toRecord(raw.chess_rapid),
    daily: toRecord(raw.chess_daily),
    tacticsHighest: raw.tactics?.highest?.rating,
    fide: raw.fide || undefined,
  };
}

export async function fetchArchiveMonths(username: string): Promise<string[]> {
  const u = username.trim().toLowerCase();
  const raw = await getJson<{ archives: string[] }>(
    `${BASE}/player/${encodeURIComponent(u)}/games/archives`,
  );
  // The response tells us which URLs to fetch next; pin them to the API host so a
  // surprising response can't point the browser somewhere else entirely.
  return (raw.archives ?? []).filter(isApiUrl);
}

function classifyResult(reason: string): GameResult {
  if (reason === "win") return "win";
  if (DRAW_REASONS.has(reason)) return "draw";
  return "loss";
}

function normalizeGame(raw: any, username: string): Game | null {
  if (raw.rules && raw.rules !== "chess") return null; // skip chess960, bughouse, etc.
  if (!raw.pgn) return null;

  const lower = username.toLowerCase();
  const whiteUser = (raw.white?.username ?? "").toLowerCase();
  const userColor: Color = whiteUser === lower ? "w" : "b";
  const me = userColor === "w" ? raw.white : raw.black;
  const opp = userColor === "w" ? raw.black : raw.white;

  return {
    source: "chesscom",
    id: raw.uuid ?? raw.url,
    url: safeUrl(raw.url) ?? "",
    pgn: raw.pgn,
    timeClass: (raw.time_class ?? "blitz") as TimeClass,
    timeControl: raw.time_control ?? "",
    rated: Boolean(raw.rated),
    endTime: raw.end_time ?? 0,
    userColor,
    result: classifyResult(me?.result ?? ""),
    resultReason: opp?.result === "win" ? me?.result ?? "" : opp?.result ?? "",
    userRating: me?.rating,
    oppUsername: opp?.username ?? "?",
    oppRating: opp?.rating,
    userAccuracy: raw.accuracies?.[userColor === "w" ? "white" : "black"],
    oppAccuracy: raw.accuracies?.[userColor === "w" ? "black" : "white"],
  };
}

/**
 * The id at the end of a chess.com game URL, or null if there isn't one.
 *
 * Every chess.com game URL is `.../<something>/<decimal id>`: of the 420 real
 * game URLs this repo has harvested from the live API (scripts/dataset-*.csv,
 * harvest-louismcdade.json), 412 are `/game/live/<digits>` and 8 are
 * `/game/daily/<digits>` — no other shape, and never a non-numeric id.
 *
 * Matching the whole final segment rather than a suffix matters: the previous
 * `url.endsWith(id)` test made the pasted id "651203" match the unrelated game
 * 123984651203, which then got scanned as if it were the one asked for.
 */
function gameIdOf(url: unknown): string | null {
  const m = /\/(\d+)\/?$/.exec(String(url ?? ""));
  return m ? m[1] : null;
}

/**
 * Pull a game id out of anything a user is likely to paste.
 *
 * Real forms: `https://www.chess.com/game/live/123984651203`, the daily and
 * older `/live/game/<id>` variants, an analysis link that trails a query string,
 * or the bare id. The id is taken as the last all-digit path segment rather than
 * a fixed position, so a new prefix doesn't break this.
 *
 * Returning null for anything else is the point. Without it, a pasted Lichess
 * link became the "id" `q7ZvsdUF`, matched nothing, and sent the walk below
 * through every monthly archive the account has — a month of full PGNs per
 * request, ~152 requests on an account like Hikaru's, all of it certain to fail.
 */
function extractGameId(raw: string): string | null {
  let path = raw.trim();
  if (/^https?:\/\//i.test(path)) {
    let u: URL;
    try {
      u = new URL(path);
    } catch {
      return null;
    }
    // A link to another site is not a chess.com game, whatever digits it holds.
    if (u.hostname !== "chess.com" && !u.hostname.endsWith(".chess.com")) return null;
    path = u.pathname;
  }
  const parts = path.split("/").filter(Boolean);
  for (let i = parts.length - 1; i >= 0; i--) {
    if (/^\d+$/.test(parts[i])) return parts[i];
  }
  return null;
}

/**
 * How far back a single-game lookup walks, in monthly archives.
 *
 * The walk used to be unbounded, which on a heavy account is the same shape of
 * traffic MAX_SCAN_GAMES was introduced to stop (see App.tsx): Hikaru has 152
 * archives, each one a month of full PGNs, and a miss fetched all of them.
 *
 * 24 is a request budget, not a claim about where games live — which is why a
 * miss inside it reports the window it covered rather than asserting the game
 * isn't the player's. Two years is comfortably past "the game I remember
 * chess.com starring", the reason this box exists at all, and caps the worst
 * case at 25 requests instead of 153.
 */
const SINGLE_GAME_MONTHS = 24;

/**
 * A month can fail for reasons that aren't fatal to the search, so tolerate a
 * couple in a row before giving up — but only a couple. The old `catch {
 * continue; }` tolerated ALL of them, which is how a rate-limited walk carried
 * on 429ing every remaining archive and then reported "not among your games".
 */
const MAX_CONSECUTIVE_MONTH_FAILURES = 2;

/**
 * Find one specific game by its chess.com URL (or bare game id).
 *
 * There's no get-game-by-id endpoint in the public API, so we walk the player's
 * monthly archives newest-first until it turns up — one small request per month.
 * Scoped to a player because the archives are the only way in; a game URL alone
 * doesn't tell us whose history to search.
 *
 * Returns null only when we are entitled to say the game isn't theirs: the id
 * was never a chess.com game id, or we read the account's ENTIRE history and it
 * wasn't there. A search cut short — by the window or by chess.com refusing us —
 * throws instead, because "we didn't find it" and "it isn't yours" are different
 * facts and only one of them is ours to state.
 */
export async function fetchGameByUrl(
  username: string,
  urlOrId: string,
): Promise<Game | null> {
  const id = extractGameId(urlOrId);
  if (!id) return null;
  const months = await fetchArchiveMonths(username);
  const oldest = Math.max(0, months.length - SINGLE_GAME_MONTHS);
  let consecutiveFailures = 0;

  for (let i = months.length - 1; i >= oldest; i--) {
    let monthData: { games?: any[] };
    try {
      monthData = await getJson<{ games: any[] }>(months[i]);
      consecutiveFailures = 0;
    } catch (e) {
      // A 429 is not a property of this month — it's the API telling us to stop,
      // and every further request makes it more true. Surface it immediately.
      if (e instanceof ApiError && e.status === 429) throw e;
      if (++consecutiveFailures > MAX_CONSECUTIVE_MONTH_FAILURES) throw e;
      continue;
    }
    const hit = (monthData.games ?? []).find((g) => gameIdOf(g.url) === id);
    if (hit) return normalizeGame(hit, username);
  }

  if (oldest > 0) {
    throw new ApiError(
      `Looked back through @${username}'s last ${SINGLE_GAME_MONTHS} monthly archives and didn't find that game — it may be older. chess.com has no fetch-one-game endpoint, so this only searches the recent window.`,
    );
  }
  return null; // the whole history was read; it really isn't there
}

/**
 * Fetch recent games, newest first, walking backwards through monthly archives
 * until we have `limit` standard-chess games (or run out of history).
 *
 * Whether the limit BIT is a fact only this loop has: it is the thing that saw
 * an archive it chose not to open. Reporting it (rather than letting the caller
 * infer it from `games.length === limit`) is what lets the UI distinguish a
 * player whose history we cut short from one who happens to have exactly this
 * many games.
 */
export async function fetchRecentGames(
  username: string,
  limit = 40,
): Promise<GameBatch> {
  const months = await fetchArchiveMonths(username);
  const out: Game[] = [];
  let i = months.length - 1;
  for (; i >= 0 && out.length < limit; i--) {
    const monthData = await getJson<{ games: any[] }>(months[i]);
    const games = (monthData.games ?? [])
      .map((g) => normalizeGame(g, username))
      .filter((g): g is Game => g !== null)
      .sort((a, b) => b.endTime - a.endTime);
    out.push(...games);
  }
  return {
    games: out.slice(0, limit),
    cap: limit,
    // Two ways history was left on the table: the last month we opened carried
    // us past the limit, or we stopped with older archives still unopened
    // (`i >= 0` — the loop only leaves the index non-negative when the length
    // test, not the month list, ended it).
    truncated: out.length > limit || i >= 0,
  };
}
