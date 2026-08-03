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
    /* The card is a summary and the viewer is where the position gets examined,
       so the whole sheet gets one spoken sentence rather than the board's full
       description followed by the SAN, the glyph as punctuation, and the stats
       line. The diagram inside is hidden for the same reason a thumbnail is:
       it is the same information, and repeating it makes the card longer to
       listen to than it is to look at. */
    <button
      className="spec"
      onClick={() => onOpen(b)}
      aria-label={`${moveLabel(b)} ${b.san}, brilliant — ${sacrificeLabel(
        b.sacPiece,
        b.sacSquare,
        b.sacrifice,
      )}${whyLabel(b) ? `, ${whyLabel(b)}` : ""}. Versus ${b.game.oppUsername}. Open this game.`}
    >
      <div className="spec-board" aria-hidden="true">
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
      <div className="spec-head" aria-hidden="true">
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
          eval <b>{formatEval(b.evalAfter, b.mateIn)}</b>
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
