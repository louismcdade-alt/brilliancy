import type { Game, Source } from "../types";
import { SOURCE_LABEL } from "../types";
import {
  formatTimeControl,
  resultClass,
  resultLetter,
  resultReasonLabel,
  timeAgo,
  timeClassLabel,
} from "../lib/format";

interface GameListProps {
  games: Game[];
  brilliancyCounts: Record<string, number>;
  /** Only used for the empty-state wording — every row already carries its own. */
  source: Source;
  onOpen: (game: Game) => void;
}

function GameRow({
  game,
  brilliancies,
  onOpen,
}: {
  game: Game;
  brilliancies: number;
  onOpen: (g: Game) => void;
}) {
  const reason = resultReasonLabel(game.resultReason);
  /**
   * Spelled out rather than left to the spans, which ran together into
   * "WINvs Tunartank(3052)WhiteBlitz3 min93.7%2h ago" and never said what the
   * row would DO. Every row is a replay control; the label has to lead with the
   * verb or a listener has no idea what pressing it achieves.
   */
  const label =
    `Replay ${game.result} as ${game.userColor === "w" ? "White" : "Black"} ` +
    `versus ${game.oppUsername}${game.oppRating ? `, rated ${game.oppRating}` : ""}` +
    (brilliancies
      ? `, ${brilliancies} brilliant ${brilliancies === 1 ? "move" : "moves"}`
      : "");

  return (
    <button className="game-row" onClick={() => onOpen(game)} aria-label={label}>
      <span className={`game-result ${resultClass(game.result)}`}>{resultLetter(game.result)}</span>
      <span className="game-main">
        <span className="game-opp">
          vs {game.oppUsername}
          {game.oppRating ? <span className="game-opp-rating">({game.oppRating})</span> : null}
        </span>
        <span className="game-sub">
          <span>{game.userColor === "w" ? "White" : "Black"}</span>
          <span>{timeClassLabel(game.timeClass)}</span>
          <span>{formatTimeControl(game.timeControl)}</span>
          {reason && game.result !== "win" && <span>by {reason}</span>}
        </span>
      </span>
      <span className="game-side">
        {/* The row's aria-label already carries the count, so this is decoration
            to a screen reader. The `title` went with it: it was the only tooltip
            on the page, it duplicated the label, and it was the one place the
            copy said "move(s)". */}
        {brilliancies > 0 && (
          <span className="game-bril-count" aria-hidden="true">
            <span style={{ fontWeight: 700 }}>!!</span>
            {brilliancies}
          </span>
        )}
        {typeof game.userAccuracy === "number" && (
          <span className="badge badge-acc">{game.userAccuracy.toFixed(1)}%</span>
        )}
        <span className="game-meta-mono">{timeAgo(game.endTime)}</span>
      </span>
    </button>
  );
}

export function GameList({ games, brilliancyCounts, source, onOpen }: GameListProps) {
  if (games.length === 0) {
    return (
      <p className="empty-note">
        No recent standard-chess games on {SOURCE_LABEL[source]} for this player.
      </p>
    );
  }
  return (
    <div className="game-list">
      {games.map((g) => (
        <GameRow key={g.id} game={g} brilliancies={brilliancyCounts[g.id] ?? 0} onOpen={onOpen} />
      ))}
    </div>
  );
}
