/**
 * The static-hero invariant, both directions:
 *   JS on  -> exactly one <h1>, and no leftover static-only headings (otherwise
 *             the page shows its contents twice)
 *   JS off -> the crawler's copy is present inside #root
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
const words = (await on.locator("body").innerText()).split(/\s+/).filter(Boolean).length;
check(words > 80, "JS on: app actually rendered", `${words} words`);

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

await browser.close();
console.log(bad === 0 ? "\nSTATIC OK\n" : `\n${bad} FAILED\n`);
process.exit(bad === 0 ? 0 : 1);
