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
    expected: [{ moveNumber: 23, san: "Qg3" }],
    // The legendary 23...Qg3!! — every capture of the queen loses. This was
    // briefly demoted while the "necessary" gate compared only absolute evals:
    // Marshall is a piece up, so quiet queen retreats also read as winning and
    // the gate fired. That was the gate being wrong, not the annotation. It now
    // also asks whether the sacrifice BEATS the best quiet alternative, and
    // Qg3 does — which is the whole reason it's the famous move and Qb4 isn't.
  },
  {
    name: "Scholar's mate — no sacrifice (negative control)",
    pgn: "1. e4 e5 2. Bc4 Nc6 3. Qh5 Nf6 4. Qxf7#",
    userColor: "w",
    // Qxf7# is a capture *and* mate, but after it Black has no legal reply, so
    // nothing is "hanging" — the detector must not call it a sacrifice.
    expected: [],
  },
  // ── Real chess.com labels ────────────────────────────────────────────────
  // Everything above is a classical game labelled from annotation tradition and
  // our own judgement. These four are different, and more valuable: the
  // `expected` lists come from chess.com's own Game Review on LouisMcdade's
  // account, which is the exact label this project exists to approximate.
  //
  // They are also where the detector is weakest. The classical fixtures score
  // 100%; these four exposed three false positives at once. That gap is what
  // overfitting looks like — famous sacrifices are not the distribution real
  // club games are drawn from.
  {
    name: "louismcdade vs inchara05 — 6...Bxf2+!! (chess.com labelled)",
    pgn: "1. e4 e5 2. Bc4 Bc5 3. c3 d6 4. Qb3 Nc6 5. Bxf7+ Kf8 6. Bh5 Bxf2+ 1-0",
    userColor: "b",
    // Game Review stars this at -0.76 on its White-oriented eval bar, i.e. Black
    // is BETTER by ~0.7 after the offer. Note chess.com gave White's 5.Bxf7+ only
    // a "Best" star, not a !!, in the same game.
    expected: [{ moveNumber: 6, san: "Bxf2+" }],
  },
  {
    name: "louismcdade vs kamagar1910 — 24.Ne6!! (chess.com labelled)",
    pgn:
      "1. e4 e5 2. Nf3 d6 3. Bc4 Nf6 4. d3 Bg4 5. O-O d5 6. Bb3 c6 7. Nxe5 Bxd1 " +
      "8. Rxd1 Bc5 9. d4 Bxd4 10. Rxd4 Nxe4 11. Ba4 b5 12. Bb3 Nd7 13. Nxc6 Qf6 " +
      "14. Be3 O-O 15. Rxd5 Rac8 16. Nd4 Rc5 17. Rxd7 a5 18. Nc3 Nd6 19. Rxd6 Qe6 " +
      "20. Rc6 Qf6 21. Rd6 Qxd6 22. Ne4 Qc7 23. Nxc5 Qxc5 24. Ne6 Qd6 25. Bc5 Qd2 " +
      "26. Bxf8 Qd7 27. Re1 Qd2 28. Kf1 Qh6 29. Rd1 Qxe6 30. Ba3 1-0",
    userColor: "w",
    // Exactly ONE brilliancy in the game per Game Review: 24.Ne6. We also flagged
    // 19.Rxd6, which chess.com does not star — a false positive to fix, not to
    // argue with.
    expected: [{ moveNumber: 24, san: "Ne6" }],
  },
  {
    name: "louismcdade vs tyo6k — NO brilliancy (chess.com labelled)",
    pgn:
      "1. e4 e5 2. Qf3 Nf6 3. Nc3 d5 4. Qd3 dxe4 5. Nxe4 Nxe4 6. Qxe4 Bd6 " +
      "7. Qg4 Bxg4 8. d4 O-O 9. Bg5 f6 10. Be3 exd4 11. Nf3 dxe3 12. fxe3 Be5 " +
      "13. Bc4+ Be6 14. Bxe6+ Kh8 15. Nxe5 fxe5 16. e4 Qf6 17. Rf1 Qxf1+ " +
      "18. Kd2 Qxa1 19. Kc3 Qxa2 20. Kb4 Qxe6 21. Kc3 Nc6 22. Kd3 Rad8+ " +
      "23. Ke3 Qh6+ 24. Ke2 Rd7 25. Ke1 Rdf7 26. Kd1 Rf1+ 27. Ke2 Nd4+ " +
      "28. Kd3 R8f3+ 29. Kc4 Qc6+ 30. Kb4 Qb5# 0-1",
    userColor: "b",
    // Game Review: zero brilliancies. We flag 28...R8f3+, a rook offer that forces
    // mate — but by then White is a bare king plus pawns against queen, two rooks
    // and a knight. chess.com withholds !! when you're this far ahead, and this is
    // the case that shows the "necessary" gate is too permissive.
    expected: [],
  },
  {
    name: "louismcdade vs eldstinto — NO brilliancy (chess.com labelled)",
    pgn:
      "1. d4 e6 2. e4 d5 3. Nf3 dxe4 4. Ne5 Nh6 5. f3 f5 6. fxe4 fxe4 7. Bc4 Qd6 " +
      "8. Bf4 Qb4+ 9. c3 Qxb2 10. Nd2 Qxc3 11. Rc1 Qxd4 12. Qh5+ g6 13. Nxg6 hxg6 " +
      "14. Qe5 Qxe5 15. Bxe5 Nc6 16. Bxh8 e5 17. Nxe4 Bf5 18. Nf6+ Kd8 19. Rd1+ Nd4 " +
      "20. Bd5 Bb4+ 21. Kf2 Ng4+ 22. Kg3 Ne2+ 23. Kf3 Ke7 24. Nxg4 Rxh8 25. Kxe2 " +
      "Bxg4+ 26. Bf3 Bxf3+ 27. Kxf3 Rf8+ 28. Ke4 Rf4+ 29. Kxe5 Bd6+ 30. Kd5 c6# 0-1",
    userColor: "b",
    // Game Review: zero brilliancies. We flag 12...g6 — a pawn move leaving the
    // knight on h6 to be taken. This is the "discovered" sacrifice branch, where
    // the offered piece isn't the one that moved, and it's the branch most likely
    // to be over-firing.
    expected: [],
  },
  {
    name: "louismcdade vs zetekkkk — NO brilliancy (chess.com labelled)",
    pgn:
      "1. e4 e5 2. Nf3 Qf6 3. d4 d5 4. dxe5 Qb6 5. exd5 Bg4 6. Be3 Qxb2 7. Nbd2 Qc3 " +
      "8. Bb5+ Bd7 9. Bxd7+ Nxd7 10. O-O Ne7 11. Qb1 O-O-O 12. e6 fxe6 13. dxe6 Ne5 " +
      "14. Qb5 Nxf3+ 15. Nxf3 c6 16. Qc5 Qf6 17. Qxa7 Qxe6 18. Qa8+ Kc7 19. Bb6+ Kxb6 " +
      "20. Qxd8+ Kc5 21. Qd4+ Kb5 22. Rab1+ Ka6 23. Qb6# 1-0",
    userColor: "w",
    // Zero brilliancies. We flag 19.Bb6+ — a real bishop offer that drags the king
    // out and mates — but the position is already +10.25. Material is level; it's
    // the evaluation that's overwhelming, and chess.com still withholds the !!.
    expected: [],
  },
  {
    name: "louismcdade vs hrkirat29 — NO brilliancy (chess.com labelled)",
    pgn:
      "1. e4 e5 2. d4 Nc6 3. c3 d5 4. Nd2 exd4 5. cxd4 Nxd4 6. Ndf3 Nxf3+ 7. Qxf3 Bc5 " +
      "8. exd5 Nf6 9. Bc4 O-O 10. Nh3 Re8+ 11. Be2 Nxd5 12. O-O c6 13. Bg5 Be7 " +
      "14. Be3 b5 15. Rac1 Bb7 16. a3 b4 17. Rc4 bxa3 18. b3 a2 19. Bd3 Qa5 20. g3 a1=Q " +
      "21. Rxa1 Qxa1+ 22. Kg2 Nxe3+ 23. Qxe3 c5+ 24. f3 Bxf3+ 25. Kxf3 Qf6+ 26. Nf4 Bd6 " +
      "27. Qd2 Rad8 28. Kg2 Bxf4 29. gxf4 Rxd3 30. Qxd3 Qg6+ 31. Qxg6 fxg6 32. Rxc5 Re2+ " +
      "33. Kf3 Rxh2 34. b4 h6 35. Rc8+ Kh7 36. Ra8 Ra2 37. b5 g5 38. b6 gxf4 39. b7 g5 " +
      "40. b8=Q g4+ 41. Kxf4 Rg2 42. Qb7+ Kg6 43. Qxg2 h5 44. Qc6+ Kf7 45. Rxa7+ Kf8 " +
      "46. Qc8# 1-0",
    userColor: "b",
    // Zero brilliancies. We flag 20...a1=Q, promoting into a capture at +5.95.
    expected: [],
  },
];
