import { test } from "node:test";
import assert from "node:assert/strict";
import { ORDER_WINDOW_HOURS, craft, flip } from "../src/lib/bazaarViews";
import { capitalFor, rankOpportunities } from "../src/lib/bazaarRanking";
import { findCraftChains } from "../src/lib/bazaarChains";
import { price } from "../src/lib/bazaarSubmissions";
import type { Submission } from "../src/lib/bazaarSubmissions";
import type { ProductSnapshot } from "../src/lib/bazaarTypes";
import type { Recipe } from "../src/lib/bazaarViews";

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

const PER_HOUR = 168;

/* ------------------------------------------------------------- the axis */

/**
 * The reason this module exists. Coins per hour makes a big slow trade beat a small fast one,
 * and the small fast one is the better answer for anyone whose coins are the constraint — which
 * is everyone, or they would not be reading a flip list.
 */
test("return on capital reorders what coins-per-hour ranks", () => {
  const flips = [
    // Huge, slow, expensive: 40M an hour, but it takes hundreds of millions to run.
    flip(product("WHALE", 10_000_000, 12_000_000, 20 * PER_HOUR, 20 * PER_HOUR))!,
    // Small, quick, cheap: less an hour, far less tied up.
    flip(product("MINNOW", 100, 130, 2_000 * PER_HOUR, 2_000 * PER_HOUR))!,
  ];
  assert.ok(flips[0].coinsPerHour > flips[1].coinsPerHour, "the whale wins on coins per hour");

  const ranked = rankOpportunities({ flips });
  assert.equal(ranked[0].id, "MINNOW", "and loses on what those coins had to be");
  assert.ok(ranked[0].returnOnCapital > ranked[1].returnOnCapital);
});

/** Every source sizes capital the same way, or the ratio compares the rules and not the trades. */
test("capital is twenty minutes of the trade's own flow, whatever kind it is", () => {
  assert.equal(capitalFor(100, 60), 100 * 60 * ORDER_WINDOW_HOURS, "60 an hour is 20 in twenty minutes");
  assert.equal(capitalFor(100, 0.5), 100, "never less than one item — you cannot make half of one");
});

test("a flip's capital is the one the flip already computed", () => {
  const f = flip(product("X", 100, 130, 500 * PER_HOUR, 500 * PER_HOUR))!;
  const [row] = rankOpportunities({ flips: [f] });
  assert.equal(row.capital, f.capital, "not recomputed, or the two tables would disagree");
  assert.equal(row.returnOnCapital, f.returnOnCapital);
});

test("a craft and a chain are sized on what producing one costs", () => {
  const market = new Map([
    ["IN", product("IN", 10, 11, 10_000 * PER_HOUR, 10_000 * PER_HOUR)],
    ["OUT", product("OUT", 1_000, 1_200, 60 * PER_HOUR, 60 * PER_HOUR)],
  ]);
  const recipe: Recipe = { output: "OUT", yield: 1, ingredients: [{ id: "IN", qty: 10 }] };
  const c = craft(recipe, market)!;
  const [row] = rankOpportunities({ crafts: [c] });
  assert.equal(row.capital, capitalFor(c.craftCost, c.bottleneck));
  assert.equal(row.source, "craft");
});

/** Each row has to say where it came from, or a reader cannot open the detail behind it. */
test("every row is tagged with the view that produced it", () => {
  const market = new Map([
    ["A", product("A", 10, 11, 1_000 * PER_HOUR, 1_000 * PER_HOUR)],
    ["B", product("B", 100, 130, 1_000 * PER_HOUR, 1_000 * PER_HOUR)],
    ["C", product("C", 1_000, 2_000, 100 * PER_HOUR, 100 * PER_HOUR)],
  ]);
  const recipes: Recipe[] = [
    { output: "B", yield: 1, ingredients: [{ id: "A", qty: 2 }] },
    { output: "C", yield: 1, ingredients: [{ id: "B", qty: 2 }] },
  ];
  const ranked = rankOpportunities({
    flips: [flip(market.get("B")!)!],
    crafts: [craft(recipes[0], market)!],
    chains: findCraftChains(market, { recipes }).filter((c) => c.depth >= 2),
    npcFlips: [{ id: "A", buyAt: 10, npcPrice: 14, margin: 4, coinsPerHour: 4 * 1_000, maxProfit: 1e9, hoursBeforeLimited: 5 }],
  });
  assert.deepEqual(new Set(ranked.map((r) => r.source)), new Set(["flip", "craft", "chain", "npc"]));
});

/**
 * A trade with no capital behind it is a missing number, not an infinite return — and infinity
 * sorts to the top, which is the one place a reader is most likely to believe it.
 */
test("a row with no capital is dropped rather than ranked first", () => {
  const ranked = rankOpportunities({
    npcFlips: [{ id: "FREE", buyAt: 0, npcPrice: 10, margin: 10, coinsPerHour: 1_000, maxProfit: 1e9, hoursBeforeLimited: 1 }],
  });
  assert.equal(ranked.length, 0);
});

test("a losing trade is not ranked at all", () => {
  const f = flip(product("X", 100, 130, 500 * PER_HOUR, 500 * PER_HOUR))!;
  assert.equal(rankOpportunities({ flips: [{ ...f, coinsPerHour: -50 }] }).length, 0);
});

/* -------------------------------------------------------- submissions */

const MARKET = () =>
  new Map([
    ["SUGAR_CANE", product("SUGAR_CANE", 10, 12, 10_000 * PER_HOUR, 10_000 * PER_HOUR)],
    ["HOT_POTATO_BOOK", product("HOT_POTATO_BOOK", 5_000, 6_000, 100 * PER_HOUR, 100 * PER_HOUR)],
  ]);

const RECIPES: Recipe[] = [
  { output: "PAPER", yield: 3, ingredients: [{ id: "SUGAR_CANE", qty: 3 }] },
  { output: "HOT_POTATO_BOOK", yield: 1, ingredients: [{ id: "PAPER", qty: 20 }] },
];

const submission = (over: Partial<Submission> = {}): Submission => ({
  id: "s1",
  sells: "HOT_POTATO_BOOK",
  buys: [{ id: "SUGAR_CANE", qty: 60 }],
  steps: [{ kind: "craft", output: "PAPER" }, { kind: "craft", output: "HOT_POTATO_BOOK" }],
  submittedAt: 0,
  ...over,
});

/**
 * The submitted figure is never the answer. Somebody's route was true when they wrote it down and
 * the prices have moved since; repeating their number is worse than not having it, because it
 * looks checked.
 */
test("a submission is priced from the market, not from what it claims", () => {
  const priced = price(submission({ claimedCoinsPerHour: 999_999_999 }), MARKET(), { recipes: RECIPES });
  assert.ok(priced.chain, "the route prices");
  assert.equal(priced.chain!.craftCost, 200, "the same 200 the chain finder gets, not the claim");
  assert.equal(priced.problem, null);
  assert.ok(priced.driftPercent !== null && priced.driftPercent < -99, "and it says how far off the claim now is");
});

test("a submission whose margin has gone is kept and marked, not dropped", () => {
  const market = MARKET();
  // The finished item collapses below what its ingredients cost.
  market.set("HOT_POTATO_BOOK", product("HOT_POTATO_BOOK", 50, 60, 100 * PER_HOUR, 100 * PER_HOUR));
  const priced = price(submission(), market, { recipes: RECIPES });
  assert.ok(priced.chain, "still priced");
  assert.match(priced.problem ?? "", /Underwater/, "and told plainly that it no longer works");
});

test("a submission naming something the bazaar does not trade says so", () => {
  const priced = price(submission({ sells: "NOT_A_THING" }), MARKET(), { recipes: RECIPES });
  assert.equal(priced.chain, null);
  assert.match(priced.problem ?? "", /does not trade/);
});

test("a submission whose ingredient nobody bids on is not priced at zero", () => {
  const priced = price(submission({ buys: [{ id: "NOBODY_BIDS", qty: 1 }] }), MARKET(), { recipes: RECIPES });
  assert.equal(priced.chain, null);
  assert.match(priced.problem ?? "", /No price for/);
});

/**
 * A plain flip is a legitimate thing to submit and the chain finder will never return it — it
 * only reports items it can *make* — so it is priced directly rather than rejected as unroutable.
 */
test("a submitted plain flip is priced like a flip", () => {
  const market = MARKET();
  const priced = price(
    submission({ sells: "SUGAR_CANE", buys: [{ id: "SUGAR_CANE", qty: 1 }], steps: [] }),
    market,
    { recipes: RECIPES },
  );
  assert.ok(priced.chain);
  assert.equal(priced.chain!.depth, 0);
  const f = flip(market.get("SUGAR_CANE")!)!;
  assert.equal(priced.chain!.margin, f.netMargin, "the same margin the Flips tab quotes");
  assert.equal(priced.chain!.coinsPerHour, f.coinsPerHour);
});
