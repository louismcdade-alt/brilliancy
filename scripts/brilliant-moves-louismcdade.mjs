/**
 * chess.com's OWN list of every brilliant move LouisMcdade has ever played.
 *
 * Source: Advanced Stats (Diamond membership, added mid-2026) —
 *   https://www.chess.com/brilliant
 *   → /member/louismcdade/stats/all-brilliant-moves?time=0
 * Read 2026-07-29 by walking the rendered page's board links, each of which is
 * `/analysis/game/live/<id>?move=<ply>`.
 *
 * WHY THIS FILE REPLACES A MONTH OF HARVESTING. Every earlier label source told
 * us a count and made us guess the location: Game Review was authoritative but
 * rate-limited to one a day, and the post-game summary was free but noisy. This
 * page gives the game AND the move for every star, all-time, in one fetch. That
 * makes the label set COMPLETE rather than sampled — which is what turns silence
 * into information: any candidate in a rated game that is not listed here is a
 * confirmed negative, without anyone having to read anything.
 *
 * SCOPE — RATED GAMES ONLY. The feature announcement says "rated games", and the
 * data agrees: two brilliancies we had confirmed in full Game Review
 * (169999249810 24.Ne6, 169869209718 16...Qxc3) are absent from this list, and
 * both of those games are unrated. So this list is exhaustive over the 293 rated
 * games in the archive and says NOTHING about the 105 unrated ones. Do not infer
 * negatives in an unrated game from its absence here.
 *
 * PLY CONVENTION. `ply` is chess.com's own `?move=` value: a 0-indexed half-move,
 * so white's move n is ply 2(n-1) and black's is 2(n-1)+1. Two independent checks
 * that this reading is right, both of which would have failed on an off-by-one:
 *   - all 9 plies land on LouisMcdade's own side to move (9/9), and
 *   - the derived game order matches the opponent captions printed under the
 *     boards on the page, in order.
 *
 * COUNTEREXAMPLE THIS LIST PRODUCED, recorded because it retires an assumption we
 * were relying on: 170905472716 was labelled an exact zero from a post-game
 * summary read, and chess.com stars 19.Bb6+ in it. The old rule of thumb — "a
 * summary count of 0 is exact, a nonzero is not" — is therefore only mostly true;
 * summary zeros can under-report too. 19 of the 20 checkable summary zeros agreed
 * with this list, so the error rate is low, but it is not zero, and every summary
 * label for a rated game is now superseded by this file.
 */

/** `san` is informational — the labels are keyed on (id, moveNumber, colour). */
export const brilliantMoves = [
  { id: "170905472716", ply: 36, move: "19.Bb6+",   opponent: "zetekkkk",        date: "2026-06-29" },
  { id: "170150169022", ply: 28, move: "15.Qf7",    opponent: "ahamedaboshadad", date: "2026-06-13" },
  { id: "168334603690", ply: 11, move: "6...Bxf2+", opponent: "inchara05",       date: "2026-05-06" },
  { id: "168271440076", ply: 12, move: "7.Qxc5",    opponent: "lucario_45",      date: "2026-05-05" },
  { id: "167673613410", ply: 23, move: "12...Bd6",  opponent: "Samy1111samy",    date: "2026-04-22" },
  { id: "167117565258", ply: 44, move: "23.Rhd1",   opponent: "Hilltopper00",    date: "2026-04-10" },
  { id: "75046302171",  ply: 27, move: "14...fxe5", opponent: "Wonky6",          date: "2023-04-12" },
  { id: "72369273649",  ply: 44, move: "23.Bc3",    opponent: "alxgy1503",       date: "2023-03-12" },
  { id: "72012130191",  ply: 45, move: "23...Nd4+", opponent: "ybbbb235",        date: "2023-03-08" },
];

/**
 * Brilliancies confirmed in full Game Review, in games the list above cannot
 * cover because they are UNRATED. Kept separate on purpose: they are positives
 * from a different source with different coverage, so they can prove a rule kills
 * a known brilliancy but they cannot make a game's negative set complete.
 */
export const unratedReviewMoves = [
  { id: "169999249810", move: "24.Ne6",    opponent: "kamagar1910",     date: "2026-06-10", source: "review" },
  { id: "169869209718", move: "16...Qxc3", opponent: "ibrahimmbaaayeh", date: "2026-06-08", source: "review" },
];

/** ply → { moveNumber, color }, chess.com's 0-indexed half-move numbering. */
export const plyToMove = (ply) => ({
  moveNumber: Math.floor(ply / 2) + 1,
  color: ply % 2 === 0 ? "w" : "b",
});

/** "19.Bb6+" / "6...Bxf2+" → { moveNumber, san }. */
export const parseMove = (move) => {
  const m = move.match(/^(\d+)\.+(.+)$/);
  if (!m) throw new Error(`unparseable move: ${move}`);
  return { moveNumber: Number(m[1]), san: m[2] };
};
