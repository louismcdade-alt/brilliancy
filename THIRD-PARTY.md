# Third-party components

Brilliancy ships other people's work to every visitor. This file records what,
under which licence, and what that obliges us to do. Serving a file to a browser
**is** distribution — linking to the upstream project in a README is not
compliance.

---

## Stockfish 16 (NNUE) — GPL-3.0-or-later

- `public/engine/stockfish-nnue-16-single.js`
- `public/engine/stockfish-nnue-16-single.wasm`
- `public/engine/nn-5af11540bbfe.nnue`

Upstream engine: <https://github.com/official-stockfish/Stockfish>
WebAssembly build: <https://github.com/nmrugg/stockfish.js>

The neural network file is the official one: Stockfish names its networks after
their own content hash, and `sha256(nn-5af11540bbfe.nnue)` begins `5af11540bbfe`,
so the filename is a self-verifying integrity check.

**What GPL-3.0 requires of us.** Every visitor receives a compiled Stockfish
build, which makes us a distributor. We must:

1. Ship the full licence text — `public/licenses/GPL-3.0.txt`, served at `/licenses/GPL-3.0.txt`, linked from the site footer.
2. Offer the corresponding source for **this** build. The engine is unmodified,
   so pointing at the exact upstream release satisfies this; if it is ever
   patched, the patched source must be published.
3. Keep the copyright and licence notices intact in the delivered files. They
   are, inside the `.js` glue.

Note the GPL is *not* the AGPL: hosting Brilliancy does not oblige us to publish
the source of Brilliancy itself. Publishing it anyway is the friendlier move, and
the plan.

---

## cburnett chess pieces — CC-BY-SA 3.0

`public/pieces/*.svg` — twelve piece SVGs by Colin M.L. Burnett.

Source: <https://commons.wikimedia.org/wiki/Category:SVG_chess_pieces>

**What CC-BY-SA 3.0 requires of us:** credit the author, name the licence, and
link to it. Share-alike applies to modifications of the images themselves — ours
are unmodified. The attribution lives in the site footer and in `README.md`.

---

## chess.js — BSD-2-Clause

Move generation, SAN/FEN parsing, and the attacker lists the sacrifice detector
is built on. <https://github.com/jhlywa/chess.js> — permissive; the licence text
must travel with any redistribution of its source, which npm handles.

## React — MIT

<https://github.com/facebook/react>

## Newsreader — SIL Open Font License 1.1

`public/fonts/newsreader-latin.woff2`, `newsreader-latin-italic.woff2`
<https://github.com/productiontype/Newsreader>

## JetBrains Mono — SIL Open Font License 1.1

`public/fonts/jetbrains-mono-latin.woff2`
<https://github.com/JetBrains/JetBrainsMono>

Both fonts are served from our own origin rather than a CDN, so no visitor is
announced to a third party merely for loading the page. The OFL permits this;
it forbids selling the fonts on their own and requires the licence to travel
with them — see `public/licenses/OFL-1.1.txt`, served at `/licenses/OFL-1.1.txt`.

---

## Data — chess.com Published-Data API

<https://www.chess.com/news/view/published-data-api>

Public, unauthenticated, CORS-enabled, called directly from the browser. Their
terms ask for attribution and reasonable request rates. Brilliancy is **not
affiliated with or endorsed by chess.com**, and the UI says so. The `!!`
classification here is our own approximation — chess.com's Game Review algorithm
is proprietary and is not exposed by the API.
