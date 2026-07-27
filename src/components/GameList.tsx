import type { Game } from "../types";
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
  return (
    <button className="game-row" onClick={() => onOpen(game)}>
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
        {brilliancies > 0 && (
          <span className="game-bril-count" title={`${brilliancies} brilliant move(s)`}>
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

export function GameList({ games, brilliancyCounts, onOpen }: GameListProps) {
  if (games.length === 0) {
    return <p className="empty-note">No standard-chess games found in recent months.</p>;
  }
  return (
    <div className="game-list">
      {games.map((g) => (
        <GameRow key={g.id} game={g} brilliancies={brilliancyCounts[g.id] ?? 0} onOpen={onOpen} />
      ))}
    </div>
  );
}
