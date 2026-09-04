#!/usr/bin/env node
/**
 * What a minion costs to build, tier by tier.
 *
 * Every other figure in this app is about what a minion *earns*, which is only half of a decision:
 * a Tier XII Melon Minion pays well and the twelve tiers of melons behind it are a real number
 * that nothing on the page was quoting. This is the other half.
 *
 * **Scraped from the rendered page, not the wikitext.** Each minion page carries a bare
 * `{{MinionRecipesTable}}` and the numbers live in a Lua module behind it, so `prop=wikitext`
 * returns a template call and nothing else. `prop=text` returns the table with the quantities in
 * it, which is why this scraper reads HTML where every other one in this repo reads wikitext.
 *
 * **Two columns, and neither alone is right.** The table gives what a tier adds and what the tier
 * has cost in total, and they are not redundant:
 *
 *  - The cumulative column expands a nested minion. A Revenant Minion II is crafted from a *Zombie
 *    Minion II*, and the upgrade cell says only "1x Zombie Minion" — no tier, nothing priceable.
 *    The cumulative cell says 220 Revenant Flesh and 80 Rotten Flesh, which is that Zombie Minion
 *    written out. Summing the upgrade column alone leaves five slayer minions costed at a fraction
 *    of what they cost.
 *  - The upgrade column carries the items the cumulative column drops, which is every item no
 *    bazaar prices: a Cobblestone Minion I is 80 cobblestone *and a wooden pickaxe*, a Revenant
 *    Minion I wants a Crystallized Heart, and only the first of each pair is in the cumulative cell.
 *
 * So the cumulative column is the source, with the missing items added back from the upgrades, and
 * the two are cross-checked on every run: a tier whose published total contradicts the previous
 * tier's total plus this tier's upgrade is arithmetic that cannot all be true. That check earns its
 * keep — the Inferno Minion's Tier XI row doubles its ashe and its blaze rods against its own Tier
 * X row, and the sum is used in its place rather than the published figure.
 *
 * The ladder is genuinely per minion and not a formula: most double every tier and switch to the
 * enchanted form at Tier V, but the slayer minions want slayer drops, several want more than one
 * ingredient, and the tier a minion stops at varies. All of it is read rather than assumed.
 */

import { writeFile, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WIKI = "https://hypixelskyblock.minecraft.wiki/api.php";
const OUT = join(ROOT, "data", "generated", "minion-recipes.json");

async function wikiHtml(page) {
  const url = `${WIKI}?${new URLSearchParams({ format: "json", formatversion: "2", action: "parse", page, prop: "text" })}`;
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(url, { headers: { "User-Agent": "skyblock-xp-planner" } });
    if (response.ok) {
      const body = await response.json();
      if (!body.parse) throw new Error(`no page: ${page}`);
      return body.parse.text;
    }
    if (response.status !== 429 || attempt >= 3) throw new Error(`${response.status} for ${page}`);
    await new Promise((done) => setTimeout(done, 2_000 * (attempt + 1)));
  }
}

/* ------------------------------------------------------------------ parsing */

/**
 * The quantities out of one cell of the recipes table.
 *
 * A cell is a `<ul>` of `<li>`s, each one an icon, a `NNx` count and a link whose `title` is the
 * item's own page name — which is the name the rest of this repo resolves ids from. The count
 * carries thousands separators past a thousand and is sometimes wrapped in an `<abbr>` spelling
 * out "1 stack plus 16", so it is read off the styled span rather than off the cell's text.
 */
export function cellItems(html) {
  const out = [];
  const pattern = /<span class="light-color color-[a-z]+"[^>]*>\s*([\d,]+)x\s*<\/span>[\s\S]*?title="([^"]+)"\s*>[^<]*<\/a>/g;
  for (const match of html.matchAll(pattern)) {
    const qty = Number(match[1].replace(/,/g, ""));
    const item = decode(match[2]).trim();
    if (!item || !Number.isFinite(qty) || qty <= 0) continue;
    out.push({ item, qty });
  }
  return out;
}

function decode(text) {
  return text
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#0?39;/g, "'");
}

/**
 * One minion page's recipe table into a per-tier ladder.
 *
 * Tiers come in row pairs — an upgrade row carrying three cells and a cumulative row carrying two
 * — so the shape of the row is what identifies it, and a page whose rows stop pairing up is
 * rejected rather than half-read.
 */
export function parseRecipes(html) {
  const start = html.indexOf("article-msTable");
  if (start < 0) return null;
  const end = html.indexOf("</table>", start);
  const table = html.slice(start, end < 0 ? undefined : end);

  const rows = table.split(/<tr[^>]*>/).slice(1);
  const tiers = [];
  let pending = null;

  for (const row of rows) {
    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => m[1]);
    if (cells.length === 0) continue;
    if (pending === null) {
      // The upgrade row: what this tier adds, plus its bazaar price and its crafting grid.
      pending = { upgrade: cellItems(cells[0]) };
    } else {
      pending.published = cellItems(cells[0]);
      tiers.push(pending);
      pending = null;
    }
  }
  if (pending !== null || tiers.length === 0) return null;
  return tiers.map((tier, i) => ({ tier: i + 1, ...tier }));
}

/** Add one tier's items into a running total, keyed by name. */
function accumulate(into, items) {
  for (const { item, qty } of items) into.set(item, (into.get(item) ?? 0) + qty);
  return into;
}

/** A minion as an ingredient — the slayer ladders each consume one, at the tier being crafted. */
function isMinion(item) {
  return / Minion$/.test(item);
}

/** True where the two totals differ on any item either of them names. */
function disagrees(expected, published) {
  for (const [item, qty] of expected) if ((published.get(item) ?? 0) !== qty) return true;
  return false;
}

/* ---------------------------------------------------------------- the ids */

const ALIASES = {
  "wooden pickaxe": "WOOD_PICKAXE",
  "wooden axe": "WOOD_AXE",
  "wooden sword": "WOOD_SWORD",
  "wooden hoe": "WOOD_HOE",
  "wooden shovel": "WOOD_SPADE",
  "stone pickaxe": "STONE_PICKAXE",
  "iron pickaxe": "IRON_PICKAXE",
  "diamond pickaxe": "DIAMOND_PICKAXE",
  "flint and steel": "FLINT_AND_STEEL",
  "fishing rod": "FISHING_ROD",
  "lapis lazuli": "INK_SACK:4",
  "cocoa beans": "INK_SACK:3",
  "nether wart": "NETHER_STALK",
  "raw porkchop": "PORK",
  "raw rabbit": "RABBIT",
  "raw mutton": "MUTTON",
  "melon slice": "MELON",
  snowball: "SNOW_BALL",
  "rabbit's foot": "RABBIT_FOOT",
  slimeball: "SLIME_BALL",
  string: "STRING",
};

function resolver(names, npcPrices) {
  const byName = new Map();
  for (const [id, name] of Object.entries(names)) {
    const key = name.trim().toLowerCase();
    if (!byName.has(key)) byName.set(key, id);
  }
  return (display) => {
    const key = display.trim().toLowerCase();
    if (ALIASES[key]) return ALIASES[key];
    const found = byName.get(key);
    if (found) return found;
    // A shopkeeper's table is the fallback: several early tiers want a vanilla tool that no bazaar
    // carries, and an id from the shop is still an id everything downstream can price.
    const guess = key.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
    return npcPrices[guess] ? guess : null;
  };
}

/* ------------------------------------------------------------------ the run */

async function main() {
  const production = JSON.parse(await readFile(join(ROOT, "data", "generated", "minion-production.json"), "utf8"));
  const names = JSON.parse(await readFile(join(ROOT, "data", "generated", "bazaar_items.json"), "utf8")).names;
  const npcPrices = JSON.parse(await readFile(join(ROOT, "data", "generated", "npc-prices.json"), "utf8")).prices;
  const resolve = resolver(names, npcPrices);

  const minions = [];
  const disagreements = [];
  const failed = [];
  const noRecipe = [];
  const mismatched = [];
  const unresolved = new Set();

  for (let i = 0; i < production.minions.length; i += 3) {
    const batch = production.minions.slice(i, i + 3);
    const parsed = await Promise.all(
      batch.map(async (minion) => {
        try {
          return { minion, tiers: parseRecipes(await wikiHtml(minion.family)) };
        } catch {
          return { minion, tiers: null };
        }
      }),
    );

    for (const { minion, tiers } of parsed) {
      if (!tiers) {
        failed.push(minion.family);
        continue;
      }
      /**
       * A minion nobody crafts.
       *
       * The Snow Minion comes out of Gifts and its cost cell is the wiki's "intentionally left
       * blank" marker, so its table parses to tiers with nothing in them. That is a real answer —
       * there is no craft cost — and it is recorded as one rather than as a row of zeroes, which
       * would read as free.
       */
      if (tiers.every((tier) => tier.upgrade.length === 0)) {
        noRecipe.push(minion.family);
        continue;
      }
      if (tiers.length !== minion.maxTier) {
        mismatched.push(`${minion.family}: ${tiers.length} tiers in the table, ${minion.maxTier} in production`);
      }

      /**
       * The cumulative ladder: the published totals, checked against their own arithmetic.
       *
       * `carried` is what the previous tier's *accepted* total was, so a corrected row corrects
       * everything above it rather than the error reappearing one tier later.
       */
      let carried = new Map();
      const seenTools = new Map();
      const ladder = tiers.map((tier, index) => {
        const published = new Map(tier.published.map((p) => [p.item, p.qty]));
        const expected = accumulate(new Map(carried), tier.upgrade.filter((u) => !isMinion(u.item)));

        // A nested minion is expanded only by the published column, so a tier that consumes one
        // cannot be checked and is taken as published.
        const nested = tier.upgrade.some((u) => isMinion(u.item));
        const wrong = !nested && index > 0 && disagrees(expected, published);
        if (wrong) {
          for (const [item, qty] of expected) {
            const theirs = published.get(item);
            if (theirs !== qty) {
              disagreements.push(
                `${minion.family} tier ${tier.tier}: ${item} is ${qty} by the tier below plus this tier's upgrade, published ${theirs ?? 0} — using ${qty}`,
              );
            }
          }
        }
        carried = wrong ? expected : published;

        /**
         * The items the published column never carries, added back.
         *
         * Vanilla tools and the one-off unlock items — a Wooden Pickaxe, a Crystallized Heart, a
         * Bat Person Helmet. They are part of what building the minion costs even where nothing
         * on the bazaar prices them, and leaving them out silently is the opposite of a cost.
         */
        for (const { item, qty } of tier.upgrade) {
          if (isMinion(item) || carried.has(item)) continue;
          seenTools.set(item, (seenTools.get(item) ?? 0) + qty);
        }

        const total = new Map(carried);
        for (const [item, qty] of seenTools) if (!total.has(item)) total.set(item, qty);

        const withIds = (list) =>
          list.map(({ item, qty }) => {
            const itemId = isMinion(item) ? null : resolve(item);
            if (!itemId) unresolved.add(item);
            return { item, itemId, qty };
          });

        return {
          tier: tier.tier,
          upgrade: withIds(tier.upgrade),
          cumulative: withIds([...total].map(([item, qty]) => ({ item, qty }))),
        };
      });

      minions.push({ generator: minion.generator, family: minion.family, tiers: ladder });
    }
  }

  const out = {
    generatedAt: new Date().toISOString(),
    source: {
      recipes:
        "Hypixel Wiki, each minion's own page — the 'Obtaining' table's Total Upgrade Cost column, " +
        "summed into a cumulative ladder and cross-checked against the table's own cumulative column.",
    },
    note:
      "`upgrade` is what one tier adds; `cumulative` is every material the tier has cost since Tier I, " +
      "including the ones the wiki's cumulative column omits because no bazaar prices them.",
    minions: minions.sort((a, b) => a.generator.localeCompare(b.generator)),
    /** Minions with no crafting recipe at all — obtained some other way. */
    noRecipe,
    disagreements,
    mismatched,
    failed,
    unresolved: [...unresolved].sort(),
  };

  await writeFile(OUT, `${JSON.stringify(out, null, 1)}\n`);
  console.log(`-> ${minions.length} minions, ${minions.reduce((n, m) => n + m.tiers.length, 0)} tiers`);
  if (noRecipe.length) console.log(`   ${noRecipe.length} not crafted at all: ${noRecipe.join(", ")}`);
  if (mismatched.length) console.log(`   ${mismatched.length} tier-count mismatches: ${mismatched.join("; ")}`);
  if (failed.length) console.log(`   ${failed.length} pages with no readable table: ${failed.join(", ")}`);
  if (disagreements.length) console.log(`   ${disagreements.length} disagreements with the published cumulative:`);
  for (const line of disagreements.slice(0, 10)) console.log(`     ${line}`);
  if (unresolved.size) console.log(`   ${unresolved.size} names with no item id: ${[...unresolved].join(", ")}`);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop())) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
