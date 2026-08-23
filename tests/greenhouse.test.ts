import { test } from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error - a plain build script, imported for its pure parsers only.
import { nameKey, parseChance, parseItemList, parsePlantNotes, parseSpreading } from "../scripts/fetch-greenhouse.mjs";
import {
  buyPrice,
  cheapestSetup,
  fortuneMultiplier,
  plantsFor,
  profitOf,
  rankMutations,
  stageSeconds,
  stagesPerHarvest,
  unitPrice,
} from "../src/lib/greenhouse";
import type { GreenhouseData, Mutation } from "../src/lib/greenhouse";
import { NET_OF_TAX } from "../src/lib/bazaar";
import type { ProductSnapshot } from "../src/lib/bazaarTypes";
import greenhouseJson from "../data/generated/greenhouse.json";

const data = greenhouseJson as unknown as GreenhouseData;

function product(id: string, instasell: number, instabuy: number): ProductSnapshot {
  return {
    id,
    at: 0,
    instabuy,
    instasell,
    supply: 1e6,
    demand: 1e6,
    weeklyBought: 1e6,
    weeklySold: 1e6,
    sellOrders: 10,
    buyOrders: 10,
    sellBook: [{ amount: 1e6, orders: 1, price: instabuy }],
    buyBook: [{ amount: 1e6, orders: 1, price: instasell }],
  };
}

/* -------------------------------------------------------------- the clock */

/**
 * The Greenhouse page publishes both the formula and the number it lands on with everything
 * maxed, which makes it self-checking: four hours flat, down to 1h 41m 3s. Reproducing the second
 * from the first is the evidence that the terms are in the right places.
 */
test("a growth stage is four hours, and 6,063 seconds fully upgraded", () => {
  const none = stageSeconds(data, { uniqueCrops: 0, cropGrowth: 0, speedAttribute: 0, growthSpeedUpgrade: 0 });
  assert.equal(none, 14_400, "four hours with nothing invested");

  const maxed = stageSeconds(data, { uniqueCrops: 12, cropGrowth: 210, speedAttribute: 10, growthSpeedUpgrade: 9 });
  assert.equal(Math.round(maxed), 6_063, "the wiki states 1h 41m 3s");
});

/**
 * The upgrade term has a step in it: five percent a tier up to eight, then fifty rather than the
 * forty-five the pattern would give. So the ninth tier is worth double a normal one — not, as it
 * is tempting to say, worth more than the eight below it, which the reciprocal shape of the
 * formula makes plainly false.
 */
test("the ninth growth upgrade is worth two tiers, not eight", () => {
  const bonusAt = (u: number) => (u >= 9 ? 0.5 : 0.05 * u);
  assert.equal(bonusAt(8), 0.4);
  assert.equal(bonusAt(9), 0.5);
  assert.equal(bonusAt(9) - bonusAt(8), 2 * (bonusAt(8) - bonusAt(7)), "double a normal tier");

  const at = (growthSpeedUpgrade: number) =>
    stageSeconds(data, { uniqueCrops: 0, cropGrowth: 0, speedAttribute: 0, growthSpeedUpgrade });
  assert.ok(at(9) < at(8), "and it does still shorten the stage");
  assert.ok(at(9) > at(8) - (at(0) - at(8)), "but not by more than the whole climb before it");
});

/**
 * Two waits, and for most of the list the first one dominates. A mutation rolls against its own
 * chance every stage, so the expected wait to appear is the reciprocal — and most commons then
 * need no growing at all.
 */
test("a harvest waits for the mutation to appear and then to grow", () => {
  const m = { chance: 0.25, growthStages: 4 } as Mutation;
  assert.equal(stagesPerHarvest(m), 8, "four stages to appear at 25%, four more to grow");

  assert.equal(stagesPerHarvest({ chance: 0.3, growthStages: 0 } as Mutation), 1 / 0.3, "a common is ready when it lands");
});

/** A blank chance is a mutation needing a special act, not one that never happens. */
test("no published chance means no cycle time, not an infinite one", () => {
  assert.equal(stagesPerHarvest({ chance: null, growthStages: 0 } as Mutation), null);
  assert.equal(stagesPerHarvest({ chance: 0, growthStages: 0 } as Mutation), null);
});

/* --------------------------------------------------------------- the ring */

/**
 * The caveat this whole feature turns on. A spreading condition counts cells of the 3x3 ring
 * around the spot, and a plant bigger than one cell fills more than one of them — so a 2x2
 * mutation asked for three times is bought twice, not three times.
 *
 * The wiki works exactly this out in footnotes for the six cases where it bites, and those are
 * used verbatim; the general rule agrees with all six.
 */
test("a bigger plant fills more of the ring, so fewer are bought", () => {
  const oneByOne = { cellsPerPlant: 1 } as Mutation;
  const twoByTwo = { cellsPerPlant: 2 } as Mutation;
  const threeByThree = { cellsPerPlant: 3 } as Mutation;

  assert.equal(plantsFor({ id: "X", name: "X", cells: 4 }, oneByOne, {}), 4, "four cells of a plain crop is four plants");
  assert.equal(plantsFor({ id: "X", name: "X", cells: 4 }, twoByTwo, {}), 2, "a 2x2 covers two cells apiece");
  assert.equal(plantsFor({ id: "X", name: "X", cells: 3 }, twoByTwo, {}), 2, "three cells still takes two of them");
  assert.equal(plantsFor({ id: "X", name: "X", cells: 6 }, threeByThree, {}), 2, "a 3x3 covers three");
});

test("the wiki's own worked cases are used rather than re-derived", () => {
  // "This means 3 total blocks of Noctilumes. In practice, this can be achieved using 2."
  const notes = { NOCTILUME: { cells: 3, plants: 2 } };
  assert.equal(plantsFor({ id: "NOCTILUME", name: "Noctilume", cells: 3 }, { cellsPerPlant: 2 } as Mutation, notes), 2);
  // A note for a different cell count does not apply to this condition.
  assert.equal(plantsFor({ id: "NOCTILUME", name: "Noctilume", cells: 8 }, { cellsPerPlant: 2 } as Mutation, notes), 4);
});

/** Every footnote the wiki wrote should agree with the general rule, or one of them is wrong. */
test("every published footnote agrees with ceil(cells / plant size)", () => {
  const byId = new Map(data.mutations.map((m) => [m.id, m]));
  let checked = 0;
  for (const m of data.mutations) {
    for (const [id, note] of Object.entries(m.plantNotes ?? {})) {
      const required = byId.get(id);
      assert.ok(required, `${m.name} cites ${id}, which is not a mutation`);
      assert.equal(
        Math.ceil(note.cells / required!.cellsPerPlant),
        note.plants,
        `${m.name} needs ${note.cells} cells of ${id} (${required!.size}x${required!.size}); the wiki says ${note.plants} plants`,
      );
      checked++;
    }
  }
  assert.ok(checked >= 6, `only ${checked} footnotes found; the page had six`);
});

/* -------------------------------------------------------------- the money */

test("a price is the bid after tax, or the shopkeeper, whichever pays more", () => {
  const market = new Map([["WHEAT", product("WHEAT", 100, 120)]]);
  assert.equal(unitPrice("WHEAT", market, {}), 120 * NET_OF_TAX, "sold into the buy book, taxed");
  assert.equal(unitPrice("WHEAT", market, { WHEAT: { sell: 500 } }), 500, "the shop pays more and takes no tax");
  assert.equal(unitPrice("NOTHING", market, {}), null, "no price is not a price of zero");
});

test("buying takes the cheaper of the bazaar and the shop", () => {
  const market = new Map([["WHEAT", product("WHEAT", 100, 120)]]);
  assert.equal(buyPrice("WHEAT", market, {}), 100);
  assert.equal(buyPrice("WHEAT", market, { WHEAT: { buy: 40 } }), 40);
});

/**
 * The slash in "Soggybud x4 / Choconut x4" is an *or*, and which side is cheaper is a live price
 * question rather than a property of the mutation — so it is answered per call, against the
 * market, the same way the bazaar's craft alternatives are.
 */
test("the cheaper of two spreading options is the one costed", () => {
  const m = {
    spreading: {
      raw: "",
      prose: false,
      options: [
        { id: "DEAR", name: "Dear", cells: 4 },
        { id: "CHEAP", name: "Cheap", cells: 4 },
      ],
    },
    plantNotes: {},
  } as unknown as Mutation;
  const market = new Map([
    ["DEAR", product("DEAR", 1_000, 1_100)],
    ["CHEAP", product("CHEAP", 10, 11)],
  ]);
  const setup = cheapestSetup(m, new Map(), market, {});
  assert.equal(setup?.option.id, "CHEAP");
  assert.equal(setup?.coins, 40, "four plants at ten");
});

test("a free requirement costs nothing rather than going unpriced", () => {
  const m = {
    spreading: { raw: "", prose: false, options: [{ id: "FIRE", name: "Fire", cells: 2, free: true }] },
    plantNotes: {},
  } as unknown as Mutation;
  assert.equal(cheapestSetup(m, new Map(), new Map(), {})?.coins, 0);
});

/* ------------------------------------------------------------ the ranking */

const GROWTH = { uniqueCrops: 12, cropGrowth: 210, speedAttribute: 10, growthSpeedUpgrade: 9 };

/**
 * The most useful thing to know before arguing about your own Farming Fortune: it multiplies
 * every mutation's drops by the same factor, so it changes what a row pays and never which row is
 * best. A wrong fortune makes every figure wrong by the same proportion and leaves the answer to
 * "which one should I grow" exactly where it was.
 */
test("fortune scales every row and reorders none of them", () => {
  const market = new Map<string, ProductSnapshot>();
  for (const m of data.mutations) for (const d of m.drops) market.set(d.id, product(d.id, 100, 120));
  market.set("ETHEREAL_VINE", product("ETHEREAL_VINE", 1_000, 1_200));

  const at = (farmingFortune: number) =>
    rankMutations(data, { market, growth: GROWTH, farmingFortune }).filter((r) => r.coinsPerHour !== null);

  const low = at(100);
  const high = at(2_000);
  assert.deepEqual(high.map((r) => r.id), low.map((r) => r.id), "the order is identical");

  // And the scaling is the ratio of the two multipliers, applied uniformly.
  const ratio = fortuneMultiplier(2_000) / fortuneMultiplier(100);
  const first = high[0].revenue / low[0].revenue;
  assert.ok(Math.abs(first - ratio) < 1e-9, `${first} vs ${ratio}`);
});

test("fortune is a hundred per extra drop", () => {
  assert.equal(fortuneMultiplier(0), 1);
  assert.equal(fortuneMultiplier(100), 2);
  assert.equal(fortuneMultiplier(1_500), 16);
});

test("three greenhouses pay three times one", () => {
  const market = new Map([["WHEAT", product("WHEAT", 100, 120)], ["ETHEREAL_VINE", product("ETHEREAL_VINE", 1, 1)]]);
  const m = data.mutations.find((x) => x.id === "DUSTGRAIN")!;
  const byId = new Map(data.mutations.map((x) => [x.id, x]));
  const one = profitOf(m, byId, data, { market, growth: GROWTH, farmingFortune: 0, plots: 1 });
  const three = profitOf(m, byId, data, { market, growth: GROWTH, farmingFortune: 0, plots: 3 });
  assert.equal(three.coinsPerHour, one.coinsPerHour! * 3);
});

/** A drop nobody is bidding on is named, not counted as free money and not silently dropped. */
test("an unpriced drop is reported rather than valued at zero", () => {
  const m = data.mutations.find((x) => x.id === "DUSTGRAIN")!;
  const byId = new Map(data.mutations.map((x) => [x.id, x]));
  const row = profitOf(m, byId, data, { market: new Map(), growth: GROWTH, farmingFortune: 0 });
  assert.deepEqual(row.unpriced, m.drops.map((d) => d.name));
  assert.equal(row.revenue, 0);
  assert.match(row.problem ?? "", /Nothing is bidding/);
});

/** A mutation needing a special act is kept and explained, never ranked as though it were free. */
test("a special-condition mutation is explained rather than ranked", () => {
  const rows = rankMutations(data, { market: new Map(), growth: GROWTH, farmingFortune: 0 });
  const godseed = rows.find((r) => r.id === "GODSEED")!;
  assert.equal(godseed.coinsPerHour, null);
  assert.match(godseed.problem ?? "", /special act/);
  assert.ok(rows.some((r) => r.id === "SHELLFRUIT"), "still on the list");
});

/* --------------------------------------------------------- the scraped file */

test("every mutation carries the fields the ranking needs", () => {
  assert.equal(data.mutations.length, 40);
  for (const m of data.mutations) {
    assert.ok(m.id && m.name, "named");
    assert.ok([1, 2, 3].includes(m.size), `${m.name} size ${m.size}`);
    assert.equal(m.cellsPerPlant, m.size, `${m.name}: a plant fills its own edge of the ring`);
    assert.ok(Array.isArray(m.drops), `${m.name} drops`);
    assert.ok(m.chance === null || (m.chance > 0 && m.chance <= 1), `${m.name} chance ${m.chance}`);
  }
});

/**
 * The ids have to be the ones the bazaar trades, and for six of the twelve base crops those are
 * still Minecraft's 2013 names. Slugging the wiki's display name gives NETHER_WART where the
 * bazaar wants NETHER_STALK, and the failure is quiet — the row just reads as unpriceable.
 */
test("crop ids are the bazaar's, not the wiki's spelling", () => {
  const ids = new Set(data.baseCrops.map((c) => c.id));
  for (const id of ["NETHER_STALK", "INK_SACK:3", "POTATO_ITEM", "CARROT_ITEM", "MELON", "DOUBLE_PLANT"]) {
    assert.ok(ids.has(id), `${id} should be a base crop id`);
  }
  assert.ok(!ids.has("NETHER_WART"), "the wiki's spelling must not survive into the data");
});

test("the base crop drops are the ones the August update left behind", () => {
  const by = new Map(data.baseCrops.map((c) => [c.id, c.baseYield]));
  // Every one of these changed on 2026-08-20; the old figures are the comment.
  assert.equal(by.get("NETHER_STALK"), 108, "was 240");
  assert.equal(by.get("CARROT_ITEM"), 175, "was 280");
  assert.equal(by.get("DOUBLE_PLANT"), 232, "Sunflower, was 160");
  assert.equal(by.get("WHEAT"), 72, "was 80");
});

/* ------------------------------------------------------------ the parsers */

test("an item template yields its name and amount", () => {
  assert.deepEqual(parseItemList("{{Item|Wheat|amount=100}}"), [{ id: "WHEAT", name: "Wheat", amount: 100 }]);
  assert.deepEqual(parseItemList("{{Item|Pumpkin}}"), [{ id: "PUMPKIN", name: "Pumpkin", amount: 1 }]);
  assert.deepEqual(parseItemList("{{Item|Farmland}}"), [], "a growth surface is not an ingredient");
});

test("Fire is a requirement with no price rather than an item to look up", () => {
  const [fire] = parseItemList("{{Item|Fire|amount=2}}");
  assert.equal(fire.free, true);
});

test("a slash separates alternatives, and prose is flagged as prose", () => {
  const both = parseSpreading("{{Item|Pumpkin|amount=1}} / {{Item|Melon|amount=1}}");
  assert.equal(both.options.length, 2);
  assert.equal(both.prose, false);

  assert.equal(parseSpreading("0 adjacent crops").prose, true);
  assert.equal(parseSpreading("Explode a [[Turtlellini]] with a [[Blastberry]].").prose, true);
});

test("a chance template reads as a fraction", () => {
  assert.equal(parseChance("{{Chance|15%|1|6.67}}"), 0.15);
  assert.equal(parseChance("nothing here"), null);
});

test("a footnote yields both the cells asked for and the plants that cover them", () => {
  const notes = parsePlantNotes(
    'x<ref group="note">This means 6 total blocks of Snoozlings. In practice, this can be achieved using {{Item|Snoozling|amount=2}}.</ref>',
  );
  assert.deepEqual(notes, { SNOOZLING: { cells: 6, plants: 2 } });
});

test("a name key ignores spacing and punctuation", () => {
  assert.equal(nameKey("Melon Slice"), nameKey("melonslice"));
  assert.equal(nameKey("Do-not-eat-shroom"), "donoteatshroom");
});
