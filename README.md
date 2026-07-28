# Brilliancy — `!!`

Type any chess.com username and the site pulls your recent games, then runs a
chess engine over them **in your browser** to surface your **brilliant moves**
(sound sacrifices) alongside your ratings and record.

No backend. No login. Your games are analyzed locally — nothing leaves the page.

## How it works

| Piece | What it does |
| --- | --- |
| **Data** | The public [chess.com API](https://www.chess.com/news/view/published-data-api) (`api.chess.com/pub`) — profile, stats, and recent monthly game archives. CORS-enabled, so the browser calls it directly. |
| **Engine** | Single-threaded [Stockfish 16 NNUE](https://github.com/nmrugg/stockfish.js) (WASM) in a Web Worker. No `SharedArrayBuffer`/COOP-COEP headers required. NNUE is switched on explicitly — this build defaults it *off*, and the classical evaluation it falls back to is weakest at exactly the material-imbalance judgement a sacrifice detector lives on. |
| **Board** | Hand-rolled React board (no board library) so the brilliant-move highlight, arrow, and `!!` seal are fully under our control. |

### What counts as "brilliant"

chess.com's `!!` label comes from their proprietary Game Review and **is not in
the public API**, so we approximate it. A move is flagged when all three hold:

1. **Sacrifice** — the move *newly* exposes real material (≥ ~2 pawns, i.e. an
   exchange sac and up) to a capture sequence the opponent didn't already have.
   This is a cheap static check ([Static Exchange Evaluation](src/engine/see.ts)),
   so it runs on every move and pre-filters candidates — only candidates pay the
   engine cost.
2. **Sound** — despite the offered material, Stockfish still likes your position
   (you're not losing after the sacrifice).
3. **Strong** — the move is the engine's best or close to it. You don't get
   credit for a sacrifice that also throws the game away.
4. **Necessary** — the sacrifice must beat the best *quiet* alternative (one that
   doesn't itself offer material) by a real margin, currently 50cp. Not "were you
   winning anyway" but "did the fireworks actually win it". Alternatives that are
   themselves sacrifices don't count — in Levitsky–Marshall the second-best move
   to `23...Qg3!!` is another winning tactic, and demoting a brilliancy because a
   *different* tactic also won misreads the rule.
5. **Not a promotion** — the offered piece must have existed before the move. A
   queen you made this turn and hung on the promotion square isn't material you
   gave up; you're down nothing you had. chess.com starred none of the three in
   our labelled set.

Two details do most of the work. Using *legal* captures (not just "is this square
attacked") rejects illusory sacrifices — a piece that only looks hanging because
it's checkmate, or whose only attacker is pinned. And measuring what the move
*newly* puts on offer, rather than what happens to be hanging afterwards, keeps
the blame on the right move: otherwise every move played beside a loose piece is
credited with sacrificing it, which is how a king move once got billed as a
5-pawn sacrifice. See [`src/engine/brilliancy.ts`](src/engine/brilliancy.ts).

It's an approximation, not chess.com's exact algorithm — that's stated in the UI.

### How well does it work?

Measured, not asserted. Against 17 of Louis's games where chess.com's own label
is known, plus six classical games: **75% precision, 90% recall**. It finds
nearly everything chess.com stars, and flags roughly one extra move for every
three real ones.

The labelled games are split into a **fit** half and a held-back **test** half
(plus a **guard** set of confirmed positives and classical games), so a rule that
merely describes the data it was invented on can be told apart from one that
generalises. `node scripts/test-harness.mjs` prints all three, and reports every
rule's effect on the held-out half specifically.

That split has already earned itself twice:

- The `necessary` gate became a **margin** (`NECESSARY_MARGIN` in
  [`brilliancy.ts`](src/engine/brilliancy.ts)) rather than a threshold, cutting
  held-out false positives **7 → 2** and precision from 43% to 75%. The old rule
  passed one sacrifice on a **three-centipawn** edge over just playing quietly.
- A rule that looked *three-for-three* in the labels — discovered sacrifices are
  never brilliant — turned out to cut Légal's Mate, the textbook discovered
  sacrifice. The guard set caught it on the first run. See the note above
  `REJECT_SHAPES`.

Still unexplained: `24.Ne6`, confirmed starred by chess.com, sits at a −102cp
margin — worse than moves chess.com declined to star. Margin is a strong signal,
not the whole definition.

## Run it

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # production build into dist/
npm run preview  # serve the production build
```

> **Note:** the first scan downloads the Stockfish NNUE network (~40 MB) from
> `public/engine/`, then the browser caches it permanently. It downloads when you
> ask for a scan, not on page load. That file ships in the repo and the build,
> which is why `dist/` and the install are large — see `USE_NNUE` in
> [`src/engine/engine.ts`](src/engine/engine.ts) for the trade-off and how to opt out.

## Verification

The `scripts/` folder has Playwright smoke tests (they use your installed
Edge/Chrome — no Chromium download). With the dev server running:

```bash
node scripts/sac-attribution.mjs  # fast: the sacrifice pre-filter, no engine (~1s)
node scripts/test-harness.mjs     # full calibration — precision/recall on fixtures
node scripts/smoke.mjs            # renders hero, boots the engine, loads a profile
node scripts/verify-detect.mjs    # runs the real detector on Légal's Mate (5.Nxe5!!)
node scripts/visual.mjs           # screenshots hero, game viewer, and a live scan
```

Two more for chasing detector disagreements against real games:

```bash
node scripts/explain.mjs --fixture Levitsky        # why each candidate was rejected
node scripts/explain.mjs --user <name> --games 5   # ...on a real account
node scripts/diag-account.mjs <name> 40            # what gets flagged, with details
```

## Stack

Vite · React + TypeScript · [chess.js](https://github.com/jhlywa/chess.js)
(move generation, SAN, FEN, `attackers()` for SEE) · Stockfish 16 WASM.

Not affiliated with chess.com.
