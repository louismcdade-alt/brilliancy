/**
 * chess.com brilliancy COUNTS, keyed by game id — the cheap half of labelling.
 *
 * The full Game Review is one a day on a free account and tells you WHICH move
 * was starred. The post-game summary is unlimited and tells you only HOW MANY.
 * This file is for the second kind, because counts are nearly free and, combined
 * with the candidate list, they pin down more than they look like they should:
 *
 *   count 0                        every candidate in that game is a confirmed
 *                                  NEGATIVE. One check, n labels.
 *   count 1, exactly 1 candidate   that candidate is a confirmed POSITIVE, with
 *                                  no Game Review spent.
 *   count 1, several candidates    ambiguous. Needs a Game Review.
 *   count >= 1, ZERO candidates    the sacrifice pre-filter missed it entirely.
 *                                  Rare and worth chasing — that is a whole class
 *                                  of blindness no threshold change can fix.
 *
 * The summary is known to OVER-count relative to Game Review (it reported 2 on a
 * game whose review showed 1), so a nonzero count is an upper bound. A 0 is exact.
 *
 * Games already carried in labels-louismcdade.mjs do NOT need repeating here —
 * the harvester merges both and prefers the richer record.
 *
 *   node scripts/harvest-labels.mjs louismcdade 250
 */
export const COUNTS = {
  // Collected 2026-07-29 from the post-game summaries, in checklist order.
  "72012130191": 1,
  "170344245882": 0, // ⚠ conflicts with labels-louismcdade.mjs, which records 1
  "172078598998": 1,
  "73055868147": 0,
  "68820772835": 0,
  "172022142658": 0,
  "73657360419": 0,
  "72369273649": 1,
  "69798477321": 0,
};
