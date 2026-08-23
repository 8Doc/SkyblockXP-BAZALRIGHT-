import { test } from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error - a plain build script, imported for its pure parsers only.
import { nameKey, parseShopPage, parseShopSlot, wikiNumber } from "../scripts/fetch-npc-prices.mjs";
import npcPrices from "../data/generated/npc-prices.json";

/**
 * The shop scraper's parsing. Every line below is a real `{{Shop UI}}` slot off the wiki, kept
 * because each one is a shape that a simpler parser gets wrong.
 */

test("a wiki number survives its escaped comma", () => {
  // The template escapes thousands separators, so `5\,000` is five thousand and not five.
  assert.equal(wikiNumber("5\\,000"), 5_000);
  assert.equal(wikiNumber("500\\,000"), 500_000);
  assert.equal(wikiNumber("640"), 640);
  assert.equal(wikiNumber("not a number"), null);
});

/**
 * The bundle size is the whole reason a price cannot be read off the cost alone. The Farm
 * Merchant sells Wheat three at a time for thirty coins, which is ten coins an item — quoting it
 * at thirty would make every craft built on wheat read three times too dear.
 */
test("a bundle price divides through by the bundle", () => {
  const wheat = parseShopSlot(
    "Wheat; 3, none, &fWheat &8x3, %inherit%//&7Cost/&630 Coins//&eClick to trade!",
  );
  assert.deepEqual(wheat, { name: "Wheat", buy: 10, stock: undefined });
});

test("the semicolon is written both with and without a space", () => {
  // The Lumber Merchant writes `Stick;32`; the Farm Merchant writes `Glass Bottle; 8`.
  assert.equal(parseShopSlot("Stick;32, none, %inherit% &8x32, %inherit%//&7Cost/&620 Coins//&e!")?.buy, 20 / 32);
  assert.equal(parseShopSlot("Glass Bottle; 8, none, %inherit%//&7Cost/&648 Coins//&e!")?.buy, 6);
});

test("a single item has no bundle and costs what it costs", () => {
  assert.deepEqual(parseShopSlot("Pumpkin, none, %inherit%, %inherit%//&7Cost/&625 Coins//&e!"), {
    name: "Pumpkin",
    buy: 25,
    stock: undefined,
  });
});

test("a stated stock limit is kept", () => {
  const slot = parseShopSlot(
    "Nether Wart, none, %inherit%, %inherit%//&7Cost/&610 Coins//&7Stock/&6640 &7remaining//&e!",
  );
  assert.deepEqual(slot, { name: "Nether Wart", buy: 10, stock: 640 });
});

/**
 * A shop asking Bits, Motes or Bronze Medals is selling for a currency this table cannot compare,
 * and pricing the number as though it were coins would put a fictional profit on every one of
 * them. Skipped rather than converted at a made-up rate.
 */
test("a price in anything but coins is skipped", () => {
  assert.equal(parseShopSlot("Kat Flower, none, %inherit%//&7Cost/&6600 Bits//&e!"), null);
  assert.equal(parseShopSlot("Rift Thing, none, %inherit%//&7Cost/&6300 Motes//&e!"), null);
  assert.equal(parseShopSlot("Something, none, %inherit%//&eClick to trade!"), null, "and so is a slot with no price at all");
});

test("only the template's own slots are read off a page", () => {
  const page = [
    "{{Shop UI|Farm Merchant",
    "|Wheat; 3, none, &fWheat &8x3, %inherit%//&7Cost/&630 Coins//&e!",
    "|Cactus, none, %inherit%, %inherit%//&7Cost/&615 Coins//&e!",
    "|arrow=none",
    "}}",
    "Some prose about the merchant that mentions 30 Coins in passing.",
  ].join("\n");
  assert.deepEqual(parseShopPage(page), [
    { name: "Wheat", buy: 10, stock: undefined },
    { name: "Cactus", buy: 15, stock: undefined },
  ]);
});

test("a name matches whatever the item resource spells it as", () => {
  assert.equal(nameKey("Enchanted Bone Meal"), nameKey("enchanted bone meal"));
  assert.equal(nameKey("Rabbit's Foot"), "rabbitsfoot");
});

/* ------------------------------------------------------------- the table */

/**
 * The cross-check that makes taking two sources worth it.
 *
 * `sell` comes from Hypixel's own item resource and `buy` from the wiki's shop pages, and a
 * shopkeeper buys low and sells high — so wherever both are known, `sell < buy`. A row the other
 * way round is a parse error rather than an arbitrage, and left in it would sit at the top of the
 * reverse-NPC list forever.
 */
test("no shopkeeper pays more for an item than it charges", () => {
  for (const [id, price] of Object.entries(npcPrices.prices)) {
    if (price.sell === undefined || price.buy === undefined) continue;
    assert.ok(price.sell < price.buy, `${id}: pays ${price.sell}, asks ${price.buy}`);
  }
});

/**
 * The direction of `npc_sell_price` was checked rather than assumed — this project has been
 * caught by Hypixel's naming once already. An enchanted item is 160 of the plain one, and the
 * ratio only holds if the figure is what a shopkeeper *pays*.
 */
test("the sell price is what a shopkeeper pays, as the enchanted ratio proves", () => {
  const p = npcPrices.prices as Record<string, { sell?: number }>;
  assert.equal(p.ENCHANTED_DIAMOND?.sell, (p.DIAMOND?.sell ?? 0) * 160);
  assert.equal(p.ENCHANTED_COAL?.sell, (p.COAL?.sell ?? 0) * 160);
});

test("every price is a positive number, and stock a whole one", () => {
  for (const [id, price] of Object.entries(npcPrices.prices)) {
    if (price.sell !== undefined) assert.ok(price.sell > 0, `${id} sell`);
    if (price.buy !== undefined) assert.ok(price.buy > 0, `${id} buy`);
    if (price.stock !== undefined) assert.ok(Number.isInteger(price.stock) && price.stock > 0, `${id} stock`);
  }
});
