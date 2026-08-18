#!/usr/bin/env node
/**
 * Turns scraped costs into something the pricer can use, and reports how much of it landed.
 *
 *   minions  — material names become bazaar product ids, so a tier costs whatever its
 *              ingredients cost right now
 *   essence  — perk names become task-id prefixes, so a perk tier costs its essence amount
 *              times the live bazaar price of that essence
 *   bank     — a flat coin cost per upgrade task
 *
 * The joins are by name and neither source was built for joining, so every one of them is
 * counted here. A category that only half-matches is worse than useless if you can't see that
 * it half-matched.
 *
 *   node scripts/build-cost-table.mjs
 */
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "data", "generated", "costs.json");

const read = async (p) => JSON.parse(await readFile(join(ROOT, p), "utf8"));
const wiki = await read("data/generated/wiki_costs.json");
const tasks = await read("data/generated/tasks.json");

console.log("fetching bazaar + item list…");
const [items, bazaar] = await Promise.all([
  fetch("https://api.hypixel.net/v2/resources/skyblock/items").then((r) => r.json()),
  fetch("https://api.hypixel.net/v2/skyblock/bazaar").then((r) => r.json()),
]);
const tradeable = new Set(Object.keys(bazaar.products));

/** Item display name -> id, preferring ids that actually trade on the bazaar. */
const nameToId = new Map();
for (const item of items.items) {
  const key = item.name?.toLowerCase().trim();
  if (!key) continue;
  if (!nameToId.has(key) || tradeable.has(item.id)) nameToId.set(key, item.id);
}

/* ----------------------------------------------------------------- minions */

const minionCosts = {};
let matched = 0;
let missed = 0;
const missingNames = new Map();

for (const [generator, tiers] of Object.entries(wiki.minionRecipes)) {
  const out = {};
  for (const [tier, materials] of Object.entries(tiers)) {
    const resolved = [];
    let complete = true;
    for (const material of materials) {
      const id = nameToId.get(material.name.toLowerCase());
      // Only bazaar-tradeable ingredients can be priced live. A tier containing anything else
      // (a quest item, a drop) is left out entirely rather than priced as if it were free.
      if (!id || !tradeable.has(id)) {
        complete = false;
        missingNames.set(material.name, (missingNames.get(material.name) ?? 0) + 1);
        continue;
      }
      resolved.push({ id, qty: material.qty });
    }
    if (complete && resolved.length) {
      out[tier] = resolved;
      matched++;
    } else {
      missed++;
    }
  }
  if (Object.keys(out).length) minionCosts[generator] = out;
}

/* ----------------------------------------------------------------- essence */

const snake = (s) =>
  s
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

/** Every essence task id, grouped by the perk stem the wiki would have to match. */
const essenceStems = new Set();
for (const task of tasks.tasks) {
  if (task.category !== "essence_shop") continue;
  const m = /^([A-Z]+)_ESSENCE_(.+)_\d+$/.exec(task.id);
  if (m) essenceStems.add(`${m[1]}|${m[2]}`);
}

const essenceCosts = {};
let perkHits = 0;
const perkMisses = [];

for (const [key, tiers] of Object.entries(wiki.essencePerks)) {
  const [shop, name] = key.split("|");
  const stem = `${shop}|${snake(name)}`;
  if (!essenceStems.has(stem)) {
    perkMisses.push(`${shop} ${name}`);
    continue;
  }
  perkHits++;
  essenceCosts[stem] = { essence: `ESSENCE_${shop}`, tiers };
}

/* -------------------------------------------------------------------- bank */

const bankCosts = {};
for (const [name, coins] of Object.entries(wiki.bankUpgrades)) bankCosts[`BANK_UPGRADE_${name}`] = coins;

/* -------------------------------------------------------------------- write */

await writeFile(
  OUT,
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      minions: minionCosts,
      essence: essenceCosts,
      bank: bankCosts,
      coverage: {
        minionTiersPriced: matched,
        minionTiersUnpriceable: missed,
        essencePerksMatched: perkHits,
        essencePerksUnmatched: perkMisses.length,
        bankUpgrades: Object.keys(bankCosts).length,
      },
    },
    null,
    1,
  ) + "\n",
);

console.log(`\nminions  ${matched} tiers priced, ${missed} left unpriced`);
if (missingNames.size) {
  const worst = [...missingNames].sort((a, b) => b[1] - a[1]).slice(0, 8);
  console.log(`         top unpriceable ingredients: ${worst.map(([n, c]) => `${n} (${c})`).join(", ")}`);
}
console.log(`essence  ${perkHits} perks matched to task ids, ${perkMisses.length} unmatched`);
if (perkMisses.length) console.log(`         unmatched: ${perkMisses.slice(0, 6).join(", ")}`);
console.log(`bank     ${Object.keys(bankCosts).length} upgrades priced`);
console.log(`-> ${OUT}`);
