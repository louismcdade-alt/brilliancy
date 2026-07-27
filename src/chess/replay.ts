import { Chess } from "chess.js";
import type { ReplayMove } from "../types";

/**
 * Parse a PGN into a flat list of moves, each carrying the FEN before and after.
 * chess.js attaches `before`/`after` FENs to verbose history entries, which is
 * exactly what both the board replay and the engine analysis need.
 */
export function parseGame(pgn: string): ReplayMove[] {
  const chess = new Chess();
  chess.loadPgn(pgn); // throws on malformed PGN; callers guard with try/catch
  const history = chess.history({ verbose: true });
  return history.map((m, i) => ({
    san: m.san,
    from: m.from,
    to: m.to,
    color: m.color,
    fenBefore: m.before,
    fenAfter: m.after,
    moveNumber: Math.floor(i / 2) + 1,
    captured: m.captured,
  }));
}

/** Starting position FEN, used before any move has been played. */
export const START_FEN =
  "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
