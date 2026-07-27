import { useMemo, useRef, useState } from "react";
import type { Brilliancy, Game, Profile, Stats } from "./types";
import {
  fetchGameByUrl,
  fetchProfile,
  fetchRecentGames,
  fetchStats,
  isNotFound,
} from "./api/chesscom";
import { engine } from "./engine/engine";
import { scanGame } from "./engine/brilliancy";
import { SearchBar } from "./components/SearchBar";
import { ProfileHeader } from "./components/ProfileHeader";
import { StatsDashboard } from "./components/StatsDashboard";
import { GameList } from "./components/GameList";
import { BrilliancyGallery } from "./components/BrilliancyGallery";
import { BoardViewer } from "./components/BoardViewer";
import { Board } from "./components/Board";

const GAMES_TO_LOAD = 30; // opening view: enough to render fast, not the scan limit
const SCAN_DEPTH = 14;

/**
 * How far back to look. Brilliant moves are rare, so a month of games can easily
 * contain none — the scan window is the difference between "you have no
 * brilliancies" and "we didn't look at the games that had them".
 */
const SCOPES = [
  { games: 30, label: "Last 30" },
  { games: 100, label: "Last 100" },
  { games: 250, label: "Last 250" },
  { games: Infinity, label: "Everything" },
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

const EXAMPLES = ["Hikaru", "MagnusCarlsen", "GothamChess"];

type Status = "idle" | "loading" | "loaded" | "error";

interface ViewerState {
  game: Game;
  brilliancies: Brilliancy[];
  initialPly?: number;
}

export function App() {
  const [query, setQuery] = useState("");
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

  const [scope, setScope] = useState<number>(GAMES_TO_LOAD);
  const [loadingMore, setLoadingMore] = useState(false);

  const [gameUrl, setGameUrl] = useState("");
  const [singleState, setSingleState] = useState<"idle" | "working">("idle");
  const [singleError, setSingleError] = useState<string | null>(null);

  const [viewer, setViewer] = useState<ViewerState | null>(null);

  const cancelScan = useRef(false);

  const sortedBrilliancies = useMemo(
    () =>
      [...brilliancies].sort(
        (a, b) => b.sacrifice - a.sacrifice || b.evalAfter - a.evalAfter,
      ),
    [brilliancies],
  );

  const brilliancyCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const b of brilliancies) counts[b.game.id] = (counts[b.game.id] ?? 0) + 1;
    return counts;
  }, [brilliancies]);

  /** Games the scan will actually cover: the window, capped by what history exists. */
  const scanCount = Math.min(scope, games.length);

  const summary = useMemo(() => {
    const total = games.length;
    const wins = games.filter((g) => g.result === "win").length;
    const accs = games.map((g) => g.userAccuracy).filter((a): a is number => typeof a === "number");
    const avgAcc = accs.length ? accs.reduce((s, a) => s + a, 0) / accs.length : null;
    return {
      total,
      winRate: total ? Math.round((wins / total) * 100) : 0,
      avgAcc,
    };
  }, [games]);

  async function loadUser(name: string) {
    const username = name.trim();
    if (!username) return;
    cancelScan.current = true;
    setStatus("loading");
    setError(null);
    setProfile(null);
    setBrilliancies([]);
    setScanState("idle");
    setScanError(null);
    setScope(GAMES_TO_LOAD);
    setGameUrl("");
    setSingleError(null);

    try {
      const prof = await fetchProfile(username);
      const [st, gms] = await Promise.all([
        fetchStats(username).catch(() => ({}) as Stats),
        fetchRecentGames(username, GAMES_TO_LOAD).catch(() => [] as Game[]),
      ]);
      setProfile(prof);
      setStats(st);
      setGames(gms);
      setStatus("loaded");
    } catch (e) {
      setStatus("error");
      setError(
        isNotFound(e)
          ? `No chess.com player called “${username}”. Check the spelling and try again.`
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
      setGames(await fetchRecentGames(profile.username, next));
    } catch {
      setScanError("Couldn't load more games from chess.com. Try again shortly.");
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
      const game = await fetchGameByUrl(profile.username, raw);
      if (!game) {
        setSingleError(`Couldn't find that game in @${profile.username}'s archives.`);
        return;
      }
      await engine.init();
      const found = await scanGame(game, { depth: SCAN_DEPTH });
      setBrilliancies((prev) => [
        ...prev.filter((b) => b.game.id !== game.id),
        ...found,
      ]);
      setGames((prev) => (prev.some((g) => g.id === game.id) ? prev : [game, ...prev]));
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

    for (let i = 0; i < toScan.length; i++) {
      if (cancelScan.current) break;
      try {
        const found = await scanGame(toScan[i], { depth: SCAN_DEPTH }, () => cancelScan.current);
        if (found.length) setBrilliancies((prev) => [...prev, ...found]);
      } catch {
        // skip a game that fails to analyze; keep the scan going
      }
      setProgress({ done: i + 1, total: toScan.length });
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

  return (
    <div className="shell">
      <header className="topbar">
        <div className="wrap topbar-inner">
          <button className="mark" onClick={reset}>
            <span className="mark-glyph">!!</span>
            <span>Brilliancy</span>
            <span className="mark-sub">for chess.com</span>
          </button>
          {profile && (
            <div className="topbar-search">
              <SearchBar
                value={query}
                onChange={setQuery}
                onSubmit={() => loadUser(query)}
                loading={status === "loading"}
                variant="bar"
              />
            </div>
          )}
        </div>
      </header>

      <main>
        {showHero && (
          <section className="hero">
            <div className="wrap hero-grid">
              <div>
                <p className="hero-eyebrow">Sound sacrifices, found by an engine</p>
                <h1>
                  Find your <span className="hero-bangs">!!</span>
                </h1>
                <p className="hero-lede">
                  Drop in any chess.com username. We pull your recent games and run a chess engine
                  over them to surface your <strong>brilliant moves</strong> — the sound sacrifices —
                  next to your ratings and record.
                </p>
                <div className="hero-search-wrap">
                  <SearchBar
                    value={query}
                    onChange={setQuery}
                    onSubmit={() => loadUser(query)}
                    loading={status === "loading"}
                    variant="hero"
                    autoFocus
                  />
                  <div className="hero-hint">
                    <span>Try</span>
                    {EXAMPLES.map((ex) => (
                      <button
                        key={ex}
                        className="hero-chip"
                        onClick={() => {
                          setQuery(ex);
                          loadUser(ex);
                        }}
                      >
                        {ex}
                      </button>
                    ))}
                  </div>
                </div>
                {error && (
                  <div className="error-box" style={{ marginTop: 18 }}>
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
              <ProfileHeader profile={profile} />
            </section>

            <section className="wrap section">
              {/* Printed label above, written value below — the way a field on a
                  form is filled in, not a row of oversized statistics. */}
              <div className="summary-strip">
                <div className="summary-cell">
                  <div className="summary-label">Games loaded</div>
                  <div className="summary-num">{summary.total}</div>
                </div>
                <div className="summary-cell">
                  <div className="summary-label">Won</div>
                  <div className="summary-num">{summary.winRate}%</div>
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
                  <h2>Ratings &amp; record</h2>
                </div>
              </div>
              <StatsDashboard stats={stats} />
            </section>

            <section className="wrap section">
              <div className="section-head">
                <div className="section-title">
                  <span className="section-index">!!</span>
                  <h2>Brilliancies</h2>
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
                        leaves this page. The first run downloads the engine (~40&nbsp;MB), then
                        it's cached.
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
                    <div className="scope-seg">
                      {SCOPES.map((s) => (
                        <button
                          key={s.label}
                          className={`scope-opt ${scope === s.games ? "is-on" : ""}`}
                          onClick={() => changeScope(s.games)}
                          disabled={loadingMore}
                        >
                          {s.label}
                        </button>
                      ))}
                    </div>
                    <span className="scope-note">
                      {loadingMore
                        ? "loading games…"
                        : `Takes ${estimate(scanCount)}. Brilliancies are rare — a single month often has none.`}
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
                        placeholder="paste a chess.com game link"
                        spellCheck={false}
                        aria-label="chess.com game URL"
                      />
                    </label>
                    <button
                      className="btn btn-ghost"
                      onClick={scanOneGame}
                      disabled={!gameUrl.trim() || singleState === "working"}
                    >
                      {singleState === "working" ? <span className="spinner" /> : "Analyse"}
                    </button>
                  </div>
                  {singleError && <p className="single-error">{singleError}</p>}
                </div>
              )}

              {scanState === "running" && (
                <div className="analyze-panel" style={{ flexDirection: "column", alignItems: "stretch" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                    <span className="spinner" />
                    <strong style={{ color: "var(--text-hi)" }}>
                      {engineWarming
                        ? "Warming up the engine…"
                        : `Analyzing game ${progress.done} of ${progress.total}`}
                    </strong>
                    <button className="btn btn-ghost" style={{ marginLeft: "auto" }} onClick={stopScan}>
                      Stop
                    </button>
                  </div>
                  <div className="progress">
                    <div className="progress-track">
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
                <div className="error-box" style={{ marginTop: 14 }}>
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
                ) : scanState === "done" ? (
                  <p className="empty-note">
                    No brilliancies in {scanCount === 1 ? "that game" : `these ${scanCount} games`} —
                    nothing cleared the bar. Brilliant moves are rare, and a short window can easily
                    hold none: try widening the scan before concluding you've never played one.
                  </p>
                ) : null)}
            </section>

            <section className="wrap section">
              <div className="section-head">
                <div className="section-title">
                  <h2>Recent games</h2>
                </div>
                <p className="section-note">Newest first. Click any game to replay it.</p>
              </div>
              <GameList
                games={games}
                brilliancyCounts={brilliancyCounts}
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
          <p className="footer-line">
            Data from the public{" "}
            <a href="https://www.chess.com/news/view/published-data-api" target="_blank" rel="noreferrer">
              chess.com API
            </a>
            . Brilliant moves are found in your browser and are an approximation of
            chess.com's <b>!!</b> — not affiliated with or endorsed by chess.com.
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
