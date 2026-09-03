import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
// @ts-expect-error - a plain build script, imported for its pure parsers only.
import { parseStorage, parseCooldowns } from "../scripts/fetch-minion-production.mjs";
import { NET_OF_TAX } from "../src/lib/bazaar";
import { compactionRatio, dropIdFor, planProfit, unitValue } from "../src/lib/minionProfit";
import type { Basis, Compactor, DropTable, ItemPrices, Recipe, StorageTables } from "../src/lib/minionProfit";
import type { Fuel, MinionData, Modifiers, Upgrade } from "../src/lib/minions";
import { varianceFrom, trustedPrice, zScore, confidenceOf } from "../src/lib/priceVariance";
import type { CoflnetPoint } from "../src/lib/bazaarHistory";

const data = JSON.parse(readFileSync("data/generated/minion-production.json", "utf8")) as MinionData;
const mods = JSON.parse(readFileSync("data/curated/minion_modifiers.json", "utf8")) as Modifiers;
const storageFile = JSON.parse(readFileSync("data/curated/minion_storage.json", "utf8"));
const dropsFile = JSON.parse(readFileSync("data/curated/minion_drops.json", "utf8")) as DropTable;
const recipes = JSON.parse(readFileSync("data/generated/recipes.json", "utf8")).recipes as Recipe[];
const names = JSON.parse(readFileSync("data/generated/bazaar_items.json", "utf8")).names as Record<string, string>;
const npc = JSON.parse(readFileSync("data/generated/npc-prices.json", "utf8")).prices as Record<string, { sell?: number }>;

const storage: StorageTables = {
  slotItems: storageFile.slotItems,
  chests: storageFile.chests,
  hoppers: storageFile.hoppers,
  compactors: storageFile.compactors,
};

const fuel = (id: string): Fuel => mods.fuels.find((f) => f.id === id)!;
const upgrade = (id: string): Upgrade => mods.upgrades.find((u) => u.id === id)!;
const compactor = (id: string): Compactor => storage.compactors.find((c) => c.id === id)!;
const none: [Upgrade, Upgrade] = [upgrade("NONE"), upgrade("NONE")];
const minion = (generator: string) => data.minions.find((m) => m.generator === generator)!;

/* -------------------------------------------------------------- the scrape */

test("storage comes out of the rendered page in tier order", () => {
  const html = `Time Between Action: &amp;a14s/&amp;7Max Storage: &amp;e64/&amp;7x
                Time Between Action: &amp;a14s/&amp;7Max Storage: &amp;e192/&amp;7x`;
  assert.deepEqual(parseStorage(html), [64, 192]);
  // The wiki relabelled "Cooldown:" to the game's own "Time Between Action:"; both are read, or a
  // parser that silently returns nothing quietly ships a table with no rates in it.
  assert.deepEqual(parseCooldowns(html), [14, 14]);
  assert.deepEqual(parseCooldowns(`Cooldown:&#160;<span class="c">48s</span>`), [48]);
});

test("every minion carries a full storage ladder", () => {
  for (const m of data.minions) {
    assert.ok(m.storage, `${m.generator} has no storage at all`);
    assert.equal(m.storage!.length, m.maxTier, `${m.generator} storage is short`);
    for (let i = 1; i < m.storage!.length; i++) {
      assert.ok(m.storage![i] >= m.storage![i - 1], `${m.generator} storage goes backwards at tier ${i + 1}`);
    }
  }
});

/* ---------------------------------------------------------------- pricing */

test("the bazaar's cut comes off both bazaar routes and not off the shopkeeper", () => {
  const prices: ItemPrices = { instasell: 100, instabuy: 120, npcSell: 30 };
  assert.equal(unitValue(prices, "instasell", null, "live")!.price, 100 * NET_OF_TAX);
  assert.equal(unitValue(prices, "order", null, "live")!.price, 120 * NET_OF_TAX);
  // A shop is a fixed price with no book and no tax, which is exactly why it wins on bulk.
  assert.equal(unitValue(prices, "npc", null, "live")!.price, 30);
});

test("a basis with no price is null rather than zero", () => {
  const prices: ItemPrices = { instasell: null, instabuy: null, npcSell: 30 };
  assert.equal(unitValue(prices, "instasell", null, "live"), null);
  assert.ok(unitValue(prices, "npc", null, "live"));
});

/* --------------------------------------------------------------- variance */

/** A month of a steady item, with one manipulated day bolted on where a test wants it. */
function month(price: number, days = 30, spike?: number): CoflnetPoint[] {
  const start = Date.UTC(2026, 7, 5);
  const points: CoflnetPoint[] = [];
  for (let d = 0; d < days; d++) {
    // A little real movement, so the deviation is not zero and z-scores mean something.
    const wobble = price * 0.01 * (d % 5 === 0 ? 1 : -1);
    points.push({ sell: price + wobble, buy: price * 1.1, timestamp: new Date(start + d * 86_400_000).toISOString().slice(0, 19) });
  }
  if (spike !== undefined) points[points.length - 1].sell = spike;
  return points;
}

const NOW = Date.UTC(2026, 8, 4);

test("a month is thirty days of it, and thinner than a week is no month at all", () => {
  const full = varianceFrom(month(400), "sell", NOW);
  assert.ok(full);
  assert.equal(full!.samples, 30);
  assert.ok(Math.abs(full!.mean - 400) < 4);

  // Six points is not a spread. Inventing one from them would make every anomaly look explicable.
  assert.equal(varianceFrom(month(400, 6), "sell", NOW), null);
});

test("the window forgets anything older than thirty days", () => {
  const old = month(400, 30).map((p) => ({ ...p, timestamp: new Date(Date.parse(p.timestamp + "Z") - 200 * 86_400_000).toISOString().slice(0, 19) }));
  assert.equal(varianceFrom(old, "sell", NOW), null);
});

test("a fortyfold spike scores as anomalous and a dear day does not", () => {
  const steady = varianceFrom(month(400), "sell", NOW)!;
  assert.equal(confidenceOf(zScore(404, steady)), "normal");
  const far = zScore(16_000, steady);
  assert.ok(far !== null && far > 4);
  assert.equal(confidenceOf(far), "anomalous");
});

test("the guarded price drops an anomaly and keeps an ordinary day", () => {
  const variance = varianceFrom(month(400), "sell", NOW)!;

  const ordinary = trustedPrice(404, variance, "guarded");
  assert.equal(ordinary.substituted, false);
  assert.equal(ordinary.price, 404);

  // The whole point of the tab: a manipulated quote must not decide the ranking.
  const spike = trustedPrice(16_000, variance, "guarded");
  assert.equal(spike.substituted, true);
  assert.equal(spike.price, variance.median);

  // And the two escape hatches do what they say.
  assert.equal(trustedPrice(16_000, variance, "live").price, 16_000);
  assert.equal(trustedPrice(404, variance, "median").price, variance.median);
});

test("an item that never moved has no z-score rather than an infinite one", () => {
  const flat: CoflnetPoint[] = Array.from({ length: 30 }, (_, d) => ({
    sell: 100,
    timestamp: new Date(Date.UTC(2026, 7, 5) + d * 86_400_000).toISOString().slice(0, 19),
  }));
  const variance = varianceFrom(flat, "sell", NOW)!;
  assert.equal(variance.deviation, 0);
  // Infinity here would sort a perfectly steady item to the top of the "suspicious" list, which is
  // exactly backwards.
  assert.equal(zScore(100, variance), null);
  assert.equal(confidenceOf(null), "normal");
});

/* ------------------------------------------------------------- compaction */

test("a compactor's ratio is read from the item's own recipe, not assumed", () => {
  // 160 is the enchanted ratio and it is in recipes.json rather than in this file.
  assert.equal(compactionRatio("COBBLESTONE", compactor("SUPER_COMPACTOR_3000"), recipes), 160);
  // No compactor is a ratio of one, so the caller can apply it unconditionally.
  assert.equal(compactionRatio("COBBLESTONE", compactor("NONE"), recipes), 1);
  // A plain Compactor only reaches a block form, so the 160-step is out of its reach entirely and
  // cobblestone — which has no block in SkyBlock — gains nothing from one.
  assert.equal(compactionRatio("COBBLESTONE", compactor("COMPACTOR"), recipes), 1);
  // Snowballs do have a block, at four, and a plain Compactor does reach that.
  assert.equal(compactionRatio("SNOW_BALL", compactor("COMPACTOR"), recipes), 4);

  // An item nothing compacts is one, not zero: it stays in the table at its own fill time rather
  // than vanishing. Almost everything a minion drops has an enchanted form, so this is checked
  // against a recipe list built for the purpose rather than hunted for in the real one.
  assert.equal(compactionRatio("NOTHING_COMPACTS_THIS", compactor("SUPER_COMPACTOR_3000"), recipes), 1);
  // And a multi-ingredient recipe is a craft, not a compaction, however single-minded it looks.
  const craft: Recipe[] = [{ output: "X", yield: 1, ingredients: [{ id: "A", qty: 160 }, { id: "B", qty: 1 }] }];
  assert.equal(compactionRatio("A", compactor("SUPER_COMPACTOR_3000"), craft), 1);
});

/* ------------------------------------------------------------------ drops */

test("a drop is priced as what the minion drops, not as what it collects", () => {
  const byName = new Map<string, string>();
  for (const [id, name] of Object.entries(names)) {
    const key = name.toLowerCase();
    if (!byName.has(key)) byName.set(key, id);
  }
  // The Cow Minion's collection resolves to Leather and the thing it drops is Raw Beef. Pricing
  // the collection would be pricing the wrong item, which is why this one is pinned.
  assert.equal(dropIdFor(minion("COW"), dropsFile, byName), "RAW_BEEF");
  // Three minions feed no collection at all and would otherwise be missing from the table.
  assert.equal(dropIdFor(minion("SNOW"), dropsFile, byName), "SNOW_BALL");
  assert.equal(dropIdFor(minion("INFERNO"), dropsFile, byName), "CRUDE_GABAGOOL");
  // And one genuinely cannot be priced, which is a null rather than a guess.
  assert.equal(dropIdFor(minion("FLOWER"), dropsFile, byName), null);
  // Everything else resolves without a pin.
  assert.equal(dropIdFor(minion("COBBLESTONE"), dropsFile, byName), "COBBLESTONE");
});

/* ----------------------------------------------------------------- the plan */

function prices(): Map<string, ItemPrices> {
  const book = new Map<string, ItemPrices>();
  for (const [id, price] of Object.entries(npc)) {
    book.set(id, { instasell: (price.sell ?? 1) * 4, instabuy: (price.sell ?? 1) * 5, npcSell: price.sell ?? null });
  }
  return book;
}

function plan(over: Partial<Parameters<typeof planProfit>[0]> = {}) {
  return planProfit({
    data,
    storage,
    drops: dropsFile,
    recipes,
    prices: prices(),
    variance: new Map(),
    names,
    basis: "instasell" as Basis,
    trust: "guarded",
    setup: {
      tier: 12,
      fuel: fuel("NONE"),
      upgrades: none,
      count: 1,
      chest: storage.chests[0],
      hopper: storage.hoppers[0],
      compactor: compactor("NONE"),
      claimHours: 8,
    },
    ...over,
  });
}

test("a minion that fills before you come back earns less than its gross", () => {
  const rows = plan();
  const cobble = rows.find((r) => r.generator === "COBBLESTONE")!;

  // A Tier XII Cobblestone Minion makes thousands an hour into 960 slots and no compactor, so an
  // eight-hour night is mostly spent standing full. This is the number other calculators miss.
  assert.ok(cobble.hoursToFill < 8, "expected an uncompacted tier XII to fill inside a night");
  assert.ok(cobble.netPerHour < cobble.grossPerHour);
  assert.ok(cobble.itemsLost > 0);
  assert.equal(Math.round(cobble.itemsPerClaim), Math.round(cobble.capacity));
});

test("a compactor is worth more than any upgrade, measured in fill time", () => {
  const bare = plan().find((r) => r.generator === "COBBLESTONE")!;
  const packed = plan({
    setup: {
      tier: 12,
      fuel: fuel("NONE"),
      upgrades: none,
      count: 1,
      chest: storage.chests[0],
      hopper: storage.hoppers[0],
      compactor: compactor("SUPER_COMPACTOR_3000"),
      claimHours: 8,
    },
  }).find((r) => r.generator === "COBBLESTONE")!;

  assert.equal(Math.round(packed.capacity / bare.capacity), 160);
  assert.ok(packed.hoursToFill > 8, "160x the storage should outlast a night");
  // Nothing is wasted any more, so the realised rate is the gross rate.
  assert.equal(packed.itemsLost, 0);
  assert.ok(Math.abs(packed.netPerHour - packed.grossPerHour) < 1);
});

test("a hopper turns waste into a trickle rather than into nothing", () => {
  const base = {
    tier: 12,
    fuel: fuel("NONE"),
    upgrades: none,
    count: 1,
    chest: storage.chests[0],
    compactor: compactor("NONE"),
    claimHours: 24,
  };
  const stopped = plan({ setup: { ...base, hopper: storage.hoppers[0] } }).find((r) => r.generator === "COBBLESTONE")!;
  const shipped = plan({ setup: { ...base, hopper: storage.hoppers.find((h) => h.id === "ENCHANTED_HOPPER")! } }).find(
    (r) => r.generator === "COBBLESTONE",
  )!;

  assert.ok(stopped.itemsLost > 0);
  assert.equal(shipped.itemsLost, 0);
  assert.ok(shipped.hopperPerHour > 0);
  assert.ok(shipped.netPerHour > stopped.netPerHour);
});

test("a fuel that never runs out is a capital cost, not an hourly one", () => {
  const base = {
    tier: 12,
    upgrades: none,
    count: 5,
    chest: storage.chests[0],
    hopper: storage.hoppers[0],
    compactor: compactor("SUPER_COMPACTOR_3000"),
    claimHours: 8,
  };
  const forever = plan({ setup: { ...base, fuel: fuel("ENCHANTED_LAVA_BUCKET") } })[0];
  assert.equal(forever.fuelPerHour, 0);

  // One that expires is a genuine subscription and is charged as one, across every minion placed.
  const burning = plan({ setup: { ...base, fuel: fuel("ENCHANTED_COAL") } })[0];
  assert.ok(burning.fuelPerHour > 0);
});

test("the minion nothing can price stays in the table with the reason on it", () => {
  const flower = plan().find((r) => r.generator === "FLOWER")!;
  assert.equal(flower.itemId, null);
  assert.equal(flower.netPerHour, 0);
  // Dropping the row would read as "this minion earns nothing" rather than "nobody has a price".
  assert.ok(flower.caveats.some((c) => /random/i.test(c) || /no single item/i.test(c)));
});

test("rows come back ranked on what you actually collect", () => {
  const rows = plan();
  for (let i = 1; i < rows.length; i++) assert.ok(rows[i - 1].netPerHour >= rows[i].netPerHour);
});
