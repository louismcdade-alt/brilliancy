import { Chess } from "chess.js";
import type { Square } from "chess.js";
import type { Brilliancy, Game, ReplayMove } from "../types";
import { parseGame } from "../chess/replay";
import { engine } from "./engine";
import { newMaterialOffered, VALUE } from "./see";

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

  let moves;
  try {
    moves = parseGame(game.pgn);
  } catch {
    return []; // unreadable PGN — skip the game rather than fail the whole scan
  }

  const found: Brilliancy[] = [];

  for (let ply = 0; ply < moves.length; ply++) {
    if (isCancelled()) break;
    const move = moves[ply];
    if (move.color !== game.userColor) continue;

    // (1) static sacrifice pre-filter — no engine cost.
    const offered = sacrificeValue(move, game.userColor);
    const sacrifice = offered.value;
    if (sacrifice < minSac) continue;
    const after = new Chess(move.fenAfter);

    // opening/book guard: in the first few moves, only a real piece sac qualifies
    if (move.moveNumber <= OPENING_MOVE && sacrifice < OPENING_MIN_SAC) continue;

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

    opts.onCandidate?.({
      moveNumber: move.moveNumber,
      san: move.san,
      sacrifice: Math.round(sacrifice * 10) / 10,
      sacSquare: offered.square,
      playedEval: Math.round(playedEval),
      evalLoss: Math.round(evalLoss),
      quietAlt: Math.round(quietAlt),
      shape,
      rejectedBy: !sound ? "sound" : !strong ? "strong" : !necessary ? "necessary" : null,
    });

    if (sound && strong && necessary && !rejectShapes.includes(shape)) {
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
      });
    }
  }

  return found;
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
