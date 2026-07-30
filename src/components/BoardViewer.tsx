import { useCallback, useEffect, useMemo, useState } from "react";
import type { Brilliancy, Game } from "../types";
import { parseGame, START_FEN } from "../chess/replay";
import { shareBrilliancy } from "../lib/shareImage";
import { Board } from "./Board";
import {
  formatEval,
  formatTimeControl,
  resultClass,
  resultLetter,
  resultReasonLabel,
  sacrificeLabel,
  whyLabel,
  timeClassLabel,
} from "../lib/format";

interface BoardViewerProps {
  game: Game;
  brilliancies: Brilliancy[];
  initialPly?: number; // 0-based ply index to open on
  username?: string; // searched player, for the share card
  onClose: () => void;
}

export function BoardViewer({ game, brilliancies, initialPly, username, onClose }: BoardViewerProps) {
  const [shareState, setShareState] = useState<"idle" | "working" | "done">("idle");
  const moves = useMemo(() => {
    try {
      return parseGame(game.pgn);
    } catch {
      return [];
    }
  }, [game.pgn]);

  const brilByPly = useMemo(() => {
    const m = new Map<number, Brilliancy>();
    for (const b of brilliancies) m.set(b.ply, b);
    return m;
  }, [brilliancies]);

  // pos = number of plies played (0 = start, N = final position)
  const [pos, setPos] = useState(initialPly !== undefined ? initialPly + 1 : moves.length);

  const idx = pos - 1; // current move index, -1 at start
  const current = idx >= 0 ? moves[idx] : null;
  const fen = current ? current.fenAfter : START_FEN;
  const brilNow = idx >= 0 ? brilByPly.get(idx) : undefined;
  const orientation = game.userColor === "w" ? "white" : "black";

  const go = useCallback(
    (next: number) => setPos(Math.max(0, Math.min(moves.length, next))),
    [moves.length],
  );

  const onShare = useCallback(
    async (b: Brilliancy) => {
      setShareState("working");
      try {
        const how = await shareBrilliancy(b, username ?? "");
        setShareState("done");
        setTimeout(() => setShareState("idle"), how === "downloaded" ? 2200 : 800);
      } catch {
        setShareState("idle");
      }
    },
    [username],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft") go(pos - 1);
      else if (e.key === "ArrowRight") go(pos + 1);
      else if (e.key === "Home") go(0);
      else if (e.key === "End") go(moves.length);
      else if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pos, go, moves.length, onClose]);

  return (
    <div className="overlay" onClick={onClose}>
      <div className="viewer" onClick={(e) => e.stopPropagation()}>
        <div className="viewer-board">
          <Board
            fen={fen}
            orientation={orientation}
            lastMove={current ? { from: current.from, to: current.to } : null}
            brilliantSquare={brilNow ? brilNow.to : null}
            sacSquare={brilNow ? brilNow.sacSquare : null}
            seal={brilNow ? "!!" : null}
            arrow={brilNow ? { from: brilNow.from, to: brilNow.to } : null}
          />
          <div className="eval-readout">
            {brilNow ? (
              <>
                <span>
                  Brilliant — <b>{brilNow.san}!!</b> ·{" "}
                  {sacrificeLabel(brilNow.sacPiece, brilNow.sacSquare, brilNow.sacrifice)}
                  {whyLabel(brilNow) ? `, ${whyLabel(brilNow)}` : ""} · eval{" "}
                  {formatEval(brilNow.evalAfter, null)}
                </span>
                <button
                  className="btn btn-bril btn-share"
                  onClick={() => onShare(brilNow)}
                  disabled={shareState === "working"}
                >
                  {shareState === "working"
                    ? "Rendering…"
                    : shareState === "done"
                      ? "Saved ✓"
                      : "Share image"}
                </button>
              </>
            ) : current ? (
              <span>
                {Math.floor(idx / 2) + 1}
                {current.color === "w" ? "." : "…"} <b>{current.san}</b>
              </span>
            ) : (
              <span>Starting position</span>
            )}
          </div>
          <div className="viewer-controls">
            <button className="ctrl-btn" onClick={() => go(0)} disabled={pos === 0} aria-label="First move">
              ⏮
            </button>
            <button className="ctrl-btn" onClick={() => go(pos - 1)} disabled={pos === 0} aria-label="Previous move">
              ◀
            </button>
            <button
              className="ctrl-btn"
              onClick={() => go(pos + 1)}
              disabled={pos === moves.length}
              aria-label="Next move"
            >
              ▶
            </button>
            <button
              className="ctrl-btn"
              onClick={() => go(moves.length)}
              disabled={pos === moves.length}
              aria-label="Last move"
            >
              ⏭
            </button>
          </div>
        </div>

        <div className="viewer-side">
          <div className="viewer-side-head">
            <div>
              <div className="game-opp" style={{ marginBottom: 6 }}>
                <span className={`game-result ${resultClass(game.result)}`} style={{ width: 44, height: 28, fontSize: 11 }}>
                  {resultLetter(game.result)}
                </span>
                vs {game.oppUsername}
                {game.oppRating ? <span className="game-opp-rating">({game.oppRating})</span> : null}
              </div>
              <div className="game-sub">
                <span>{timeClassLabel(game.timeClass)}</span>
                <span>{formatTimeControl(game.timeControl)}</span>
                {game.result !== "win" && <span>by {resultReasonLabel(game.resultReason)}</span>}
                {game.url && (
                  <a href={game.url} target="_blank" rel="noreferrer" style={{ color: "var(--bril)" }}>
                    open ↗
                  </a>
                )}
              </div>
            </div>
            <button className="viewer-close" onClick={onClose} aria-label="Close">
              ✕
            </button>
          </div>

          <div className="movelist">
            {Array.from({ length: Math.ceil(moves.length / 2) }).map((_, row) => {
              const wi = row * 2;
              const bi = row * 2 + 1;
              return (
                <MoveRow
                  key={row}
                  no={row + 1}
                  whiteIdx={wi}
                  blackIdx={bi < moves.length ? bi : null}
                  whiteSan={moves[wi]?.san ?? ""}
                  blackSan={moves[bi]?.san ?? ""}
                  currentIdx={idx}
                  brilByPly={brilByPly}
                  onPick={(i) => go(i + 1)}
                />
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * The red pen coming back round past where it started — the overshoot is what
 * separates a drawn circle from a rounded rectangle. One path, reused wherever
 * a move gets marked.
 */
export function InkCircle() {
  return (
    <svg className="circle-ink" viewBox="0 0 126 44" preserveAspectRatio="none" aria-hidden="true">
      <path d="M14 23 C14 10, 43 4, 67 5 C95 6, 118 11, 118 24 C118 36, 89 42, 61 41 C33 40, 14 35, 13 23 C12 15, 21 9, 33 6" />
    </svg>
  );
}

function MoveCell({
  index,
  san,
  current,
  bril,
  onPick,
}: {
  index: number;
  san: string;
  current: boolean;
  bril: boolean;
  onPick: (i: number) => void;
}) {
  if (!san) return <span />;
  return (
    <button
      className={["move-cell", current ? "is-current" : "", bril ? "is-bril" : ""].filter(Boolean).join(" ")}
      onClick={() => onPick(index)}
      aria-label={bril ? `${san} — brilliant` : san}
    >
      {bril ? (
        <span className="circled">
          {san}
          <InkCircle />
        </span>
      ) : (
        san
      )}
      {bril && <span className="mini-bang">!!</span>}
    </button>
  );
}

function MoveRow({
  no,
  whiteIdx,
  blackIdx,
  whiteSan,
  blackSan,
  currentIdx,
  brilByPly,
  onPick,
}: {
  no: number;
  whiteIdx: number;
  blackIdx: number | null;
  whiteSan: string;
  blackSan: string;
  currentIdx: number;
  brilByPly: Map<number, Brilliancy>;
  onPick: (i: number) => void;
}) {
  return (
    <>
      <span className="move-no">{no}.</span>
      <MoveCell
        index={whiteIdx}
        san={whiteSan}
        current={currentIdx === whiteIdx}
        bril={brilByPly.has(whiteIdx)}
        onPick={onPick}
      />
      {blackIdx !== null ? (
        <MoveCell
          index={blackIdx}
          san={blackSan}
          current={currentIdx === blackIdx}
          bril={brilByPly.has(blackIdx)}
          onPick={onPick}
        />
      ) : (
        <span />
      )}
    </>
  );
}
