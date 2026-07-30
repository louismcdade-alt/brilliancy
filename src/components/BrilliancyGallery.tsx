import type { Brilliancy } from "../types";
import { Board } from "./Board";
import { InkCircle } from "./BoardViewer";
import { formatEval, sacrificeLabel, timeAgo, whyLabel } from "../lib/format";

function moveLabel(b: Brilliancy): string {
  // "23." for white, "23…" for black
  return b.game.userColor === "w" ? `${b.moveNumber}.` : `${b.moveNumber}…`;
}

function SpecCard({ b, onOpen }: { b: Brilliancy; onOpen: (b: Brilliancy) => void }) {
  return (
    <button className="spec" onClick={() => onOpen(b)}>
      <div className="spec-board">
        <Board
          fen={b.fenBefore}
          orientation={b.game.userColor === "w" ? "white" : "black"}
          arrow={{ from: b.from, to: b.to }}
          brilliantSquare={b.to}
          sacSquare={b.sacSquare}
          seal="!!"
          lastMove={{ from: b.from, to: b.to }}
          coords={false}
        />
      </div>
      <div className="spec-head">
        <span className="spec-move">
          <span className="circled">
            {b.san}
            <InkCircle />
          </span>
          <span className="bangs">!!</span>
        </span>
        <span className="spec-movenum">{moveLabel(b)}</span>
      </div>
      <div className="spec-stats">
        <span>
          {sacrificeLabel(b.sacPiece, b.sacSquare, b.sacrifice)}
          {whyLabel(b) ? `, ${whyLabel(b)}` : ""}
        </span>
        <span>
          eval <b>{formatEval(b.evalAfter, null)}</b>
        </span>
      </div>
      <div className="spec-foot">
        <span className="spec-vs">vs {b.game.oppUsername}</span>
        <span>{timeAgo(b.game.endTime)}</span>
      </div>
    </button>
  );
}

export function BrilliancyGallery({
  brilliancies,
  onOpen,
}: {
  brilliancies: Brilliancy[];
  onOpen: (b: Brilliancy) => void;
}) {
  return (
    <div className="spec-grid">
      {brilliancies.map((b) => (
        <SpecCard key={`${b.game.id}-${b.ply}`} b={b} onOpen={onOpen} />
      ))}
    </div>
  );
}
