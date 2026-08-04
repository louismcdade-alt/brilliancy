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
 * Find one specific game by its chess.com URL (or bare game id).
 *
 * There's no get-game-by-id endpoint in the public API, so we walk the player's
 * monthly archives newest-first until it turns up — one small request per month.
 * Scoped to a player because the archives are the only way in; a game URL alone
 * doesn't tell us whose history to search.
 */
export async function fetchGameByUrl(
  username: string,
  urlOrId: string,
): Promise<Game | null> {
  const id = urlOrId.trim().replace(/\/+$/, "").split("/").pop();
  if (!id) return null;
  const months = await fetchArchiveMonths(username);
  for (let i = months.length - 1; i >= 0; i--) {
    let monthData: { games?: any[] };
    try {
      monthData = await getJson<{ games: any[] }>(months[i]);
    } catch {
      continue; // a single unreadable month shouldn't abort the search
    }
    const hit = (monthData.games ?? []).find((g) => String(g.url ?? "").endsWith(id));
    if (hit) return normalizeGame(hit, username);
  }
  return null;
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
