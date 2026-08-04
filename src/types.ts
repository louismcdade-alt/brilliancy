export type Color = "w" | "b";

/**
 * Which site a profile or game came from.
 *
 * Carried on the data rather than held only in App state because two things
 * downstream genuinely need it: the scan cache (a chess.com uuid and a Lichess
 * 8-char id live in the same Map and must not be able to collide) and the UI
 * copy (a "chess.com game link" field is wrong for a Lichess user). Anything
 * that has a Game can therefore answer "where did this come from" without being
 * handed a second argument.
 */
export type Source = "chesscom" | "lichess";

/** Display name for a source, for use in copy. */
export const SOURCE_LABEL: Record<Source, string> = {
  chesscom: "chess.com",
  lichess: "Lichess",
};

export interface Profile {
  source: Source;
  username: string;
  name?: string;
  /** Federation title ("GM", "IM", "WFM"…). Both APIs report it; neither always. */
  title?: string;
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
  /**
   * Games played at this time class, when the source reports a total but not a
   * win/draw/loss split. Lichess's `perfs` are exactly that shape — a rating and
   * a game count and nothing else — so without this the card would have to claim
   * "0 games" or say nothing about volume at all.
   */
  games?: number;
  /** Lichess `prov`: too few games for the rating to have settled. */
  provisional?: boolean;
}

export interface Stats {
  bullet?: RatingRecord;
  blitz?: RatingRecord;
  rapid?: RatingRecord;
  daily?: RatingRecord;
  /** Lichess only — chess.com has no classical pool. */
  classical?: RatingRecord;
  /** Lichess only — the equivalent of chess.com's "daily", but named honestly. */
  correspondence?: RatingRecord;
  tacticsHighest?: number;
  fide?: number;
}

/**
 * The union is the union of BOTH sites' pools, not a lowest common denominator.
 *
 * Folding Lichess "classical" into "daily" would print a false label on a real
 * rating — they are different pools with different meanings (classical is a
 * long over-the-board-style clock; daily/correspondence is days per move). The
 * cost of widening is one entry each in StatsDashboard's ORDER; the cost of
 * squashing would be paid by every Lichess user reading a wrong number.
 */
export type TimeClass =
  | "bullet"
  | "blitz"
  | "rapid"
  | "daily"
  | "classical"
  | "correspondence";
export type GameResult = "win" | "loss" | "draw";

export interface Game {
  source: Source;
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

/**
 * What a games fetch returned, plus what it had to leave behind.
 *
 * `games` alone is not enough to describe the result honestly. Every adapter
 * stops somewhere, and the two ways it can stop look identical from a length:
 * an account with exactly as many games as we asked for and an account with ten
 * times that both come back full. The UI has to tell a reader "there is more we
 * didn't fetch", and only the adapter is in a position to know — it is the one
 * that saw the archive it declined to open, or the extra export line it asked
 * for and got. So it says so rather than leaving the caller to guess.
 */
export interface GameBatch {
  games: Game[];
  /** The ceiling that actually applied: the caller's limit, or the adapter's own if lower. */
  cap: number;
  /** True when the source had more history than `cap` let us take. */
  truncated: boolean;
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
  /** Forced mate the player has after the move (in full moves), else null. */
  mateIn: number | null;
  /**
   * Plies from this move to the player's checkmate at the END of this game, when
   * that end is near (≤8 plies); else null. Game truth rather than engine truth:
   * Légal's Nxe5 forces nothing — the mate only exists if the queen is taken —
   * but the queen WAS taken and the mate DID land, and that is worth saying.
   */
  mateSoonPlies: number | null;
  /** Legal king moves the opponent has left after the move. */
  kingMoves: number;
  /** Squares round the enemy king this move newly attacks. */
  kingRingDelta: number;
  /** Material vs before the move, six plies later in the actual game. */
  regain6: number;
  /** Plies of real continuation behind regain6; < 6 means the game ended first. */
  regainPlies: number;
  /**
   * The learned scorer's confidence, 0–1. Used to ORDER results, not shown: a
   * bare "0.83" means nothing to a reader and inviting them to compare two
   * decimals would imply a precision this model does not have. What it can
   * honestly do is put the likeliest brilliancies first.
   */
  score: number;
  /**
   * Centipawns by which this move beat the best QUIET alternative — the
   * `necessary` gate's measurement, and the most explanatory number we have.
   * "Nothing quieter came close" is the difference between a brilliancy and a
   * strong move that happened to give up material. null when MultiPV found no
   * quiet alternative at all.
   */
  quietMargin: number | null;
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
  /** Piece promoted TO ("q", "n", …), if this move was a promotion. */
  promotion?: string;
}
