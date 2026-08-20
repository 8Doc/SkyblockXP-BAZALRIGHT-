/**
 * A rarity for the accessories the items resource ships without one.
 *
 * Magical power is a function of rarity and nothing else, so an accessory with no rarity has no
 * defined magical power and gets dropped from the model entirely. Eighteen are in that state,
 * and dropping them is expensive twice over: the bag cannot credit one the player is wearing, so
 * `computed MP` reads low; and the family it anchors looks empty, so the planner offers a tier
 * the player has already upgraded past. A real maxed profile was holding six of them —
 * Dante's Ring among them — and being offered Dante's Talisman as missing XP.
 *
 * `impliedTier` used to guess COMMON for anything named "... Talisman", which is a guess that
 * happens to be right and covers only the Talisman step. This reads the rarity off the wiki
 * infobox instead, which states it for every accessory that has a page.
 *
 * Driven from the items resource rather than from accessories.json, because the accessories this
 * is for are exactly the ones accessories.json has already dropped.
 */
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WIKI = "https://hypixel-skyblock.fandom.com/api.php";
const BASE = "https://api.hypixel.net/v2/resources/skyblock";
const UA = { "User-Agent": "skyblock-xp-planner/0.1 (data build script)" };

/** The infobox writes rarity as a letter, a word, or a word in any case. All three appear. */
const RARITY = {
  c: "COMMON", common: "COMMON",
  u: "UNCOMMON", uncommon: "UNCOMMON",
  r: "RARE", rare: "RARE",
  e: "EPIC", epic: "EPIC",
  l: "LEGENDARY", legendary: "LEGENDARY",
  m: "MYTHIC", mythic: "MYTHIC",
  s: "SPECIAL", special: "SPECIAL",
  vs: "VERY_SPECIAL", "very special": "VERY_SPECIAL",
};

function fieldOf(wikitext, field) {
  for (const part of (wikitext ?? "").split("|")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim().toLowerCase() !== field) continue;
    return part.slice(eq + 1).split("\n")[0].trim();
  }
  return null;
}

const { items } = await fetch(`${BASE}/items`, { headers: UA }).then((r) => r.json());
const untiered = items.filter((i) => i.category === "ACCESSORY" && !i.tier);
console.log(`  ${untiered.length} accessories ship without a rarity`);

const byName = new Map(untiered.map((i) => [i.name, i]));
const titles = [...byName.keys()];
const found = [];
const missing = [];

for (let i = 0; i < titles.length; i += 50) {
  const batch = titles.slice(i, i + 50);
  const url = `${WIKI}?action=query&prop=revisions&rvprop=content&rvslots=main&redirects=1&format=json&titles=${batch
    .map(encodeURIComponent)
    .join("|")}`;
  const body = await fetch(url, { headers: UA }).then((r) => r.json());
  // A redirect means the title we asked for is not the title we got back, so results are keyed
  // by the id the infobox states rather than by the page name.
  for (const page of Object.values(body.query?.pages ?? {})) {
    const text = page.revisions?.[0]?.slots?.main?.["*"];
    if (!text) continue;
    const stated = fieldOf(text, "id");
    const item = (stated && untiered.find((u) => u.id === stated.toUpperCase())) ?? byName.get(page.title);
    if (!item) continue;
    // Splitting the infobox on "|" tears a templated value in half — "rarity = {{R|l}}" arrives
    // as "{{R". Those are re-read off the raw text, which is how the Runebook gets its legendary.
    const raw = fieldOf(text, "rarity");
    const templated = /\|\s*rarity\s*=\s*\{\{\s*R\s*\|\s*([a-z ]+?)\s*\}\}/i.exec(text)?.[1];
    const statedRarity = raw && !raw.startsWith("{{") ? raw : (templated ?? null);
    const rarity = statedRarity ? RARITY[statedRarity.toLowerCase()] : null;
    // A rarity written as a template ("{{R|c}}" split across the infobox) is left alone rather
    // than half-parsed into a wrong answer.
    if (!rarity) continue;
    found.push({ id: item.id, name: item.name, rarity, page: page.title });
  }
  process.stdout.write(`\r  ${Math.min(i + 50, titles.length)}/${titles.length}`);
}
process.stdout.write("\n");

const got = new Set(found.map((f) => f.id));
for (const item of untiered) if (!got.has(item.id)) missing.push({ id: item.id, name: item.name });
found.sort((a, b) => a.id.localeCompare(b.id));
missing.sort((a, b) => a.id.localeCompare(b.id));

await writeFile(
  join(ROOT, "data/generated/accessory_rarity.json"),
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      source: "Hypixel SkyBlock Fandom wiki infobox: rarity",
      note: "Rarity for accessories the items resource ships without one. Magical power is a function of rarity, so without this they have no defined magical power and are dropped from the model — uncreditable when worn, and leaving their family looking empty.",
      consequence:
        "A wrong rarity mis-prices an accessory's magical power in both the bag total and the task. Anything the wiki does not state plainly is left in `missing` and stays dropped, rather than guessed at.",
      rarities: found,
      missing,
    },
    null,
    1,
  ) + "\n",
);
console.log(`  ${found.length} rarities read, ${missing.length} still without one`);
