/**
 * The static-hero invariant, all three parts:
 *   JS on  -> exactly one <h1>, and no leftover static-only headings (otherwise
 *             the page shows its contents twice)
 *   JS off -> the crawler's copy is present inside #root
 *   both   -> the lines that exist verbatim in BOTH copies still say the same
 *             thing, so Google is not served different words from the ones
 *             visitors read
 */
import { chromium } from "playwright";

// Override to aim at a second dev server while 5173 is taken by a hand-driven
// one — vite picks 5174 for the second `npm run dev`. Default unchanged.
const BASE = process.env.BASE_URL || "http://localhost:5173/";

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

await browser.close();
console.log(bad === 0 ? "\nSTATIC OK\n" : `\n${bad} FAILED\n`);
process.exit(bad === 0 ? 0 : 1);
