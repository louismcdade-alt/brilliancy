/**
 * Labeled test set for the brilliancy detector — the ground truth `test-harness.mjs`
 * scores against. This is the file you grow over time: every game you add with a
 * correct `expected` list makes threshold tuning measurable instead of eyeballed.
 *
 * Each fixture:
 *   name       — human label for the output.
 *   pgn        — the game.
 *   userColor  — "w" | "b", whose moves we judge (the detector only scores this side).
 *   expected   — the moves that SHOULD be flagged brilliant, as { moveNumber, san }.
 *   diverges   — optional. Moves annotation tradition calls !! that we knowingly do
 *                NOT flag, each with a `why`. These are judgement calls, not bugs:
 *                counting them as misses would make the harness permanently red and
 *                the reason would rot in a git log, so they're reported separately
 *                and excluded from the score. Revisit whenever a threshold changes.
 *                Treat this as the COMPLETE set of true brilliancies for that side:
 *                anything else the detector flags counts as a false positive, and
 *                any listed move it misses counts as a false negative. So only add a
 *                game once you're confident you've labeled *all* its brilliancies for
 *                that side — a half-labeled game silently punishes precision.
 *
 * Seeded conservatively with games whose brilliancy set is unambiguous:
 *   - one clean positive (a queen-offer mating combination),
 *   - one clean negative (a quick mate with no sacrifice, which also checks that a
 *     mating *capture* isn't mistaken for a sac).
 * Broaden from here with real chess.com games whose `!!` you can verify in Game Review.
 */
export const fixtures = [
  {
    name: "Légal's Mate — 5.Nxe5!! (queen offer)",
    pgn: "1. e4 e5 2. Bc4 d6 3. Nf3 Bg4 4. Nc3 g6 5. Nxe5 Bxd1 6. Bxf7+ Ke7 7. Nd5#",
    userColor: "w",
    expected: [{ moveNumber: 5, san: "Nxe5" }],
  },
  {
    name: "Opera Game (Morphy) — 16.Qb8+!! queen sac",
    pgn:
      "1. e4 e5 2. Nf3 d6 3. d4 Bg4 4. dxe5 Bxf3 5. Qxf3 dxe5 6. Bc4 Nf6 " +
      "7. Qb3 Qe7 8. Nc3 c6 9. Bg5 b5 10. Nxb5 cxb5 11. Bxb5+ Nbd7 12. O-O-O Rd8 " +
      "13. Rxd7 Rxd7 14. Rd1 Qe6 15. Bxd7+ Nxd7 16. Qb8+ Nxb8 17. Rd8#",
    userColor: "w",
    // Three genuine sound sacrifices in the combination, each one *necessary*
    // (white is materially down, so no quiet alternative wins): the knight on b5,
    // the exchange on d7, and the mating queen offer. Note 15.Bxd7+ is deliberately
    // NOT here — bishop takes ROOK, so net of the capture it wins material rather
    // than offering any; the sacrifice pre-filter must reject it outright.
    expected: [
      { moveNumber: 10, san: "Nxb5" },
      { moveNumber: 13, san: "Rxd7" },
      { moveNumber: 16, san: "Qb8+" },
    ],
  },
  {
    name: "Réti–Tartakower 1910 — 9.Qd8+!! queen sac",
    pgn:
      "1. e4 c6 2. d4 d5 3. Nc3 dxe4 4. Nxe4 Nf6 5. Qd3 e5 6. dxe5 Qa5+ " +
      "7. Bd2 Qxe5 8. O-O-O Nxe4 9. Qd8+ Kxd8 10. Bg5+ Kc7 11. Bd8#",
    userColor: "w",
    // ONE brilliancy: 9.Qd8+!! forces Kxd8 and mates. The quiet alternative
    // (9.Qxe4) merely restores material equality, so the "already winning" gate
    // must NOT demote it. 10.Bg5+ is double check — the bishop can't legally be
    // taken, so no second sac.
    //
    // 8.O-O-O was labeled here once, on the theory that castling deliberately
    // leaves the e4 knight en prise. It doesn't: the knight is worth exactly the
    // same 3.0 to Black *before* castling as after, so the move offers nothing
    // it wasn't already offering — the same shape as every false positive the
    // detector produced on real games. Castling here is strong and it is brave,
    // but the sacrifice was on the board before White touched the king.
    expected: [{ moveNumber: 9, san: "Qd8+" }],
  },
  {
    name: "Ed. Lasker–Thomas 1912 — 11.Qxh7+!! king hunt",
    pgn:
      "1. d4 e6 2. Nf3 f5 3. Nc3 Nf6 4. Bg5 Be7 5. Bxf6 Bxf6 6. e4 fxe4 " +
      "7. Nxe4 b6 8. Ne5 O-O 9. Bd3 Bb7 10. Qh5 Qe7 11. Qxh7+ Kxh7 12. Nxf6+ Kh6 " +
      "13. Neg4+ Kg5 14. h4+ Kf4 15. g3+ Kf3 16. Be2+ Kg2 17. Rh2+ Kg1 18. Kd2#",
    userColor: "w",
    // One brilliancy: the queen sac that drags the king from g8 to g1. Every
    // later check (12.Nxf6+ double check, 13.Neg4+, 16.Be2+, 17.Rh2+) leaves a
    // piece "attacked" only by illegal captures — good coverage for the
    // legal-captures-only rule during a king hunt.
    expected: [{ moveNumber: 11, san: "Qxh7+" }],
  },
  {
    name: "Levitsky–Marshall 1912 — 23...Qg3!! (gold coins)",
    pgn:
      "1. d4 e6 2. e4 d5 3. Nc3 c5 4. Nf3 Nc6 5. exd5 exd5 6. Be2 Nf6 " +
      "7. O-O Be7 8. Bg5 O-O 9. dxc5 Be6 10. Nd4 Bxc5 11. Nxe6 fxe6 12. Bg4 Qd6 " +
      "13. Bh3 Rae8 14. Qd2 Bb4 15. Bxf6 Rxf6 16. Rad1 Qc5 17. Qe2 Bxc3 " +
      "18. bxc3 Qxc3 19. Rxd5 Nd4 20. Qh5 Ref8 21. Re5 Rh6 22. Qg5 Rxh3 23. Rc5 Qg3",
    userColor: "b",
    // 22...Rxh3 is deliberately NOT labeled: it captures a bishop and concedes
    // rook-for-bishop-and-pawn, a net offer under one pawn — annotation tradition
    // gives it "!", not "!!". And 17...Bxc3 is a pure trade (bxc3 recaptures) —
    // the net-of-capture rule must keep it off the list.
    expected: [],
    // The legendary 23...Qg3!! — every capture of the queen loses. We don't flag
    // it, and the reason is the already-winning rule working as designed rather
    // than a threshold that needs nudging: Marshall is a clean piece up here, and
    // at depth 14 the quiet queen retreats 23...Qb4 (+3.00), 23...Qa3 (+2.85) and
    // 23...Qb2 (+2.67) win about as convincingly as Qg3 itself (+3.03). A move
    // that improves a won position by 3 centipawns is not the move that won the
    // game, however beautiful it is — and chess.com withholds !! on the same
    // grounds. Note this fixture used to pass only because the sacrifice test was
    // broken: with "what hangs after the move" rather than "what this move puts
    // on offer", nearly every alternative looked like a sacrifice too, so the
    // gate had nothing quiet left to compare against and never fired.
    diverges: [
      {
        moveNumber: 23,
        san: "Qg3",
        why: "Black is already winning (+3) with quiet queen moves — the ALREADY_WINNING gate",
      },
    ],
  },
  {
    name: "Scholar's mate — no sacrifice (negative control)",
    pgn: "1. e4 e5 2. Bc4 Nc6 3. Qh5 Nf6 4. Qxf7#",
    userColor: "w",
    // Qxf7# is a capture *and* mate, but after it Black has no legal reply, so
    // nothing is "hanging" — the detector must not call it a sacrifice.
    expected: [],
  },
];
