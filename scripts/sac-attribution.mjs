/**
 * Regression test for sacrifice *attribution* — the pre-filter only, no engine, so
 * it runs in about a second and can gate every change to see.ts / the pre-filter.
 *
 * The bug it exists to prevent: measuring what hangs *after* a move without asking
 * whether the move put it there. That credits every move played beside a loose
 * piece with sacrificing it, and produced nonsense like Carlsen "sacrificing" a
 * rook with a king move (38...Kg8) in a real game.
 *
 * Cases below are real positions. Node computes the FENs with chess.js; the actual
 * src/engine/brilliancy.ts runs in the browser, so this tests shipping code rather
 * than a copy of it.
 *
 * Prereq: the dev server must be running (npm run dev).
 *
 *   node scripts/sac-attribution.mjs
 */
import { chromium } from "playwright";
import { Chess } from "chess.js";

const MIN_SAC = 2.0; // must match MIN_SACRIFICE in src/engine/brilliancy.ts

/**
 * expect: "sac"    — the move itself offers >= MIN_SAC of new material
 *         "no-sac" — it does not (either nothing is offered, or what hangs was
 *                    already hanging before the move was played)
 */
const cases = [
  // ---- genuine sacrifices: the move creates the offer -------------------------
  {
    name: "Légal 5.Nxe5 — knight offered, and the queen behind it",
    fen: "rn1qkbnr/ppp2p1p/3p2p1/4p3/2B1P1b1/2N2N2/PPPP1PPP/R1BQK2R w KQkq - 0 5",
    san: "Nxe5",
    color: "w",
    expect: "sac",
  },
  {
    name: "Opera Game 10.Nxb5 — knight into the fire for a pawn",
    fen: "rn2kb1r/p3qppp/2p2n2/1p2p1B1/2B1P3/1QN5/PPP2PPP/R3K2R w KQkq - 0 10",
    san: "Nxb5",
    color: "w",
    expect: "sac",
  },
  {
    name: "Opera Game 16.Qb8+ — the queen offer",
    fen: "4kb1r/p2n1ppp/4q3/4p1B1/4P3/1Q6/PPP2PPP/2KR4 w k - 0 16",
    san: "Qb8+",
    color: "w",
    expect: "sac",
  },
  {
    name: "Lasker–Thomas 11.Qxh7+ — queen sac, king hunt",
    fen: "rn3rk1/pbppq1pp/1p2pb2/4N2Q/3PN3/3B4/PPP2PPP/R3K2R w KQ - 6 11",
    san: "Qxh7+",
    color: "w",
    expect: "sac",
  },
  {
    name: "Marshall 23...Qg3 — the gold-coins queen offer",
    fen: "5rk1/pp4pp/4p3/2R3Q1/3n4/2q4r/P1P2PPP/5RK1 b - - 1 23",
    san: "Qg3",
    color: "b",
    expect: "sac",
  },
  {
    name: "Carlsen 22.Nf5+ — knight steps onto a square it can be taken on",
    fen: "4r1r1/pbp1kp1p/2qbpp2/2p5/4N2N/Q5P1/PPP2P1P/1K1RR3 w - - 2 22",
    san: "Nf5+",
    color: "w",
    expect: "sac",
  },

  // ---- NOT sacrifices: the material was already loose ------------------------
  {
    name: "Carlsen 38...Kg8 — a KING 'sacrificing' a rook it never touched",
    fen: "8/6bk/3p3p/2p1P3/1pb1BpP1/7P/2r2B2/7K b - - 1 38",
    san: "Kg8",
    color: "b",
    expect: "no-sac",
  },
  {
    name: "Carlsen 29.Qa4 — knight on c3 was en prise before the queen moved",
    fen: "2b3k1/p6p/1q2p1p1/2p1P3/2np1PP1/2N2NKP/P7/3Q4 w - - 0 29",
    san: "Qa4",
    color: "w",
    expect: "no-sac",
  },
  {
    name: "Carlsen 24...Bf8 — queen already hanging on d3, bishop move blamed",
    fen: "r1b1R1k1/p4nbp/p5p1/8/8/2pq1N1P/1PP2PP1/R5K1 b - - 1 24",
    san: "Bf8",
    color: "b",
    expect: "no-sac",
  },
  {
    name: "Carlsen 26.hxg7 — pawn push actually REDUCED the exposure on h8",
    fen: "4r2Q/2r1k1p1/p2qp2P/2npn1P1/1p1N4/2N1P3/PP3P2/1K1R3R w - - 3 26",
    san: "hxg7",
    color: "w",
    expect: "no-sac",
  },
  {
    name: "Réti 8.O-O-O — the e4 knight is worth the same before and after",
    fen: "rnb1kb1r/pp3ppp/2p2n2/4q3/4N3/3Q4/PPPB1PPP/R3KBNR w KQkq - 0 8",
    san: "O-O-O",
    color: "w",
    expect: "no-sac",
  },
  {
    name: "Marshall 17...Bxc3 — a trade (bxc3 recaptures), not an offer",
    fen: "4r1k1/pp4pp/2n1pr2/2qp4/1b6/2N4B/PPP1QPPP/3R1RK1 b - - 3 17",
    san: "Bxc3",
    color: "b",
    expect: "no-sac",
  },
  {
    name: "Opera Game 15.Bxd7+ — bishop takes ROOK, this wins material",
    fen: "4kb1r/p2r1ppp/4qn2/1B2p1B1/4P3/1Q6/PPP2PPP/2KR4 w k - 2 15",
    san: "Bxd7+",
    color: "w",
    expect: "no-sac",
  },
  {
    name: "Scholar's mate 4.Qxf7# — a capture with no legal reply is no sacrifice",
    fen: "r1bqkb1r/pppp1ppp/2n2n2/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq - 4 4",
    san: "Qxf7#",
    color: "w",
    expect: "no-sac",
  },
];

// Resolve each case to a (fenBefore, fenAfter, captured) triple up front — chess.js
// runs happily in node, and it keeps the browser side down to the code under test.
const prepared = cases.map((c) => {
  const board = new Chess(c.fen);
  const m = board.move(c.san);
  return { ...c, fenAfter: board.fen(), captured: m.captured, piece: m.piece };
});

async function launch() {
  for (const channel of ["msedge", "chrome"]) {
    try {
      return await chromium.launch({ channel, headless: true });
    } catch {
      /* next */
    }
  }
  return await chromium.launch({ headless: true });
}

const browser = await launch();
const page = await browser.newPage();
page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
await page.goto("http://localhost:5173/", { waitUntil: "networkidle" });

const results = await page.evaluate(async (rows) => {
  const { sacrificeValue } = await import("/src/engine/brilliancy.ts");
  return rows.map((r) => {
    const got = sacrificeValue(
      { fenBefore: r.fen, fenAfter: r.fenAfter, captured: r.captured },
      r.color,
    );
    return { value: got.value, square: got.square };
  });
}, prepared);

let failed = 0;
for (let i = 0; i < prepared.length; i++) {
  const c = prepared[i];
  const got = results[i];
  const isSac = got.value >= MIN_SAC;
  const ok = isSac === (c.expect === "sac");
  if (!ok) failed++;
  const detail = `offers ${got.value.toFixed(1)}${got.square ? ` on ${got.square}` : ""}`;
  console.log(`${ok ? "✓" : "✗"} ${c.name}\n    moved ${c.piece}, ${detail} (want ${c.expect})`);
}

console.log(
  `\n${prepared.length - failed}/${prepared.length} passed` + (failed ? ` — ${failed} FAILED` : ""),
);
await browser.close();
process.exit(failed ? 1 : 0);
