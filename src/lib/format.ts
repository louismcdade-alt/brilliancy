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
/**
 * Above any real evaluation, below MATE_CP (100000). engine.ts encodes a forced
 * mate as MATE_CP minus 10 per ply, and those scores reach several UI paths that
 * would otherwise render them as a ~1000-pawn advantage.
 */
export const MATE_SCALE = 90_000;

export function whyLabel(b: {
  mateIn: number | null;
  mateSoonPlies: number | null;
  kingMoves: number;
  kingRingDelta: number;
  regain6: number;
  regainPlies: number;
}): string | null {
  if (b.mateIn !== null) return b.mateIn === 1 ? "forcing mate next move" : `forcing mate in ${b.mateIn}`;
  if (b.mateSoonPlies !== null) {
    const m = Math.ceil(b.mateSoonPlies / 2);
    return b.mateSoonPlies <= 1 ? "delivering mate" : m === 1 ? "and mate came next move" : `and mate followed ${m} moves later`;
  }
  if (b.kingMoves === 0 && b.kingRingDelta > 0) return "and the king has nowhere to run";
  if (b.kingRingDelta >= 2) return "tearing open the king's cover";
  // Only claim recovery when there was enough game left to observe it. A game
  // that ends on the sacrifice leaves the material offered but untaken, which
  // reads as recovered and is the opposite of true.
  //
  // The guard must match the horizon of the value it gates. This read `>= 4`
  // while testing `regain6`, and regainAt CLAMPS to the final position — so at
  // 4 or 5 plies the clamp was still active and regain6 was still a
  // final-position reading. That is the original bug surviving in a narrower
  // window: a game ending 4 plies after an UNTAKEN sacrifice still read as
  // recovered. Six plies of `regain6` needs six plies of game.
  if (b.regainPlies >= 6 && b.regain6 >= -0.5) return "and the material comes straight back";
  return null;
}

/**
 * The full case for a move, as separate lines — the detector's own argument in
 * plain English, in the order it actually reasons.
 *
 * A single clause ("sacrifices the queen on b8") points AT the move; it never
 * says why that is brilliant rather than merely losing material. Each line here
 * is one gate the move had to clear, phrased from the number that cleared it, so
 * a reader can disagree with a specific claim instead of trusting a verdict:
 *
 *   1. what was given up          the sacrifice itself
 *   2. what it bought             mate, a trapped king, an opened attack
 *   3. why nothing quieter did    the margin over the best quiet alternative
 *   4. that it was still best     eval loss against the engine's top move
 *
 * Line 3 is the one that distinguishes a brilliancy from a strong move that
 * happened to cost material, and it is the gate this project spent the most
 * evidence on.
 */
export function reasonLines(b: {
  sacPiece: string | null;
  sacSquare: string | null;
  sacrifice: number;
  mateIn: number | null;
  mateSoonPlies: number | null;
  kingMoves: number;
  kingRingDelta: number;
  regain6: number;
  regainPlies: number;
  quietMargin: number | null;
  evalLoss: number;
}): string[] {
  const lines: string[] = [];
  const name = b.sacPiece ? PIECE_NAME[b.sacPiece] : null;
  lines.push(
    name && b.sacSquare
      ? `Gives up the ${name} on ${b.sacSquare} — ${b.sacrifice} pawns of material`
      : `Gives up ${b.sacrifice} pawns of material`,
  );

  const bought = whyLabel(b);
  if (bought) lines.push(bought.replace(/^and /, "").replace(/^./, (c) => c.toUpperCase()));

  // Mate scores are encoded near ±100000, so a margin against one is not a
  // number of pawns and must never be printed as one — "no quiet move came
  // within 995.16 of it" is gibberish dressed as precision. Above ten pawns the
  // gap has stopped being a quantity a reader can picture anyway, so say the
  // qualitative thing instead.
  if (b.quietMargin !== null && b.quietMargin > 0) {
    lines.push(
      b.quietMargin >= 1000
        ? "No quiet move came anywhere close"
        : `No quiet move came within ${(b.quietMargin / 100).toFixed(2)} of it`,
    );
  }

  // Eval loss needs no mate guard: the tests below are upper bounds, so a
  // mate-scale value simply matches neither and adds no line.
  if (b.evalLoss <= 0) lines.push("The engine's own first choice");
  else if (b.evalLoss <= 40) lines.push(`Within ${(b.evalLoss / 100).toFixed(2)} of the engine's best`);

  return lines;
}

/**
 * Why a sacrifice was weighed and declined — one clause, in pencil.
 *
 * Derived from the RAW NUMBERS, never from `rejectedBy`. That field names the
 * hand-written gates, and the gates stopped being the shipping verdict at
 * commit e646382 when a learned scorer replaced them — so printing "rejected by:
 * necessary" would state something untrue about how the decision was actually
 * reached. The numbers below are the same ones the model reads, so a reader who
 * disagrees is disagreeing with the real evidence.
 *
 * Ordered by how much a reader can do with it. The quiet alternative comes
 * first, because naming the move that got the same result for free is the only
 * line here that teaches anything.
 */
export function nearMissLine(c: {
  quietMove: string | null;
  quietAlt: number;
  playedEval: number;
  evalLoss: number;
}): string {
  const margin = isFinite(c.quietAlt) ? c.playedEval - c.quietAlt : null;

  // The interesting case, and the common one: something quieter did as well or
  // better. Mate-scale margins are near ±100000 and are not a number of pawns,
  // so they never get printed as one.
  if (c.quietMove && margin !== null && margin < 0) {
    return Math.abs(margin) >= 1000
      ? `${c.quietMove} was far better without giving anything up`
      : `${c.quietMove} was ${(Math.abs(margin) / 100).toFixed(2)} better, and gives up nothing`;
  }
  if (c.quietMove && margin !== null && margin < 50) {
    return `${c.quietMove} did about as well without giving anything up`;
  }
  // No quiet alternative existed to compare against — a gap in what was
  // measured, and said as such rather than dressed up as a verdict.
  if (margin === null) return "Nothing quiet to compare it against";
  // "Lost" has to mean lost. playedEval is centipawns AFTER the move, so a bare
  // `< 0` fires on -1 — a dead level position — and the engine's own word for
  // roughly equal reaches to -20. Use a real losing margin (2 pawns), and say
  // "was losing" rather than "was already lost": "already" attributes the state
  // to the position BEFORE the move, while the number measures the position
  // after, so the sacrifice itself may be what put it there.
  if (c.playedEval <= -200) return "The position was losing either way";
  // Unlike reasonLines' eval tests, this one is a LOWER bound, so a mate-scale
  // value DOES match it — when the engine's best line is a forced mate and this
  // sacrifice isn't, evalLoss is ~100000 and this printed "Cost 999.70".
  if (c.evalLoss >= MATE_SCALE) return "The engine had a forced mate instead";
  if (c.evalLoss > 40) return `Cost ${(c.evalLoss / 100).toFixed(2)} against the engine's best`;
  return "Close, but not clear enough";
}

/**
 * Engine cp (player POV) → compact label like "+2.4" / "M3".
 *
 * The `mate` argument is authoritative when supplied. When it isn't, the score
 * is still checked for mate scale: engine.ts encodes a forced mate as
 * MATE_CP (100000) minus 10 per ply, so a caller passing `null` for a mating
 * line would otherwise print "+999.7" — a thousand-pawn advantage — next to a
 * footer reading "forcing mate in 3". Every call site did exactly that.
 *
 * Deriving the ply count here would duplicate engine.ts's encoding in a third
 * place, so the fallback deliberately prints a bare "M" rather than guessing a
 * number: it is honest about being mate without inventing a distance. Callers
 * that know the distance pass it and get "M3".
 */
export function formatEval(cp: number, mate: number | null): string {
  if (mate !== null) return `M${Math.abs(mate)}`;
  if (Math.abs(cp) >= MATE_SCALE) return cp > 0 ? "M" : "-M";
  const pawns = cp / 100;
  return (pawns >= 0 ? "+" : "") + pawns.toFixed(1);
}
