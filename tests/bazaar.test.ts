import { test } from "node:test";
import assert from "node:assert/strict";
import { NET_OF_TAX, costToBuy, hourlySold, normalise, proceedsFromSelling, walk } from "../src/lib/bazaar";
import { ORDER_WINDOW_HOURS, affordableCoinsPerHour, badHourCount, crash, craft, flip, manipulation } from "../src/lib/bazaarViews";
import { daily, decode, despike, encode, proximityToAverage, sample, trim } from "../src/lib/bazaarHistory";
import type { HistoryRow, ProductSnapshot, RawBazaarProduct } from "../src/lib/bazaarTypes";

/**
 * The figures below are a real read of ENCHANTED_CACTUS and ICE_HUNK, kept because they are what
 * the relabelling was checked against: every field here was matched one-for-one with what
 * skyblock.bz shows for the same item at the same moment.
 */
const CACTUS: RawBazaarProduct = {
  buy_summary: [
    { amount: 11, pricePerUnit: 103_006.9, orders: 1 },
    { amount: 14, pricePerUnit: 103_007, orders: 1 },
    { amount: 1027, pricePerUnit: 103_007.1, orders: 1 },
  ],
  sell_summary: [
    { amount: 69, pricePerUnit: 100_507.9, orders: 1 },
    { amount: 1396, pricePerUnit: 100_507.8, orders: 2 },
    { amount: 1476, pricePerUnit: 100_507.6, orders: 1 },
  ],
  quick_status: {
    buyPrice: 103_007.109,
    buyVolume: 53_474,
    buyMovingWeek: 213_174,
    buyOrders: 110,
    sellPrice: 100_507.804,
    sellVolume: 22_538,
    sellMovingWeek: 176_065,
    sellOrders: 23,
  },
};

function cactus(): ProductSnapshot {
  const p = normalise("ENCHANTED_CACTUS", CACTUS, 1_787_435_006_965);
  assert.ok(p);
  return p;
}

test("Hypixel's buy side is the sell book, and the names come out the player's way round", () => {
  const p = cactus();

  // The inversion this whole module exists to do once: buy_summary is what you buy *from*, so
  // it is made of sell offers, and its volume is supply rather than demand.
  assert.equal(p.sellBook[0].price, 103_006.9, "cheapest sell offer");
  assert.equal(p.buyBook[0].price, 100_507.9, "richest buy order");
  assert.equal(p.supply, 53_474);
  assert.equal(p.demand, 22_538);
  assert.equal(p.sellOrders, 110, "Hypixel calls these buyOrders");
  assert.equal(p.buyOrders, 23, "Hypixel calls these sellOrders");
});

test("prices quote the best order, not Hypixel's weighted average", () => {
  const p = cactus();
  // 103,007.109 is the average of the top slice of the book. Nobody is selling at it.
  assert.equal(p.instabuy, 103_006.9);
  assert.equal(p.instasell, 100_507.9);
});

test("a walk crosses levels and reports where the book is left", () => {
  const p = cactus();

  const one = costToBuy(p, 11);
  assert.equal(one.coins, 11 * 103_006.9);
  assert.equal(one.priceAfter, 103_007, "the level was cleared, so the next one is on top");

  const across = costToBuy(p, 25);
  assert.equal(across.filled, 25);
  assert.equal(round(across.coins), round(11 * 103_006.9 + 14 * 103_007));
  assert.equal(across.priceAfter, 103_007.1);

  const partial = costToBuy(p, 5);
  assert.equal(partial.priceAfter, 103_006.9, "a partly filled level stays on top");
});

test("a walk past the published depth is short, and says so", () => {
  const p = cactus();
  const deep = costToBuy(p, 1_000_000);
  assert.ok(deep.exhausted, "Hypixel publishes 30 levels; past them we are guessing");
  assert.equal(deep.filled, 11 + 14 + 1027);
  assert.equal(deep.priceAfter, 0, "zero means we cannot see, not that the market is empty");
});

test("an empty book fills nothing rather than dividing by zero", () => {
  const empty = walk([], 100);
  assert.equal(empty.filled, 0);
  assert.equal(empty.average, 0);
  assert.ok(empty.exhausted);
});

test("a flip is rate-limited by its slower leg", () => {
  const p = cactus();
  const f = flip(p);
  assert.ok(f);

  assert.equal(round(f.margin), round(103_006.9 - 100_507.9));
  assert.equal(round(f.netMargin), round(103_006.9 * NET_OF_TAX - 100_507.9), "the sale is taxed");

  // 213,174 bought against 176,065 sold in the week: the sell side is slower, so it sets the
  // round-trip rate. Ranking on the buy side alone would overstate this flip by a fifth.
  assert.equal(f.hourlyFills, 176_065 / 168);
  assert.equal(round(f.coinsPerHour), round(f.netMargin * (176_065 / 168)));
});

test("an empty side of the book is unpriced, not free", () => {
  // Wheat is nine out of one Hay Block, and nobody bids on Hay Blocks. Reading the missing bid
  // as zero quotes the craft as pure profit and puts it at the top of the list; skyblock.bz
  // shows exactly that, with a craft cost of 0.
  const unbid = normalise("HAY_BLOCK", {
    buy_summary: [{ amount: 5, pricePerUnit: 400, orders: 1 }],
    sell_summary: [],
    quick_status: {
      buyPrice: 400,
      buyVolume: 5,
      buyMovingWeek: 90,
      buyOrders: 1,
      sellPrice: 0,
      sellVolume: 0,
      sellMovingWeek: 0,
      sellOrders: 0,
    },
  });
  assert.ok(unbid);
  assert.equal(unbid.instasell, 0, "there is genuinely no bid");
  assert.equal(flip(unbid), null, "and no flip either");

  const market = new Map([["HAY_BLOCK", unbid], ["WHEAT", cactus()]]);
  const recipe = { output: "WHEAT", yield: 9, ingredients: [{ id: "HAY_BLOCK", qty: 1 }] };
  assert.equal(craft(recipe, market), null, "no price is not a low price");
});

test("a flip with no spread is not a flip", () => {
  const crossed = normalise("X", {
    ...CACTUS,
    buy_summary: [{ amount: 1, pricePerUnit: 100, orders: 1 }],
    sell_summary: [{ amount: 1, pricePerUnit: 100, orders: 1 }],
  });
  assert.ok(crossed);
  assert.equal(flip(crossed), null);
});

/**
 * The Shadow Warp problem: a 180M item with a 12M spread and three round trips an hour, which
 * plain coins-per-hour ranks eighth of fifteen hundred flips and nobody with 50M can actually
 * run. Both figures below exist to say so.
 */
function thin(): ProductSnapshot {
  const p = normalise("SHADOW_WARP_SCROLL", {
    buy_summary: [{ amount: 2, pricePerUnit: 195_000_000, orders: 1 }],
    sell_summary: [{ amount: 1, pricePerUnit: 180_000_000, orders: 1 }],
    quick_status: {
      buyPrice: 195_000_000,
      buyVolume: 30,
      buyMovingWeek: 655,
      buyOrders: 12,
      sellPrice: 180_000_000,
      sellVolume: 12,
      sellMovingWeek: 588,
      sellOrders: 9,
    },
  });
  assert.ok(p);
  return p;
}

test("a bad hour is zero for anything that trades once an hour", () => {
  // Poisson(1) puts 37% of its mass on nought, so the quarter-worst hour of a once-an-hour item
  // has no trades in it at all. That is the whole complaint about ranking on a mean.
  assert.equal(badHourCount(1), 0);
  assert.equal(badHourCount(1.4), 1, "and the cliff is where the arithmetic puts it");
  assert.equal(badHourCount(4), 3, "four an hour is usually three");
  assert.equal(badHourCount(0), 0, "an item that never trades cannot have a good hour either");

  // High rates barely move, which is the point: missing one of eight hundred costs nothing.
  const busy = badHourCount(800);
  assert.ok(busy > 780 && busy < 800, `800/hr stays near 800, got ${busy}`);
});

test("a thin flip's bad hour is far below its mean", () => {
  const f = flip(thin());
  assert.ok(f);

  assert.ok(f.hourlyFills < 4, "three and a half round trips an hour");
  assert.ok(f.badHourFills < f.hourlyFills, "a quarter of hours are worse than the mean");
  assert.ok(
    f.badHourCoins < f.coinsPerHour * 0.75,
    `a bad hour should cost this flip a quarter or more, got ${f.badHourCoins} of ${f.coinsPerHour}`,
  );
});

test("a busy flip's bad hour is barely below its mean", () => {
  const f = flip(cactus());
  assert.ok(f);
  // Over a thousand round trips an hour: variance stops mattering.
  assert.ok(f.badHourCoins > f.coinsPerHour * 0.95, "a busy item's bad hour is not much of a hour");
});

test("capital is the order to place, sized to twenty minutes of flow", () => {
  // The worked example: a 10k item taking sixty instasells an hour is twenty items in twenty
  // minutes, so 200k goes in and no more. Anything beyond that is coins queued behind coins.
  const steady = normalise("EXAMPLE", {
    buy_summary: [{ amount: 100, pricePerUnit: 11_000, orders: 1 }],
    sell_summary: [{ amount: 100, pricePerUnit: 10_000, orders: 1 }],
    quick_status: {
      buyPrice: 11_000,
      buyVolume: 100,
      buyMovingWeek: 60 * 168,
      buyOrders: 4,
      sellPrice: 10_000,
      sellVolume: 100,
      sellMovingWeek: 60 * 168,
      sellOrders: 4,
    },
  });
  assert.ok(steady);

  const f = flip(steady);
  assert.ok(f);
  assert.equal(f.hourlyFills, 60);
  assert.equal(f.orderSize, 20, "twenty minutes of sixty an hour");
  assert.equal(f.capital, 200_000);
});

test("an order is sized on round trips, not on how fast you could buy", () => {
  // 280 instasells an hour against 36 instabuys: buying at the pace you can buy hands you
  // ninety-four items in twenty minutes and then three hours of inventory. Size on the slower leg.
  const lopsided = normalise("LOPSIDED", {
    buy_summary: [{ amount: 100, pricePerUnit: 1100, orders: 1 }],
    sell_summary: [{ amount: 100, pricePerUnit: 1000, orders: 1 }],
    quick_status: {
      buyPrice: 1100,
      buyVolume: 100,
      buyMovingWeek: 36 * 168,
      buyOrders: 4,
      sellPrice: 1000,
      sellVolume: 100,
      sellMovingWeek: 280 * 168,
      sellOrders: 4,
    },
  });
  assert.ok(lopsided);

  const f = flip(lopsided);
  assert.ok(f);
  assert.equal(round(f.orderSize), round(36 * ORDER_WINDOW_HOURS), "twelve, not ninety-four");
});

test("sizing to the window makes the return a margin question", () => {
  // Order size very nearly cancels out of coinsPerHour / capital, leaving three turns an hour of
  // the after-tax margin. Volume has not stopped mattering — it sets coinsPerHour, the other
  // ceiling — but the rate your coins earn at is a margin question once the sizing is right.
  const f = flip(cactus());
  assert.ok(f);
  const threeTurns = (f.netMargin / f.buyAt) / ORDER_WINDOW_HOURS;
  assert.ok(Math.abs(f.returnOnCapital / threeTurns - 1) < 0.01, "within a percent on a busy item");
});

test("an item too thin to size down says so in its capital", () => {
  const f = flip(thin());
  assert.ok(f);

  // Three and a half round trips an hour is 1.2 items in twenty minutes, and you cannot order
  // 1.2 items. One unit of a 181M item is the floor, and it is most of an hour's flow.
  assert.equal(f.orderSize, 1);
  assert.equal(f.capital, f.buyAt);
  assert.ok(f.orderSize > f.hourlyFills * ORDER_WINDOW_HOURS * 0.5, "the floor is doing the work");
});

test("a budget caps what a flip can pay you, and no budget means no cap", () => {
  const f = flip(cactus());
  assert.ok(f);

  assert.equal(affordableCoinsPerHour(f, null), f.coinsPerHour, "unasked is unlimited");

  // Enough for the whole window: the market's own rate is the binding ceiling.
  assert.equal(round(affordableCoinsPerHour(f, f.capital * 10)), round(f.coinsPerHour));

  // Enough for a tenth of the order: a tenth of the rate.
  const tenth = affordableCoinsPerHour(f, f.capital / 10);
  assert.ok(
    Math.abs(tenth / (f.coinsPerHour / 10) - 1) < 0.05,
    `a tenth of the order earns about a tenth, got ${tenth} against ${f.coinsPerHour / 10}`,
  );
});

test("a book measured in hours tells a market from a straggler", () => {
  // Turtlellini as it stood: 127 items of supply against six hundred instabuys an hour, holding
  // up an ask five times the bid. Eleven minutes of book is not a price.
  const drained = normalise("TURTLELLINI", {
    buy_summary: [{ amount: 1, pricePerUnit: 457_178, orders: 1 }],
    sell_summary: [{ amount: 160, pricePerUnit: 71_793, orders: 1 }],
    quick_status: {
      buyPrice: 457_178,
      buyVolume: 127,
      buyMovingWeek: 111_172,
      buyOrders: 6,
      sellPrice: 71_793,
      sellVolume: 464_758,
      sellMovingWeek: 134_796,
      sellOrders: 900,
    },
  });
  assert.ok(drained);

  const f = flip(drained);
  assert.ok(f);
  assert.ok(f.supplyHours * 60 < 15, `the sell side is minutes deep, got ${f.supplyHours * 60}`);
  assert.ok(f.demandHours > 100, "while the buy side is weeks deep");
  assert.equal(f.bookHours, f.supplyHours, "the thinner side is the one that matters");

  // The same measure on a working market runs to hours, which is what makes them comparable.
  const healthy = flip(cactus());
  assert.ok(healthy);
  assert.ok(healthy.bookHours > 1, `a real book holds hours, got ${healthy.bookHours}`);
});

test("a flip you cannot afford one of pays nothing, not a fraction", () => {
  const f = flip(thin());
  assert.ok(f);

  // 181M an item. Someone holding 50M does not earn a quarter of it; they cannot place the order.
  assert.equal(affordableCoinsPerHour(f, 50_000_000), 0);
  assert.equal(affordableCoinsPerHour(f, f.buyAt - 1), 0, "one coin short is short");
  assert.equal(round(affordableCoinsPerHour(f, f.buyAt)), round(f.coinsPerHour), "and one is the whole order");
});

/**
 * ICE_HUNK's buy book, top-heavy in the way that makes a crash cheap: 1,567 items at 2,589.2
 * with the next bid down at 1,205. skyblock.bz priced this exact book at 899,260.5 and the walk
 * below reproduces it to the coin, which is where the 2.25% tax figure came from.
 */
const ICE: RawBazaarProduct = {
  sell_summary: [
    { amount: 1567, pricePerUnit: 2589.2, orders: 1 },
    { amount: 71_680, pricePerUnit: 1205, orders: 2 },
    { amount: 98_213, pricePerUnit: 1202, orders: 3 },
  ],
  buy_summary: [
    { amount: 500, pricePerUnit: 3087, orders: 1 },
    { amount: 1200, pricePerUnit: 3110.4, orders: 2 },
    { amount: 5000, pricePerUnit: 3140, orders: 3 },
  ],
  quick_status: {
    buyPrice: 3087,
    buyVolume: 40_000,
    buyMovingWeek: 120_000,
    buyOrders: 40,
    sellPrice: 2589.2,
    sellVolume: 171_460,
    sellMovingWeek: 362_000,
    sellOrders: 12,
  },
};

test("crashing costs what the round trip through both books loses", () => {
  const p = normalise("ICE_HUNK", ICE);
  assert.ok(p);

  const plan = crash(p);
  assert.ok(plan);

  // Clear the top bid and the price falls to the next one down. That is the crash.
  assert.equal(plan.partial.items, 1567);
  assert.equal(plan.partial.priceBefore, 2589.2);
  assert.equal(plan.partial.priceAfter, 1205);

  const bought = costToBuy(p, 1567).coins;
  const dumped = proceedsFromSelling(p, 1567).coins;
  assert.equal(round(plan.partial.cost), round(bought - dumped * NET_OF_TAX));

  const caught = hourlySold(p) * 0.5 * (1 / 3);
  assert.equal(round(plan.partial.estimatedProfit), round(caught * (2589.2 - 1205) - plan.partial.cost));
});

test("a crash too deep to price is null, not a number with a guess in it", () => {
  const p = normalise("ICE_HUNK", ICE);
  assert.ok(p);
  // The whole buy book is 171,460 items and the visible sell book holds a fraction of that.
  assert.equal(crash(p)?.full, null);
});

test("a buyout's risk takes the shopkeeper as a floor under the book", () => {
  const p = normalise("JUNK", {
    sell_summary: [{ amount: 1000, pricePerUnit: 0.2, orders: 1 }],
    buy_summary: [{ amount: 1000, pricePerUnit: 0.22, orders: 1 }],
    quick_status: {
      buyPrice: 0.22,
      buyVolume: 1000,
      buyMovingWeek: 10,
      buyOrders: 1,
      sellPrice: 0.2,
      sellVolume: 1000,
      sellMovingWeek: 10,
      sellOrders: 1,
    },
  });
  assert.ok(p);

  const bookOnly = manipulation(p);
  assert.ok(bookOnly);
  assert.equal(round(bookOnly.full.risk), round(220 - 200 * NET_OF_TAX), "1,000 items, dumped");

  // A shopkeeper paying 1 coin each recovers 1,000 and turns a losing buyout into free money.
  const withShop = manipulation(p, { sell: 1 });
  assert.ok(withShop);
  assert.equal(round(withShop.full.risk), round(220 - 1000));
  assert.ok(withShop.full.risk < 0, "negative risk is the whole point of the list");
});

test("a book too deep to own is not a manipulation candidate", () => {
  const p = cactus();
  assert.equal(manipulation(p), null, "110 sell orders is past what Hypixel even publishes");
});

/* --------------------------------------------------------------- history */

test("delta rows round-trip through absolute samples", () => {
  const rows: HistoryRow[] = [
    [178_734_868.698, 103_623.1, 100_185.8, 26_166, 59_662, 216_781, 163_452],
    [2, 0, 0, 0, -1, 0, 1],
    [2.1, -0.1, 0.1, 0, -12, 0, 12],
  ];

  const series = decode(rows);
  assert.equal(series.length, 3);
  assert.equal(series[0].at, 1_787_348_686_980);
  assert.equal(series[0].values.instabuy, 103_623.1);
  assert.equal(series[2].values.instabuy, 103_623, "two deltas applied, not re-accumulated drift");
  assert.equal(series[2].values.demand, 59_662 - 1 - 12);

  assert.deepEqual(encode(series), rows);
});

test("the window forgets from the front", () => {
  const series = [0, 1, 2, 3].map((i) => ({
    at: i * 3_600_000,
    values: { instabuy: i, instasell: i, supply: i, demand: i, weeklyBought: i, weeklySold: i },
  }));

  const kept = trim(series, 2 * 3_600_000);
  assert.equal(kept.length, 3, "the newest sample plus two hours behind it");
  assert.equal(kept[0].values.instabuy, 1);
});

test("a day keeps its last read, so the rollup survives the trim", () => {
  const day = 86_400_000;
  const series = [
    { at: day * 5, values: values(10) },
    { at: day * 5 + 3_600_000, values: values(12) },
    { at: day * 6, values: values(20) },
  ];

  const rolled = daily(series);
  assert.equal(rolled.length, 2);
  assert.equal(rolled[0].values.instabuy, 12, "the last read of the day, not the mean");
  assert.equal(rolled[0].at, day * 5);
});

test("proximity reads as a percentage away from the item's own average", () => {
  const history = [values(100), values(200), values(300)].map((v, i) => ({ at: i, values: v }));
  assert.equal(proximityToAverage(200, history, "instabuy"), 0, "average is the zero point");
  assert.equal(proximityToAverage(100, history, "instabuy"), -50);
  assert.equal(proximityToAverage(400, history, "instabuy"), 100);
  assert.equal(proximityToAverage(100, [], "instabuy"), null, "no history, no comparison");
});

test("one manipulated day does not flatten six years of chart", () => {
  const series = [values(100), values(100_000), values(100)].map((v, i) => ({ at: i, values: v }));
  const clean = despike(series, "instabuy");
  assert.equal(clean[1].values.instabuy, 300, "pulled back to what its neighbours suggest");
  assert.equal(clean[0].values.instabuy, 100, "the ends have no neighbours and are left alone");
  assert.equal(clean[2].values.instabuy, 100);
});

test("a snapshot samples the six series the history tracks", () => {
  const p = cactus();
  const s = sample(p);
  assert.equal(s.at, p.at);
  assert.deepEqual(s.values, {
    instabuy: 103_006.9,
    instasell: 100_507.9,
    supply: 53_474,
    demand: 22_538,
    weeklyBought: 213_174,
    weeklySold: 176_065,
  });
});

function values(n: number) {
  return { instabuy: n, instasell: n, supply: n, demand: n, weeklyBought: n, weeklySold: n };
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
