# Brilliancy — `!!`

Type any chess.com username and the site pulls your recent games, then runs a
chess engine over them **in your browser** to surface your **brilliant moves**
(sound sacrifices) alongside your ratings and record.

No backend. No login. Your games are analyzed locally — nothing leaves the page.

## How it works

| Piece | What it does |
| --- | --- |
| **Data** | The public [chess.com API](https://www.chess.com/news/view/published-data-api) (`api.chess.com/pub`) — profile, stats, and recent monthly game archives. CORS-enabled, so the browser calls it directly. |
| **Engine** | Single-threaded [Stockfish 16 NNUE](https://github.com/nmrugg/stockfish.js) (WASM) running in a Web Worker. No `SharedArrayBuffer`/COOP-COEP headers required. |
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
4. **Necessary** — no *quiet* alternative was already winning comfortably. If you
   were winning anyway, the fireworks weren't what won it.

Two details do most of the work. Using *legal* captures (not just "is this square
attacked") rejects illusory sacrifices — a piece that only looks hanging because
it's checkmate, or whose only attacker is pinned. And measuring what the move
*newly* puts on offer, rather than what happens to be hanging afterwards, keeps
the blame on the right move: otherwise every move played beside a loose piece is
credited with sacrificing it, which is how a king move once got billed as a
5-pawn sacrifice. See [`src/engine/brilliancy.ts`](src/engine/brilliancy.ts).

It's an approximation, not chess.com's exact algorithm — that's stated in the UI.

## Run it

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # production build into dist/
npm run preview  # serve the production build
```

> **Note:** the first scan downloads the Stockfish NNUE network (~40 MB) from
> `public/engine/`, then the browser caches it. That file ships in the repo and
> the build, which is why `dist/` and the install are large.

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
