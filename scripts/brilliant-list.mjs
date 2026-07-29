/**
 * Scrape chess.com's all-time Brilliant Moves list for one or more accounts.
 *
 * This is the label source the whole project now rests on. chess.com publishes,
 * per member, every brilliancy they have ever played — as a board linking to
 * `/analysis/game/live/<id>?move=<ply>`, so it gives the GAME and the MOVE rather
 * than a count. Combined with the public archive API it yields complete labels:
 * the listed moves are positives, and every other candidate in a covered game is
 * a confirmed negative.
 *
 * THE PAGE IS PUBLIC. Verified logged out: 200, boards render, "Log In" in the
 * header. Reading it needs no session and no credentials — which is why this is a
 * plain Playwright script and not something driven through a signed-in browser.
 * (Diamond is needed to see the feature on your OWN profile page, not to read
 * someone's.)
 *
 * PREMIUM ACCOUNTS ONLY. The list is built from chess.com's Advanced Stats, which
 * is a paid feature, and it simply does not exist for a free account — the page
 * falls back to a generic "All Stats" view with no Brilliant Moves section at all.
 * Verified across ten accounts with a perfect split: every account that rendered
 * a list is `status: premium` in the public API, every one that didn't is `basic`.
 * So this script checks membership first (one free API call) rather than loading a
 * page that cannot work. Anyone can READ a premium member's list; the member has
 * to be paying for it to exist.
 *
 * A premium account with no section is reported as unusable rather than as zero.
 * The two are indistinguishable from outside — Advanced Stats takes up to 24h to
 * compute on a fresh subscription — and treating "not computed yet" as "no
 * brilliancies" would manufacture false negatives out of every game they played.
 *
 * SCOPE, and it is not optional to respect: the list covers RATED games only.
 * Two brilliancies confirmed in full Game Review are absent from LouisMcdade's
 * list and both of those games are unrated. Downstream code must therefore label
 * negatives from rated games alone; an unrated game's absence here means nothing.
 *
 * DAILY GAMES ARE INDEXED — evidenced, not assumed. An earlier pass excluded them
 * because nothing on the page said either way, and a wrong negative is the most
 * expensive label there is. Then apesquared's list came back 28 live and 10
 * daily, with links like `/analysis/game/daily/908663389?move=58`. Correspondence
 * is a large share of some accounts' brilliancies, so excluding it was discarding
 * roughly a third of the positives on offer. Both kinds are kept, tagged.
 *
 * Note the reporting trap this exposed: the run before this one printed
 * "8 live moves (page says 218) COMPLETE", which reads as a contradiction and was
 * not one — 218 entries really had loaded, 210 of them daily. The completeness
 * flag was right and the number beside it was measuring something else.
 *
 * WHEN THE COUNT DOESN'T RECONCILE, ASSUME THE WORST. Some accounts render every
 * entry (218/218, 67/67, 23/23, 47/47); others stop short at the same number no
 * matter how long you scroll (63/127, 25/82). So the shortfall is probably not a
 * scroll that gave up — more likely the headline counts brilliancies the page
 * cannot link to, in unrated games or variants. We cannot tell from outside, and
 * the difference matters: if entries are missing, an unlisted game is not a
 * negative, and neither is an unlisted MOVE inside a listed game. Either way such
 * a list is marked incomplete and downstream code must use it for positives only.
 *
 * INFINITE SCROLL. Roughly 12 entries load at a time. `--max-scrolls` caps it;
 * the script stops early when the count stops growing, and reports whether it got
 * everything by comparing against the total the page prints. A partial list is
 * still usable for POSITIVES but ruins negatives-by-exclusion, so partial results
 * are written with `complete: false` and downstream code must check it.
 *
 *   node scripts/brilliant-list.mjs louismcdade
 *   node scripts/brilliant-list.mjs user1 user2 user3 --max-scrolls 40
 */
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { getJson, plyToMove } from "./lib/chesscom.mjs";

const args = process.argv.slice(2);
const maxIdx = args.indexOf("--max-scrolls");
const MAX_SCROLLS = maxIdx >= 0 ? Number(args[maxIdx + 1]) : 60;
// Guard the -1 case: without --max-scrolls, `maxIdx + 1` is 0 and would silently
// eat the first username.
const users = args.filter((a, i) => !a.startsWith("--") && !(maxIdx >= 0 && i === maxIdx + 1));
if (!users.length) {
  console.error("usage: node scripts/brilliant-list.mjs <user> [<user>…] [--max-scrolls N]");
  process.exit(1);
}

const OUT_DIR = "scripts/brilliant-lists";
mkdirSync(OUT_DIR, { recursive: true });

async function launch() {
  for (const channel of ["msedge", "chrome"]) {
    try {
      return await chromium.launch({ channel, headless: true });
    } catch {
      /* next */
    }
  }
  return chromium.launch({ headless: true });
}

const browser = await launch();

for (const user of users) {
  // Free API call, and it saves a page load that could only ever fail.
  try {
    const profile = await getJson(`https://api.chess.com/pub/player/${encodeURIComponent(user)}`);
    if (profile.status === "basic") {
      console.log(`${user.padEnd(20)}     — basic account, Advanced Stats does not exist for it`);
      continue;
    }
  } catch (e) {
    console.error(`${user}: profile lookup failed — ${String(e).split(/\r?\n/)[0]}`);
    continue;
  }

  const page = await browser.newPage();
  try {
    await page.goto(`https://www.chess.com/member/${encodeURIComponent(user)}/stats/all-brilliant-moves?time=0`, {
      // networkidle never settles on this page — chess.com polls in the
      // background — so wait on the content instead of on the network.
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
    await page.waitForTimeout(4000);

    const read = () =>
      page.evaluate(() => {
        const links = [...document.querySelectorAll('a[href*="/analysis/game/"]')].map((a) => {
          const u = new URL(a.href);
          const parts = u.pathname.split("/");
          return { id: parts[parts.length - 1], kind: parts[parts.length - 2], ply: Number(u.searchParams.get("move")) };
        });
        // The headline number beside "Brilliant Moves" is the total the account
        // has; it is how we know whether the scroll finished.
        const m = document.body.innerText.match(/Brilliant Moves\s+([\d,]+)/);
        return { links, total: m ? Number(m[1].replace(/,/g, "")) : null };
      });

    // Tolerate stalls. Breaking on the first iteration that adds nothing gave up
    // early on two accounts (63 of 127, 25 of 82) — a slow batch is not the end of
    // the list. Wait longer each time and only quit after several dead rounds.
    let state = await read();
    let stalls = 0;
    for (let i = 0; i < MAX_SCROLLS; i++) {
      const prev = state.links.length;
      await page.mouse.wheel(0, 20000);
      await page.waitForTimeout(1200 + stalls * 1500);
      state = await read();
      if (state.total !== null && state.links.length >= state.total) break;
      stalls = state.links.length > prev ? 0 : stalls + 1;
      if (stalls >= 4) break;
    }

    const seen = new Set();
    const moves = [];
    for (const l of state.links) {
      if ((l.kind !== "live" && l.kind !== "daily") || !Number.isInteger(l.ply)) continue;
      const key = `${l.id}:${l.ply}`;
      if (seen.has(key)) continue;
      seen.add(key);
      moves.push({ id: l.id, kind: l.kind, ply: l.ply, ...plyToMove(l.ply) });
    }

    // No headline number means the Brilliant Moves section never rendered. On a
    // premium account that is either "none yet" or "not computed yet", and those
    // are indistinguishable from out here — so it is unusable, not zero.
    const rendered = state.total !== null;
    const complete = rendered && state.links.length >= state.total;
    const out = {
      user,
      scrapedAt: new Date().toISOString(),
      rendered,
      total: state.total,
      scraped: state.links.length,
      complete,
      moves,
    };
    writeFileSync(`${OUT_DIR}/${user.toLowerCase()}.json`, JSON.stringify(out, null, 1));
    const verdict = !rendered
      ? "⚠ no Brilliant Moves section — unusable (none yet, or not computed yet)"
      : complete
        ? "COMPLETE"
        : "⚠ PARTIAL — positives only, negatives unusable";
    const live = moves.filter((m) => m.kind === "live").length;
    console.log(
      `${user.padEnd(20)} ${String(moves.length).padStart(5)} moves (${live} live, ${moves.length - live} daily)` +
        ` of ${state.total ?? "?"}  ${verdict}`,
    );
  } catch (e) {
    console.error(`${user}: ${String(e).split(/\r?\n/)[0]}`);
  } finally {
    await page.close();
  }
}

await browser.close();
