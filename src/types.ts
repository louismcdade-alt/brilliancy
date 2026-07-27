export type Color = "w" | "b";

export interface Profile {
  username: string;
  name?: string;
  avatar?: string;
  /** Optional: absent when the API returns a URL we won't render (see safeUrl). */
  url?: string;
  country?: string; // e.g. "US"
  location?: string;
  joined?: number; // unix seconds
  followers?: number;
  status?: string;
  isOnline: boolean;
}

export interface RatingRecord {
  rating?: number;
  bestRating?: number;
  win: number;
  loss: number;
  draw: number;
}

export interface Stats {
  bullet?: RatingRecord;
  blitz?: RatingRecord;
  rapid?: RatingRecord;
  daily?: RatingRecord;
  tacticsHighest?: number;
  fide?: number;
}

export type TimeClass = "bullet" | "blitz" | "rapid" | "daily";
export type GameResult = "win" | "loss" | "draw";

export interface Game {
  id: string;
  url: string;
  pgn: string;
  timeClass: TimeClass;
  timeControl: string;
  rated: boolean;
  endTime: number; // unix seconds
  /** From the searched player's perspective. */
  userColor: Color;
  result: GameResult;
  resultReason: string; // e.g. "checkmated", "resigned", "timeout"
  userRating?: number;
  oppUsername: string;
  oppRating?: number;
  userAccuracy?: number;
  oppAccuracy?: number;
}

/** A move flagged by the brilliancy detector. */
export interface Brilliancy {
  game: Game;
  ply: number; // 0-based index into the move list
  moveNumber: number; // full move number (1-based)
  san: string;
  /** FEN before the brilliant move (side to move = the player). */
  fenBefore: string;
  /** FEN after the brilliant move. */
  fenAfter: string;
  from: string;
  to: string;
  /** Centipawns, from the player's perspective, after the move. */
  evalAfter: number;
  /** How much the move "lost" vs the engine's best, in cp (small = strong). */
  evalLoss: number;
  /** Material (in pawns) the player put on offer with this move. */
  sacrifice: number;
  /** Square holding the sacrificed piece — not always the move's destination. */
  sacSquare: string | null;
  /** Type of the sacrificed piece ("n", "r", …). Never "k": kings can't be sacrificed. */
  sacPiece: string | null;
}

export interface ReplayMove {
  san: string;
  from: string;
  to: string;
  color: Color;
  fenBefore: string;
  fenAfter: string;
  moveNumber: number;
  /** Piece type captured by this move ("p", "n", …), if any. */
  captured?: string;
}
