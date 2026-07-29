/**
 * chess.com brilliancy readings, keyed by game id.
 *
 * Each value is an ARRAY of independent reads, not a single number, because the
 * post-game summary is NON-DETERMINISTIC. Reloading one game minutes apart can
 * report 1 Brilliant on one load and none on the next; 172078598998 gave 0, 0
 * and 1 across three reads. Storing a lone number threw that away and made a
 * coin-flip look like a measurement.
 *
 * WHAT THE NOISE LOOKS LIKE. It appears one-directional — the summary
 * OVER-reports rather than missing things:
 *
 *   - 169869209718 genuinely has 1 (confirmed in Game Review). Repeated reads
 *     never lost it: 1, 1.
 *   - Every disagreement seen so far is a lone 1 against several 0s.
 *   - An earlier session saw a summary report 2 where Game Review found 1.
 *
 * Two other traps, both of which produce wrong readings that look fine:
 *
 *   - The panel RENDERS BEFORE IT FINISHES, briefly showing placeholder tiles
 *     (??, ?, check) while it says "I'm creating your Game". Read then and you
 *     get nonsense. Wait for that text to disappear.
 *   - The tiles are the top three categories PRESENT, not a fixed set, so a
 *     missing Brilliant tile means zero. And Great is a blue "!" while Brilliant
 *     is a teal "!!" — easy to read one as the other.
 *
 * THE RULE THIS FILE ENCODES:
 *
 *   every read 0   ->  usable as an exact zero; each candidate becomes a negative
 *   any read >= 1  ->  UNRESOLVED. Never promote to a positive from here; only a
 *                      full Game Review can do that.
 *
 * That is deliberately lopsided, and it is the wrong way round for what this
 * project needs — zeros give negatives, and negatives are the thing we already
 * have too many of. It is still better than a poisoned positive, which would
 * teach a model to imitate a move chess.com never starred.
 *
 * Reads require being LOGGED IN; logged out, the panel shows no counts at all.
 *
 *   node scripts/harvest-labels.mjs louismcdade 400
 */
export const COUNTS = {
  // Single historical reads, kept but weak — one read cannot distinguish a real
  // zero from a lucky one. Worth re-reading before leaning on any of them.
  "73055868147": [0],
  "68820772835": [0],
  "172022142658": [0],
  "73657360419": [0],
  "69798477321": [0],
  "69076347829": [0],
  "123448874857": [0],
  "123260503855": [0],
  "166905127436": [0],
  "125086814631": [0],
  "169872260446": [0],
  "169264876272": [0],
  "167779992358": [0],
  "123010260621": [0],
  "71533522913": [0],
  "166904355742": [0],
  "73056434083": [0],

  // Disputed — these are the games that exposed the problem.
  "172078598998": [1, 0, 0], // Louis read 1; two later reads showed no Brilliant tile
  "170344245882": [1, 1, 0], // read 1 twice, then 0
  "72012130191": [1],
  "72369273649": [1],
  "73742490905": [1],
};
