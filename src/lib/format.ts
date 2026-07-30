import type { GameResult, TimeClass } from "../types";

/** ISO-3166 alpha-2 (e.g. "US") → regional-indicator flag emoji. */
export function countryFlag(code?: string): string {
  if (!code || code.length !== 2) return "";
  const cc = code.toUpperCase();
  if (!/^[A-Z]{2}$/.test(cc)) return "";
  return String.fromCodePoint(
    ...[...cc].map((c) => 0x1f1e6 + (c.charCodeAt(0) - 65)),
  );
}

function minutes(seconds: number): string {
  if (seconds % 60 === 0) return `${seconds / 60} min`;
  if (seconds < 60) return `${seconds} sec`;
  return `${(seconds / 60).toFixed(1)} min`;
}

/** chess.com `time_control` → human label ("600" → "10 min", "180+2" → "3 min + 2"). */
export function formatTimeControl(tc: string): string {
  if (!tc) return "";
  if (tc.includes("/")) {
    const perMove = parseInt(tc.split("/")[1], 10);
    const days = Math.round(perMove / 86400);
    return `${days} day${days === 1 ? "" : "s"}/move`;
  }
  if (tc.includes("+")) {
    const [base, inc] = tc.split("+");
    return `${minutes(parseInt(base, 10))} + ${inc}`;
  }
  return minutes(parseInt(tc, 10));
}

export function timeClassLabel(tc: TimeClass): string {
  return tc.charAt(0).toUpperCase() + tc.slice(1);
}

export function timeAgo(unixSeconds: number): string {
  if (!unixSeconds) return "";
  const diff = Date.now() / 1000 - unixSeconds;
  const day = 86400;
  if (diff < 3600) return `${Math.max(1, Math.round(diff / 60))} min ago`;
  if (diff < day) return `${Math.round(diff / 3600)}h ago`;
  if (diff < day * 30) return `${Math.round(diff / day)}d ago`;
  if (diff < day * 365) return `${Math.round(diff / (day * 30))}mo ago`;
  return `${Math.round(diff / (day * 365))}y ago`;
}

export function joinedYear(unixSeconds?: number): string {
  if (!unixSeconds) return "";
  return new Date(unixSeconds * 1000).getFullYear().toString();
}

const RESULT_REASON: Record<string, string> = {
  checkmated: "checkmate",
  resigned: "resignation",
  timeout: "time",
  abandoned: "abandonment",
  win: "",
  agreed: "agreement",
  repetition: "repetition",
  stalemate: "stalemate",
  insufficient: "insufficient material",
  "50move": "50-move rule",
  timevsinsufficient: "timeout vs. insufficient",
};

export function resultReasonLabel(reason: string): string {
  return RESULT_REASON[reason] ?? reason;
}

export function resultClass(result: GameResult): string {
  return result === "win" ? "res-win" : result === "loss" ? "res-loss" : "res-draw";
}

export function resultLetter(result: GameResult): string {
  return result === "win" ? "WIN" : result === "loss" ? "LOSS" : "DRAW";
}

const PIECE_NAME: Record<string, string> = {
  p: "pawn",
  n: "knight",
  b: "bishop",
  r: "rook",
  q: "queen",
};

/**
 * "sacrifices the knight on f5" — naming the piece matters because the offered
 * piece is not always the one that moved, and a bare number next to a king move
 * reads as if the king were the thing being given up.
 */
export function sacrificeLabel(
  sacPiece: string | null,
  sacSquare: string | null,
  sacrifice: number,
): string {
  const name = sacPiece ? PIECE_NAME[sacPiece] : null;
  if (!name || !sacSquare) return `sacrifices ${sacrifice}`;
  return `sacrifices the ${name} on ${sacSquare}`;
}

/**
 * The annotator's one-line verdict — WHY the sacrifice works, not just what it
 * gave up. Phrases are deliberately in the terse voice of a scoresheet margin
 * note, and each one is backed by a measured field rather than adjectives:
 * a forced mate outranks everything, then a king with no squares, then an
 * attack the move itself opened, then material that comes straight back.
 * Null when none of them holds — an honest silence beats a vague flourish.
 */
export function whyLabel(b: {
  mateIn: number | null;
  mateSoonPlies: number | null;
  kingMoves: number;
  kingRingDelta: number;
  regain6: number;
}): string | null {
  if (b.mateIn !== null) return b.mateIn === 1 ? "forcing mate next move" : `forcing mate in ${b.mateIn}`;
  if (b.mateSoonPlies !== null) {
    const m = Math.ceil(b.mateSoonPlies / 2);
    return b.mateSoonPlies <= 1 ? "delivering mate" : m === 1 ? "and mate came next move" : `and mate followed ${m} moves later`;
  }
  if (b.kingMoves === 0 && b.kingRingDelta > 0) return "and the king has nowhere to run";
  if (b.kingRingDelta >= 2) return "tearing open the king's cover";
  if (b.regain6 >= -0.5) return "and the material comes straight back";
  return null;
}

/** Engine cp (player POV) → compact label like "+2.4" / "M3". */
export function formatEval(cp: number, mate: number | null): string {
  if (mate !== null) return `M${Math.abs(mate)}`;
  const pawns = cp / 100;
  return (pawns >= 0 ? "+" : "") + pawns.toFixed(1);
}
