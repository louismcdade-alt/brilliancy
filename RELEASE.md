# Releasing Brilliancy

A static site with no backend, no login, and no database, so releasing it is
mostly about **licence obligations** and **one awkwardly large file**. Work top to
bottom; each step says what "done" looks like.

---

## 0. Pre-flight — everything must be green

```bash
npm run build                      # tsc --noEmit + vite build
node scripts/sac-attribution.mjs   # sacrifice pre-filter, ~1s   (needs npm run dev)
node scripts/test-harness.mjs      # precision/recall on fixtures (needs npm run dev)
node scripts/csp-check.mjs         # serves dist/ under the real CSP and drives it
node scripts/net-audit.mjs         # what a session actually talks to (needs npm run preview)
```

**Done when:** build clean, 14/14 attribution, 100%/100% harness, 0 CSP
violations, and `net-audit` reports **0 requests carrying a body** with no third
party other than `api.chess.com` and `images.chesscomfiles.com`.

---

## 1. Version control

The project is not a git repo yet.

```bash
git init && git add -A && git commit -m "Brilliancy: initial commit"
```

`.gitignore` already covers `node_modules`, `dist`, and the screenshot output.
Note `public/engine/` is **not** ignored — the 40 MB network file is committed on
purpose, because the build needs it and it never changes. GitHub warns above 50 MB
and hard-blocks at 100 MB; at 40 MB it is fine, but this is why the repo is large.

Then create the remote. Claude Code's safety classifier won't create it for you —
run this yourself:

```bash
gh repo create brilliancy --public --source=. --remote=origin --push
```

**Public, not private.** Stockfish is GPL-3.0 and you are distributing its build;
a public repo is the cleanest way to satisfy the corresponding-source offer, and
the `/ship-to-github` skill's default of private is the wrong call here.

**Done when:** `git remote -v` shows origin and `gh repo view --web` opens.

---

## 2. Licence obligations — do this before anyone can load the site

Already in place, but verify after any asset change:

- [ ] `/licenses/GPL-3.0.txt` and `/licenses/OFL-1.1.txt` are served (they live in
      `public/licenses/`, so they ship).
- [ ] `THIRD-PARTY.md` is in the repo root **and** at `/licenses/THIRD-PARTY.md`.
- [ ] The footer credits Stockfish (GPL-3.0), the cburnett pieces (CC BY-SA 3.0),
      and links the full notices.
- [ ] The footer still says **not affiliated with or endorsed by chess.com**.

Why it matters: serving a compiled Stockfish build to a browser *is* distribution
under the GPL. Linking the upstream project in a README does not discharge it.

**Done when:** you can load `/licenses/GPL-3.0.txt` on the deployed site.

---

## 3. Choose a host

| Host | 40 MB NNUE file | Verdict |
| --- | --- | --- |
| **Netlify** | fine | Reads `public/_headers` directly. **Recommended.** |
| **Vercel** | fine | Reads `vercel.json`. Equally good. |
| Cloudflare Pages | **rejected** — 25 MiB per-file cap | Only viable if the net moves to R2. |
| GitHub Pages | fine (100 MB/file) | Works, but bandwidth is a soft 100 GB/month and every new visitor pulls ~40 MB. |

Both config files are committed and kept in step; whichever host you pick, the
other's config is simply ignored.

### Netlify

```bash
npx netlify-cli deploy --build --prod
```

Or connect the GitHub repo in the dashboard — build command `npm run build`,
publish directory `dist`.

### Vercel

```bash
npx vercel --prod
```

`vercel.json` already pins the framework, build command, output directory and
headers, so the dashboard needs no configuration.

**Done when:** the site loads and a scan finds a brilliancy on a real account.

---

## 4. Verify the deployed site, not just the local build

```bash
curl -sI https://YOUR-DOMAIN | grep -i "content-security-policy\|x-content-type\|referrer-policy"
AUDIT_URL=https://YOUR-DOMAIN node scripts/net-audit.mjs
```

Then by hand, on a phone as well as a desktop:

- [ ] Search a username → profile, ratings and games load.
- [ ] Run a scan → the engine downloads once and the progress bar moves.
- [ ] A brilliancy renders with the move circled in red.
- [ ] "Share image" produces a PNG.
- [ ] Reload → the engine comes from cache, not the network (this is what the
      `immutable` cache headers are for; if it re-downloads 40 MB, they aren't
      being applied).

**Done when:** headers present, no third-party origins beyond chess.com, and the
second load is fast.

---

## 5. First-load weight — decide before you promote it

The app bundle is ~73 KB gzipped. The engine is **~40 MB**, and it is the entire
cost of the first visit. That is acceptable for a link you send to a friend and
punishing for a link that gets posted somewhere busy.

Options, in the order worth trying:

1. **Ship as-is.** The UI already warns "(~40 MB), then it's cached", and the
   engine only downloads when a scan is requested — not on page load.
2. **Swap to a lite NNUE build (~6 MB).** Six times cheaper for a small loss of
   playing strength that this application does not need. Re-run
   `scripts/test-harness.mjs` afterwards: the thresholds were calibrated at depth
   14 against *this* net.
3. **Move the net to object storage** (Cloudflare R2 + Pages) if bandwidth becomes
   the constraint. Remember to add that origin to `connect-src` in both header
   configs, or the CSP will block it.

---

## 6. After launch

- [ ] Watch for chess.com rate-limiting (HTTP 429). The app surfaces it, but a
      popular day could hit it — the fix is caching archives in `localStorage`,
      not hammering harder.
- [ ] Turn the five confirmed brilliancies into harness fixtures once you've
      checked which ones chess.com's Game Review actually stars.
- [ ] Re-run `npm audit` periodically. Production dependencies are currently
      clean; the outstanding advisories are all dev-only (see below).

---

## Known, accepted risks

**Dev-toolchain advisories.** `npm audit --omit=dev` reports **0 vulnerabilities**,
so nothing reaches visitors. `npm audit` (including dev) reports three, all in
Vite/esbuild/postcss and all exploitable only against a running dev server:
notably one where any website you visit can read your dev server's responses, and
a Windows-specific NTLMv2 hash disclosure. They matter to *you*, on this machine,
not to the deployed site. The fix is `vite@8`, a major upgrade — worth scheduling,
not worth blocking a release on. Until then, don't run `npm run dev` while
browsing untrusted sites.

**chess.com is trusted as a data source.** Every URL from their API is now
validated as http(s) before it reaches an `href` or `src`, and archive URLs must
point at their API host. The remaining trust is that their JSON is well-formed;
malformed PGNs are already caught and skipped per-game.
