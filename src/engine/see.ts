import { Chess } from "chess.js";
import type { Square } from "chess.js";
import type { Color } from "../types";

export const VALUE: Record<string, number> = {
  p: 1,
  n: 3,
  b: 3.2,
  r: 5,
  q: 9,
  k: 99, // king: large so it only ever captures as a last resort
};

function other(c: Color): Color {
  return c === "w" ? "b" : "w";
}

/**
 * Static Exchange Evaluation: the net material (in pawns) the `attackerSide`
 * can win by initiating a capture sequence on `square`. Uses the classic
 * swap-off algorithm over chess.js attacker lists. X-ray attacks (batteries)
 * are not modelled — fine for a heuristic pre-filter.
 */
export function see(chess: Chess, square: Square, attackerSide: Color): number {
  const occ = chess.get(square);
  if (!occ) return 0;
  const defenderSide = other(attackerSide);

  const atk = chess
    .attackers(square, attackerSide)
    .map((s) => VALUE[chess.get(s)!.type])
    .sort((a, b) => a - b);
  if (atk.length === 0) return 0;

  const def = chess
    .attackers(square, defenderSide)
    .map((s) => VALUE[chess.get(s)!.type])
    .sort((a, b) => a - b);

  const gain: number[] = [VALUE[occ.type]];
  let prevOcc = atk[0]; // attacker's least piece now stands on the square
  let ai = 1;
  let di = 0;
  let side: Color = defenderSide; // defender recaptures next
  let d = 0;

  while (true) {
    let pick: number | undefined;
    if (side === attackerSide) pick = ai < atk.length ? atk[ai++] : undefined;
    else pick = di < def.length ? def[di++] : undefined;
    if (pick === undefined) break;

    d++;
    gain[d] = prevOcc - gain[d - 1];
    prevOcc = pick;
    side = other(side);
  }

  for (let i = d; i > 0; i--) gain[i - 1] = -Math.max(-gain[i - 1], gain[i]);
  return gain[0];
}

/**
 * Every square where the side to move can win material from `playerColor`, mapped
 * to how much. We only consider *legal* captures, which keeps the king out of it
 * and, crucially, rejects illusory offers: a piece that merely looks attacked but
 * can't actually be taken (checkmate, or the only attacker is pinned).
 */
export function hangingMap(
  chess: Chess,
  playerColor: Color,
): Map<Square, number> {
  const opp = other(playerColor);
  const map = new Map<Square, number>();

  for (const m of chess.moves({ verbose: true })) {
    if (!m.flags.includes("c")) continue; // normal captures only (skip en passant)
    if (map.has(m.to)) continue;
    const target = chess.get(m.to);
    if (!target || target.color !== playerColor || target.type === "k") continue;
    const v = see(chess, m.to, opp);
    if (v > 0) map.set(m.to, v);
  }
  return map;
}

/**
 * After `playerColor` has moved (so the opponent is to move), how much material
 * is on offer — the most the opponent can win on any single square.
 */
export function maxMaterialHanging(
  chess: Chess,
  playerColor: Color,
): { value: number; square: Square | null } {
  let best = 0;
  let bestSq: Square | null = null;
  for (const [sq, v] of hangingMap(chess, playerColor)) {
    if (v > best) {
      best = v;
      bestSq = sq;
    }
  }
  return { value: best, square: bestSq };
}

/**
 * `fen` has the player to move; hand the move back to the opponent so we can ask
 * "what could you already have taken?". The en-passant right belongs to the side
 * that was to move, so it's cleared. If the player is in check this position is
 * technically illegal, but chess.js still generates the opponent's captures from
 * it — and that's exactly the question we're asking.
 */
function withOpponentToMove(fen: string): string {
  const parts = fen.split(" ");
  parts[1] = parts[1] === "w" ? "b" : "w";
  parts[3] = "-";
  return parts.join(" ");
}

/**
 * Material the move *newly* puts on offer — the heart of sacrifice attribution.
 *
 * Asking only "what is hanging after the move?" credits every move played while a
 * piece happens to be loose. In real games that is the dominant false positive:
 * Carlsen's 38...Kg8 was flagged as a 5-pawn sacrifice because a rook on c2 had
 * been en prise since the move before — a king, of all things, "sacrificed" a rook
 * it never touched. A sacrifice is something a move *does*, so we compare the
 * opponent's winnable squares before and after and keep only the new exposure.
 *
 * Per square rather than in aggregate: after 10.Nxb5 in the Opera Game, Morphy's
 * bishop on c4 was already worth 2.2 to Black, and only the knight on b5 (0 → 3)
 * is the offer being made. Comparing totals would hide it.
 */
export function newMaterialOffered(
  fenBefore: string,
  fenAfter: string,
  playerColor: Color,
): { value: number; square: Square | null } {
  const wasOffered = hangingMap(new Chess(withOpponentToMove(fenBefore)), playerColor);
  let best = 0;
  let bestSq: Square | null = null;
  for (const [sq, v] of hangingMap(new Chess(fenAfter), playerColor)) {
    const delta = v - (wasOffered.get(sq) ?? 0);
    if (delta > best) {
      best = delta;
      bestSq = sq;
    }
  }
  return { value: best, square: bestSq };
}

/**
 * Material the move ALLOWS rather than offers — what it declines to rescue.
 *
 * `newMaterialOffered` only sees material a move pushes into danger. It is blind
 * by construction to the other half of chess.com's label: the opponent attacks
 * something, and instead of saving it you play elsewhere. The delta there is
 * zero, so the move never reaches the engine. Four of the nine brilliancies
 * chess.com credits to LouisMcdade are that shape.
 *
 * Split in two, because the two halves have opposite track records and must not
 * be pooled:
 *
 *   fresh     the opponent's IMMEDIATELY PRECEDING move put this on offer, and
 *             the reply leaves it there. `14...fxe5` — White plays e4 attacking
 *             the knight on f5, Black strikes elsewhere and lets it go.
 *   standing  it was already on offer before the opponent's last move, and the
 *             reply still doesn't address it. This is the dangerous one: it is
 *             the class that once credited Carlsen's `38...Kg8` with sacrificing
 *             a rook on c2 it never touched, 12 of 21 flags on real games. It is
 *             measured here because `7.Qxc5` — a confirmed brilliancy with a rook
 *             loose on h1 since before the opponent's move — lands in it, so the
 *             class is not empty of true positives either.
 *
 * Per square, like `newMaterialOffered`: an exposure the opponent created must not
 * cancel against an unrelated one that disappeared.
 *
 * `fenBeforeOpp` is the position before the opponent's preceding move, so the
 * OPPONENT is already to move in it and it must not be flipped — flipping hands
 * the move to the player, who cannot capture their own pieces, and every map
 * comes back empty. Pass null at the first ply of a game.
 */
export function allowedMaterial(
  fenBeforeOpp: string | null,
  fenBefore: string,
  fenAfter: string,
  playerColor: Color,
): {
  fresh: { value: number; square: Square | null };
  standing: { value: number; square: Square | null };
} {
  const beforeOpp = fenBeforeOpp
    ? hangingMap(new Chess(fenBeforeOpp), playerColor)
    : new Map<Square, number>();
  const before = hangingMap(new Chess(withOpponentToMove(fenBefore)), playerColor);
  const after = hangingMap(new Chess(fenAfter), playerColor);

  let fresh = 0;
  let freshSq: Square | null = null;
  let standing = 0;
  let standingSq: Square | null = null;

  for (const [sq, survives] of after) {
    const was = before.get(sq) ?? 0;
    const older = beforeOpp.get(sq) ?? 0;
    // What the opponent's last move added here, and what predates it. Both are
    // capped by what is still on offer after the reply — material the move
    // actually rescued isn't allowed, it's saved.
    const created = Math.min(Math.max(0, was - older), survives);
    const carried = Math.min(Math.min(was, older), survives);
    if (created > fresh) {
      fresh = created;
      freshSq = sq;
    }
    if (carried > standing) {
      standing = carried;
      standingSq = sq;
    }
  }
  return { fresh: { value: fresh, square: freshSq }, standing: { value: standing, square: standingSq } };
}
