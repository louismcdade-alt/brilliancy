import { useMemo } from "react";

type Orientation = "white" | "black";

interface BoardProps {
  fen: string;
  orientation?: Orientation;
  lastMove?: { from: string; to: string } | null;
  brilliantSquare?: string | null;
  /** Square of the piece being offered, marked only when it isn't the move's own. */
  sacSquare?: string | null;
  seal?: string | null;
  arrow?: { from: string; to: string } | null;
  coords?: boolean;
}

// Crisp vector pieces (cburnett set) served from /public/pieces — the same
// "real board" look chess.com uses, far easier to read than Unicode glyphs.
const PIECE_NAME: Record<string, string> = {
  k: "K",
  q: "Q",
  r: "R",
  b: "B",
  n: "N",
  p: "P",
};

function pieceSrc(piece: { type: string; color: "w" | "b" }) {
  return `/pieces/${piece.color}${PIECE_NAME[piece.type]}.svg`;
}

const FILES = ["a", "b", "c", "d", "e", "f", "g", "h"];

interface Cell {
  square: string;
  piece: { type: string; color: "w" | "b" } | null;
  light: boolean;
  fileIdx: number;
  rankIdx: number; // 0 = rank 1
}

function parseFen(fen: string): Map<string, { type: string; color: "w" | "b" }> {
  const map = new Map<string, { type: string; color: "w" | "b" }>();
  const placement = fen.split(" ")[0];
  const ranks = placement.split("/"); // rank 8 first
  ranks.forEach((rankStr, ri) => {
    const rank = 8 - ri;
    let file = 0;
    for (const ch of rankStr) {
      if (/\d/.test(ch)) {
        file += parseInt(ch, 10);
      } else {
        const color = ch === ch.toUpperCase() ? "w" : "b";
        map.set(`${FILES[file]}${rank}`, { type: ch.toLowerCase(), color });
        file += 1;
      }
    }
  });
  return map;
}

/** Center of a square in board-percentage coordinates, respecting orientation. */
function squareCenter(square: string, orientation: Orientation) {
  const fileIdx = FILES.indexOf(square[0]);
  const rankIdx = parseInt(square[1], 10) - 1;
  const col = orientation === "white" ? fileIdx : 7 - fileIdx;
  const row = orientation === "white" ? 7 - rankIdx : rankIdx;
  return { x: (col + 0.5) * 12.5, y: (row + 0.5) * 12.5 };
}

export function Board({
  fen,
  orientation = "white",
  lastMove,
  brilliantSquare,
  sacSquare,
  seal,
  arrow,
  coords = true,
}: BoardProps) {
  const cells = useMemo<Cell[]>(() => {
    const pieces = parseFen(fen);
    const ranks = orientation === "white" ? [8, 7, 6, 5, 4, 3, 2, 1] : [1, 2, 3, 4, 5, 6, 7, 8];
    const files = orientation === "white" ? FILES : [...FILES].reverse();
    const out: Cell[] = [];
    for (const rank of ranks) {
      for (const file of files) {
        const square = `${file}${rank}`;
        const fileIdx = FILES.indexOf(file);
        out.push({
          square,
          piece: pieces.get(square) ?? null,
          light: (fileIdx + rank) % 2 === 1,
          fileIdx,
          rankIdx: rank - 1,
        });
      }
    }
    return out;
  }, [fen, orientation]);

  const arrowGeo = useMemo(() => {
    if (!arrow) return null;
    const a = squareCenter(arrow.from, orientation);
    const b = squareCenter(arrow.to, orientation);
    // shorten the tail and head so the line sits inside the squares
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len;
    const uy = dy / len;
    const start = { x: a.x + ux * 4.5, y: a.y + uy * 4.5 };
    const end = { x: b.x - ux * 4.6, y: b.y - uy * 4.6 };
    return { start, end };
  }, [arrow, orientation]);

  const sealPos = brilliantSquare ? squareCenter(brilliantSquare, orientation) : null;

  return (
    <div className="board-frame">
      <div className="board" role="img" aria-label="Chess position">
        {cells.map((c) => {
          const isFrom = lastMove?.from === c.square;
          const isTo = lastMove?.to === c.square;
          const isBril = brilliantSquare === c.square;
          const isSac = sacSquare === c.square && !isBril;
          const showFile = coords && c.rankIdx === (orientation === "white" ? 0 : 7);
          const showRank = coords && c.fileIdx === (orientation === "white" ? 0 : 7);
          return (
            <div
              key={c.square}
              className={[
                "sq",
                c.light ? "sq-light" : "sq-dark",
                isFrom ? "sq-from" : "",
                isTo ? "sq-to" : "",
                isBril ? "sq-bril" : "",
                isSac ? "sq-sac" : "",
              ]
                .filter(Boolean)
                .join(" ")}
            >
              {c.piece && (
                <img
                  className={`piece piece-${c.piece.color}`}
                  src={pieceSrc(c.piece)}
                  alt=""
                  draggable={false}
                />
              )}
              {showFile && <span className="sq-coord sq-coord-file">{c.square[0]}</span>}
              {showRank && <span className="sq-coord sq-coord-rank">{c.square[1]}</span>}
            </div>
          );
        })}

        {arrowGeo && (
          <svg className="board-arrows" viewBox="0 0 100 100" preserveAspectRatio="none">
            <defs>
              {/* A pen stroke on a diagram, not a UI arrow — thin enough that the
                  pieces underneath still read. */}
              <marker
                id="bril-arrowhead"
                markerWidth="2.6"
                markerHeight="2.6"
                refX="1.3"
                refY="1.3"
                orient="auto"
              >
                <path d="M0,0 L2.6,1.3 L0,2.6 Z" fill="var(--pen)" />
              </marker>
            </defs>
            <line
              x1={arrowGeo.start.x}
              y1={arrowGeo.start.y}
              x2={arrowGeo.end.x}
              y2={arrowGeo.end.y}
              stroke="var(--pen)"
              strokeWidth="1.4"
              strokeLinecap="round"
              opacity="0.85"
              markerEnd="url(#bril-arrowhead)"
            />
          </svg>
        )}

        {seal && sealPos && (
          <div className="board-seal" style={{ left: `${sealPos.x}%`, top: `${sealPos.y}%` }}>
            {seal}
          </div>
        )}
      </div>
    </div>
  );
}
