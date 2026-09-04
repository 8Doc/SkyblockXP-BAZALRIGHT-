import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
// @ts-expect-error - a plain build script, imported for its pure parsers only.
import { cellItems, parseRecipes } from "../scripts/fetch-minion-recipes.mjs";
import { buyPriceOf, craftCostOf, paybackDays } from "../src/lib/minionCraft";
import type { MinionRecipes } from "../src/lib/minionCraft";

const recipes = JSON.parse(readFileSync("data/generated/minion-recipes.json", "utf8")) as MinionRecipes & {
  disagreements: string[];
  mismatched: string[];
};

/* ------------------------------------------------------------- the scrape */

test("a quantity is read off the count, not off the prose beside it", () => {
  // The cell spells out "1 stack plus 16" in an abbr and the number lives in a styled span, so
  // reading the cell's text would find 1, 16 and 80 and have to guess which is the count.
  const cell = `<li><span class="spriteicon"><a href="/w/Cobblestone" title="Cobblestone"><img/></a></span>
    <abbr title="1 stack plus 16 (80 in total)"><span class="light-color color-green">80x</span></abbr>
    <a href="/w/Cobblestone" title="Cobblestone">Cobblestone</a></li>`;
  assert.deepEqual(cellItems(cell), [{ item: "Cobblestone", qty: 80 }]);

  // Past a thousand the wiki writes a separator, which is not part of the number.
  const big = `<span class="light-color color-green">1,024x</span> <a href="/w/X" title="Enchanted Cobblestone">x</a>`;
  assert.deepEqual(cellItems(big), [{ item: "Enchanted Cobblestone", qty: 1024 }]);
});

test("a table whose rows stop pairing up is rejected rather than half-read", () => {
  // Each tier is two rows — the upgrade, then the total — so an odd row count means the parse has
  // slipped, and half a recipe ladder is worse than none.
  const odd = `article-msTable"><tr><th>Tier</th></tr><tr><td><span class="light-color color-green">4x</span> <a title="Coal">c</a></td><td>x</td><td>x</td></tr>`;
  assert.equal(parseRecipes(odd), null);
  assert.equal(parseRecipes("<p>no table here</p>"), null);
});

/* ------------------------------------------------------------ the ladder */

test("the ladder is cumulative and a nested minion is written out", () => {
  const revenant = recipes.minions.find((m) => m.generator === "REVENANT")!;
  const eleven = revenant.tiers.find((t) => t.tier === 11)!;

  // The upgrade cell says "1x Zombie Minion" and no tier, which prices nothing. The cumulative has
  // those eleven zombie minions as the rotten flesh they were made of.
  assert.ok(eleven.upgrade.some((u) => u.item === "Zombie Minion" && u.itemId === null));
  assert.ok(eleven.cumulative.some((c) => c.itemId === "ROTTEN_FLESH" && c.qty > 8000));
  assert.ok(!eleven.cumulative.some((c) => / Minion$/.test(c.item)));

  // And the items no bazaar prices are still in the bill rather than quietly free.
  assert.ok(eleven.cumulative.some((c) => c.item === "Crystallized Heart" && c.itemId === null));
});

test("the tools the published cumulative drops are added back", () => {
  // A Cobblestone Minion I is 80 cobblestone and a wooden pickaxe. The wiki's cumulative column
  // carries only the cobblestone, because it lists what the bazaar prices.
  const cobble = recipes.minions.find((m) => m.generator === "COBBLESTONE")!;
  const twelve = cobble.tiers.find((t) => t.tier === 12)!;
  assert.ok(twelve.cumulative.some((c) => c.itemId === "WOOD_PICKAXE" && c.qty === 1));
  assert.equal(twelve.cumulative.find((c) => c.itemId === "ENCHANTED_COBBLESTONE")?.qty, 2040);
  assert.equal(twelve.cumulative.find((c) => c.itemId === "COBBLESTONE")?.qty, 1072);
});

test("a published total that contradicts its own arithmetic is corrected, and recorded", () => {
  // The Inferno Minion's Tier XI row doubles the ashe and the blaze rods against its own Tier X
  // row. The cross-check is the only reason anybody would notice.
  const inferno = recipes.minions.find((m) => m.generator === "INFERNO")!;
  const eleven = inferno.tiers.find((t) => t.tier === 11)!;
  assert.equal(eleven.cumulative.find((c) => c.item === "Derelict Ashe")?.qty, 400);
  assert.equal(eleven.cumulative.find((c) => c.item === "Molten Powder")?.qty, 1272);
  assert.ok(recipes.disagreements.some((d) => /Inferno Minion tier 11/.test(d)));
});

test("a minion nobody crafts says so rather than costing nothing", () => {
  // The Snow Minion comes out of Gifts. A row of zeroes would read as free, which is a stronger
  // claim than the page makes.
  assert.ok(recipes.noRecipe.includes("Snow Minion"));
  assert.equal(
    recipes.minions.find((m) => m.generator === "SNOW"),
    undefined,
  );
  assert.equal(craftCostOf("SNOW", 12, recipes, () => 1), null);
});

test("every minion's ladder covers every tier it has", () => {
  assert.deepEqual(recipes.mismatched, []);
});

/* -------------------------------------------------------------- the bill */

const priced: MinionRecipes = {
  noRecipe: [],
  minions: [
    {
      generator: "TEST",
      family: "Test Minion",
      tiers: [
        { tier: 1, upgrade: [], cumulative: [{ item: "Cheap", itemId: "CHEAP", qty: 100 }] },
        {
          tier: 2,
          upgrade: [],
          cumulative: [
            { item: "Cheap", itemId: "CHEAP", qty: 300 },
            { item: "Dear", itemId: "DEAR", qty: 2 },
            { item: "Unpriceable", itemId: null, qty: 1 },
          ],
        },
      ],
    },
  ],
};
const price = (id: string): number | null => ({ CHEAP: 5, DEAR: 1_000 })[id] ?? null;

test("the bill is the cumulative cost, dearest line first", () => {
  const cost = craftCostOf("TEST", 2, priced, price)!;
  assert.equal(cost.coins, 300 * 5 + 2 * 1_000);
  assert.equal(cost.lines[0].item, "Dear");
  assert.equal(cost.lines[0].coins, 2_000);
});

test("an ingredient nothing prices is reported, not treated as free", () => {
  const cost = craftCostOf("TEST", 2, priced, price)!;
  assert.equal(cost.unpriced.length, 1);
  assert.equal(cost.unpriced[0].item, "Unpriceable");
  // It still appears in the bill, at no coins, so the reader can see what is missing.
  assert.ok(cost.lines.some((l) => l.item === "Unpriceable" && l.unit === null));
});

test("a tier the minion does not have answers with the tier it stops at", () => {
  // Asking a Tier XII question of an eleven-tier minion is a real thing the tabs do, since the
  // setup carries one tier for every minion on the page.
  assert.equal(craftCostOf("TEST", 12, priced, price)!.tier, 2);
  assert.equal(craftCostOf("TEST", 1, priced, price)!.coins, 500);
  assert.equal(craftCostOf("MISSING", 1, priced, price), null);
});

test("materials are priced at what buying costs, not at what selling fetches", () => {
  const market = new Map([["X", { instabuy: 12 }]]);
  const npc: Record<string, { buy?: number; sell?: number }> = { Y: { buy: 30, sell: 3 }, Z: { sell: 9 } };
  const priceOf = buyPriceOf(market, npc);
  assert.equal(priceOf("X"), 12);
  // No bazaar for it, so the shopkeeper's asking price stands in.
  assert.equal(priceOf("Y"), 30);
  // A shop that only buys is not a shop you can buy from.
  assert.equal(priceOf("Z"), null);
  assert.equal(priceOf("NOTHING"), null);
});

test("payback is the cost over the income, and never negative", () => {
  assert.equal(paybackDays(1_000, 100), 10);
  assert.equal(paybackDays(0, 100), 0);
  assert.equal(paybackDays(1_000, 0), Infinity);
});
