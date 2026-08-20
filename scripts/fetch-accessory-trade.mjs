/**
 * Which accessories can actually be bought.
 *
 * The items resource is unreliable here: it leaves can_trade, can_auction and soulbound unset on
 * plenty of things that cannot be traded at all, so everything defaults to buyable and the cost
 * to finish the bag absorbs items nobody can sell you. Rift accessories are the worst of it —
 * Crux Chronomicon and Celestial Starstone were being priced at two billion each.
 *
 * The wiki infobox states it outright as `auctionable`/`tradeable`, so that is what this reads.
 * Titles are batched fifty at a time, which is the API's limit for a multi-page fetch.
 */
import { writeFile, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WIKI = "https://hypixel-skyblock.fandom.com/api.php";
const UA = { "User-Agent": "skyblock-xp-planner/0.1 (data build script)" };

const accessories = JSON.parse(await readFile(join(ROOT, "data/generated/accessories.json"), "utf8")).accessories;
const titles = accessories.map((a) => a.name);

/** Infobox flags are y/n/yes/no; anything else is left undecided rather than guessed. */
function flagOf(wikitext, field) {
  // Split on the infobox's own separator rather than pattern-matching: the fields are one per
  // "| name = value" and a plain scan is easier to trust than an escaped regex.
  for (const part of (wikitext ?? "").split("|")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim().toLowerCase() !== field) continue;
    const value = part.slice(eq + 1).split("\n")[0].trim().toLowerCase();
    if (value === "y" || value === "yes" || value === "true") return true;
    if (value === "n" || value === "no" || value === "false") return false;
    return null;
  }
  return null;
}

const byName = new Map();
for (let i = 0; i < titles.length; i += 50) {
  const batch = titles.slice(i, i + 50);
  const url = `${WIKI}?action=query&prop=revisions&rvprop=content&rvslots=main&format=json&titles=${batch
    .map(encodeURIComponent)
    .join("|")}`;
  const body = await fetch(url, { headers: UA }).then((r) => r.json());
  for (const page of Object.values(body.query?.pages ?? {})) {
    const text = page.revisions?.[0]?.slots?.main?.["*"];
    if (!text) continue;
    byName.set(page.title, {
      auctionable: flagOf(text, "auctionable"),
      tradeable: flagOf(text, "tradeable"),
      sellable: flagOf(text, "sellable"),
    });
  }
  process.stdout.write(`\r  ${Math.min(i + 50, titles.length)}/${titles.length}`);
}
process.stdout.write("\n");

const out = [];
let untradeable = 0;
for (const acc of accessories) {
  const flags = byName.get(acc.name);
  if (!flags) continue;
  // Only a stated "no" overrides. A page that doesn't say is left to the items resource.
  const buyable = flags.auctionable ?? flags.tradeable;
  if (buyable === false) {
    untradeable++;
    out.push({ id: acc.id, name: acc.name, buyable: false });
  }
}

await writeFile(
  join(ROOT, "data/generated/accessory_trade.json"),
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      source: "Hypixel SkyBlock Fandom wiki infobox: auctionable / tradeable",
      note: "Accessories the wiki states cannot be bought. Only an explicit no is recorded; silence defers to the items resource.",
      pagesRead: byName.size,
      untradeable: out,
    },
    null,
    1,
  ) + "\n",
);
console.log(`  read ${byName.size} pages, ${untradeable} accessories the wiki says cannot be bought`);
