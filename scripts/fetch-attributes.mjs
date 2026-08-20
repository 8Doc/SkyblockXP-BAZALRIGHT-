/**
 * Every attribute in the game, with the shard that feeds it.
 *
 * The old source was the Fandom wiki's rendered rarity tables, which document 181 attributes.
 * The game has 320 — exactly the number of SHARD_* products on the bazaar — so a third of the
 * category was invisible and the ceiling read 1,810 XP against a real 3,200.
 *
 * The community wiki the editors moved to carries the full list as template calls, one per
 * attribute, with the shard and the rarity stated outright:
 *
 *     {{Attribute Table Entry | id = C1 | shard = Grove | attribute = Nature Elemental ...
 *
 * Rarity matters beyond labelling: it selects the shard ladder, and a rarer attribute maxes on
 * far fewer shards.
 */
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WIKI = "https://hypixelskyblock.minecraft.wiki/api.php";
const UA = { "User-Agent": "skyblock-xp-planner/0.1 (data build script)" };
const RARITIES = ["Common", "Uncommon", "Rare", "Epic", "Legendary"];

/** Template fields are one per line as "| name = value", so this needs no pattern. */
function field(block, name) {
  for (const line of block.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("|")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    if (trimmed.slice(1, eq).trim().toLowerCase() !== name) continue;
    return trimmed.slice(eq + 1).trim() || null;
  }
  return null;
}

/** "Essence of the Forest" -> "essence_of_the_forest", matching how progress is keyed. */
const attributeKey = (name) =>
  name
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();

console.log("fetching the bazaar to see which shards actually trade…");
const bazaar = await fetch("https://api.hypixel.net/v2/skyblock/bazaar").then((r) => r.json());
const traded = new Set(Object.keys(bazaar.products ?? {}));
// The wiki writes the shard's display name and the bazaar writes its id, and the two disagree
// on where the word breaks: "End Stone Protector" against SHARD_ENDSTONE_PROTECTOR. Comparing
// letters only settles it without a table of exceptions.
const letters = (id) => id.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
const byLetters = new Map([...traded].map((id) => [letters(id), id]));

const attributes = [];
const seen = new Set();
let noShard = 0;

for (const rarity of RARITIES) {
  const url = `${WIKI}?action=parse&page=${encodeURIComponent(`Attributes/List/${rarity}`)}&format=json&prop=wikitext`;
  const body = await fetch(url, { headers: UA }).then((r) => r.json());
  if (body.error) {
    console.log(`  ${rarity.padEnd(10)} (no page)`);
    continue;
  }

  const blocks = body.parse.wikitext["*"].split("{{Attribute Table Entry").slice(1);
  let found = 0;
  for (const block of blocks) {
    const name = field(block, "attribute");
    const shard = field(block, "shard");
    if (!name || !shard) continue;

    const key = attributeKey(name);
    if (seen.has(key)) continue;
    seen.add(key);

    // "Grove" is the shard's own name; the item is "Grove Shard" and the id SHARD_GROVE.
    const derived = `SHARD_${shard.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`;
    const shardId = traded.has(derived) ? derived : (byLetters.get(letters(derived)) ?? derived);
    if (!traded.has(shardId)) noShard++;

    attributes.push({
      key,
      name,
      rarity: rarity.toUpperCase(),
      shardName: `${shard} Shard`,
      shardId,
      tradeable: traded.has(shardId),
    });
    found++;
  }
  console.log(`  ${rarity.padEnd(10)} ${found} attributes`);
}

attributes.sort((a, b) => a.key.localeCompare(b.key));
await writeFile(
  join(ROOT, "data", "generated", "attributes.json"),
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      source: `${WIKI} — Attributes/List/{rarity}`,
      note: "Every attribute and the shard that feeds it. Rarity selects the shard ladder, not just the label.",
      totalXp: attributes.length * 10,
      attributes,
    },
    null,
    1,
  ) + "\n",
);
console.log(`\nwrote ${attributes.length} attributes (${attributes.length * 10} XP), ${noShard} with no bazaar shard`);
