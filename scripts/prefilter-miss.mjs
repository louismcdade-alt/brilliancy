/**
 * Diagnose a starred move that never became a candidate.
 *
 * The gates can be inspected with explain.mjs, but only for moves that reached
 * the engine. A move rejected by the SACRIFICE PRE-FILTER is invisible to that
 * tool — it is dropped before any search happens — and four of chess.com's nine
 * brilliancies for LouisMcdade are in that class. This script opens that box: for
 * each labelled star it prints what the pre-filter saw and, crucially, WHEN the
 * material went on offer.
 *
 * Three numbers, and the difference between them is the whole diagnosis:
 *
 *   offers   what ships — material the move itself newly exposes (a delta).
 *   hanging  the naive snapshot: everything the opponent can win afterwards.
 *   fresh    was the exposure created by the OPPONENT'S last move? If a piece was
 *            hanging both before and after, `offers` is 0 by design — but there is
 *            a real difference between "it has been loose for ten moves and this
 *            move ignores it" and "you just attacked it and I am declining to move
 *            it". The first is the false-positive class the delta rule exists to
 *            kill; the second may be a sacrifice the delta rule cannot see.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * PRE-REGISTERED 2026-07-29, written down before the held-out misses were run.
 *
 * Read from the FIT half only — 14...fxe5 vs Wonky6, the one pre-filter miss not
 * held back. Its numbers: offers 0.0, hanging 2.0 on f5, and the whole 2.0 was
 * created by White's immediately preceding 14.e4. Black's knight on f5 was
 * attacked, Black declined to move it and struck elsewhere instead.
 *
 * HYPOTHESIS. The pre-filter misses are ALLOW-sacrifices. Our sacrifice test only
 * recognises an OFFER — material the move itself newly exposes — so a player who
 * refuses to rescue a piece the opponent just attacked has, by construction, a
 * delta of zero and never reaches the engine. chess.com counts both.
 *
 * PREDICTION for the three held-out misses (170150169022 15.Qf7, 168271440076
 * 7.Qxc5, 167117565258 23.Rhd1): each shows `offers` < MIN_SACRIFICE and `fresh`
 * ≥ MIN_SACRIFICE. Anything else falsifies this — in particular, a miss with
 * `fresh` 0 is a third mechanism and this reading of the fit example does not
 * generalise.
 *
 * WHY `fresh` IS NARROW ON PURPOSE. Re-admitting already-hanging material is how
 * the detector used to credit Carlsen's 38...Kg8 with sacrificing a rook it never
 * touched — 12 of 21 flags on real games were that bug. `fresh` is not "something
 * is loose"; it is "your last move put this on offer and my move leaves it
 * there", per square. A piece loose for ten moves scores 0, exactly as now.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Prereq: the dev server must be running (npm run dev).
 *
 *   node scripts/prefilter-miss.mjs                 # every labelled star
 *   node scripts/prefilter-miss.mjs 75046302171     # one game
 */
import { chromium } from "playwright";
import { Chess } from "chess.js";
import { chesscomLabels } from "./labels-louismcdade.mjs";

const only = process.argv.slice(2);
const games = chesscomLabels.filter(
  (g) => g.count > 0 && (only.length === 0 || only.includes(g.id)),
);
if (!games.length) {
  console.error("no labelled positives matched");
  process.exit(1);
}

/** Replay to the starred move and capture the positions around it. */
function positions(game, expected) {
  const chess = new Chess();
  const sans = game.pgn
    .replace(/\{[^}]*\}/g, "")
    .replace(/\d+\.(\.\.)?/g, " ")
    .split(/\s+/)
    .filter((t) => t && !/^(1-0|0-1|1\/2-1\/2|\*)$/.test(t));

  const target = 2 * (expected.moveNumber - 1) + (game.userColor === "w" ? 0 : 1);
  let beforeOpp = null; // position before the opponent's preceding move
  for (let i = 0; i < sans.length; i++) {
    if (i === target - 1) beforeOpp = chess.fen();
    const fenBefore = chess.fen();
    const m = chess.move(sans[i]);
    if (!m) throw new Error(`${game.id}: illegal ${sans[i]} at ply ${i}`);
    if (i === target) {
      return {
        san: m.san,
        played: sans[i],
        oppMove: target > 0 ? sans[target - 1] : null,
        fenBeforeOpp: beforeOpp,
        fenBefore,
        fenAfter: chess.fen(),
        captured: m.captured ?? null,
      };
    }
  }
  throw new Error(`${game.id}: ply ${target} not reached`);
}

const rows = games.map((g) => {
  const exp = g.expected[0];
  const p = positions(g, exp);
  if (p.san !== exp.san) throw new Error(`${g.id}: replay gave ${p.san}, label says ${exp.san}`);
  return { id: g.id, name: g.name, half: g.half, color: g.userColor, move: `${exp.moveNumber}${g.userColor === "w" ? "." : "..."}${exp.san}`, ...p };
});

const browser = await (async () => {
  for (const channel of ["msedge", "chrome"]) {
    try {
      return await chromium.launch({ channel, headless: true });
    } catch {
      /* next */
    }
  }
  return chromium.launch({ headless: true });
})();
const page = await browser.newPage();
page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
await page.goto("http://localhost:5173/", { waitUntil: "networkidle" });

const out = await page.evaluate(async (input) => {
  const { sacrificeValue, MIN_SACRIFICE } = await import("/src/engine/brilliancy.ts");
  const { maxMaterialHanging, hangingMap } = await import("/src/engine/see.ts");
  // Bare specifiers don't resolve in the page; go at the file Vite serves.
  const { Chess } = await import("/node_modules/chess.js/dist/esm/chess.js");
  const flip = (fen) => {
    const p = fen.split(" ");
    p[1] = p[1] === "w" ? "b" : "w";
    p[3] = "-";
    return p.join(" ");
  };
  const asObj = (map) => Object.fromEntries([...map].map(([k, v]) => [k, v]));

  return input.map((r) => ({
    id: r.id,
    minSac: MIN_SACRIFICE,
    offers: sacrificeValue(r, r.color),
    hangingAfter: maxMaterialHanging(new Chess(r.fenAfter), r.color),
    // The same question at two earlier moments, both asked with the OPPONENT to
    // move — that is what "how much of mine could you already take?" requires.
    // `fenBefore` has the player to move, so it needs flipping. `fenBeforeOpp`
    // already has the opponent to move and must NOT be flipped: flipping it hands
    // the move to the player, whose own pieces they cannot capture, and hangingMap
    // then returns an empty map for every position. That bug made every exposure
    // look brand new.
    exposedBefore: asObj(hangingMap(new Chess(flip(r.fenBefore)), r.color)),
    exposedBeforeOpp: r.fenBeforeOpp
      ? asObj(hangingMap(new Chess(r.fenBeforeOpp), r.color))
      : null,
    exposedAfter: asObj(hangingMap(new Chess(r.fenAfter), r.color)),
  }));
}, rows);

for (let i = 0; i < rows.length; i++) {
  const r = rows[i];
  const o = out[i];
  const seen = o.offers.value >= o.minSac;
  const top = (m) => {
    const e = Object.entries(m ?? {});
    return e.length ? e.map(([sq, v]) => `${sq}:${v.toFixed(1)}`).join(" ") : "—";
  };
  // Per square, like newMaterialOffered — comparing totals would let an exposure
  // the opponent created cancel against an unrelated one that vanished.
  //   created  = the opponent's last move put this much on offer here
  //   survived = it is still on offer after the player replied
  let fresh = 0;
  let freshSq = null;
  for (const [sq, after] of Object.entries(o.exposedAfter)) {
    const created = (o.exposedBefore[sq] ?? 0) - (o.exposedBeforeOpp?.[sq] ?? 0);
    const v = Math.min(created, after);
    if (v > fresh) {
      fresh = v;
      freshSq = sq;
    }
  }

  console.log(`${seen ? "CANDIDATE" : "INVISIBLE"}  [${r.half}] ${r.move}  ${r.name}`);
  console.log(`    offers   ${o.offers.value.toFixed(1)}${o.offers.square ? ` on ${o.offers.square}` : ""}   (pre-filter needs ≥ ${o.minSac})`);
  console.log(`    hanging  ${o.hangingAfter.value.toFixed(1)}${o.hangingAfter.square ? ` on ${o.hangingAfter.square}` : ""}   (snapshot after the move)`);
  console.log(`    exposed  before opp's ${r.oppMove ?? "—"}: ${top(o.exposedBeforeOpp)}`);
  console.log(`             before ${r.move}: ${top(o.exposedBefore)}`);
  console.log(`             after  ${r.move}: ${top(o.exposedAfter)}`);
  console.log(
    `    fresh    ${fresh.toFixed(1)}${freshSq ? ` on ${freshSq}` : ""}  ` +
      `(exposure the OPPONENT's ${r.oppMove ?? "—"} created, still standing after the reply)`,
  );
  console.log("");
}

await browser.close();
