import type { NearMiss } from "../engine/brilliancy";
import { nearMissLine, sacrificeLabel } from "../lib/format";

interface NearMissListProps {
  nearMisses: NearMiss[];
  /** Are there flagged brilliancies above this list? Changes what it has to say. */
  hasBrilliancies: boolean;
  onOpen: (n: NearMiss) => void;
}

/**
 * How many to show.
 *
 * A 250-game scan produces hundreds of these and printing them all turns a
 * scoresheet into a dashboard. Six is about what fits under the gallery without
 * competing with it, and the ranking is by the model's own confidence, so the
 * six shown are the six it came closest to flagging.
 */
const SHOW = 6;

/**
 * The pencil tier: sacrifices the engine weighed and declined.
 *
 * This exists because the scan already pays for every one of these — a MultiPV
 * search, a post-move search and a shallow search each — and used to throw all of
 * it away. Brilliant moves are rare, so for most players a scan of thirty games
 * ended in an apologetic paragraph, having done every bit of the work needed to
 * say something considerably more interesting.
 *
 * Two voices on the sheet, and this is the third: the form is printed, the moves
 * are written in ballpoint, the `!!` is the annotator's red pen. A move the
 * annotator considered and did not circle belongs in pencil — present, legible,
 * and visibly not the same claim.
 */
export function NearMissList({ nearMisses, hasBrilliancies, onOpen }: NearMissListProps) {
  if (nearMisses.length === 0) return null;

  const shown = [...nearMisses].sort((a, b) => b.score - a.score).slice(0, SHOW);

  return (
    <div className="pencil">
      <div className="pencil-head">
        <h3 id="h-pencil">Weighed and not circled</h3>
        <p>
          {hasBrilliancies
            ? "Sacrifices the engine looked at and didn't call brilliant, closest first."
            : "No brilliancies this time — but these are the sacrifices the engine stopped to look at, closest first."}
        </p>
      </div>

      <ul className="pencil-list" aria-labelledby="h-pencil">
        {shown.map((n) => {
          const c = n.candidate;
          const move = `${c.moveNumber}${n.game.userColor === "w" ? "." : "…"} ${c.san}`;
          return (
            <li key={`${n.game.source}:${n.game.id}:${c.ply}`}>
              <button
                className="pencil-row"
                onClick={() => onOpen(n)}
                aria-label={`${move} versus ${n.game.oppUsername}. ${sacrificeLabel(
                  c.sacPiece,
                  c.sacSquare,
                  c.sacrifice,
                )}. ${nearMissLine(c)}. Open this game.`}
              >
                <span className="pencil-move" aria-hidden="true">
                  {move}
                </span>
                <span className="pencil-why" aria-hidden="true">
                  {sacrificeLabel(c.sacPiece, c.sacSquare, c.sacrifice)} · {nearMissLine(c)}
                </span>
                <span className="pencil-vs" aria-hidden="true">
                  vs {n.game.oppUsername}
                </span>
              </button>
            </li>
          );
        })}
      </ul>

      {nearMisses.length > shown.length && (
        <p className="pencil-more">
          and {nearMisses.length - shown.length} more the engine weighed
        </p>
      )}
    </div>
  );
}
