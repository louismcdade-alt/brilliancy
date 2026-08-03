import type {
  Color,
  Game,
  GameResult,
  Profile,
  RatingRecord,
  Stats,
  TimeClass,
} from "../types";

/**
 * Lichess adapter — the same four functions chesscom.ts exports, over a very
 * different API, so App.tsx can pick a module and never branch again.
 *
 * Two things about Lichess had to be checked against the live API rather than
 * taken from the docs, and both changed the shape of this file:
 *
 *   1. The single-game endpoint is `https://lichess.org/game/export/{id}` —
 *      NOT `/api/game/{id}`. `/api/game/{id}` still answers 200, but it is an
 *      older route that returns `players.white.userId` instead of a user object
 *      and, decisively, returns no `pgn` at all even with `pgnInJson=true`.
 *      Since a game with no PGN is useless to the detector, only `/game/export`
 *      works here. Note it lives OUTSIDE `/api`, which is why the CSP has to
 *      allow the whole `https://lichess.org` origin.
 *
 *   2. The bulk export enforces ONE REQUEST AT A TIME per IP and answers 429
 *      with `{"error":"Please only run 1 request(s) at a time"}` — measured, not
 *      assumed; two overlapping exports from this machine reproduced it every
 *      time. That is a much easier limit to trip than chess.com's, so the 429
 *      message below says what to do rather than just what happened.
 */
const ORIGIN = "https://lichess.org";

class ApiError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

export function isNotFound(err: unknown): boolean {
  return err instanceof ApiError && err.status === 404;
}

/**
 * Only let http(s) URLs through to an `href` or `src`.
 *
 * Same reasoning as chesscom.ts, and deliberately duplicated rather than shared:
 * this is the security boundary for a *different* third party, and a boundary
 * that is one import away from being deleted by a refactor of the other file is
 * not much of a boundary. It is nine lines.
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

async function get(url: string, accept: string): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, { headers: { Accept: accept } });
  } catch {
    throw new ApiError("Couldn't reach Lichess. Check your connection.");
  }
  if (res.status === 404) throw new ApiError("not-found", 404);
  if (res.status === 429) {
    // Lichess asks for one export at a time and for clients to back off; saying
    // "wait a minute" is the actual remedy, and it is short enough to be true.
    throw new ApiError(
      "Lichess is rate-limiting requests — it only allows one game export at a time. Wait a minute and try again.",
      429,
    );
  }
  if (!res.ok) throw new ApiError(`Lichess returned ${res.status}.`, res.status);
  return res;
}

async function getJson<T>(url: string): Promise<T> {
  const res = await get(url, "application/json");
  return (await res.json()) as T;
}

/**
 * Profile and stats come from the SAME endpoint on Lichess (`/api/user/{name}`
 * carries `perfs` inline), but App.tsx calls fetchProfile and fetchStats
 * separately because that is the shape chess.com forced. Rather than change the
 * caller for one site, memoise the last user document for a few seconds: the
 * second call is always microseconds behind the first, so this turns two
 * requests into one without any behaviour a user could observe.
 *
 * Single entry, not a Map: only one profile is ever on screen, so a growing
 * cache would only ever hold garbage. TTL is short because "is this player
 * online" is on this document, and a stale answer to that is worse than a
 * second request.
 */
const USER_TTL_MS = 15_000;
let userCache: { key: string; at: number; doc: any } | null = null;

async function fetchUser(username: string): Promise<any> {
  const key = username.trim().toLowerCase();
  if (userCache && userCache.key === key && Date.now() - userCache.at < USER_TTL_MS) {
    return userCache.doc;
  }
  const doc = await getJson<any>(`${ORIGIN}/api/user/${encodeURIComponent(key)}`);
  userCache = { key, at: Date.now(), doc };
  return doc;
}

export async function fetchProfile(username: string): Promise<Profile> {
  const raw = await fetchUser(username);

  // A closed account still answers 200 with a near-empty document — no perfs, no
  // games, nothing to scan. Failing loudly beats rendering a blank profile that
  // looks like a bug in this site rather than a fact about the account.
  if (raw.disabled) throw new ApiError("closed", 404);

  const prof = raw.profile ?? {};
  const seenAt = typeof raw.seenAt === "number" ? raw.seenAt / 1000 : null;

  return {
    source: "lichess",
    username: raw.username ?? username.trim(),
    name: prof.realName,
    title: typeof raw.title === "string" ? raw.title : undefined,
    // Lichess's public user document carries no avatar URL at all — verified
    // against a live response. That is a feature here: nothing to render means
    // no second image host in the CSP.
    avatar: undefined,
    url: safeUrl(raw.url) ?? `${ORIGIN}/@/${encodeURIComponent(raw.id ?? username)}`,
    // `profile.flag` is usually ISO-3166 alpha-2 but Lichess also allows
    // subdivisions ("GB-ENG") and pseudo-flags ("_lichess", "_earth").
    // countryFlag() already rejects anything that isn't exactly two A–Z letters,
    // so passing it straight through degrades to no flag rather than to mojibake.
    country: typeof prof.flag === "string" ? prof.flag : undefined,
    location: prof.location,
    joined: typeof raw.createdAt === "number" ? Math.round(raw.createdAt / 1000) : undefined,
    // Lichess dropped follower counts from the public user document; there is no
    // honest number to show, so show none.
    followers: undefined,
    status: raw.patron ? "patron" : undefined,
    // `online` is only present on some responses, so derive from `seenAt` with
    // the same five-minute window chesscom.ts uses for `last_online` — one rule
    // means "Online now" means the same thing on both sites.
    isOnline: raw.online === true || (seenAt !== null && Date.now() / 1000 - seenAt < 300),
  };
}

/**
 * A Lichess `perf` node → RatingRecord.
 *
 * There is no win/draw/loss split per time class in the public API — `count` is
 * an account-wide total and cannot be attributed to a pool — so W/D/L stay zero
 * and the game count rides on `games` instead. StatsDashboard reads a zero total
 * as "no record to draw" and falls back to the count, which is the truthful
 * rendering: we know how many, we don't know how they went.
 */
function toRecord(node: any): RatingRecord | undefined {
  if (!node || typeof node.rating !== "number" || !node.games) return undefined;
  return {
    rating: node.rating,
    // No peak rating in this document. `/api/user/{u}/rating-history` has it but
    // costs a second request and a second failure mode for a ★ badge, so the
    // badge simply doesn't render for Lichess.
    bestRating: undefined,
    win: 0,
    loss: 0,
    draw: 0,
    games: node.games,
    provisional: node.prov === true,
  };
}

export async function fetchStats(username: string): Promise<Stats> {
  const raw = await fetchUser(username);
  const perfs = raw.perfs ?? {};
  return {
    // ultraBullet is a separate pool and would need its own card for one
    // stat nobody came here for; blitz/bullet/rapid/classical/correspondence is
    // the set that maps onto how people describe their own rating.
    bullet: toRecord(perfs.bullet),
    blitz: toRecord(perfs.blitz),
    rapid: toRecord(perfs.rapid),
    classical: toRecord(perfs.classical),
    correspondence: toRecord(perfs.correspondence),
    tacticsHighest: typeof perfs.puzzle?.rating === "number" ? perfs.puzzle.rating : undefined,
    fide: raw.profile?.fideRating || undefined,
  };
}

/** Lichess `speed` → the app's TimeClass. */
function toTimeClass(speed: unknown): TimeClass {
  switch (speed) {
    // ultraBullet has no card of its own, but a ¼+0 game is a bullet game by any
    // description a reader would use, so the label is right even though the pool
    // is separate.
    case "ultraBullet":
    case "bullet":
      return "bullet";
    case "rapid":
      return "rapid";
    case "classical":
      return "classical";
    case "correspondence":
      return "correspondence";
    default:
      return "blitz";
  }
}

/**
 * Lichess `status` → the chess.com result-reason vocabulary that
 * lib/format.ts's RESULT_REASON map already speaks.
 *
 * Translating here rather than widening that map keeps one shared file out of
 * this change, and the vocabularies genuinely do line up — except for draws,
 * where Lichess collapses agreement, repetition, the 50-move rule and
 * insufficient material into a single "draw". Guessing one of them would print a
 * fact we don't have, so a draw gets no reason at all and the row simply omits
 * the clause.
 */
const STATUS_REASON: Record<string, string> = {
  mate: "checkmated",
  resign: "resigned",
  outoftime: "timeout",
  timeout: "abandoned", // Lichess "timeout" = a player never moved and was claimed
  stalemate: "stalemate",
  noStart: "abandoned",
  draw: "",
  cheat: "",
  unknownFinish: "",
  variantEnd: "",
};

/**
 * Build the URL a reader should land on. `/{id}/{colour}` opens the board from
 * the searched player's side, which is what someone clicking their own game
 * expects; `/{id}` alone always shows White's view.
 */
function gameUrl(id: string, color: Color): string {
  return `${ORIGIN}/${encodeURIComponent(id)}/${color === "w" ? "white" : "black"}`;
}

function normalizeGame(raw: any, username: string): Game | null {
  // Matches how chesscom.ts drops chess960 and bughouse: the detector's
  // calibration is standard-chess calibration.
  if (raw.variant && raw.variant !== "standard") return null;
  if (!raw.pgn || !raw.id) return null;

  const lower = username.trim().toLowerCase();
  const white = raw.players?.white ?? {};
  const black = raw.players?.black ?? {};
  const whiteName = String(white.user?.name ?? white.user?.id ?? "").toLowerCase();
  const blackName = String(black.user?.name ?? black.user?.id ?? "").toLowerCase();

  // If neither side is the player we asked about, we cannot say whose moves to
  // judge — and guessing "white" would silently scan the opponent. Drop it.
  let userColor: Color;
  if (whiteName === lower) userColor = "w";
  else if (blackName === lower) userColor = "b";
  else return null;

  const me = userColor === "w" ? white : black;
  const opp = userColor === "w" ? black : white;

  let result: GameResult;
  if (!raw.winner) result = "draw";
  else result = raw.winner === (userColor === "w" ? "white" : "black") ? "win" : "loss";

  // Emit chess.com-shaped time-control strings so lib/format.ts renders them
  // without needing to learn a second dialect: "300+3" → "5 min + 3", and
  // correspondence borrows chess.com's seconds-per-move form, "1/86400" →
  // "1 days/move".
  let timeControl = "";
  if (raw.clock && typeof raw.clock.initial === "number") {
    timeControl = `${raw.clock.initial}+${raw.clock.increment ?? 0}`;
  } else if (typeof raw.daysPerTurn === "number") {
    timeControl = `1/${raw.daysPerTurn * 86400}`;
  }

  const oppName =
    opp.user?.name ??
    (typeof opp.aiLevel === "number" ? `Stockfish level ${opp.aiLevel}` : "Anonymous");

  return {
    source: "lichess",
    id: raw.id,
    url: safeUrl(gameUrl(raw.id, userColor)) ?? "",
    pgn: raw.pgn,
    timeClass: toTimeClass(raw.speed),
    timeControl,
    rated: Boolean(raw.rated),
    // Both timestamps are milliseconds on Lichess, unlike chess.com's seconds.
    endTime: Math.round((raw.lastMoveAt ?? raw.createdAt ?? 0) / 1000),
    userColor,
    result,
    resultReason: result === "win" ? "" : STATUS_REASON[raw.status] ?? "",
    userRating: typeof me.rating === "number" ? me.rating : undefined,
    oppUsername: oppName,
    oppRating: typeof opp.rating === "number" ? opp.rating : undefined,
    // Lichess computes accuracy only for games that have been through its own
    // analysis, and does not expose it on the export at all. Leaving these
    // undefined (rather than 0) is what keeps the Accuracy summary cell showing
    // "—" instead of an invented 0.0%.
    userAccuracy: undefined,
    oppAccuracy: undefined,
  };
}

/**
 * Pull a game id out of anything a user is likely to paste.
 *
 * Real forms: `https://lichess.org/q7ZvsdUF`, `.../q7ZvsdUF/black`, a 12-char
 * link that embeds the player token (`q7ZvsdUFhAsd` — the game id is the first
 * 8 characters), or the bare id. `/black` and `/white` are too short to match
 * the id pattern, so they fall out on their own.
 */
function extractGameId(raw: string): string | null {
  let path = raw.trim();
  try {
    // Only treat it as a URL if it parses as one; a bare id must not become
    // "https://q7zvsdUF/".
    if (/^https?:\/\//i.test(path)) path = new URL(path).pathname;
  } catch {
    /* fall through and treat the whole string as a path */
  }
  const parts = path.split("/").filter(Boolean);
  // `/@/username` is a profile link, not a game; a 9-character username would
  // otherwise match the id pattern below and send us hunting for a game id.
  if (parts[0] === "@") return null;
  for (const part of parts) {
    if (/^[A-Za-z0-9]{8,12}$/.test(part)) return part.slice(0, 8);
  }
  return null;
}

/**
 * Find one specific game by URL or id.
 *
 * Far simpler than the chess.com path: Lichess has a real get-by-id endpoint, so
 * there are no archives to walk. The username is still taken, because
 * normalizeGame needs to know whose moves to judge — and if the pasted game
 * doesn't involve them it returns null, which is the right answer rather than a
 * scan of a stranger's moves.
 */
export async function fetchGameByUrl(
  username: string,
  urlOrId: string,
): Promise<Game | null> {
  const id = extractGameId(urlOrId);
  if (!id) return null;
  try {
    const raw = await getJson<any>(
      `${ORIGIN}/game/export/${encodeURIComponent(id)}?pgnInJson=true&clocks=false&evals=false&literate=false`,
    );
    return normalizeGame(raw, username);
  } catch (e) {
    if (isNotFound(e)) return null; // "no such game" is a null, not an error box
    throw e;
  }
}

/**
 * Fetch recent games, newest first.
 *
 * One request, not chess.com's month-by-month walk — but the response is
 * NDJSON, a stream of one JSON object per line rather than an array, so it has
 * to be split by hand. Read the whole body as text before splitting: a partial
 * read would leave a truncated final line that JSON.parse rejects, and the
 * bodies here are PGN-sized, not video-sized.
 *
 * `max` is capped because `Infinity` is a legal scope in the UI ("Everything")
 * and would go into the URL as the literal string "Infinity". 500 is well past
 * the largest scope a user can pick from the panel.
 */
export async function fetchRecentGames(
  username: string,
  limit = 40,
): Promise<Game[]> {
  const u = username.trim();
  const max = Number.isFinite(limit) ? Math.max(1, Math.min(500, Math.floor(limit))) : 500;
  const url =
    `${ORIGIN}/api/games/user/${encodeURIComponent(u)}` +
    `?max=${max}&pgnInJson=true&clocks=false&evals=false&opening=false&sort=dateDesc`;

  const res = await get(url, "application/x-ndjson");
  const text = await res.text();

  const out: Game[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const game = normalizeGame(JSON.parse(trimmed), u);
      if (game) out.push(game);
    } catch {
      // One unparseable line shouldn't lose the other 249. Skipping is silent
      // on purpose: there is nothing a reader could do about it.
    }
  }
  // Lichess returns newest-first already, but the sort is what the rest of the
  // app assumes and it costs nothing to guarantee it rather than rely on it.
  return out.sort((a, b) => b.endTime - a.endTime).slice(0, max);
}
