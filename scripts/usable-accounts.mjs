/**
 * Print the accounts whose scraped brilliancy list can license NEGATIVES.
 *
 * Two filters, both load-bearing:
 *
 *   complete   the page rendered every entry it claims to have. An incomplete
 *              list cannot mark anything negative — not an unlisted game, and not
 *              an unlisted move inside a listed game.
 *   enough     at least a few brilliancies, or the account contributes a random
 *              sample and no positives, which costs engine time to learn nothing
 *              about recall.
 *
 * Accounts whose list did not render at all are silently absent: on a premium
 * account that means either "none yet" or "Advanced Stats has not finished
 * computing", and those are indistinguishable from outside.
 *
 *   node scripts/usable-accounts.mjs [--min-moves 4]
 */
import { readdirSync, readFileSync } from "node:fs";

const i = process.argv.indexOf("--min-moves");
const MIN_MOVES = i >= 0 ? Number(process.argv[i + 1]) : 4;
const DIR = "scripts/brilliant-lists";

const usable = [];
const skipped = { partial: 0, empty: 0, thin: 0 };
for (const file of readdirSync(DIR).filter((f) => f.endsWith(".json"))) {
  const list = JSON.parse(readFileSync(`${DIR}/${file}`, "utf8"));
  // Older list files predate the `rendered` field. For those, a non-null total
  // is the same evidence — the headline count only exists if the section drew.
  // Without this, every pre-field account (louismcdade included) reads as "no
  // section" and silently drops out of the harvest, which is exactly what
  // happened on the first expansion run.
  const rendered = list.rendered ?? list.total !== null;
  if (!rendered) skipped.empty++;
  else if (!list.complete) skipped.partial++;
  else if (list.moves.length < MIN_MOVES) skipped.thin++;
  else usable.push(list.user);
}

console.error(
  `${usable.length} usable · skipped ${skipped.empty} with no section, ` +
    `${skipped.partial} incomplete, ${skipped.thin} with <${MIN_MOVES} moves`,
);
console.log(usable.join(" "));
