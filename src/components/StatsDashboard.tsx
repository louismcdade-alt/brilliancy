import type { RatingRecord, Stats, TimeClass } from "../types";
import { timeClassLabel } from "../lib/format";

const ORDER: TimeClass[] = ["bullet", "blitz", "rapid", "daily"];

function StatCard({ tc, rec }: { tc: TimeClass; rec: RatingRecord }) {
  const total = rec.win + rec.loss + rec.draw;
  const pct = (n: number) => (total ? (n / total) * 100 : 0);
  const winRate = total ? Math.round((rec.win / total) * 100) : 0;
  return (
    <div className="stat-card">
      <div className="stat-card-top">
        <span className="stat-class">{timeClassLabel(tc)}</span>
        {rec.bestRating ? <span className="stat-best">★ {rec.bestRating}</span> : null}
      </div>
      <div className="stat-rating">{rec.rating ?? "—"}</div>
      <div className="stat-rating-sub">
        {total ? `${winRate}% win rate · ${total.toLocaleString()} games` : "current rating"}
      </div>
      {total > 0 && (
        <>
          <div className="wld" role="img" aria-label={`${rec.win} wins, ${rec.draw} draws, ${rec.loss} losses`}>
            <div className="wld-w" style={{ width: `${pct(rec.win)}%` }} />
            <div className="wld-d" style={{ width: `${pct(rec.draw)}%` }} />
            <div className="wld-l" style={{ width: `${pct(rec.loss)}%` }} />
          </div>
          <div className="wld-legend">
            <span>
              <b>{rec.win}</b> W
            </span>
            <span>
              <b>{rec.draw}</b> D
            </span>
            <span>
              <b>{rec.loss}</b> L
            </span>
          </div>
        </>
      )}
    </div>
  );
}

export function StatsDashboard({ stats }: { stats: Stats }) {
  const cards = ORDER.map((tc) => ({ tc, rec: stats[tc] })).filter(
    (c): c is { tc: TimeClass; rec: RatingRecord } => Boolean(c.rec && c.rec.rating),
  );

  if (cards.length === 0) {
    return <p className="empty-note">chess.com isn't returning rating stats for this player.</p>;
  }

  return (
    <div className="stat-grid">
      {cards.map(({ tc, rec }) => (
        <StatCard key={tc} tc={tc} rec={rec} />
      ))}
    </div>
  );
}
