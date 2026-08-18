#!/usr/bin/env node
/**
 * Scrapes the *costs* the Hypixel API doesn't publish, so the solver can price more than
 * accessories and minion tier XII.
 *
 *   bank      — coin cost of each account upgrade
 *   minions   — the crafting materials for every tier of every minion, which turn into live
 *               prices once matched against the bazaar
 *   essence   — how much essence each perk tier costs, priced from the bazaar at query time
 *
 * Materials are stored as item names paired with quantities; matching them to bazaar product
 * ids happens in build-cost-table.mjs, where a failed match can be counted and reported rather
 * than silently dropped.
 *
 *   node scripts/fetch-wiki-costs.mjs
 */
import { writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "data", "generated", "wiki_costs.json");
const WIKI = "https://hypixel-skyblock.fandom.com/api.php";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function rendered(page) {
  const url = `${WIKI}?action=parse&page=${encodeURIComponent(page)}&format=json&prop=text`;
  const res = await fetch(url, { headers: { "User-Agent": "skyblock-xp-planner/0.1 (data build script)" } });
  if (!res.ok) throw new Error(`${page} -> ${res.status}`);
  const body = await res.json();
  if (body.error) return null;
  return body.parse.text["*"];
}

const text = (html) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#160;|&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

const tableRows = (html) =>
  [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map((m) =>
    [...m[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map((c) => text(c[1])),
  );

const ROMAN = { I: 1, II: 2, III: 3, IV: 4, V: 5, VI: 6, VII: 7, VIII: 8, IX: 9, X: 10, XI: 11, XII: 12 };
const coins = (s) => {
  const m = /([\d,]+)\s*coins/i.exec(s ?? "");
  return m ? Number(m[1].replace(/,/g, "")) : null;
};

/* -------------------------------------------------------------------- bank */

async function bank() {
  const html = await rendered("Bank");
  const upgrades = {};
  for (const row of tableRows(html)) {
    const name = row[0];
    if (!/^(Starter|Gold|Deluxe|Super Deluxe|Premier|Luxurious|Palatial)$/.test(name ?? "")) continue;
    // "+ 5M coinsTotal:5,077,194 coins" — the total is what an upgrade actually costs to reach.
    // "+ 5M coins Total : 5,077,194 coins" — the total is what reaching this tier really costs.
    const total = /Total\s*:\s*([\d,]+)/.exec(row[1] ?? "");
    if (total) upgrades[name.toUpperCase().replace(/ /g, "_")] = Number(total[1].replace(/,/g, ""));
  }
  return upgrades;
}

/* ----------------------------------------------------------------- minions */

/** "1x Wooden Pickaxe 80x Cobblestone" -> [{ name, qty }] */
function materials(cell) {
  const out = [];
  for (const m of (cell ?? "").matchAll(/([\d,]+)x\s+([A-Za-z' \-]+?)(?=\s+[\d,]+x\s|$)/g)) {
    const name = m[2].trim().replace(/\s+(CUMU|Total.*)$/i, "");
    if (name) out.push({ name, qty: Number(m[1].replace(/,/g, "")) });
  }
  return out;
}

async function minions(families) {
  const recipes = {};
  let done = 0;
  for (const family of families) {
    const html = await rendered(family.page);
    done++;
    process.stdout.write(`\r  minions ${done}/${families.length} — ${family.page.padEnd(28).slice(0, 28)}`);
    if (!html) continue;

    // Parse table by table, not the page as one row stream. A minion page carries several
    // tables that also start rows with a roman numeral — collection tiers further down, for
    // one — and reading past the end of the upgrade table lets those rows overwrite the real
    // recipe with whatever numbers they happen to contain.
    const tables = [...html.matchAll(/<table[^>]*>([\s\S]*?)<\/table>/g)].map((m) => m[1]);

    const tiers = {};
    for (const table of tables) {
      const rows = tableRows(table);
      const header = rows.findIndex((r) => r[0] === "Tier" && r.some((c) => /Upgrade Cost/i.test(c)));
      if (header < 0) continue;

      for (const row of rows.slice(header + 1)) {
        const tier = ROMAN[row[0]];
        if (!tier || tiers[tier]) continue;
        // Column 2 holds the materials for this tier specifically (column 3+ are cumulative).
        const items = materials(row[2]);
        if (items.length) tiers[tier] = items;
      }
      break; // the first table with that header is the upgrade table
    }

    if (Object.keys(tiers).length) recipes[family.generator] = tiers;
    await sleep(120); // be a polite scraper
  }
  process.stdout.write("\n");
  return recipes;
}

/* ----------------------------------------------------------------- essence */

/**
 * Essence perk costs live on Essence Shops/<Type>, one table per shop: a perk row (name in
 * bold), then a row of per-tier essence costs beneath it.
 *
 * The perk *name* is what has to carry the join to Hypixel's task ids, and the two don't always
 * agree — the wiki calls a perk "One Punch" where the game id says FLAT_DAMAGE_VS_ENDER. Names
 * are kept as-is here; build-cost-table.mjs reports how many actually matched rather than
 * guessing at the rest.
 */
async function essence() {
  const shops = ["Dragon", "Wither", "Undead", "Diamond", "Forest", "Gold", "Spider", "Ice", "Crimson"];
  const perks = {};

  for (const shop of shops) {
    const html = await rendered(`Essence Shops/${shop}`);
    if (!html) continue;

    const rawRows = [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map((m) => m[1]);
    let currentPerk = null;

    for (const raw of rawRows) {
      const cells = [...raw.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map((c) => c[1]);
      if (!cells.length) continue;

      // A perk row announces itself with a bolded name.
      const bold = /<b>([\s\S]*?)<\/b>/.exec(cells[0]);
      if (bold) {
        currentPerk = text(bold[1]);
        continue;
      }

      // The row right after is "<Type> Essence" followed by the cost of each tier.
      const label = text(cells[0]);
      if (!currentPerk || label !== `${shop} Essence`) continue;

      const costs = {};
      cells.slice(1).forEach((cell, index) => {
        const value = text(cell).replace(/,/g, "");
        if (/^\d+$/.test(value)) costs[index + 1] = Number(value);
      });
      if (Object.keys(costs).length) perks[`${shop.toUpperCase()}|${currentPerk}`] = costs;
      currentPerk = null;
    }
    await sleep(120);
  }
  return perks;
}

/* --------------------------------------------------------------------- run */

const minionFamilies = JSON.parse(
  await (await import("node:fs/promises")).readFile(join(ROOT, "data/generated/minions.json"), "utf8"),
).minions.map((m) => ({ generator: m.generator, page: m.family }));

console.log("scraping wiki costs…");
const bankUpgrades = await bank();
console.log(`  bank      ${Object.keys(bankUpgrades).length} upgrades: ${JSON.stringify(bankUpgrades)}`);

const minionRecipes = await minions(minionFamilies);
console.log(`  minions   ${Object.keys(minionRecipes).length} of ${minionFamilies.length} families have recipes`);

const essencePerks = await essence();
console.log(`  essence   ${Object.keys(essencePerks).length} perks with tier costs`);

await mkdir(dirname(OUT), { recursive: true });
await writeFile(
  OUT,
  JSON.stringify(
    { generatedAt: new Date().toISOString(), source: WIKI, bankUpgrades, minionRecipes, essencePerks },
    null,
    1,
  ) + "\n",
);
console.log(`-> ${OUT}`);
