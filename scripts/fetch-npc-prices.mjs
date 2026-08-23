#!/usr/bin/env node
/**
 * What a shopkeeper pays for an item, what it charges for one, and how many it stocks.
 *
 * Two sources, because each half comes from a different place and neither has both.
 *
 * **What the NPC pays you** is first-party: Hypixel's own items resource carries
 * `npc_sell_price` on 2,434 items. Hypixel names its bazaar fields from the order book's point
 * of view and this project has been bitten by that once already, so the direction was checked
 * rather than assumed — and it checks out arithmetically. Enchanted Diamond reads 1,280 against
 * Diamond's 8, Enchanted Coal 160 against Coal's 1, and an enchanted item is 160 of the plain
 * one. That ratio only holds if the figure is the price a shopkeeper *pays*, which is
 * `NpcPrice.sell`.
 *
 * **What the NPC charges you** is not in any API, so it comes off the wiki's shop pages. Every
 * shop keeps its inventory on a `/UI` subpage as a `{{Shop UI}}` call, one line per slot,
 * carrying the display name, the bundle size, the asking price and — on the shops that have one
 * — the daily stock limit. That is `NpcPrice.buy` and `NpcPrice.stock`.
 *
 * The two cross-check each other where they overlap, which is the point of taking both: a
 * shopkeeper buys low and sells high, so `sell < buy` on every item that appears in both, and
 * anything violating that is a parse error rather than an arbitrage. Wheat is the worked
 * example — the API says a shopkeeper pays 6, the wiki says it asks 30 for three, and 6 < 10 is
 * the spread you would expect.
 *
 *   node scripts/fetch-npc-prices.mjs
 */
import { writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "data", "generated", "npc-prices.json");
const WIKI = "https://hypixelskyblock.minecraft.wiki/api.php";
const ITEMS = "https://api.hypixel.net/v2/resources/skyblock/items";
const UA = { "User-Agent": "skyblock-xp-planner/0.1 (data build script)" };

/** A wiki number: `5\,000` is five thousand, the comma escaped for the template parser. */
export function wikiNumber(raw) {
  const digits = String(raw).replace(/\\/g, "").replace(/,/g, "").trim();
  return /^\d+(\.\d+)?$/.test(digits) ? Number(digits) : null;
}

/**
 * One `{{Shop UI}}` slot.
 *
 * `Wheat; 3, none, ...//&7Cost/&630 Coins//...` is three Wheat for thirty coins, so the price of
 * one is ten. The bundle size is the whole reason this cannot be read off the cost alone, and
 * it is written two ways (`Wheat;3` and `Wheat; 3`) across the shops.
 *
 * Only coins are taken. A shop that asks for Bits, Motes, Bronze Medals or a quest item is
 * selling for a currency this table cannot compare, and pricing it as though the number were
 * coins would put fictional profits on every one — so it is skipped rather than converted.
 */
export function parseShopSlot(line) {
  const cost = /&7Cost\/&6([\d\\,.]+)\s*Coins/i.exec(line);
  if (!cost) return null;
  const coins = wikiNumber(cost[1]);
  if (coins === null || coins <= 0) return null;

  // The name runs to the first comma or semicolon; a semicolon means a bundle size follows.
  const head = line.slice(0, Math.min(...[line.indexOf(","), line.length].filter((n) => n >= 0)));
  const bundle = /^([^;]+);\s*(\d+)\s*$/.exec(head.trim());
  const name = (bundle ? bundle[1] : head).trim();
  const qty = bundle ? Number(bundle[2]) : 1;
  if (!name || qty <= 0) return null;

  const stock = /&7Stock\/&6([\d\\,]+)/i.exec(line);
  return {
    name,
    buy: coins / qty,
    stock: stock ? wikiNumber(stock[1]) ?? undefined : undefined,
  };
}

/** Every `{{Shop UI}}` slot on a page. Lines outside the template have no Cost and drop out. */
export function parseShopPage(text) {
  const slots = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith("|")) continue;
    const slot = parseShopSlot(line.slice(1));
    if (slot) slots.push(slot);
  }
  return slots;
}

/** `Enchanted Bone Meal` -> `enchantedbonemeal`, so spacing and punctuation stop mattering. */
export const nameKey = (name) =>
  String(name)
    .replace(/§./g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");

async function main() {
  console.log("reading Hypixel's item resource…");
  const items = (await (await fetch(ITEMS)).json()).items ?? [];
  console.log(`  ${items.length} items`);

  // Display name -> id. A name shared by several ids cannot be resolved from a shop line, so it
  // is recorded as ambiguous and left out rather than resolved to whichever came first.
  const byName = new Map();
  for (const item of items) {
    if (!item.name || !item.id) continue;
    const key = nameKey(item.name);
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(item.id);
  }

  // A zero is not a price, it is a refusal: 84 items carry `npc_sell_price: 0`, which is the
  // resource saying no shopkeeper buys them at all. Recording it as a price would be the same
  // mistake `craft()` refuses to make with an unbid ingredient — and here it would quote every
  // one of them as a shop that pays nothing, rather than as a shop that is not open to you.
  const sell = new Map();
  let refuses = 0;
  for (const item of items) {
    if (typeof item.npc_sell_price !== "number") continue;
    if (item.npc_sell_price > 0) sell.set(item.id, item.npc_sell_price);
    else refuses++;
  }
  console.log(`  ${sell.size} carry a shop price; ${refuses} state a zero, which is a refusal rather than a price`);

  console.log("listing the wiki's shop pages…");
  const pages = [];
  let cont = "";
  do {
    const url = `${WIKI}?action=query&list=embeddedin&eititle=Template:Shop%20UI&eilimit=500&format=json${cont}`;
    const body = await fetch(url, { headers: UA }).then((r) => r.json());
    pages.push(...body.query.embeddedin.map((p) => p.title).filter((t) => !t.startsWith("Template:")));
    cont = body.continue ? `&eicontinue=${encodeURIComponent(body.continue.eicontinue)}` : "";
  } while (cont);
  console.log(`  ${pages.length} shop pages`);

  const buy = new Map();
  const stock = new Map();
  const unresolved = new Map();
  const ambiguous = new Map();

  for (let i = 0; i < pages.length; i += 20) {
    const batch = pages.slice(i, i + 20);
    const url = `${WIKI}?action=query&prop=revisions&rvprop=content&rvslots=main&format=json&redirects=1&titles=${batch
      .map(encodeURIComponent)
      .join("|")}`;
    const body = await fetch(url, { headers: UA }).then((r) => r.json());
    for (const page of Object.values(body.query?.pages ?? {})) {
      const text = page.revisions?.[0]?.slots?.main?.["*"];
      if (!text) continue;
      for (const slot of parseShopPage(text)) {
        const ids = byName.get(nameKey(slot.name));
        if (!ids) {
          unresolved.set(slot.name, (unresolved.get(slot.name) ?? 0) + 1);
          continue;
        }
        if (ids.length > 1) {
          ambiguous.set(slot.name, ids);
          continue;
        }
        const id = ids[0];
        // The same good is sold by several shops at the same price; where they differ, the
        // cheapest is the one a player would actually buy from.
        const prior = buy.get(id);
        if (prior === undefined || slot.buy < prior) buy.set(id, slot.buy);
        if (slot.stock !== undefined) stock.set(id, Math.max(stock.get(id) ?? 0, slot.stock));
      }
    }
  }
  console.log(`  ${buy.size} items have a coin price on a shop page`);

  /* ------------------------------------------------------------- cross-check */

  // A shopkeeper buys low and sells high. Anything the other way round is a parse error, not an
  // arbitrage — and left in, it would be top of the reverse-NPC list forever.
  const crossed = [];
  for (const [id, ask] of buy) {
    const pays = sell.get(id);
    if (pays !== undefined && pays > ask) crossed.push({ id, pays, ask });
  }

  const prices = {};
  for (const id of new Set([...sell.keys(), ...buy.keys()])) {
    const entry = {};
    if (sell.has(id)) entry.sell = sell.get(id);
    if (buy.has(id) && !crossed.some((c) => c.id === id)) entry.buy = buy.get(id);
    if (stock.has(id)) entry.stock = stock.get(id);
    if (Object.keys(entry).length > 0) prices[id] = entry;
  }

  const sorted = Object.fromEntries(Object.entries(prices).sort(([a], [b]) => a.localeCompare(b)));

  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(
    OUT,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        source: {
          sell: `${ITEMS} (npc_sell_price)`,
          buy: "hypixelskyblock.minecraft.wiki, every page transcluding Template:Shop UI",
        },
        note:
          "sell is what a shopkeeper pays you for one, from Hypixel's own item resource. buy is what it charges you for one, off the wiki's shop pages, divided through by the bundle size — a shop selling three Wheat for thirty coins is ten coins an item. stock is the daily limit where a shop states one. Only coin prices are taken: a shop asking Bits or Motes is selling for a currency this table cannot compare, and is skipped rather than converted.",
        crossCheck:
          "A shopkeeper buys low and sells high, so sell < buy wherever both are known. Anything crossed is a parse error rather than an arbitrage and its buy price is dropped.",
        totals: {
          items: Object.keys(sorted).length,
          withSell: Object.values(sorted).filter((p) => p.sell !== undefined).length,
          withBuy: Object.values(sorted).filter((p) => p.buy !== undefined).length,
          withStock: Object.values(sorted).filter((p) => p.stock !== undefined).length,
          crossed: crossed.length,
          /** Items the resource prices at zero, meaning no shopkeeper buys them at all. */
          refusedByShops: refuses,
        },
        /** Dropped for reading backwards — recorded rather than silently discarded. */
        crossed,
        /** Shop lines naming something the item resource has no id for. */
        unresolved: Object.fromEntries([...unresolved].sort((a, b) => b[1] - a[1])),
        /** Display names several ids share, which a shop line cannot pick between. */
        ambiguous: Object.fromEntries([...ambiguous]),
        prices: sorted,
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );

  console.log(`\n-> ${Object.keys(sorted).length} items`);
  console.log(`   ${Object.values(sorted).filter((p) => p.sell !== undefined).length} with a sell price`);
  console.log(`   ${Object.values(sorted).filter((p) => p.buy !== undefined).length} with a buy price`);
  console.log(`   ${Object.values(sorted).filter((p) => p.stock !== undefined).length} with a stock limit`);
  if (crossed.length) {
    console.log(`   ${crossed.length} dropped for reading backwards (shop pays more than it asks):`);
    for (const c of crossed.slice(0, 10)) console.log(`     ${c.id}: pays ${c.pays}, asks ${c.ask}`);
  }
  const missed = [...unresolved].sort((a, b) => b[1] - a[1]).slice(0, 12);
  if (missed.length) {
    console.log(`   ${unresolved.size} shop names with no item id, most common:`);
    for (const [name, n] of missed) console.log(`     ${name} (${n}x)`);
  }
}

// Run when invoked directly; the parsers above stay exported so the tests can reach them without
// fetching a hundred and sixty wiki pages. No top-level `await` on the call, for the reason
// `fetch-bazaar-data.mjs` records: it stops the test runner transpiling the file at all.
if (process.argv[1]?.endsWith("fetch-npc-prices.mjs")) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
