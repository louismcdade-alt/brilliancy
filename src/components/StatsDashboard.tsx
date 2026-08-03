import type { Source, RatingRecord, Stats, TimeClass } from "../types";
import { SOURCE_LABEL } from "../types";
import { timeClassLabel } from "../lib/format";

/**
 * One order for both sites. chess.com never fills `classical` or
 * `correspondence`, Lichess never fills `daily`, so the empty ones drop out at
 * the filter below and neither source needs a branch of its own.
 */
const ORDER: TimeClass[] = [
  "bullet",
  "blitz",
  "rapid",
  "classical",
  "daily",
  "correspondence",
];

function StatCard({ tc, rec }: { tc: TimeClass; rec: RatingRecord }) {
  const total = rec.win + rec.loss + rec.draw;
  const pct = (n: number) => (total ? (n / total) * 100 : 0);
  const winRate = total ? Math.round((rec.win / total) * 100) : 0;
  // Three tiers of honesty, best available first: a full record, or just the
  // volume (all Lichess can tell us), or nothing but the number itself.
  const sub = total
    ? `${winRate}% win rate · ${total.toLocaleString()} games`
    : rec.games
      ? `${rec.games.toLocaleString()} game${rec.games === 1 ? "" : "s"}`
      : "current rating";
  return (
    <div className="stat-card">
      <div className="stat-card-top">
        <span className="stat-class">{timeClassLabel(tc)}</span>
        {rec.bestRating ? <span className="stat-best">★ {rec.bestRating}</span> : null}
        {/* A provisional rating is a rating the site itself won't stand behind
            yet; printing it unqualified next to a settled one invites a
            comparison that isn't available. */}
        {!rec.bestRating && rec.provisional ? (
          <span className="stat-prov">provisional</span>
        ) : null}
      </div>
      <div className="stat-rating">{rec.rating ?? "—"}</div>
      <div className="stat-rating-sub">{sub}</div>
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

export function StatsDashboard({ stats, source }: { stats: Stats; source: Source }) {
  const cards = ORDER.map((tc) => ({ tc, rec: stats[tc] })).filter(
    (c): c is { tc: TimeClass; rec: RatingRecord } => Boolean(c.rec && c.rec.rating),
  );

  if (cards.length === 0) {
    return (
      <p className="empty-note">
        {SOURCE_LABEL[source]} isn't returning rating stats for this player.
      </p>
    );
  }

  return (
    <div className="stat-grid">
      {cards.map(({ tc, rec }) => (
        <StatCard key={tc} tc={tc} rec={rec} />
      ))}
    </div>
  );
}
