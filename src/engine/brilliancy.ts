import { Chess } from "chess.js";
import type { Square } from "chess.js";
import type { Brilliancy, Game, ReplayMove } from "../types";
import { parseGame } from "../chess/replay";
import { engine } from "./engine";
import { allowedMaterial, materialBalance, newMaterialOffered, VALUE } from "./see";
import { kingPressure } from "./king";
import { brilliancyScore, SCORE_CUT } from "./score";

/**
 * Heuristic for a "brilliant" move, in the spirit of chess.com's !! (we told the
 * user up front this approximates rather than matches their proprietary label):
 *
 *   1. SACRIFICE  — the move NEWLY exposes real material (>= a minor piece's
 *                   worth) to a capture sequence the opponent didn't already
 *                   have. Cheap static check (SEE), so it runs on every move and
 *                   pre-filters candidates.
 *   2. SOUND      — despite the offered material, the engine still likes the
 *                   player's position (not losing after the sacrifice).
 *   3. STRONG     — the move is the engine's best or close to it; you don't get
 *                   credit for a sacrifice that also throws away the game.
 *
 * Only moves that pass the static sacrifice test pay the (expensive) engine cost.
 */
export const MIN_SACRIFICE = 2.0; // pawns of material; ~exchange sac and up
const STILL_GOOD = 20; // cp from player POV: must be at least roughly equal after
const MAX_EVAL_LOSS = 120; // cp the played move may trail the engine's best

// "Necessary" gate: the sacrifice has to be what won the game, not decoration on
// a position that was already winning. Alternatives that are themselves
// sacrifices don't count — in Levitsky–Marshall the second-best move to
// 23...Qg3!! is another winning tactic (23...Nf3+), and demoting a brilliancy
// because a *different tactic* also won misreads the rule. Hence MultiPV, and
// hence "quiet".
//
// This is now a MARGIN, not a threshold, and that change is the single biggest
// accuracy win the project has had: held-out false positives 7 → 2, precision
// 42% → 73%, recall untouched. The evidence, gathered on the fit half and the
// classical games only:
//
//   true positives   +56 +58 +62 +122 +201, plus three forced mates
//   false positives  +3, −66, and one with no quiet alternative at all
//
// The old gate was `quietAlt < 250 || quietAlt < playedEval`, and both clauses
// leaked. 23.Nxb6 cleared the second by *three centipawns* — noise dressed as a
// brilliancy. 12...Nxd5 cleared the first simply by occurring in a level
// position, while being 66cp WORSE than just playing quietly; "necessary" is a
// strange thing to call a sacrifice you'd have done better without.
const NECESSARY_MARGIN = 50; // cp the sacrifice must BEAT the best quiet alternative by

// KNOWN MISS, investigated 2026-07-28 and deliberately left unfixed: 24.Ne6 in
// game 169999249810 is confirmed starred by chess.com and this gate rejects it.
// Recorded here because the obvious fixes have all been tried and they fail.
//
//   Not a depth problem. At depth 20 the margin gets WORSE (-102 -> -120), so
//   the engine really does think a quiet move is a whole pawn better. chess.com
//   starred a move that is objectively not best, which our gate cannot express.
//
//   No threshold can work. Order the labelled moves by either feature and the
//   positive is sandwiched between two negatives:
//
//     margin   12.Nxd5 (-66) >  24.Ne6 (-102) > 19.Rxd6 (-113)
//     loss     12.Nxd5 ( 66) <  24.Ne6 ( 102) < 19.Rxd6 ( 113)
//     label        FP              TP               FP
//
//   Non-monotonic in both. Any cut admitting 24.Ne6 also admits 12...Nxd5, and
//   19.Rxd6 sits 11cp away on the other side — inside engine noise. 24.Ne6 and
//   19.Rxd6 are even in the SAME GAME.
//
//   `accepted` looked like the answer and isn't. It does split that pair
//   (24.Ne6 declined, 19.Rxd6 taken), but letting a declined direct offer bypass
//   this gate also admits 12...Nxd5 and 23.Nxb6, both declined, both direct,
//   both confirmed NOT starred. It separates the case you are staring at and
//   nothing else.
//
// The honest position is that one labelled positive cannot support a new rule.
// The last pattern this project promoted on 3 examples cut Légal's Mate. So the
// miss stays counted against recall rather than hidden behind a `diverges`
// entry, and the fix waits for more labelled brilliancies — specifically ones
// the engine scores BELOW a quiet alternative, which is the class 24.Ne6 is in
// and the class we currently have exactly one of.
const MULTI_PV = 3; // lines to search: played/best + enough to find a quiet alt

// Opening/book guard: ignore theoretical pawn gambits (Queen's Gambit, Smith-Morra,
// Danish, …) in the first few moves. A genuine piece sacrifice still qualifies this
// early — Légal's 5.Nxe5 offers ~a piece — so we only raise the bar, never skip
// outright on move number alone.
const OPENING_MOVE = 8; // full moves considered "still in the opening"
const OPENING_MIN_SAC = 3.0; // pawns; in the opening, must sac at least ~a minor piece

/**
 * What KIND of offer the move makes — orthogonal to whether the offer is any
 * good, which is what the eval gates below decide.
 *
 *   direct      the piece that moved is the piece left hanging. Every one of the
 *               six brilliancies chess.com has confirmed for Louis is this shape.
 *   discovered  the move exposes some OTHER piece.
 *   promotion   the hanging piece is the queen this very move created.
 *
 * Only `promotion` is rejected — see REJECT_SHAPES below for why `discovered`
 * is measured but not acted on.
 */
export type OfferShape = "direct" | "discovered" | "promotion";

/**
 * Which shapes disqualify a move. Read the two entries differently:
 *
 * PROMOTION is rejected. Three in the labelled set (23.c8=Q, 18.gxh8=Q+,
 * 20...a1=Q), none of them starred, and the reasoning stands on its own: a queen
 * that did not exist a move ago is a strange thing to call sacrificed, because
 * you are down nothing you had before the move. Note the honest caveat — all
 * three examples fall in the FIT half, so this rule currently has *no* held-out
 * evidence at all. It is principled and it is free; it is not yet measured.
 *
 * DISCOVERED is NOT rejected, and the story of why is the reason the guard set
 * exists. It looked like the strongest finding in the set: three for three
 * unstarred (39.Kc2, 29.Kd2, 12...g6, two of them king moves), with a tidy
 * rationale — the player didn't offer the piece so much as stop shielding it.
 * Adding it to this list immediately cut Légal's Mate, where 5.Nxe5 vacates f3
 * and unmasks the queen on d1, so the offered square is d1 and the move goes to
 * e5. That is the textbook discovered sacrifice, and the rule killed it.
 *
 * So the shape of the offer is not the discriminator. Something else separates
 * Légal's from three unstarred king shuffles, and until that something is found
 * the field stays measured and unused rather than guessed at.
 */
const REJECT_SHAPES: readonly OfferShape[] = ["promotion"];

/** Every gate a sacrifice was measured against — for calibration tooling. */
export interface Candidate {
  moveNumber: number;
  san: string;
  sacrifice: number;
  sacSquare: string | null;
  playedEval: number;
  evalLoss: number;
  /** Best alternative that isn't itself a sacrifice; -Infinity if there was none. */
  quietAlt: number;
  /**
   * The shape of the offer. Deliberately NOT folded into `rejectedBy`: keeping it
   * a separate axis means one harness pass can score the detector both with and
   * without the shape rule, which is what makes a fit/test split affordable.
   */
  shape: OfferShape;
  /**
   * Does the opponent's BEST reply actually take the offered material?
   *
   * Free to compute — the post-move search already returns a bestmove, so this
   * costs no extra engine time. Measured, not gated, until there is enough
   * labelled data to say whether it means anything: the last time this project
   * promoted a 3-for-3 pattern straight to a rule it cut Légal's Mate.
   *
   * The chess intuition is that a real sacrifice is one the opponent cannot
   * profitably accept, whereas a "sacrifice" the engine simply takes was closer
   * to a bad trade. null when there was no legal reply (mate/stalemate) or no
   * identifiable offered square.
   */
  accepted: boolean | null;
  /**
   * Which test admitted this move to candidacy.
   *
   *   offer  the move newly exposed material — the shipping pre-filter.
   *   allow  it exposed nothing new, but left material of the opponent's on the
   *          table. ONLY produced when `admitAllow` is set, and such a move is
   *          never flagged. It is here to be priced, not to be believed.
   *
   * `shape` is derived from the offered square and is therefore only meaningful
   * when this is "offer".
   */
  admitted: "offer" | "allow";
  /**
   * Material the move declined to rescue, split by when it went on offer — see
   * `allowedMaterial` in see.ts. `fresh` is what the opponent's immediately
   * preceding move attacked; `standing` was already loose before that.
   *
   * Measured, never gated, on the same terms as `shape` and `accepted` — and as
   * of 2026-07-29 measured means REFUTED as an admission rule. Do not retry it
   * without new evidence:
   *
   *   admission     TP  FP  FN     over 294 labelled games, gates unchanged
   *   base           4   1   7     what ships
   *   fresh ≥ 2      4  12   7
   *   fresh ≥ 5      4   4   7
   *   standing ≥ 2   4   7   7
   *   any allow      4  18   7
   *
   * Every relaxation costs false positives and buys NOTHING. The reason is the
   * useful part: admitting allow-sacrifices does surface all three of the stars
   * the pre-filter used to miss, and all three then die at the EVAL gates anyway
   * — `14...fxe5` margin −22, `7.Qxc5` margin −6, `23.Rhd1` evalLoss 184. The
   * pre-filter was never the binding constraint on those moves; `necessary` is.
   * See scripts/score-offline.mjs to re-run the table.
   */
  fresh: number;
  freshSquare: string | null;
  standing: number;
  standingSquare: string | null;
  /**
   * Did the material come BACK, and how fast — pawns of material relative to the
   * position before the move, measured 2, 4 and 6 plies later in the game that
   * was actually played. Negative means still down; near zero means recovered.
   *
   * The motivation is that a "sacrifice" you win straight back is a trade, and
   * trades are not brilliant. Nothing we currently measure distinguishes the two:
   * `sacrifice` says what went on offer, `accepted` says whether it was taken,
   * and neither says whether it came home.
   *
   * Free — it reads the continuation already parsed for the scan, no search. Two
   * honest limits. It reflects what the OPPONENT actually played rather than best
   * play, so a blunder afterwards can flatter a bad sacrifice; and near the end of
   * a game the horizon is clipped to the final position. It is legitimate to use
   * at inference time regardless, because this detector only ever scans completed
   * games — the continuation is always available, so this is not leakage.
   *
   * Measured and ungated, like `shape`, `accepted`, `fresh` and `standing`.
   */
  regain2: number;
  regain4: number;
  regain6: number;
  /** Plies of real continuation behind the regain figures; < 6 means clipped. */
  regainPlies: number;
  /**
   * What the sacrifice was FOR — pressure on the enemy king, counted statically.
   *
   *   kingRing       squares of the enemy king's ring (plus his own square) the
   *                  player attacks after the move.
   *   kingRingDelta  how many of those the move itself added. A delta, for the
   *                  same reason `newMaterialOffered` is one: a position that was
   *                  already an attack must not credit every move played in it.
   *   kingMoves      legal king moves the opponent has left. Low is the point.
   *
   * Every other feature here describes what was given up or what the engine
   * thinks. These are the first that describe what the move was trying to do,
   * which is the half of "brilliant" the detector has never measured. Free, and
   * measured-ungated like the rest.
   */
  kingRing: number;
  kingRingDelta: number;
  kingMoves: number;
  /** Which EVAL gate rejected it, or null if all three passed. */
  rejectedBy: "sound" | "strong" | "necessary" | null;
}

export interface ScanOptions {
  depth?: number;
  minSacrifice?: number;
  /**
   * Offer shapes to disqualify; defaults to REJECT_SHAPES. Pass `[]` to disable
   * the rule entirely. Exists so the calibration harness can MEASURE a shape rule
   * rather than assert it — see scripts/test-harness.mjs and the fit/test split
   * in labels-louismcdade.mjs.
   */
  rejectShapes?: readonly OfferShape[];
  /**
   * Also admit ALLOW-sacrifices as candidates: moves that expose nothing new but
   * leave material of the opponent's on the table. Off by default, and it does
   * not change what gets flagged either way — an allow candidate is reported to
   * `onCandidate` with its engine numbers and then dropped.
   *
   * The point is to buy the measurement before the rule, and the measurement came
   * back negative (see `fresh` on Candidate for the table). Keep the flag: it is
   * what makes the dataset able to price the pre-filter at all, and a dataset
   * containing only moves the pre-filter admits can never do that. It costs a
   * 398-game harvest about 2.3× the searches — 381 candidates become 1138.
   */
  admitAllow?: boolean;
  /**
   * Use the hand-written eval gates instead of the learned scorer. Off by
   * default — the model ships. Calibration tooling sets this to score the old
   * rule against the new one from a single engine pass, which is the only way an
   * A/B stays affordable.
   */
  useGates?: boolean;
  /**
   * Fires for every move that clears the static sacrifice filter, whether or not
   * the engine gates pass. Lets the calibration scripts see *why* a move was
   * dropped — the only way to chase a false negative without guessing.
   */
  onCandidate?: (c: Candidate) => void;
}

/** Analyze one game and return the brilliant moves the searched player made. */
export async function scanGame(
  game: Game,
  opts: ScanOptions = {},
  isCancelled: () => boolean = () => false,
): Promise<Brilliancy[]> {
  const depth = opts.depth ?? 14;
  const minSac = opts.minSacrifice ?? MIN_SACRIFICE;
  const rejectShapes = opts.rejectShapes ?? REJECT_SHAPES;
  const admitAllow = opts.admitAllow ?? false;
  const useGates = opts.useGates ?? false;

  let moves;
  try {
    moves = parseGame(game.pgn);
  } catch {
    return []; // unreadable PGN — skip the game rather than fail the whole scan
  }

  const found: Brilliancy[] = [];

  // Does this game end with the player delivering mate? Checked once; each
  // candidate then measures its distance to that mate. `#` in the final SAN is
  // the whole test — chess.js wrote these moves, so the suffix is reliable.
  const last = moves[moves.length - 1];
  const endsInPlayerMate = !!last && last.color === game.userColor && last.san.includes("#");

  for (let ply = 0; ply < moves.length; ply++) {
    if (isCancelled()) break;
    const move = moves[ply];
    if (move.color !== game.userColor) continue;

    // (1) static sacrifice pre-filter — no engine cost.
    const offered = sacrificeValue(move, game.userColor);
    const sacrifice = offered.value;
    const isOffer = sacrifice >= minSac;

    // What the move leaves on the table, as opposed to what it puts there. Only
    // computed when it can matter — for a move that already qualifies as an offer
    // (so the record carries the columns) or when allow-candidates are wanted —
    // so the app pays nothing new per move.
    //
    // The previous ply is the opponent's, so ITS fenBefore is the position with
    // the opponent to move, which is what `allowedMaterial` needs.
    const allow =
      isOffer || admitAllow
        ? allowedMaterial(
            ply > 0 ? moves[ply - 1].fenBefore : null,
            move.fenBefore,
            move.fenAfter,
            game.userColor,
          )
        : null;
    const allowValue = allow ? Math.max(allow.fresh.value, allow.standing.value) : 0;

    if (!isOffer && !(admitAllow && allowValue >= minSac)) continue;
    const after = new Chess(move.fenAfter);

    // opening/book guard: in the first few moves, only a real piece sac qualifies.
    // For an offer this is exactly the old test; an allow is judged on what it
    // leaves hanging instead.
    const headline = isOffer ? sacrifice : allowValue;
    if (move.moveNumber <= OPENING_MOVE && headline < OPENING_MIN_SAC) continue;

    // (1b) shape of the offer — also static. Note this does NOT `continue`: the
    // engine still runs, so onCandidate can report the eval of a rejected shape.
    // Six moves in 396 games take this path, so the wasted search is noise, and
    // the alternative is a calibration tool that goes blind exactly where the
    // newest rule is doing the work.
    const shape: OfferShape =
      offered.square === null || offered.square === move.to
        ? move.promotion && offered.square === move.to
          ? "promotion"
          : "direct"
        : "discovered";

    // The square the whole judgement hangs on: what was offered, or for an allow
    // the more valuable of the two things left standing.
    const focusSquare = isOffer
      ? offered.square
      : allow && allow.fresh.value >= allow.standing.value
        ? allow.fresh.square
        : (allow?.standing.square ?? null);

    // (2) + (3) engine verification. MultiPV gives the best move plus alternatives,
    // so we can test that the sac was actually necessary.
    const lines = await engine.analyzeMultiPV(move.fenBefore, depth, MULTI_PV); // player to move
    if (isCancelled()) break;
    const post = await engine.analyze(move.fenAfter, depth); // opponent to move

    const bestEval = lines[0]?.cp ?? 0; // best the player could achieve
    const playedEval = -post.cp; // value of the move actually played, player POV
    const evalLoss = bestEval - playedEval;

    // Best QUIET alternative: a different root move that doesn't itself offer
    // material. Another winning *tactic* in the list must not demote this one.
    const playedUci = move.from + move.to;
    let quietAlt = -Infinity;
    for (const line of lines) {
      if (!line.move || line.move.startsWith(playedUci)) continue;
      if (isSacrifice(move.fenBefore, line.move, game.userColor, minSac)) continue;
      if (line.cp > quietAlt) quietAlt = line.cp;
    }

    // sound (still ≥ roughly equal) AND strong (engine's best or close) AND
    // necessary (no quiet alternative was already winning comfortably).
    const sound = playedEval >= STILL_GOOD;
    const strong = evalLoss <= MAX_EVAL_LOSS;
    // The sacrifice must beat the best quiet alternative by a real margin.
    //
    // `!isFinite(quietAlt)` means MultiPV found no quiet alternative at all —
    // every line it returned was itself a sacrifice. That is a gap in what we
    // measured, not evidence that the sacrifice was needed, so it fails. Tested
    // both ways on the held-out half and rejecting won clearly (2 false
    // positives against 4). Worth revisiting if MULTI_PV is ever widened, since
    // a bigger window would turn some of these into real comparisons.
    const necessary = isFinite(quietAlt) && playedEval - quietAlt >= NECESSARY_MARGIN;

    // Relative to BEFORE the move: the material is not gone yet immediately
    // after a sacrifice — it goes when the opponent takes it — so measuring
    // against fenAfter would read every offer as costing nothing.
    const regain = regainAt(moves, ply, game.userColor);
    const kp = kingPressure(move.fenBefore, move.fenAfter, game.userColor);
    // `post` is searched from fenAfter with the OPPONENT to move, so a negative
    // mate score is the opponent being mated — i.e. the player's forced mate.
    const mateIn = post.mate !== null && post.mate < 0 ? -post.mate : null;

    const candidate: Candidate = {
      moveNumber: move.moveNumber,
      san: move.san,
      sacrifice: Math.round(sacrifice * 10) / 10,
      sacSquare: offered.square,
      playedEval: Math.round(playedEval),
      evalLoss: Math.round(evalLoss),
      quietAlt: Math.round(quietAlt),
      shape,
      // UCI bestmove is "<from><to>[promotion]", so the destination is chars 2-4.
      // The opponent accepted iff their best reply lands on the square in
      // question — the offered one, or for an allow the one left hanging.
      accepted:
        focusSquare === null || !post.bestMove || post.bestMove.length < 4
          ? null
          : post.bestMove.slice(2, 4) === focusSquare,
      admitted: isOffer ? "offer" : "allow",
      ...regain,
      ...kp,
      fresh: allow ? Math.round(allow.fresh.value * 10) / 10 : 0,
      freshSquare: allow?.fresh.square ?? null,
      standing: allow ? Math.round(allow.standing.value * 10) / 10 : 0,
      standingSquare: allow?.standing.square ?? null,
      rejectedBy: !sound ? "sound" : !strong ? "strong" : !necessary ? "necessary" : null,
    };
    opts.onCandidate?.(candidate);

    // The verdict. The learned scorer replaced `sound && strong && necessary` on
    // 2026-07-30: measured leave-one-account-out over 27 accounts and 775
    // labelled brilliancies, it beats those gates on BOTH precision (33.3% ->
    // 37.5%) and recall (35.2% -> 56.5%), winning 17 of 22 comparable accounts.
    // The gates are still computed above, so `rejectedBy` keeps meaning what it
    // always meant and the old rule stays A/B-able from one engine pass.
    const score = brilliancyScore(candidate);
    const passes = useGates ? sound && strong && necessary : score >= SCORE_CUT;

    // An allow candidate is never flagged, whatever the score says: the model
    // was trained on offer-candidates only, so an allow row is out of its
    // distribution rather than merely low-scoring.
    if (isOffer && passes && !rejectShapes.includes(shape)) {
      found.push({
        game,
        ply,
        moveNumber: move.moveNumber,
        san: move.san,
        fenBefore: move.fenBefore,
        fenAfter: move.fenAfter,
        from: move.from,
        to: move.to,
        evalAfter: Math.round(playedEval),
        evalLoss: Math.round(evalLoss),
        sacrifice: Math.round(sacrifice * 10) / 10,
        sacSquare: offered.square,
        sacPiece: offered.square ? (after.get(offered.square as Square)?.type ?? null) : null,
        quietMargin: isFinite(quietAlt) ? Math.round(playedEval - quietAlt) : null,
        mateIn,
        mateSoonPlies:
          endsInPlayerMate && moves.length - 1 - ply <= 8 ? moves.length - 1 - ply : null,
        kingMoves: kp.kingMoves,
        kingRingDelta: kp.kingRingDelta,
        regain6: regain.regain6,
        regainPlies: regain.regainPlies,
        score,
      });
    }
  }

  return found;
}

/**
 * Material relative to the position before move `ply`, 2 / 4 / 6 plies later,
 * plus how many plies were ACTUALLY available to look at.
 *
 * `regainPlies` is not bookkeeping, it is the difference between a measurement
 * and an artefact. When a game ends inside the horizon the readings clamp to the
 * final position, and that position flatters the sacrificer: the material has
 * been offered but not yet taken, so a move that hangs a bishop reads as +1 for
 * the pawn it grabbed. The site said "the material comes straight back" about
 * 6...Bxf2+ in a game whose PGN ENDS on that move — nothing came back, play
 * simply stopped, and Kxf2 would have won the piece.
 *
 * This matters beyond the wording. Brilliancies end games far more often than
 * ordinary moves do (mate, resignation), so a clipped horizon is correlated with
 * the label, and any apparent "positives recover their material" signal has to
 * be checked against `regainPlies` before it is believed.
 */
function regainAt(
  moves: ReplayMove[],
  ply: number,
  color: Game["userColor"],
): { regain2: number; regain4: number; regain6: number; regainPlies: number } {
  const base = materialBalance(moves[ply].fenBefore, color);
  const at = (k: number) => {
    const m = moves[Math.min(ply + k, moves.length - 1)];
    return Math.round((materialBalance(m.fenAfter, color) - base) * 10) / 10;
  };
  return { regain2: at(2), regain4: at(4), regain6: at(6), regainPlies: moves.length - 1 - ply };
}

/** Value of a captured piece for netting against a sac — pawns don't count. */
function capturedPieceValue(captured: string | undefined): number {
  return captured && captured !== "p" ? VALUE[captured] : 0;
}

/**
 * How much material a move actually offers, and where it sits. This is the whole
 * sacrifice test, and it is deliberately a *delta*: the offer must be one the move
 * itself creates, because material that was already loose before it was played
 * isn't sacrificed by whoever happens to move next. Without that, any move played
 * beside a hanging piece is credited with sacrificing it — which is how a king
 * once got the blame for a rook it never touched.
 *
 * Capturing a PIECE offsets what the move leaves hanging: BxN met by a recapture
 * is a trade, not a sac (Marshall's 17...Bxc3), and a capture that wins material
 * outright (Morphy's 15.Bxd7+, bishop takes rook) is the opposite of a sacrifice.
 * Captured PAWNS don't offset anything — a piece flung into the fire for a pawn or
 * two is still a sacrifice (Morphy's 10.Nxb5, Légal's Nxe5), and SEE has already
 * netted any pawn the recapture sequence claws back.
 */
export function sacrificeValue(
  move: Pick<ReplayMove, "fenBefore" | "fenAfter" | "captured">,
  color: Game["userColor"],
): { value: number; square: string | null } {
  const offered = newMaterialOffered(move.fenBefore, move.fenAfter, color);
  return {
    value: offered.value - capturedPieceValue(move.captured),
    square: offered.square,
  };
}

/**
 * Would playing `uci` from `fen` itself be a sacrifice (material the move newly
 * puts on offer, net of any piece it captures, ≥ minSac)? Mirrors the main
 * pre-filter; used to classify MultiPV alternatives as quiet vs tactical for the
 * "necessary" gate.
 */
function isSacrifice(
  fen: string,
  uci: string,
  color: Game["userColor"],
  minSac: number,
): boolean {
  try {
    const c = new Chess(fen);
    const m = c.move({
      from: uci.slice(0, 2),
      to: uci.slice(2, 4),
      promotion: uci[4],
    });
    return (
      sacrificeValue(
        { fenBefore: fen, fenAfter: c.fen(), captured: m.captured },
        color,
      ).value >= minSac
    );
  } catch {
    return false; // unplayable line — treat as quiet
  }
}
