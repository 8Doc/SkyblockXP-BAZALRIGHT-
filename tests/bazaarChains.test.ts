import { test } from "node:test";
import assert from "node:assert/strict";
import { NET_OF_TAX, hourlySold } from "../src/lib/bazaar";
import { craft } from "../src/lib/bazaarViews";
import { combineSteps, enchantTier, findCraftChains, unorthodoxChains } from "../src/lib/bazaarChains";
import type { AnvilRules } from "../src/lib/bazaarChains";
import type { ProductSnapshot } from "../src/lib/bazaarTypes";
import type { NpcPrice, Recipe } from "../src/lib/bazaarViews";
import anvil from "../data/curated/anvil_combines.json";

/**
 * A book of fixed numbers rather than a live read, so every figure below can be checked by hand.
 * One level a side keeps the arithmetic visible: the walk is not what is under test here.
 */
function product(id: string, instasell: number, instabuy: number, weeklySold: number, weeklyBought: number): ProductSnapshot {
  return {
    id,
    at: 0,
    instabuy,
    instasell,
    supply: 1_000_000,
    demand: 1_000_000,
    weeklyBought,
    weeklySold,
    sellOrders: 50,
    buyOrders: 50,
    sellBook: [{ amount: 1_000_000, orders: 1, price: instabuy }],
    buyBook: [{ amount: 1_000_000, orders: 1, price: instasell }],
  };
}

/** 168 hours in the moving week, so a weekly figure of 168 is one an hour. */
const PER_HOUR = 168;

const RULES: AnvilRules = {
  feeCoins: anvil.feeCoins,
  inputsRequired: anvil.inputsRequired,
  maxCombinableLevel: anvil.maxCombinableLevel,
};

/* ------------------------------------------------------------ the arithmetic */

/**
 * The whole reason this module exists, in one case.
 *
 * Sugar Cane is a bazaar good, Paper is not, and a Hot Potato Book is made of Paper. `craft()`
 * refuses the Book — one of its ingredients has no price — and refuses Paper too, because Paper
 * cannot be sold. Neither refusal is wrong on its own and together they hide a real trade.
 */
test("a chain prices a step the bazaar does not sell", () => {
  const market = new Map([
    ["SUGAR_CANE", product("SUGAR_CANE", 10, 12, 1000 * PER_HOUR, 1000 * PER_HOUR)],
    ["HOT_POTATO_BOOK", product("HOT_POTATO_BOOK", 5_000, 6_000, 100 * PER_HOUR, 100 * PER_HOUR)],
  ]);
  const recipes: Recipe[] = [
    // Three Sugar Cane make three Paper — a yield of three, which the cost has to divide through.
    { output: "PAPER", yield: 3, ingredients: [{ id: "SUGAR_CANE", qty: 3 }] },
    { output: "HOT_POTATO_BOOK", yield: 1, ingredients: [{ id: "PAPER", qty: 20 }] },
  ];

  const chains = findCraftChains(market, { recipes });
  const book = chains.find((c) => c.id === "HOT_POTATO_BOOK");
  assert.ok(book, "the chain finder reaches it where a single craft cannot");

  // Paper costs what its cane costs: 3 x 10 / 3 = 10 each. Twenty of them is 200.
  assert.equal(book!.craftCost, 200);
  assert.equal(book!.depth, 2, "cane -> paper -> book");
  assert.equal(book!.margin, 6_000 * NET_OF_TAX - 200);
});

/**
 * A yield above one is where a chain and a single craft can silently disagree. Dividing at the
 * end rather than at each hop leaves a recipe that makes thirty-two pricing everything above it
 * thirty-two times too high, and the number still looks plausible.
 */
test("each hop divides by its own yield, not the last one", () => {
  const market = new Map([
    ["A", product("A", 100, 110, 1000 * PER_HOUR, 1000 * PER_HOUR)],
    ["C", product("C", 5_000, 6_000, 10 * PER_HOUR, 10 * PER_HOUR)],
  ]);
  const recipes: Recipe[] = [
    { output: "B", yield: 4, ingredients: [{ id: "A", qty: 8 }] }, // 8 x 100 / 4 = 200 each
    { output: "C", yield: 2, ingredients: [{ id: "B", qty: 6 }] }, // 6 x 200 / 2 = 600 each
  ];
  const c = findCraftChains(market, { recipes }).find((x) => x.id === "C");
  assert.ok(c);
  assert.equal(c!.craftCost, 600);
});

/**
 * A one-hop chain has to reproduce `craft()` exactly, or the two tables quote different numbers
 * for the same trade and neither can be trusted.
 */
test("a one-hop chain agrees with craft() to the coin", () => {
  const market = new Map([
    ["ENCHANTED_CACTUS_GREEN", product("ENCHANTED_CACTUS_GREEN", 1_000, 1_100, 500 * PER_HOUR, 500 * PER_HOUR)],
    ["ENCHANTED_CACTUS", product("ENCHANTED_CACTUS", 100_000, 110_000, 20 * PER_HOUR, 30 * PER_HOUR)],
  ]);
  const recipe: Recipe = { output: "ENCHANTED_CACTUS", yield: 1, ingredients: [{ id: "ENCHANTED_CACTUS_GREEN", qty: 32 }] };

  const single = craft(recipe, market);
  const chained = findCraftChains(market, { recipes: [recipe] }).find((c) => c.id === "ENCHANTED_CACTUS");
  assert.ok(single && chained);
  assert.equal(chained!.craftCost, single!.craftCost);
  assert.equal(chained!.margin, single!.margin);
  assert.equal(chained!.bottleneck, single!.bottleneck);
  assert.equal(chained!.coinsPerHour, single!.coinsPerHour);
});

/** The scarcest leaf caps the whole chain, and the row has to name it rather than just slow down. */
test("the bottleneck is the tightest hop, and it says which", () => {
  const market = new Map([
    ["FAST", product("FAST", 10, 11, 10_000 * PER_HOUR, 10_000 * PER_HOUR)],
    ["SLOW", product("SLOW", 10, 11, 5 * PER_HOUR, 5 * PER_HOUR)],
    ["OUT", product("OUT", 1_000, 1_200, 10_000 * PER_HOUR, 10_000 * PER_HOUR)],
  ]);
  const recipes: Recipe[] = [
    { output: "MID", yield: 1, ingredients: [{ id: "FAST", qty: 1 }, { id: "SLOW", qty: 1 }] },
    { output: "OUT", yield: 1, ingredients: [{ id: "MID", qty: 1 }] },
  ];
  const c = findCraftChains(market, { recipes }).find((x) => x.id === "OUT");
  assert.ok(c);
  assert.equal(c!.inputLimit, hourlySold(market.get("SLOW")!), "five an hour, not ten thousand");
  assert.equal(c!.limitedBy, "SLOW");
});

/** No price is not a low price — the rule `craft()` already keeps, held across a whole chain. */
test("one unpriceable leaf makes the whole path unpriceable", () => {
  const market = new Map([["OUT", product("OUT", 1_000, 1_200, 100 * PER_HOUR, 100 * PER_HOUR)]]);
  const recipes: Recipe[] = [{ output: "OUT", yield: 1, ingredients: [{ id: "NOBODY_BIDS", qty: 1 }] }];
  assert.equal(findCraftChains(market, { recipes }).length, 0);
});

/** Alternatives are a price question, and prices move, so it is answered per call. */
test("the cheapest of several paths wins, decided against the live market", () => {
  const recipes: Recipe[] = [
    { output: "ENCHANTED_IRON", yield: 1, ingredients: [{ id: "IRON_INGOT", qty: 160 }] },
    { output: "ENCHANTED_IRON", yield: 1, ingredients: [{ id: "IRON_BLOCK", qty: 160 }] },
  ];
  const base = [
    ["ENCHANTED_IRON", product("ENCHANTED_IRON", 100_000, 120_000, 100 * PER_HOUR, 100 * PER_HOUR)],
    ["IRON_INGOT", product("IRON_INGOT", 10, 11, 1000 * PER_HOUR, 1000 * PER_HOUR)],
  ] as const;

  const blocksDear = new Map<string, ProductSnapshot>([...base, ["IRON_BLOCK", product("IRON_BLOCK", 500, 510, 1000 * PER_HOUR, 1000 * PER_HOUR)]]);
  assert.equal(findCraftChains(blocksDear, { recipes }).find((c) => c.id === "ENCHANTED_IRON")!.craftCost, 1_600);

  const blocksCheap = new Map<string, ProductSnapshot>([...base, ["IRON_BLOCK", product("IRON_BLOCK", 5, 6, 1000 * PER_HOUR, 1000 * PER_HOUR)]]);
  assert.equal(findCraftChains(blocksCheap, { recipes }).find((c) => c.id === "ENCHANTED_IRON")!.craftCost, 800);
});

/** A graph with a loop in it must not recurse forever, and a loop is never the cheaper path. */
test("a recipe cycle terminates", () => {
  const market = new Map([
    ["INGOT", product("INGOT", 10, 11, 1000 * PER_HOUR, 1000 * PER_HOUR)],
    ["BLOCK", product("BLOCK", 95, 100, 1000 * PER_HOUR, 1000 * PER_HOUR)],
  ]);
  const recipes: Recipe[] = [
    { output: "BLOCK", yield: 1, ingredients: [{ id: "INGOT", qty: 9 }] },
    { output: "INGOT", yield: 9, ingredients: [{ id: "BLOCK", qty: 1 }] },
  ];
  const chains = findCraftChains(market, { recipes });
  assert.ok(chains.length > 0, "it returns rather than hanging");
  assert.equal(chains.find((c) => c.id === "BLOCK")!.craftCost, 90, "nine ingots at ten");
});

/* ------------------------------------------------------------------ npc leaves */

test("a shop-bought leaf is priced at what the shop charges", () => {
  const market = new Map([["OUT", product("OUT", 1_000, 1_200, 100 * PER_HOUR, 100 * PER_HOUR)]]);
  const recipes: Recipe[] = [{ output: "OUT", yield: 1, ingredients: [{ id: "PAPER", qty: 10 }] }];
  const npcPrices: Record<string, NpcPrice> = { PAPER: { buy: 5, sell: 2, stock: 240 } };

  const c = findCraftChains(market, { recipes, npcPrices }).find((x) => x.id === "OUT");
  assert.ok(c);
  assert.equal(c!.craftCost, 50, "ten Paper at what the shop asks, not what it pays");
  assert.equal(c!.inputLimit, 1, "240 a day is ten an hour, and ten go into each craft");
});

/**
 * A shop with no published stock is not a shop with infinite stock, and it is not one selling
 * nothing either. The cost is known and the rate is not, so the row carries the unknown up
 * rather than ranking on a number nobody measured.
 */
test("a shop leaf with no stated stock is flagged rather than assumed", () => {
  const market = new Map([["OUT", product("OUT", 1_000, 1_200, 100 * PER_HOUR, 100 * PER_HOUR)]]);
  const recipes: Recipe[] = [{ output: "OUT", yield: 1, ingredients: [{ id: "BOWL", qty: 1 }] }];
  const c = findCraftChains(market, { recipes, npcPrices: { BOWL: { buy: 3 } } }).find((x) => x.id === "OUT");
  assert.ok(c);
  assert.deepEqual(c!.unknownSupply, ["BOWL"]);
});

/* --------------------------------------------------------------- the anvil */

test("an enchantment id splits into its family and level", () => {
  assert.deepEqual(enchantTier("ENCHANTMENT_PROTECTION_3"), { family: "PROTECTION", level: 3 });
  assert.deepEqual(enchantTier("ENCHANTMENT_BANE_OF_ARTHROPODS_5"), { family: "BANE_OF_ARTHROPODS", level: 5 });
  assert.equal(enchantTier("ENCHANTED_CACTUS"), null, "not every id is a book");
});

/**
 * The ladder comes off the market's own ids, so a step exists only where both books are real.
 * The cap is the curated half: the wiki states the sixth level generally comes from Dungeons and
 * Experiments rather than an anvil, and that combining two of them yields a *lower* book.
 */
test("combines stop at the level the wiki says an anvil can reach", () => {
  const market = new Map(
    [1, 2, 3, 4, 5, 6, 7].map((n) => [`ENCHANTMENT_LUCK_${n}`, product(`ENCHANTMENT_LUCK_${n}`, 10, 12, PER_HOUR, PER_HOUR)] as const),
  );
  const steps = combineSteps(market, RULES);
  assert.deepEqual(
    steps.map((s) => s.inputTier).sort((a, b) => a - b),
    [1, 2, 3, 4],
    "four steps, landing at five; nothing offers a sixth",
  );
  assert.ok(steps.every((s) => s.inputsRequired === 2 && s.anvilFeeCoins === 0));
});

test("a combine with no book above it on the market is not offered", () => {
  const market = new Map([["ENCHANTMENT_LUCK_1", product("ENCHANTMENT_LUCK_1", 10, 12, PER_HOUR, PER_HOUR)]]);
  assert.deepEqual(combineSteps(market, RULES), []);
});

/**
 * Two books in, one out, free — so the cost doubles at each rung and the rate halves. Four rungs
 * from a level one is sixteen of them, which is the whole reason a combine chain can be worth
 * finding and also the reason its throughput collapses.
 */
test("a combine doubles the cost and halves the rate at every rung", () => {
  // The upper books have to be dearer than the pair below them, or buying one outright is
  // cheaper and the combine is not a trade — which is the next test.
  const market = new Map<string, ProductSnapshot>([
    ["ENCHANTMENT_X_1", product("ENCHANTMENT_X_1", 100, 110, 1600 * PER_HOUR, 1600 * PER_HOUR)],
    ["ENCHANTMENT_X_2", product("ENCHANTMENT_X_2", 500, 550, 1600 * PER_HOUR, 1600 * PER_HOUR)],
    ["ENCHANTMENT_X_3", product("ENCHANTMENT_X_3", 2_000, 2_200, 1600 * PER_HOUR, 1600 * PER_HOUR)],
  ]);
  const chains = findCraftChains(market, { recipes: [], anvil: RULES });
  const two = chains.find((c) => c.id === "ENCHANTMENT_X_2");
  const three = chains.find((c) => c.id === "ENCHANTMENT_X_3");
  assert.ok(two && three);

  assert.equal(two!.craftCost, 200, "two level-ones at a hundred, and the anvil takes nothing");
  assert.equal(three!.craftCost, 400, "four level-ones, not two level-twos at their asking price");
  assert.equal(two!.inputLimit, 800, "1,600 an hour of the input makes 800 pairs");
  assert.equal(three!.inputLimit, 400);
  assert.equal(three!.depth, 2);
  assert.ok(three!.combines);
});

/**
 * Buying the thing is a path like any other, and often the cheapest one. A finder that always
 * preferred the combine would quote a chain costing twice what the item sells for and rank it as
 * though the coins came back.
 */
test("when the finished book is cheaper than the pair, no chain is offered", () => {
  const market = new Map<string, ProductSnapshot>(
    [1, 2].map((n) => [`ENCHANTMENT_Y_${n}`, product(`ENCHANTMENT_Y_${n}`, 100, 120, PER_HOUR, PER_HOUR)] as const),
  );
  const chains = findCraftChains(market, { recipes: [], anvil: RULES });
  assert.ok(!chains.some((c) => c.id === "ENCHANTMENT_Y_2"), "two at 100 beats one at 100 only in the wrong direction");
});

/** Both edge kinds in one path, which is the case neither a craft table nor a book ladder finds. */
test("a chain runs through a craft and a combine interchangeably", () => {
  const market = new Map([
    ["SUGAR_CANE", product("SUGAR_CANE", 10, 11, 10_000 * PER_HOUR, 10_000 * PER_HOUR)],
    ["ENCHANTMENT_X_1", product("ENCHANTMENT_X_1", 400, 420, 1000 * PER_HOUR, 1000 * PER_HOUR)],
    ["ENCHANTMENT_X_2", product("ENCHANTMENT_X_2", 900, 1_000, 1000 * PER_HOUR, 1000 * PER_HOUR)],
  ]);
  // The book's level one is crafted from cane, then combined up a rung.
  const recipes: Recipe[] = [{ output: "ENCHANTMENT_X_1", yield: 1, ingredients: [{ id: "SUGAR_CANE", qty: 20 }] }];

  const c = findCraftChains(market, { recipes, anvil: RULES }).find((x) => x.id === "ENCHANTMENT_X_2");
  assert.ok(c);
  assert.equal(c!.craftCost, 400, "two level-ones, each twenty cane at ten — cheaper than buying them at 400");
  assert.deepEqual(c!.hops.map((h) => h.kind), ["craft", "combine"]);
  assert.equal(c!.depth, 2);
});

/* ------------------------------------------------------------------ the cut */

test("only chains a single craft could not already find are surfaced", () => {
  const market = new Map([
    ["A", product("A", 10, 11, 1000 * PER_HOUR, 1000 * PER_HOUR)],
    ["B", product("B", 100, 120, 1000 * PER_HOUR, 1000 * PER_HOUR)],
    ["C", product("C", 1_000, 1_200, 1000 * PER_HOUR, 1000 * PER_HOUR)],
  ]);
  const recipes: Recipe[] = [
    { output: "B", yield: 1, ingredients: [{ id: "A", qty: 5 }] },
    { output: "C", yield: 1, ingredients: [{ id: "B", qty: 5 }] },
  ];
  const all = findCraftChains(market, { recipes });
  assert.ok(all.some((c) => c.id === "B" && c.depth === 1));

  const shown = unorthodoxChains(all);
  assert.ok(!shown.some((c) => c.id === "B"), "a one-hop craft is already a row on the Crafts tab");
  assert.ok(shown.some((c) => c.id === "C"), "two hops is not");
});

test("maxDepth stops the walk where it is told to", () => {
  const market = new Map([
    ["A", product("A", 1, 2, 1000 * PER_HOUR, 1000 * PER_HOUR)],
    ["D", product("D", 1_000, 1_200, 1000 * PER_HOUR, 1000 * PER_HOUR)],
  ]);
  const recipes: Recipe[] = [
    { output: "B", yield: 1, ingredients: [{ id: "A", qty: 2 }] },
    { output: "C", yield: 1, ingredients: [{ id: "B", qty: 2 }] },
    { output: "D", yield: 1, ingredients: [{ id: "C", qty: 2 }] },
  ];
  assert.equal(findCraftChains(market, { recipes, maxDepth: 3 }).some((c) => c.id === "D"), true);
  assert.equal(findCraftChains(market, { recipes, maxDepth: 2 }).some((c) => c.id === "D"), false);
});
