/**
 * Measure the contrast of the text tokens and board marks in BOTH themes, in
 * the real app, against the ground each element actually sits on.
 *
 * This exists because contrast bugs here have twice been composition failures —
 * two individually-correct colour decisions meeting in the middle — and neither
 * was visible by reading the CSS or by looking at one theme. The `!!` was
 * invisible in dark mode for months; `--text-faint` was below AA on every
 * ground in both themes; the board coordinates measured 1.25:1.
 *
 * Prereq: the dev server must be running (npm run dev).
 */
import { chromium } from "playwright";

// Override to aim at a second dev server while 5173 is taken by a hand-driven
// one — vite picks 5174 for the second `npm run dev`. Default unchanged.
const BASE = process.env.BASE_URL || "http://localhost:5173/";
const AA = 4.5; // normal-size text
const AA_UI = 3.0; // non-text / large text

async function launch() {
  for (const channel of ["msedge", "chrome"]) {
    try { return await chromium.launch({ channel, headless: true }); } catch { /* next */ }
  }
  return await chromium.launch({ headless: true });
}

/** Walk up for the first non-transparent background — what the eye actually sees behind the text. */
const MEASURE = `(sel) => {
  const el = document.querySelector(sel);
  if (!el) return null;
  const parse = (c) => (c.match(/[\\d.]+/g) || []).slice(0, 3).map(Number);
  const lum = (rgb) => {
    const [r, g, b] = rgb.map((v) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const fg = parse(getComputedStyle(el).color);
  let node = el, bg = null;
  while (node) {
    const c = getComputedStyle(node).backgroundColor;
    if (c && !/rgba\\(0, 0, 0, 0\\)|transparent/.test(c)) { bg = parse(c); break; }
    node = node.parentElement;
  }
  if (!bg) bg = [255, 255, 255];
  const [hi, lo] = [lum(fg), lum(bg)].sort((a, b) => b - a);
  return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
}`;

// [selector, label, threshold]
const TARGETS = [
  [".hero-eyebrow", "hero eyebrow (--text-dim on --desk)", AA],
  [".scope-label", "picker 'Source' label (--text-faint)", AA],
  [".hero-lede", "hero lede", AA],
  [".footer-legal", "footer legal (--text-faint)", AA],
  [".mark-sub", "topbar sub (--text-dim on --desk)", AA],
];

const browser = await launch();
let failed = 0;

for (const theme of ["light", "dark"]) {
  const page = await browser.newPage({ colorScheme: theme, viewport: { width: 1280, height: 900 } });
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.waitForSelector(".board .piece");
  console.log(`\n${theme.toUpperCase()}`);
  for (const [sel, label, min] of TARGETS) {
    const r = await page.evaluate(new Function("sel", `return (${MEASURE})(sel)`), sel);
    if (r === null) { console.log(`  --    ${label} (not present)`); continue; }
    const ok = r >= min;
    if (!ok) failed++;
    console.log(`  ${ok ? "ok  " : "FAIL"} ${r.toFixed(2).padStart(5)} (needs ${min})  ${label}`);
  }
  await page.close();
}

const p = await browser.newPage({ colorScheme: "dark" });
await p.goto(BASE, { waitUntil: "domcontentloaded" });

/**
 * Board coordinates are measured from the TOKENS, not from a rendered .sq-coord.
 * The hero and gallery boards pass coords={false}, so a selector-based check
 * finds no element and reports "not present" — which reads like a pass and is
 * how a 1.25:1 coordinate could survive a green run. The ink is a single pinned
 * value now, so token arithmetic is exact and needs no viewer.
 */
const coord = await p.evaluate(() => {
  const s = getComputedStyle(document.documentElement);
  const hex = (h) => {
    const n = parseInt(h.trim().replace("#", ""), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  };
  const lum = (rgb) => {
    const [r, g, b] = rgb.map((v) => {
      const x = v / 255;
      return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const ratio = (a, b) => {
    const [hi, lo] = [lum(hex(a)), lum(hex(b))].sort((x, y) => y - x);
    return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
  };
  const ink = s.getPropertyValue("--board-coord");
  return {
    onLight: ratio(ink, s.getPropertyValue("--sq-light")),
    onDark: ratio(ink, s.getPropertyValue("--sq-dark")),
  };
});
for (const [k, v] of Object.entries(coord)) {
  const ok = v >= AA;
  if (!ok) failed++;
  console.log(`\n  ${ok ? "ok  " : "FAIL"} ${v.toFixed(2)} (needs ${AA})  board coordinate ${k}`);
}

// The two dark-theme reds must not be the same ink: red is the annotator's pen
// and marks the !! alone, so an error box sharing its hex breaks that rule.
const [mark, bad] = await p.evaluate(() => {
  const s = getComputedStyle(document.documentElement);
  return [s.getPropertyValue("--mark").trim(), s.getPropertyValue("--bad").trim()];
});
const distinct = mark.toLowerCase() !== bad.toLowerCase();
if (!distinct) failed++;
console.log(`\n${distinct ? "  ok  " : " FAIL "} dark --mark (${mark}) is distinct from --bad (${bad})`);

await browser.close();
console.log(failed === 0 ? "\nCONTRAST OK\n" : `\n${failed} CONTRAST FAILURE(S)\n`);
process.exit(failed === 0 ? 0 : 1);
