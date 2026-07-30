/**
 * What does `admitAllow` actually cost a user waiting for a scan?
 *
 * 23% of chess.com's brilliancies (175 of 775 labelled) are ALLOW-sacrifices —
 * the opponent attacks something and the player declines to save it. The
 * shipping pre-filter never surfaces them, so they are unreachable by any model
 * at any threshold. Admitting them raises the recall ceiling; it also sends more
 * moves to the engine, and engine time IS the wait.
 *
 * The earlier estimate of "~2.3x" came from counting candidates, which is the
 * wrong unit: candidates differ in cost (a mate search terminates early, a quiet
 * middlegame position does not), and a game with no candidates at all is nearly
 * free either way. So this times the real thing — the same games, scanned twice,
 * alternating so a warming engine or a busy machine cannot favour one arm.
 *
 * Prereq: the dev server must be running (npm run dev).
 *
 *   node scripts/bench-admit.mjs [--games 24]
 */
import { chromium } from "playwright";
import { readFileSync } from "node:fs";

const i = process.argv.indexOf("--games");
const N = i >= 0 ? Number(process.argv[i + 1]) : 24;

const cache = JSON.parse(readFileSync("scripts/harvest-multi.json", "utf8"));
// A realistic slice: consecutive random-sample games from one account, which is
// what a real scan looks like. Star games would over-represent tactical
// positions and flatter the allow arm's cost.
const games = Object.values(cache.games)
  .filter((g) => g.sample === "random" && g.user === "louismcdade")
  .slice(0, N)
  .map((g) => ({ id: g.id, userColor: g.userColor }));

const pgns = new Map();
const { archives } = await (await fetch("https://api.chess.com/pub/player/louismcdade/games/archives")).json();
for (const url of archives) {
  const { games: batch } = await (await fetch(url)).json();
  for (const g of batch) {
    const id = String(g.url).split("/").pop();
    pgns.set(id, (g.pgn?.split(/\n\n/)[1] ?? "").replace(/\{[^}]*\}/g, "").replace(/\d+\.\.\./g, "").replace(/\s+/g, " ").trim());
  }
}
const suite = games.filter((g) => pgns.get(g.id)).map((g) => ({ ...g, pgn: pgns.get(g.id) }));

const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage();
page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
await page.goto("http://localhost:5173/", { waitUntil: "networkidle" });

async function scan(game, admitAllow) {
  return page.evaluate(
    async ({ game, admitAllow }) => {
      const bril = await import("/src/engine/brilliancy.ts");
      let candidates = 0;
      const t0 = performance.now();
      const found = await bril.scanGame(
        { ...game, url: "", timeClass: "blitz", timeControl: "300", rated: true,
          endTime: 0, result: "win", resultReason: "", oppUsername: "opp" },
        { depth: 14, admitAllow, onCandidate: () => candidates++ },
      );
      return { ms: performance.now() - t0, candidates, flagged: found.length };
    },
    { game, admitAllow },
  );
}

// One warm-up so the engine and its net are loaded before anything is timed.
await scan(suite[0], false);

const totals = { off: { ms: 0, c: 0, f: 0 }, on: { ms: 0, c: 0, f: 0 } };
for (const g of suite) {
  // Alternate order per game so drift affects both arms equally.
  const first = Math.random() < 0.5;
  const a = await scan(g, first);
  const b = await scan(g, !first);
  const off = first ? b : a;
  const on = first ? a : b;
  totals.off.ms += off.ms; totals.off.c += off.candidates; totals.off.f += off.flagged;
  totals.on.ms += on.ms; totals.on.c += on.candidates; totals.on.f += on.flagged;
  process.stderr.write(`  ${g.id}  off ${(off.ms / 1000).toFixed(1)}s/${off.candidates}c   on ${(on.ms / 1000).toFixed(1)}s/${on.candidates}c\n`);
}

await browser.close();

const n = suite.length;
const s = (x) => (x / 1000).toFixed(1);
console.log(`\n${n} real games, each scanned both ways (alternating order)\n`);
console.log(`  admitAllow OFF   ${s(totals.off.ms).padStart(6)}s total · ${(totals.off.ms / n / 1000).toFixed(2)}s per game · ${totals.off.c} candidates · ${totals.off.f} flagged`);
console.log(`  admitAllow ON    ${s(totals.on.ms).padStart(6)}s total · ${(totals.on.ms / n / 1000).toFixed(2)}s per game · ${totals.on.c} candidates · ${totals.on.f} flagged`);
console.log(`\n  time   ×${(totals.on.ms / totals.off.ms).toFixed(2)}`);
console.log(`  candidates ×${(totals.on.c / Math.max(1, totals.off.c)).toFixed(2)}`);
console.log(`\nA 30-game scan: ${s((totals.off.ms / n) * 30)}s → ${s((totals.on.ms / n) * 30)}s`);
