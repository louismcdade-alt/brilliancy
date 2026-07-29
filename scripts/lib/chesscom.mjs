/**
 * Shared chess.com helpers — archive fetching and the ply/SAN conventions.
 *
 * Extracted when the second script needed them. The rule this project already
 * learned the hard way (two probe scripts that reimplemented SEE in JS, both
 * deleted) is that duplicated logic drifts, and a label pipeline that drifts
 * produces labels nobody can trust.
 */

export async function getJson(url) {
  const res = await fetch(url, { headers: { Accept: "application/json", "User-Agent": "brilliancy-calibration" } });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}

/** SAN tokens in play order, index 0 = white's first move — chess.com's ply. */
export function sanList(pgn) {
  return pgn
    .replace(/\{[^}]*\}/g, "")
    .replace(/^\[.*$/gm, "")
    .replace(/\d+\.(\.\.)?/g, " ")
    .split(/\s+/)
    .filter((t) => t && !/^(1-0|0-1|1\/2-1\/2|\*)$/.test(t));
}

/** chess.com's `?move=` is a 0-indexed half-move. */
export const plyToMove = (ply) => ({
  moveNumber: Math.floor(ply / 2) + 1,
  color: ply % 2 === 0 ? "w" : "b",
});

/** "19.Bb6+" / "6...Bxf2+" → { moveNumber, san }. */
export const parseMove = (move) => {
  const m = String(move).match(/^(\d+)\.+(.+)$/);
  if (!m) throw new Error(`unparseable move: ${move}`);
  return { moveNumber: Number(m[1]), san: m[2] };
};

/** chess.com's numeric game id, the key every label file here uses. */
export const gameId = (url) => String(url).split("/").pop();

/**
 * Every standard-chess game in an account's archive, keyed by numeric id.
 *
 * `rated` and `live` are carried because the brilliant-move list only covers
 * rated games, and nothing on that page says whether daily games are indexed at
 * all — so both have to be filterable downstream rather than assumed.
 */
export async function fetchArchive(user) {
  const { archives } = await getJson(`https://api.chess.com/pub/player/${user}/games/archives`);
  const games = new Map();
  for (const month of archives) {
    let batch;
    try {
      ({ games: batch } = await getJson(month));
    } catch {
      continue;
    }
    for (const g of batch ?? []) {
      if (g.rules !== "chess") continue;
      const id = gameId(g.url);
      const userColor = (g.white?.username ?? "").toLowerCase() === user.toLowerCase() ? "w" : "b";
      games.set(id, {
        id,
        url: g.url,
        rated: !!g.rated,
        live: String(g.url).includes("/game/live/"),
        timeClass: g.time_class,
        userColor,
        // The player's own rating in THIS game. Carried so a rule can be checked
        // for rating dependence: a pattern fitted only on 400-rated games is not
        // obviously chess.com's rule, and this is the column that tests that.
        rating: (userColor === "w" ? g.white?.rating : g.black?.rating) ?? null,
        opp: userColor === "w" ? g.black?.username : g.white?.username,
        date: g.end_time ? new Date(g.end_time * 1000).toISOString().slice(0, 10) : "",
        pgn: (g.pgn?.split(/\n\n/)[1] ?? "").replace(/\{[^}]*\}/g, "").replace(/\d+\.\.\./g, "").replace(/\s+/g, " ").trim(),
      });
    }
  }
  return games;
}

/**
 * Deterministic sample of `n` ids — FNV-1a hash, smallest first.
 *
 * Not `Math.random()`, and the reason is the same one that governs the fit/test
 * split: a sample redrawn on every run is a sample you can redraw until the
 * numbers flatter you. Hashing the id also means adding games later cannot
 * reshuffle the ones already chosen, so a dataset only ever grows.
 */
export function stableSample(ids, n) {
  const hash = (s) => {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h;
  };
  return [...ids].sort((a, b) => hash(a) - hash(b) || a.localeCompare(b)).slice(0, n);
}
