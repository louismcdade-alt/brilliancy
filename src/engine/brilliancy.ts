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

// "Necessary" gate: if a *quiet* alternative (one that doesn't itself sacrifice
// material) already keeps an advantage this large, the sacrifice wasn't what won
// the game — you were winning without fireworks. chess.com withholds !! when
// you're already winning, so we do too. Read from a MultiPV search. Crucially,
// alternatives that are themselves sacrifices don't count: in Levitsky–Marshall
// the second-best move to 23...Qg3!! is another winning tactic (23...Nf3+), and
// demoting a brilliancy because a *different tactic* also won misreads the rule.
const ALREADY_WINNING = 250; // cp; best quiet alternative ≥ +2.5 ⇒ not brilliant
const MULTI_PV = 3; // lines to search: played/best + enough to find a quiet alt

// Opening/book guard: ignore theoretical pawn gambits (Queen's Gambit, Smith-Morra,
// Danish, …) in the first few moves. A genuine piece sacrifice still qualifies this
// early — Légal's 5.Nxe5 offers ~a piece — so we only raise the bar, never skip
// outright on move number alone.
const OPENING_MOVE = 8; // full moves considered "still in the opening"
const OPENING_MIN_SAC = 3.0; // pawns; in the opening, must sac at least ~a minor piece

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
  /** Which gate rejected it, or null if it was flagged brilliant. */
  rejectedBy: "sound" | "strong" | "necessary" | null;
}

export interface ScanOptions {
  depth?: number;
  minSacrifice?: number;
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
    // "Already winning" has to mean *you could have won just as easily without
    // the fireworks*, not merely "the eval was high". Comparing the absolute
    // number alone threw away Morphy's 16.Qb8+ — mate in one — because a quiet
    // move reached +2.54, four centipawns over the line. A sacrifice that beats
    // every quiet alternative is, by definition, the move that won the game.
    const necessary = quietAlt < ALREADY_WINNING || quietAlt < playedEval;

    opts.onCandidate?.({
      moveNumber: move.moveNumber,
      san: move.san,
      sacrifice: Math.round(sacrifice * 10) / 10,
      sacSquare: offered.square,
      playedEval: Math.round(playedEval),
      evalLoss: Math.round(evalLoss),
      quietAlt: Math.round(quietAlt),
      rejectedBy: !sound ? "sound" : !strong ? "strong" : !necessary ? "necessary" : null,
    });

    if (sound && strong && necessary) {
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
