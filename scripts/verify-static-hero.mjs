/**
 * The static-hero invariant, all four parts:
 *   JS on  -> exactly one <h1>, and no leftover static-only headings (otherwise
 *             the page shows its contents twice)
 *   JS off -> the crawler's copy is present inside #root
 *   both   -> the lines that exist verbatim in BOTH copies still say the same
 *             thing, so Google is not served different words from the ones
 *             visitors read
 *   dist   -> and the same is true of the HTML the build emits, not just the
 *             one the dev server serves
 */
import { stat } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { serveDist } from "./lib/serve-dist.mjs";

// Override to aim at a second dev server while 5173 is taken by a hand-driven
// one — vite picks 5174 for the second `npm run dev`. Default unchanged.
const BASE = process.env.BASE_URL || "http://localhost:5173/";

const here = dirname(fileURLToPath(import.meta.url));
const SRC_HTML = join(here, "..", "index.html");
const DIST_HTML = join(here, "..", "dist", "index.html");

/**
 * The headings that exist ONLY in the static crawler copy inside #root. React
 * must replace all of them; if one is still on screen with JS on, the page is
 * showing its contents twice. Prefix match, so copy edits don't break the test
 * on a trailing word.
 */
const STATIC_H2 = [
  "What is a brilliant move",
  "How Brilliancy finds them",
  "Is this the same as chess.com",
];

/**
 * The lines that are DUPLICATED VERBATIM between index.html and App.tsx, and so
 * are the ones that can silently drift apart. A small named set, not the whole
 * document: the two copies are deliberately different lengths — the static lede
 * is SEO prose and the rendered lede is a shorter sell — so demanding the whole
 * hero match would be red forever and get ignored, which is worse than no gate.
 *
 * The h1 matters most. Its visible half is a glyph, so every word Google has to
 * rank the page on lives in the .sr-only span, and there is nothing on screen
 * that would look wrong if the two copies of that span diverged.
 */
const SHARED_COPY = [
  { label: "the h1 (incl. its .sr-only span)", selector: "h1" },
  { label: "the hero eyebrow", selector: ".hero-eyebrow" },
];

/**
 * What the static lede SELLS. Equality is impossible here — that paragraph is
 * intentionally written twice, longer for the crawler — so instead: anything the
 * crawler's copy promises has to be a thing the rendered app still mentions.
 * Drop Lichess from the app and the static copy is left advertising it to
 * Google; that is the drift this catches. Lowercased before comparing.
 */
const SOLD_TERMS = ["chess.com", "lichess", "brilliant moves", "sound sacrifices", "chess engine"];

/** Rendering puts newlines around the absolutely-positioned .sr-only span with
 *  CSS loaded and not without it, so whitespace can never be part of a match. */
const norm = (s) => s.replace(/\s+/g, " ").trim();

/**
 * Case is STYLING here, not copy: .hero-eyebrow is `text-transform: uppercase`,
 * so the rendered eyebrow reads SOUND SACRIFICES while the file says Sound
 * sacrifices. index.css never loads for the static copy, so a case-sensitive
 * compare is red on the very first run for a difference no reader can see —
 * a gate that fails for a non-reason is one people learn to skip.
 *
 * innerText, not textContent, for the same "what does a reader get" reason: the
 * two <span>s in the h1 have no whitespace between them in App.tsx and a newline
 * between them in index.html, and only layout resolves that to one space.
 *
 * The dist checks at the bottom need this MORE, not less, and for the opposite
 * reason: vite injects a <link rel=stylesheet> into the built index.html, so with
 * JS off the shipped static copy DOES get index.css and the eyebrow comes back
 * SHOUTED where the dev server's comes back in sentence case. Same words, and
 * that difference is why the two log lines look like they disagree.
 */
const sameCopy = (a, b) => a.toLowerCase() === b.toLowerCase();

async function launch() {
  for (const channel of ["msedge", "chrome"]) {
    try { return await chromium.launch({ channel, headless: true }); } catch { /* next */ }
  }
  return await chromium.launch({ headless: true });
}
const browser = await launch();
let bad = 0;
const check = (ok, label, detail = "") => {
  console.log(`${ok ? "  ok  " : " FAIL "} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) bad++;
};

// --- JS ON ---
const on = await browser.newPage();
await on.goto(BASE, { waitUntil: "networkidle" });
await on.waitForSelector(".board .piece");
const h1s = await on.locator("h1").allInnerTexts();
check(h1s.length === 1, "JS on: exactly one <h1>", `${h1s.length}: ${JSON.stringify(h1s)}`);

/**
 * The h1 count alone is NOT enough, and believing it was is how this script
 * overclaimed. index.html carries three <h2> Q&A sections inside #root. The
 * tempting fix for their SEO problem — move that prose OUTSIDE #root so React
 * cannot wipe it — leaves the h1 count at exactly 1, passes an h1-only check,
 * and permanently duplicates three headings and ~400 words on the live page.
 * So count the headings React is supposed to have replaced.
 */
const h2s = await on.locator("h2").allInnerTexts();
const staticOnly = h2s.filter((t) => STATIC_H2.some((s) => t.trim().startsWith(s)));
check(
  staticOnly.length === 0,
  "JS on: no static-only <h2> survived hydration",
  staticOnly.length ? JSON.stringify(staticOnly) : "none",
);

// Asserted, not just printed: a silent loss of the rendered hero would
// otherwise pass every check above.
const onBody = await on.locator("body").innerText();
const words = onBody.split(/\s+/).filter(Boolean).length;
check(words > 80, "JS on: app actually rendered", `${words} words`);

// Kept for the drift comparison below, which needs both renders side by side.
const onCopy = new Map();
for (const { selector } of SHARED_COPY) {
  onCopy.set(selector, norm(await on.locator(selector).first().innerText().catch(() => "")));
}

// --- JS OFF ---
const ctx = await browser.newContext({ javaScriptEnabled: false });
const off = await ctx.newPage();
await off.goto(BASE, { waitUntil: "domcontentloaded" });
const rootText = await off.locator("#root").innerText().catch(() => "");
const offWords = rootText.trim().split(/\s+/).filter(Boolean).length;
check(offWords > 200, "JS off: static copy present inside #root", `${offWords} words`);
// Word count alone would survive the prose being replaced by 200 words of
// anything, so pin the actual sections the SEO pass was written for.
const missing = STATIC_H2.filter((s) => !rootText.includes(s));
check(missing.length === 0, "JS off: all three Q&A sections present", missing.join(" | ") || "all present");
const offH1 = await off.locator("h1").count();
check(offH1 === 1, "JS off: exactly one <h1>", `${offH1}`);

/**
 * --- BOTH: the two copies still agree ---
 *
 * The hero exists twice on purpose (see the comment above #root in index.html)
 * and the two checks above test the two DIRECTIONS without ever comparing the
 * words. So editing the headline in one file and not the other passed every
 * check while serving the crawler a different promise from the visitor's.
 */
for (const { label, selector } of SHARED_COPY) {
  const offCopy = norm(await off.locator(selector).first().innerText().catch(() => ""));
  const onText = onCopy.get(selector);
  const agree = offCopy !== "" && sameCopy(offCopy, onText);
  check(
    agree,
    `both: ${label} is word-for-word identical`,
    agree ? JSON.stringify(offCopy) : `static ${JSON.stringify(offCopy)} vs rendered ${JSON.stringify(onText)}`,
  );
}

const onLower = norm(onBody).toLowerCase();
const unsold = SOLD_TERMS.filter((t) => !onLower.includes(t));
check(
  unsold.length === 0,
  "both: everything the static copy sells is still in the app",
  unsold.length ? `rendered page never mentions: ${unsold.join(", ")}` : SOLD_TERMS.join(", "),
);
// The same terms have to be in the crawler's copy too, or the check above is
// asserting nothing about the file it is meant to be guarding.
const offLower = norm(rootText).toLowerCase();
const unstated = SOLD_TERMS.filter((t) => !offLower.includes(t));
check(
  unstated.length === 0,
  "both: ...and the static copy still says it",
  unstated.length ? `static copy never mentions: ${unstated.join(", ")}` : SOLD_TERMS.join(", "),
);

/**
 * --- dist: AND THE SAME IS TRUE OF WHAT ACTUALLY SHIPS ---
 *
 * Everything above reads the dev server. `npm run build` is a gate too, but all
 * it proves is that the build exits 0 — until this block, no gate read a single
 * byte of dist/. That matters HERE more than anywhere else, because vite rewrites
 * index.html on every build: it swaps the module script's src, and its html
 * transform is free to touch the rest of the document. The gate whose entire job
 * is noticing that the crawler's copy drifted from the visitor's could not see
 * the build eating that copy. Verified by hand before this was written: blanking
 * the eyebrow in dist/index.html left every check above green.
 *
 * JS OFF only, and deliberately.
 *   - The build's effect on the STATIC copy is the whole exposure. The rendered
 *     copy comes out of App.tsx via the bundle, and vite does not rewrite string
 *     literals in JSX — so `onCopy`, captured from the dev server above, is the
 *     same rendered copy dist would produce, and comparing dist's static half
 *     against it is the comparison that can actually catch drift.
 *   - A JS-on load of dist means booting the WASM engine, which is ~10s of gate
 *     time to re-prove something csp-check.mjs already proves under the STRICTER
 *     production CSP.
 *
 * No CSP on this server either: a build that failed to hydrate under the real
 * policy would fail this gate wearing a copy-drift label, which is exactly the
 * red-for-a-non-reason problem the comments above keep steering around.
 * csp-check.mjs owns the policy question.
 */
const [distStat, srcStat] = await Promise.all([
  stat(DIST_HTML).catch(() => null),
  stat(SRC_HTML).catch(() => null),
]);
/**
 * Skipped rather than failed when dist/ is missing or predates index.html. In
 * the agent's gate suite `npm run build` runs immediately before this script, so
 * it is always fresh there and the block always runs; a human who ran `npm run
 * dev` and nothing else should not get a red gate for a build they never asked
 * for. The skip prints, so it cannot pass for a check that ran.
 */
if (!distStat || !srcStat || distStat.mtimeMs < srcStat.mtimeMs) {
  console.log(
    ` skip  dist: ${distStat ? "dist/index.html is older than index.html" : "no dist/index.html"}` +
      " — run `npm run build` to include the shipped HTML",
  );
} else {
  const distServer = await serveDist();
  const distBase = `http://localhost:${distServer.address().port}/`;
  const distCtx = await browser.newContext({ javaScriptEnabled: false });
  const distPage = await distCtx.newPage();
  await distPage.goto(distBase, { waitUntil: "domcontentloaded" });

  const distRoot = await distPage.locator("#root").innerText().catch(() => "");
  const distMissing = STATIC_H2.filter((s) => !distRoot.includes(s));
  check(
    distMissing.length === 0,
    "dist: all three Q&A sections survived the build",
    distMissing.join(" | ") || "all present",
  );

  for (const { label, selector } of SHARED_COPY) {
    const built = norm(await distPage.locator(selector).first().innerText().catch(() => ""));
    const rendered = onCopy.get(selector);
    const agree = built !== "" && sameCopy(built, rendered);
    check(
      agree,
      `dist: ${label} is word-for-word identical`,
      agree ? JSON.stringify(built) : `built ${JSON.stringify(built)} vs rendered ${JSON.stringify(rendered)}`,
    );
  }

  const distLower = norm(distRoot).toLowerCase();
  const distUnstated = SOLD_TERMS.filter((t) => !distLower.includes(t));
  check(
    distUnstated.length === 0,
    "dist: ...and the shipped copy still sells it",
    distUnstated.length ? `shipped copy never mentions: ${distUnstated.join(", ")}` : SOLD_TERMS.join(", "),
  );

  /**
   * The one thing worth asserting about the bundle from here: index.html's
   * rewritten <script src> has to point at a file that exists. The filename is
   * content-hashed, so it changes every build, and a stale or half-written dist
   * ships an HTML file whose entry module 404s — a blank page that typecheck,
   * build and every check above are all happy with.
   */
  const entry = await distPage.locator('script[type="module"]').first().getAttribute("src").catch(() => null);
  const entryRes = entry ? await distPage.request.get(new URL(entry, distBase).href) : null;
  check(
    entryRes?.ok() === true,
    "dist: the entry bundle it points at is really there",
    entry ? `${entry} -> ${entryRes ? entryRes.status() : "no response"}` : "no module script in dist/index.html",
  );

  await distCtx.close();
  distServer.close();
}

await browser.close();
console.log(bad === 0 ? "\nSTATIC OK\n" : `\n${bad} FAILED\n`);
process.exit(bad === 0 ? 0 : 1);
