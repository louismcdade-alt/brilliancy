import { Chess } from "chess.js";
import type { Square } from "chess.js";
import type { Color } from "../types";

/**
 * Pressure on the opponent's king — static, no search.
 *
 * The motivation is that chess.com's Brilliant label is not really about
 * material. A sacrifice is brilliant when it buys something, and what it usually
 * buys is an attack: squares round the enemy king, and a king with nowhere to go.
 * The detector currently measures what was given up and what the engine thinks,
 * and nothing at all about what the move was FOR.
 *
 * Deliberately counted rather than evaluated. Stockfish already gives us an
 * opinion in centipawns; the point of these numbers is to describe the position
 * in terms a rule can be written in, and that a person reading "sacrifices the
 * knight on f5" would recognise.
 */

const FILES = "abcdefgh";

/** The eight squares around `sq`, clipped at the edges of the board. */
function ring(sq: Square): Square[] {
  const f = FILES.indexOf(sq[0]);
  const r = Number(sq[1]);
  const out: Square[] = [];
  for (let df = -1; df <= 1; df++) {
    for (let dr = -1; dr <= 1; dr++) {
      if (!df && !dr) continue;
      const nf = f + df;
      const nr = r + dr;
      if (nf < 0 || nf > 7 || nr < 1 || nr > 8) continue;
      out.push((FILES[nf] + nr) as Square);
    }
  }
  return out;
}

function kingSquare(chess: Chess, color: Color): Square | null {
  for (const row of chess.board()) {
    for (const piece of row) {
      if (piece && piece.type === "k" && piece.color === color) return piece.square as Square;
    }
  }
  return null;
}

/**
 * How many squares of the enemy king's ring (plus the king's own square) the
 * player attacks in `fen`. `isAttacked` does not depend on whose turn it is, so
 * this is well defined before and after the move alike.
 */
function ringAttacked(fen: string, playerColor: Color): number {
  let chess: Chess;
  try {
    chess = new Chess(fen);
  } catch {
    return 0;
  }
  const enemy: Color = playerColor === "w" ? "b" : "w";
  const ks = kingSquare(chess, enemy);
  if (!ks) return 0;
  let n = 0;
  for (const sq of [ks, ...ring(ks)]) {
    if (chess.isAttacked(sq, playerColor)) n++;
  }
  return n;
}

/**
 * Legal king moves the opponent has. `fenAfter` already has them to move, so no
 * side-to-move flip is needed — and a flip would be wrong here, since mobility
 * is only meaningful for the side actually on move.
 */
function enemyKingMobility(fenAfter: string, playerColor: Color): number {
  let chess: Chess;
  try {
    chess = new Chess(fenAfter);
  } catch {
    return 0;
  }
  const enemy: Color = playerColor === "w" ? "b" : "w";
  if (chess.turn() !== enemy) return 0;
  const ks = kingSquare(chess, enemy);
  if (!ks) return 0;
  return chess.moves({ square: ks, verbose: true }).length;
}

export function kingPressure(
  fenBefore: string,
  fenAfter: string,
  playerColor: Color,
): { kingRing: number; kingRingDelta: number; kingMoves: number } {
  const after = ringAttacked(fenAfter, playerColor);
  return {
    kingRing: after,
    // The delta is the part attributable to the move, in the same spirit as
    // newMaterialOffered: a position that was already an attack should not credit
    // every move played in it.
    kingRingDelta: after - ringAttacked(fenBefore, playerColor),
    kingMoves: enemyKingMobility(fenAfter, playerColor),
  };
}
