#!/usr/bin/env node
/**
 * Builds the attribute table: every attribute in the game, the shard that feeds it, and the
 * bazaar product that shard trades as.
 *
 * This does two things the profile alone can't:
 *
 *   1. Completes the universe. `attributes.stacks` only lists attributes the player already
 *      holds shards in, so deriving the catalogue from it caps a player's ceiling at whatever
 *      they happen to have touched. The wiki lists all of them.
 *
 *   2. Makes them priceable. Every attribute is fed by a named shard, and those shards trade on
 *      the bazaar — so "get this attribute to level 6" has a real coin cost rather than being a
 *      grind with no ranking. Shard products are named after the *mob*, not the attribute
 *      ("Snow Elemental" is fed by "Blizzard Shard" = SHARD_BLIZZARD), which is why this
 *      mapping has to be scraped rather than guessed.
 *
 *   node scripts/fetch-attributes.mjs
 */
import { writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "data", "generated", "attributes.json");
const WIKI = "https://hypixel-skyblock.fandom.com/api.php";

const RARITIES = ["Common", "Uncommon", "Rare", "Epic", "Legendary"];

const text = (html) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#160;|&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

async function rendered(page) {
  const url = `${WIKI}?action=parse&page=${encodeURIComponent(page)}&format=json&prop=text`;
  const res = await fetch(url, { headers: { "User-Agent": "skyblock-xp-planner/0.1 (data build script)" } });
  if (!res.ok) return null;
  const body = await res.json();
  if (body.error) return null;
  return body.parse.text["*"];
}

/** "Snow Elemental" -> "snow_elemental", matching the keys in attributes.stacks. */
const attributeKey = (name) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

/** "Blizzard Shard" -> "SHARD_BLIZZARD", matching the bazaar product id. */
const shardId = (name) =>
  "SHARD_" +
  name
    .replace(/\s*Shard\s*$/i, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

console.log("fetching bazaar for shard price validation…");
const bazaar = await fetch("https://api.hypixel.net/v2/skyblock/bazaar").then((r) => r.json());
const traded = new Set(Object.keys(bazaar.products ?? {}));

const attributes = [];
const seen = new Set();

for (const rarity of RARITIES) {
  const html = await rendered(`Attributes/List/${rarity}`);
  if (!html) {
    console.log(`  ${rarity.padEnd(10)} (no page)`);
    continue;
  }

  const rows = [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map((m) =>
    [...m[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map((c) => text(c[1])),
  );

  // The header names the columns; find Attribute and Shard Name by label rather than position,
  // since the tables don't agree on column order across rarities.
  const header = rows.find((r) => r.includes("Attribute") && r.some((c) => /Shard Name/i.test(c)));
  if (!header) {
    console.log(`  ${rarity.padEnd(10)} (no recognisable header)`);
    continue;
  }
  const attributeAt = header.indexOf("Attribute");
  const shardAt = header.findIndex((c) => /Shard Name/i.test(c));

  let found = 0;
  for (const row of rows) {
    if (row === header || row.length <= Math.max(attributeAt, shardAt)) continue;
    const name = row[attributeAt];
    const shard = row[shardAt];
    if (!name || !shard || !/Shard/i.test(shard)) continue;

    const key = attributeKey(name);
    if (!key || seen.has(key)) continue;
    seen.add(key);

    const id = shardId(shard);
    attributes.push({ key, name, rarity: rarity.toUpperCase(), shardName: shard, shardId: id, tradeable: traded.has(id) });
    found++;
  }
  console.log(`  ${rarity.padEnd(10)} ${found} attributes`);
}

attributes.sort((a, b) => a.key.localeCompare(b.key));
const tradeable = attributes.filter((a) => a.tradeable).length;

await mkdir(dirname(OUT), { recursive: true });
await writeFile(
  OUT,
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      source: `${WIKI} — Attributes/List/<rarity>`,
      note: "Each attribute is fed by one shard, which trades on the bazaar under the mob's name rather than the attribute's. tradeable=false means no bazaar product matched, so that attribute stays unpriced.",
      totalAttributes: attributes.length,
      tradeableAttributes: tradeable,
      attributes,
    },
    null,
    1,
  ) + "\n",
);

console.log(`\n${attributes.length} attributes, ${tradeable} with a bazaar-traded shard`);
const untraded = attributes.filter((a) => !a.tradeable);
if (untraded.length) {
  console.log(`unpriced (${untraded.length}): ${untraded.slice(0, 10).map((a) => `${a.name} -> ${a.shardId}`).join(", ")}`);
}
console.log(`-> ${OUT}`);
