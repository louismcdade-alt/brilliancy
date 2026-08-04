import { useMemo, useRef, useState } from "react";
import type { Brilliancy, Game, Profile, Source, Stats } from "./types";
import { SOURCE_LABEL } from "./types";
import * as chesscom from "./api/chesscom";
import * as lichess from "./api/lichess";
import { engine } from "./engine/engine";
import { scanGame } from "./engine/brilliancy";
import type { Candidate, NearMiss } from "./engine/brilliancy";
import { brilliancyScore, SCORE_CUT } from "./engine/score";
import { NearMissList } from "./components/NearMissList";
import { SearchBar } from "./components/SearchBar";
import { ProfileHeader } from "./components/ProfileHeader";
import { StatsDashboard } from "./components/StatsDashboard";
import { GameList } from "./components/GameList";
import { BrilliancyGallery } from "./components/BrilliancyGallery";
import { BoardViewer } from "./components/BoardViewer";
import { Board } from "./components/Board";

/**
 * The two adapters expose the same five names, so the whole of the rest of this
 * file picks a module and then never asks which site it is talking to again.
 * `isNotFound` has to come from the module too: each adapter has its own private
 * ApiError class, so chesscom's version would answer `false` to a Lichess 404.
 */
const API = { chesscom, lichess } as const;

const GAMES_TO_LOAD = 30; // opening view: enough to render fast, not the scan limit
const SCAN_DEPTH = 14;

/**
 * The ceiling on "Everything", and it is a real ceiling rather than a tidy-up.
 *
 * This used to be `Infinity`, which chesscom.ts faithfully turned into "walk
 * every monthly archive". Hikaru has 152 of them (counted against the live API),
 * so picking Everything on a heavy account meant ~150 sequential requests and
 * tens of thousands of games fetched before a single move reached the engine —
 * the exact shape of traffic that earns the rate-limiting RELEASE.md lists as a
 * launch risk, and all of it spent before the user sees anything happen.
 *
 * 1000 is chosen from the other end: at the measured ~50 games/minute it is
 * about twenty minutes of scanning, which is already far past what anyone will
 * sit through. A cap that only binds on histories nobody would wait out anyway
 * costs no real user anything.
 *
 * Lichess never had this problem — its adapter caps `max` at 500 because the
 * value goes into a query string and `Infinity` would have been sent as the
 * literal text "Infinity".
 */
const MAX_SCAN_GAMES = 1000;

/**
 * How far back to look. Brilliant moves are rare, so a month of games can easily
 * contain none — the scan window is the difference between "you have no
 * brilliancies" and "we didn't look at the games that had them".
 */
const SCOPES = [
  { games: 30, label: "Last 30" },
  { games: 100, label: "Last 100" },
  { games: 250, label: "Last 250" },
  { games: MAX_SCAN_GAMES, label: "Everything" },
];

/**
 * Measured, not guessed: 120 games in 2m08s on a laptop, so ~56/minute. Cost
 * tracks the number of *sacrifice candidates* rather than games — quiet games
 * never reach the engine — so this is a rough middle rather than a promise.
 */
const GAMES_PER_MINUTE = 50;

function estimate(games: number): string {
  if (games < GAMES_PER_MINUTE) return "under a minute";
  return `about ${Math.round(games / GAMES_PER_MINUTE)} minutes`;
}

// A Greek-gift sacrifice — decorates the hero with a recognizable !! motif.
const HERO_FEN = "r1bq1rk1/ppp2ppp/2n2n2/3p4/1b1P4/2NB1N2/PPP2PPP/R1BQ1RK1 w - - 0 1";

/**
 * Example handles have to be per-source: "Hikaru" on Lichess is not Nakamura,
 * and a chip that loads a stranger's games is worse than no chip at all.
 */
const EXAMPLES: Record<Source, string[]> = {
  chesscom: ["Hikaru", "MagnusCarlsen", "GothamChess"],
  lichess: ["DrNykterstein", "EricRosen", "penguingim1"],
};

/**
 * A pasted profile link should just work. Both sites put the handle in a
 * predictable place, and the URL says which site it is far more reliably than
 * the handle ever could — so a paste sets the source as well as the name, and
 * the segmented control follows along rather than silently disagreeing with what
 * was pasted.
 */
function parseQuery(raw: string, fallback: Source): { source: Source; username: string } {
  const text = raw.trim();
  const lower = text.toLowerCase();

  if (lower.includes("lichess.org")) {
    // https://lichess.org/@/EricRosen  ·  lichess.org/@/EricRosen/all
    const m = text.match(/lichess\.org\/@\/([A-Za-z0-9_-]+)/i);
    if (m) return { source: "lichess", username: m[1] };
  }
  if (lower.includes("chess.com")) {
    // https://www.chess.com/member/Hikaru  ·  chess.com/member/hikaru/stats
    const m = text.match(/chess\.com\/(?:member|player)\/([A-Za-z0-9_-]+)/i);
    if (m) return { source: "chesscom", username: m[1] };
  }
  // A bare "@handle" is a handle, not a URL — strip the sigil the field already
  // prints so pasting "@hikaru" doesn't search for a user literally called that.
  return { source: fallback, username: text.replace(/^@+/, "") };
}

/**
 * Turn an adapter error into something worth showing a reader.
 *
 * Both adapters throw `ApiError("not-found", 404)` — an internal sentinel that
 * exists so isNotFound() can recognise a 404, not a sentence. It has reached the
 * screen twice now, so the filter lives in one place: anything the adapter wrote
 * for a human is passed through, anything that looks like a sentinel (empty, or
 * a single word with no space in it) is replaced by `fallback`.
 *
 * A 404 from a games endpoint is deliberately NOT special-cased into "no such
 * player". Measured against the live API: Lichess's game export answers a
 * throttled IP with 404 as readily as with 429, on an account whose profile had
 * just loaded 200. So a 404 here means "the export refused us", and "try again
 * shortly" is both the honest reading and the useful one.
 */
function humanError(e: unknown, fallback: string): string {
  const raw = e instanceof Error ? e.message : "";
  return !raw || !/\s/.test(raw) ? fallback : raw;
}

type Status = "idle" | "loading" | "loaded" | "error";

interface ViewerState {
  game: Game;
  brilliancies: Brilliancy[];
  initialPly?: number;
}

export function App() {
  const [query, setQuery] = useState("");
  /**
   * The source the SEARCH BOX is set to. Deliberately separate from
   * `profile.source`, which is the source the loaded player actually came from:
   * flicking the control to Lichess while a chess.com profile is on screen must
   * not make "load more games" start asking Lichess for that player's history.
   * Everything after a successful load reads profile.source; only loadUser reads
   * this one.
   */
  const [source, setSource] = useState<Source>("chesscom");
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);

  const [profile, setProfile] = useState<Profile | null>(null);
  const [stats, setStats] = useState<Stats>({});
  const [games, setGames] = useState<Game[]>([]);

  const [brilliancies, setBrilliancies] = useState<Brilliancy[]>([]);
  const [scanState, setScanState] = useState<"idle" | "running" | "done">("idle");
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [engineWarming, setEngineWarming] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  /**
   * Did the games request FAIL, as opposed to returning nothing?
   *
   * `games: []` is produced by both, and the two need opposite copy: "this
   * player has no recent standard games" is a conclusion about the player, and
   * printing it when the request was actually refused states as fact something
   * we do not know — directly under a banner saying the request failed.
   */
  const [gamesFailed, setGamesFailed] = useState(false);
  const [nearMisses, setNearMisses] = useState<NearMiss[]>([]);

  const [scope, setScope] = useState<number>(GAMES_TO_LOAD);
  const [loadingMore, setLoadingMore] = useState(false);

  const [gameUrl, setGameUrl] = useState("");
  const [singleState, setSingleState] = useState<"idle" | "working">("idle");
  const [singleError, setSingleError] = useState<string | null>(null);

  const [viewer, setViewer] = useState<ViewerState | null>(null);

  const cancelScan = useRef(false);

  /**
   * Games already scanned this session, keyed by chess.com game id.
   *
   * Widening the scope was re-buying work already paid for: "Last 30" then
   * "Last 100" rescanned the first thirty, and at roughly 2.7s a game that is a
   * wasted minute and a half in front of someone who is watching a progress bar.
   * Scanning is deterministic — engine.ts issues `ucinewgame` before every
   * search precisely so the same position always returns the same evaluation —
   * so a cached result is not merely similar to a fresh one, it is identical.
   *
   * In memory only, never localStorage: the site's claim is that nothing leaves
   * the page, and a cache that survives the tab would make that harder to say
   * plainly. It empties on reload, which is the correct trade.
   *
   * KEYED BY SOURCE, GAME **AND COLOUR**. A scan only judges one side, so the
   * same game has two different answers depending on whose moves are being
   * looked at — and both players can be searched in one session, since a game id
   * is shared between them. Keying on the id alone would serve White's
   * brilliancies to someone who searched Black.
   *
   * The source prefix guards the same failure across sites. This cache outlives
   * a search — that is the whole point of it — so a chess.com uuid and a Lichess
   * 8-character id share one Map, and nothing in either id space rules out a
   * collision. A collision here would not error; it would quietly show one
   * player a different game's brilliancies, which is the worst kind of bug this
   * app can have. Two extra characters in a key is a cheap way not to have it.
   */
  const scanCache = useRef(new Map<string, Brilliancy[]>());
  /**
   * The declined sacrifices, cached beside the flagged ones under the same key.
   *
   * A PARALLEL map rather than widening scanCache's value: that cache's keying
   * and its cancelled-scan rule are subtle and load-bearing, and there is no
   * reason to reopen them to add a second payload. Both maps are written and
   * read together, so they cannot disagree about which games have been scanned.
   */
  const nearCache = useRef(new Map<string, NearMiss[]>());
  const cacheKey = (g: Game) => `${g.source}:${g.id}:${g.userColor}`;

  /**
   * Likeliest first, not biggest first.
   *
   * Ordering by sacrifice size answers "which gave up the most material", which
   * is not the question a reader has. The learned scorer is trained to predict
   * exactly the thing they care about — whether chess.com would call this
   * brilliant — so it is the better ranking, and it matters more than it used to:
   * the model flags roughly twice as many moves as the old rule at around 30%
   * precision, so what sits at the top of the list is most of what gets read.
   * Sacrifice size stays as the tie-break.
   */
  const sortedBrilliancies = useMemo(
    () =>
      [...brilliancies].sort(
        (a, b) => b.score - a.score || b.sacrifice - a.sacrifice || b.evalAfter - a.evalAfter,
      ),
    [brilliancies],
  );

  /**
   * Keyed by bare game id, unlike scanCache: `brilliancies` is cleared by
   * loadUser on every search, so everything in it belongs to the one profile
   * currently on screen and therefore to one source. There is no cross-source
   * lifetime here for a collision to happen in.
   */
  const brilliancyCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const b of brilliancies) counts[b.game.id] = (counts[b.game.id] ?? 0) + 1;
    return counts;
  }, [brilliancies]);

  /** Games the NEXT scan will cover: the window, capped by what history exists. */
  const scanCount = Math.min(scope, games.length);

  /**
   * What the scan that just FINISHED actually did: games covered and moves it
   * found, both counted in the run itself.
   *
   * `games` is deliberately separate from scanCount, because analysing a single
   * pasted game leaves scanCount at 30, so every "in N games" claim after a
   * one-game scan named a number that had nothing to do with what was examined.
   * `moves` exists for the same reason and was the half that got missed:
   * `brilliancies` ACCUMULATES across a sweep and a later single-game scan, so
   * the assertive region paired the running total with the one game just
   * examined and announced "3 brilliant moves found in 1 game" — a sentence
   * about no scan that ever happened, spoken to a screen reader as the answer.
   * Counted here rather than read back off state because a scan that re-finds a
   * game's brilliancies (the cache-hit path, or re-analysing a game already in
   * the list) changes the total by less than it found.
   */
  const [lastScan, setLastScan] = useState<{ moves: number; games: number }>({
    moves: 0,
    games: 0,
  });

  /**
   * The sentence the assertive live region speaks when a scan finishes.
   *
   * Two numbers, and they are not always the same one. `lastScan.moves` is what
   * this run found; `sortedBrilliancies.length` is what is on screen, which
   * after a single-game scan still includes everything an earlier sweep found —
   * the gallery and the "Circled" cell deliberately keep showing those. So when
   * they differ the announcement names both and says which is which, rather than
   * picking one and contradicting either the scan or the page.
   */
  const scanAnnouncement = useMemo(() => {
    if (scanState !== "done") return "";
    const { moves, games: n } = lastScan;
    const where = n === 1 ? "this game" : `${n} games`;
    const head = moves
      ? `Scan complete. ${moves} brilliant ${moves === 1 ? "move" : "moves"} found in ${where}.`
      : `Scan complete. No brilliant moves found in ${where}.`;
    const shown = sortedBrilliancies.length;
    return moves === shown
      ? head
      : `${head} ${shown} brilliant ${shown === 1 ? "move" : "moves"} shown in total, including earlier scans.`;
  }, [scanState, lastScan, sortedBrilliancies.length]);

  const summary = useMemo(() => {
    const total = games.length;
    const wins = games.filter((g) => g.result === "win").length;
    const accs = games.map((g) => g.userAccuracy).filter((a): a is number => typeof a === "number");
    const avgAcc = accs.length ? accs.reduce((s, a) => s + a, 0) / accs.length : null;
    return {
      total,
      // null, not 0, when there are no games to compute it from. The Accuracy
      // and Circled cells already render "—" in that case; Won was the one that
      // invented a number, so a failed games request (a Lichess throttle, say)
      // printed a confident "Won 0%" above the fold while the error explaining
      // the empty list sat further down the page.
      winRate: total ? Math.round((wins / total) * 100) : null,
      avgAcc,
    };
  }, [games]);

  async function loadUser(name: string, forceSource?: Source) {
    const parsed = parseQuery(name, forceSource ?? source);
    const username = parsed.username;
    const site = parsed.source;
    if (!username) return;
    // A pasted profile URL can override the picker; reflect that in the control
    // so it never shows a different site from the one being searched.
    if (site !== source) setSource(site);
    cancelScan.current = true;
    setStatus("loading");
    setError(null);
    setProfile(null);
    setBrilliancies([]);
    setNearMisses([]);
    setScanState("idle");
    setScanError(null);
    setGamesFailed(false);
    setScope(GAMES_TO_LOAD);
    setGameUrl("");
    setSingleError(null);

    const api = API[site];
    try {
      const prof = await api.fetchProfile(username);
      /**
       * Stats and games are each allowed to fail without losing the profile —
       * but a games failure is NOT allowed to fail silently. It used to be:
       * `.catch(() => [])` rendered "0 games loaded" identically whether the
       * player has none or the request was refused, and Lichess makes that
       * distinction matter, since its export endpoint permits only one request
       * at a time per IP and answers 429 to the second. "You have no games" is a
       * conclusion about the player; "wait a minute" is a thing to do.
       *
       * Stats keeps its silent catch: a missing rating card is self-evidently a
       * gap, and there is nothing the reader can act on.
       */
      let gamesError: string | null = null;
      const [st, gms] = await Promise.all([
        api.fetchStats(username).catch(() => ({}) as Stats),
        api.fetchRecentGames(username, GAMES_TO_LOAD).catch((e) => {
          gamesError = humanError(
            e,
            `Couldn't load games from ${SOURCE_LABEL[site]}. Try again shortly.`,
          );
          return [] as Game[];
        }),
      ]);
      setProfile(prof);
      setStats(st);
      setGames(gms);
      setScanError(gamesError);
      // Remembered separately from the message, because an empty list means two
      // completely different things and the list is what has to say which.
      setGamesFailed(gamesError !== null);
      setStatus("loaded");
    } catch (e) {
      setStatus("error");
      setError(
        api.isNotFound(e)
          ? `No ${SOURCE_LABEL[site]} player called “${username}”. Check the spelling — and the source, if they play on the other site.`
          : e instanceof Error
            ? e.message
            : "Something went wrong loading that player.",
      );
    }
  }

  /** Widen (or narrow) the window, refetching so the list and the scan agree. */
  async function changeScope(next: number) {
    if (!profile || next === scope) return;
    setScope(next);
    if (next <= games.length) return; // already have them; just scan fewer
    setLoadingMore(true);
    try {
      setGames(await API[profile.source].fetchRecentGames(profile.username, next));
    } catch (e) {
      // Surface the adapter's own message when it has one — Lichess's 429 tells
      // the user to wait a minute, which is actionable; a generic "try again
      // shortly" would throw that away. But it has to go through the same
      // sentinel filter loadUser uses: widening the scope is the single most
      // likely way to trip Lichess's export throttle, and a bare `e.message`
      // printed the word "not-found" on screen when it did.
      setScanError(
        humanError(
          e,
          `Couldn't load more games from ${SOURCE_LABEL[profile.source]}. Try again shortly.`,
        ),
      );
    } finally {
      setLoadingMore(false);
    }
  }

  /**
   * Analyze one specific game. This is the answer to "chess.com starred a move in
   * THIS game" — those games are usually nowhere near the most recent 30, and
   * waiting out a full sweep to check one of them is absurd.
   */
  async function scanOneGame() {
    const raw = gameUrl.trim();
    if (!raw || !profile || singleState === "working") return;
    setSingleState("working");
    setSingleError(null);
    try {
      const game = await API[profile.source].fetchGameByUrl(profile.username, raw);
      if (!game) {
        setSingleError(
          `Couldn't find that ${SOURCE_LABEL[profile.source]} game among @${profile.username}'s games.`,
        );
        return;
      }
      await engine.init();
      // Collect near-misses here too. Analysing one game is the path someone
      // takes when they already believe there is something in it, which is
      // exactly when "the engine looked at this and here is why it said no" is
      // the answer they came for.
      const weighed: NearMiss[] = [];
      const found = await scanGame(game, {
        depth: SCAN_DEPTH,
        onCandidate: (c: Candidate) => {
          if (c.admitted !== "offer") return;
          weighed.push({ game, candidate: c, score: brilliancyScore(c) });
        },
      });
      const near = weighed.filter((n) => n.score < SCORE_CUT);
      scanCache.current.set(cacheKey(game), found);
      nearCache.current.set(cacheKey(game), near);
      setBrilliancies((prev) => [
        ...prev.filter((b) => b.game.id !== game.id),
        ...found,
      ]);
      setNearMisses((prev) => [...prev.filter((n) => n.game.id !== game.id), ...near]);
      setGames((prev) => (prev.some((g) => g.id === game.id) ? prev : [game, ...prev]));
      // Exactly one game was examined, and `found` is everything in it. Every
      // "N moves in M games" claim reads this, not the accumulated gallery.
      setLastScan({ moves: found.length, games: 1 });
      setScanState("done");
      setViewer({ game, brilliancies: found, initialPly: found[0]?.ply });
      if (!found.length) {
        setSingleError("No brilliancy in that game — opened it so you can look for yourself.");
      }
    } catch (e) {
      setSingleError(
        e instanceof Error ? e.message : "Couldn't analyze that game.",
      );
    } finally {
      setSingleState("idle");
    }
  }

  async function runScan() {
    if (games.length === 0 || scanState === "running") return;
    const toScan = games.slice(0, scanCount);
    cancelScan.current = false;
    setScanState("running");
    setScanError(null);
    setBrilliancies([]);
    setNearMisses([]);
    setProgress({ done: 0, total: toScan.length });
    setEngineWarming(true);

    try {
      await engine.init();
    } catch {
      setEngineWarming(false);
      setScanState("idle");
      setScanError("The chess engine couldn't start in this browser. Try Chrome or Firefox.");
      return;
    }
    setEngineWarming(false);

    // `scanned` counts games actually reached, so a cancelled scan reports the
    // window it covered rather than the one it was aiming at. `moves` is summed
    // here rather than read from state after the loop: setBrilliancies is
    // asynchronous, so state inside and just after the loop is stale.
    let scanned = 0;
    let moves = 0;
    let failures = 0;
    for (let i = 0; i < toScan.length; i++) {
      if (cancelScan.current) break;
      scanned++;
      try {
        const game = toScan[i];
        const cached = scanCache.current.get(cacheKey(game));
        // Every candidate the engine weighed, flagged or not. Collected into a
        // local array rather than straight into state: onCandidate fires several
        // times per game and a setState per callback would re-render the gallery
        // on every rejected move.
        const weighed: NearMiss[] = [];
        // Re-point `game` on a cache hit: the id is the same but the object came
        // from an earlier fetch, and the UI reads b.game for opponent and date.
        const found = cached
          ? cached.map((b) => ({ ...b, game }))
          : await scanGame(
              game,
              {
                depth: SCAN_DEPTH,
                onCandidate: (c: Candidate) => {
                  // Offer candidates only. An `allow` row is outside the model's
                  // training distribution, so its score is not a confidence in
                  // anything -- brilliancy.ts refuses to flag one for the same
                  // reason, and showing it here would launder that.
                  if (c.admitted !== "offer") return;
                  weighed.push({ game, candidate: c, score: brilliancyScore(c) });
                },
              },
              () => cancelScan.current,
            );
        // Never cache a cancelled game: scanGame returns whatever it found
        // before the abort, which is a partial answer wearing a complete one's
        // clothes.
        const near = cached
          ? (nearCache.current.get(cacheKey(game)) ?? []).map((n) => ({ ...n, game }))
          : weighed.filter((n) => n.score < SCORE_CUT);
        if (!cached && !cancelScan.current) {
          scanCache.current.set(cacheKey(game), found);
          nearCache.current.set(cacheKey(game), near);
        }
        moves += found.length;
        if (found.length) setBrilliancies((prev) => [...prev, ...found]);
        if (near.length) setNearMisses((prev) => [...prev, ...near]);
      } catch {
        // Skip a game that fails to analyze and keep the scan going — but COUNT
        // it. Swallowing these silently meant a scan in which the engine died
        // after init (a dead worker, OOM on a phone) reached "done" with zero
        // brilliancies and reported "nothing even reached the engine", which is
        // a confident conclusion about the player's chess drawn from a failure
        // of ours.
        failures++;
      }
      setProgress({ done: i + 1, total: toScan.length });
    }

    setLastScan({ moves, games: scanned });
    if (failures > 0 && failures === scanned) {
      // Every single game failed: report the failure, not a result.
      setScanError(
        "The engine stopped responding partway through, so none of these games were analysed. Reload the page and try again.",
      );
    } else if (failures > 0) {
      setScanError(
        `${failures} of ${scanned} games couldn't be analysed and were skipped, so this list may be incomplete.`,
      );
    }
    if (!cancelScan.current) setScanState("done");
    else setScanState("idle");
  }

  function stopScan() {
    cancelScan.current = true;
  }

  function reset() {
    cancelScan.current = true;
    setStatus("idle");
    setProfile(null);
    setError(null);
    setQuery("");
  }

  const showHero = !profile;
  /** The site whose data is on screen — not necessarily the one in the picker. */
  const activeSite = profile ? SOURCE_LABEL[profile.source] : SOURCE_LABEL[source];

  return (
    <div className="shell">
      {/* 46 tab stops in the loaded state, and hundreds once the scope is wide —
          the game list alone is one stop per row. Without this a keyboard user
          has no way past it. */}
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="topbar">
        <div className="wrap topbar-inner">
          {/* The h1 got this treatment and the logo never did, so the first
              control a screen reader reaches was announcing "exclamation mark
              exclamation mark Brilliancy chess.com & lichess". Same fix, plus a
              real name: this button resets to the search and nothing said so. */}
          <button className="mark" onClick={reset} aria-label="Brilliancy — back to search">
            <span className="mark-glyph" aria-hidden="true">
              !!
            </span>
            <span>Brilliancy</span>
            <span className="mark-sub">chess.com &amp; lichess</span>
          </button>
          {profile && (
            <div className="topbar-search">
              <SearchBar
                value={query}
                onChange={setQuery}
                source={source}
                onSourceChange={setSource}
                onSubmit={() => loadUser(query)}
                loading={status === "loading"}
                variant="bar"
              />
            </div>
          )}
        </div>
      </header>

      <main id="main" tabIndex={-1}>
        {/* Mounted unconditionally, and that is the whole trick: aria-live only
            announces CHANGES to a region already in the tree, so a live region
            that appears at the same moment as its first message says nothing at
            all. Polite, because a scan runs for minutes and must not interrupt
            someone reading the page; throttled to every fifth game, because
            announcing all 250 would bury the speech queue under its own
            progress. Before this, pressing "Find brilliancies" produced total
            silence for one to five minutes with no way to tell working from
            broken — on the site's primary action. */}
        {/* Loading a profile is the FIRST thing anyone does here and it
            announced nothing between submit and the profile appearing — the
            same "working or broken?" silence the scan region exists to fix.
            Its failure path is already covered by the role="alert" error box,
            so this only has to speak for the states that aren't errors. */}
        <div className="sr-only" aria-live="polite" aria-atomic="true">
          {status === "loading"
            ? "Loading profile…"
            : status === "loaded" && profile
              ? `Loaded ${profile.username}. ${games.length} ${games.length === 1 ? "game" : "games"} ready to scan.`
              : loadingMore
                ? "Loading more games…"
                : ""}
        </div>
        <div className="sr-only" aria-live="polite" aria-atomic="true">
          {scanState === "running"
            ? engineWarming
              ? "Loading the chess engine. This happens once, then it is cached."
              : progress.done % 5 === 0 || progress.done === progress.total
                ? `Analysed ${progress.done} of ${progress.total} games. ${brilliancies.length} brilliant ${brilliancies.length === 1 ? "move" : "moves"} found so far.`
                : ""
            : ""}
        </div>
        {/* Assertive, because this one is the answer to the question the user
            asked and there is nothing left to interrupt. */}
        <div className="sr-only" aria-live="assertive" aria-atomic="true">
          {scanAnnouncement}
        </div>

        {showHero && (
          <section className="hero">
            <div className="wrap hero-grid">
              <div>
                <p className="hero-eyebrow">Sound sacrifices, found by an engine</p>
                {/* The visible headline is the glyph, because the glyph is the
                    logo. But "Find your !!" is a headline with no words in it:
                    a screen reader says "exclamation mark exclamation mark" and
                    a search engine sees nothing at all. The hidden span carries
                    the meaning for both. */}
                <h1>
                  Find your{" "}
                  <span className="hero-bangs" aria-hidden="true">
                    !!
                  </span>
                  <span className="sr-only">
                    brilliant moves — Brilliancy for chess.com and Lichess
                  </span>
                </h1>
                <p className="hero-lede">
                  Drop in any chess.com or Lichess username. We pull your recent games and run a
                  chess engine over them to surface your <strong>brilliant moves</strong> — the
                  sound sacrifices — next to your ratings and record.
                </p>
                <div className="hero-search-wrap">
                  <SearchBar
                    value={query}
                    onChange={setQuery}
                    source={source}
                    onSourceChange={setSource}
                    onSubmit={() => loadUser(query)}
                    loading={status === "loading"}
                    variant="hero"
                    autoFocus
                  />
                  <div className="hero-hint">
                    <span>Try</span>
                    {EXAMPLES[source].map((ex) => (
                      <button
                        key={ex}
                        className="hero-chip"
                        // Every other control on the page announces a verb; these
                        // announced a bare handle ("Hikaru, button"), and the
                        // "Try" label beside them is not associated with them.
                        aria-label={`Try the example ${SOURCE_LABEL[source]} account ${ex}`}
                        onClick={() => {
                          setQuery(ex);
                          // Pass the source explicitly rather than relying on the
                          // state update above having landed: setSource is
                          // asynchronous, and a chip that searched the wrong site
                          // on its first click would be a maddening bug.
                          loadUser(ex, source);
                        }}
                      >
                        {ex}
                      </button>
                    ))}
                  </div>
                </div>
                {/* role="alert" implies assertive: this is a direct answer to
                    the user's own keypress, so interrupting is correct. Without
                    it a typo'd username produced a visible error and complete
                    silence. */}
                {error && (
                  <div className="error-box" role="alert" id="search-error" style={{ marginTop: 18 }}>
                    {error}
                  </div>
                )}
              </div>
              <div className="hero-stage">
                <Board
                  fen={HERO_FEN}
                  orientation="white"
                  arrow={{ from: "d3", to: "h7" }}
                  brilliantSquare="h7"
                  seal="!!"
                  coords={false}
                />
              </div>
            </div>
          </section>
        )}

        {profile && (
          <>
            <section className="wrap">
              {/* showHero is !profile, so searching unmounts the hero and takes
                  the only h1 on the page with it — the document then started at
                  h2 and heading navigation had no top-level anchor. Naming the
                  player is better copy than the hero's line anyway, because by
                  this point the page is about someone specific. */}
              <h1 className="sr-only">
                Brilliant moves in @{profile.username}'s {activeSite} games
              </h1>
              <ProfileHeader profile={profile} />
            </section>

            <section className="wrap section" aria-labelledby="h-ratings">
              {/* Printed label above, written value below — the way a field on a
                  form is filled in, not a row of oversized statistics. */}
              <div className="summary-strip">
                <div className="summary-cell">
                  <div className="summary-label">Games loaded</div>
                  <div className="summary-num">{summary.total}</div>
                </div>
                <div className="summary-cell">
                  <div className="summary-label">Won</div>
                  <div className="summary-num">
                    {summary.winRate === null ? "—" : `${summary.winRate}%`}
                  </div>
                </div>
                <div className="summary-cell">
                  <div className="summary-label">Accuracy</div>
                  <div className="summary-num">
                    {summary.avgAcc !== null ? `${summary.avgAcc.toFixed(1)}%` : "—"}
                  </div>
                </div>
                <div className="summary-cell">
                  <div className="summary-label">Circled</div>
                  <div className={`summary-num ${brilliancies.length ? "is-bril" : ""}`}>
                    {scanState === "idle" ? "—" : brilliancies.length}
                  </div>
                </div>
              </div>

              <div className="section-head">
                <div className="section-title">
                  <h2 id="h-ratings">Ratings &amp; record</h2>
                </div>
              </div>
              <StatsDashboard stats={stats} source={profile.source} />
            </section>

            <section className="wrap section" aria-labelledby="h-brilliancies">
              <div className="section-head">
                <div className="section-title">
                  <span className="section-index" aria-hidden="true">
                    !!
                  </span>
                  <h2 id="h-brilliancies">Brilliancies</h2>
                </div>
                <p className="section-note">
                  Sound sacrifices detected by Stockfish. An approximation of chess.com's !!.
                </p>
              </div>

              {/* Controls stay put once a scan finishes — widening the window or
                  checking one more game is exactly what you want to do next. */}
              {scanState !== "running" && (
                <div className="analyze-panel analyze-panel-col">
                  <div className="analyze-row">
                    <div className="analyze-copy">
                      <h3>
                        Scan {loadingMore ? "…" : scanCount} game{scanCount === 1 ? "" : "s"} for
                        brilliant moves
                      </h3>
                      <p>
                        Runs a chess engine in your browser over every move you played. Nothing
                        leaves this page. The first scan downloads the engine and its
                        neural network (~40&nbsp;MB); after that it's cached and instant.
                      </p>
                    </div>
                    <button
                      className="btn btn-bril"
                      onClick={runScan}
                      disabled={games.length === 0 || loadingMore}
                    >
                      {scanState === "done" ? "Scan again" : "Find brilliancies"}
                    </button>
                  </div>

                  <div className="scope-row">
                    <span className="scope-label">How far back</span>
                    {/* Which option is selected was carried only by the `is-on`
                        class, which assistive tech cannot see — so all four
                        announced identically and there was no way to tell what
                        the current scope was. */}
                    <div className="scope-seg" role="group" aria-label="How far back to scan">
                      {SCOPES.map((s) => (
                        <button
                          key={s.label}
                          className={`scope-opt ${scope === s.games ? "is-on" : ""}`}
                          aria-pressed={scope === s.games}
                          onClick={() => changeScope(s.games)}
                          disabled={loadingMore}
                        >
                          {s.label}
                        </button>
                      ))}
                    </div>
                    <span className="scope-note">
                      {/* Say when the cap bites. "Everything" that quietly stops
                          at a thousand games is a small lie, and on a site whose
                          headline claim is that it only approximates chess.com's
                          !!, small lies are expensive. Most accounts never reach
                          it and never see this clause. */}
                      {loadingMore
                        ? "loading games…"
                        : `Takes ${estimate(scanCount)}. ${
                            scope === MAX_SCAN_GAMES && games.length >= MAX_SCAN_GAMES
                              ? `Capped at the most recent ${MAX_SCAN_GAMES} games.`
                              : "Brilliancies are rare — a single month often has none."
                          }`}
                    </span>
                  </div>

                  <div className="single-row">
                    <label className="single-field">
                      <span className="single-label">Or analyse one game</span>
                      <input
                        className="single-input"
                        value={gameUrl}
                        onChange={(e) => setGameUrl(e.target.value)}
                        onKeyDown={(e) => e.key === "Enter" && scanOneGame()}
                        placeholder={`paste a ${activeSite} game link`}
                        spellCheck={false}
                        aria-label={`${activeSite} game URL`}
                      />
                    </label>
                    <button
                      className="btn btn-ghost"
                      onClick={scanOneGame}
                      disabled={!gameUrl.trim() || singleState === "working"}
                      aria-label={singleState === "working" ? "Analysing that game" : undefined}
                    >
                      {singleState === "working" ? <span className="spinner" /> : "Analyse"}
                    </button>
                  </div>
                  {singleError && (
                    <p className="single-error" role="alert">
                      {singleError}
                    </p>
                  )}
                </div>
              )}

              {scanState === "running" && (
                <div className="analyze-panel" style={{ flexDirection: "column", alignItems: "stretch" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                    <span className="spinner" />
                    <strong style={{ color: "var(--text-hi)" }}>
                      {/* On a cold cache this step is a 40 MB network download with
                          no progress to report, so it must say what it's waiting
                          on — otherwise it reads as a hang. */}
                      {engineWarming
                        ? "Loading the engine — first time only, then it's cached…"
                        : `Analyzing game ${progress.done} of ${progress.total}`}
                    </strong>
                    <button className="btn btn-ghost" style={{ marginLeft: "auto" }} onClick={stopScan}>
                      Stop
                    </button>
                  </div>
                  <div className="progress">
                    {/* aria-valuetext rather than bare numbers: "142 of 250
                        games analysed" is what the bar means, and a screen
                        reader left to itself would announce a bare percentage. */}
                    <div
                      className="progress-track"
                      role="progressbar"
                      aria-label="Scan progress"
                      aria-valuemin={0}
                      aria-valuemax={progress.total}
                      aria-valuenow={progress.done}
                      aria-valuetext={`${progress.done} of ${progress.total} games analysed`}
                    >
                      <div
                        className="progress-fill"
                        style={{
                          width: `${progress.total ? (progress.done / progress.total) * 100 : 5}%`,
                        }}
                      />
                    </div>
                    <div className="progress-meta">
                      <span>{brilliancies.length} found so far</span>
                      <span>{progress.total ? Math.round((progress.done / progress.total) * 100) : 0}%</span>
                    </div>
                  </div>
                </div>
              )}

              {scanError && (
                <div className="error-box" role="alert" style={{ marginTop: 14 }}>
                  {scanError}
                </div>
              )}

              {(scanState === "done" || (scanState === "running" && brilliancies.length > 0)) &&
                (sortedBrilliancies.length > 0 ? (
                  <div style={{ marginTop: 18 }}>
                    <BrilliancyGallery
                      brilliancies={sortedBrilliancies}
                      onOpen={(b) =>
                        setViewer({
                          game: b.game,
                          brilliancies: brilliancies.filter((x) => x.game.id === b.game.id),
                          initialPly: b.ply,
                        })
                      }
                    />
                  </div>
                ) : scanState === "done" && nearMisses.length === 0 ? (
                  // Only the true nothing-at-all case now. When the engine
                  // weighed something, the pencil tier below says so and this
                  // paragraph would be contradicting it.
                  <p className="empty-note">
                    No brilliancies in{" "}
                    {lastScan.games === 1 ? "that game" : `these ${lastScan.games} games`} —
                    nothing even reached the engine. Brilliant moves are rare, and a short window can
                    easily hold none: try widening the scan before concluding you've never played
                    one.
                  </p>
                ) : null)}

              {scanState === "done" && (
                <NearMissList
                  nearMisses={nearMisses}
                  hasBrilliancies={sortedBrilliancies.length > 0}
                  onOpen={(n) =>
                    setViewer({
                      game: n.game,
                      brilliancies: brilliancies.filter((x) => x.game.id === n.game.id),
                      initialPly: n.candidate.ply,
                    })
                  }
                />
              )}
            </section>

            <section className="wrap section" aria-labelledby="h-games">
              <div className="section-head">
                <div className="section-title">
                  <h2 id="h-games">Recent games</h2>
                </div>
                <p className="section-note">Newest first. Click any game to replay it.</p>
              </div>
              <GameList
                games={games}
                loadFailed={gamesFailed}
                brilliancyCounts={brilliancyCounts}
                source={profile.source}
                onOpen={(g) =>
                  setViewer({
                    game: g,
                    brilliancies: brilliancies.filter((x) => x.game.id === g.id),
                  })
                }
              />
            </section>
          </>
        )}
      </main>

      <footer className="footer">
        <div className="wrap">
          {/* Attribution here isn't decoration: shipping Stockfish's WASM build to
              every visitor is GPL distribution, and the cburnett pieces are
              CC-BY-SA. Both require credit and a licence link at the point of use. */}
          {/* This line is a factual claim about where the page sends requests, so
              it has to list every host it can reach — adding Lichess to
              connect-src without adding it here would leave the site quietly
              understating what it talks to. */}
          <p className="footer-line">
            Games come from whichever site you search: the public{" "}
            <a href="https://www.chess.com/news/view/published-data-api" target="_blank" rel="noreferrer">
              chess.com API
            </a>{" "}
            or the public{" "}
            <a href="https://lichess.org/api" target="_blank" rel="noreferrer">
              Lichess API
            </a>
            . Nothing else is contacted, and no account is needed for either. Brilliant moves are
            found in your browser and are an approximation of chess.com's <b>!!</b> — not
            affiliated with or endorsed by chess.com or Lichess.
          </p>
          <p className="footer-line footer-legal">
            Engine:{" "}
            <a href="https://github.com/official-stockfish/Stockfish" target="_blank" rel="noreferrer">
              Stockfish 16
            </a>{" "}
            (
            <a href="/licenses/GPL-3.0.txt" target="_blank" rel="noreferrer">
              GPL-3.0
            </a>
            ), WASM build by{" "}
            <a href="https://github.com/nmrugg/stockfish.js" target="_blank" rel="noreferrer">
              nmrugg/stockfish.js
            </a>
            . Pieces by Colin M.L. Burnett (
            <a
              href="https://creativecommons.org/licenses/by-sa/3.0/"
              target="_blank"
              rel="noreferrer"
            >
              CC BY-SA 3.0
            </a>
            ). Full notices:{" "}
            <a href="/licenses/THIRD-PARTY.md" target="_blank" rel="noreferrer">
              third-party licences
            </a>
            .
          </p>
        </div>
      </footer>

      {viewer && (
        <BoardViewer
          game={viewer.game}
          brilliancies={viewer.brilliancies}
          initialPly={viewer.initialPly}
          username={profile?.username}
          onClose={() => setViewer(null)}
        />
      )}
    </div>
  );
}
