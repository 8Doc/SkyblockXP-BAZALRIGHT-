import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
// @ts-expect-error - a plain build script, imported for its pure parsers only.
import { parseCollects, parseCollection, parseCooldowns } from "../scripts/fetch-minion-production.mjs";
import { actionSeconds, itemsPerHour, planMinions, target } from "../src/lib/minions";
import type { Collection, Fuel, MinionData, MinionProduction, Modifiers, Upgrade } from "../src/lib/minions";

const data = JSON.parse(readFileSync("data/generated/minion-production.json", "utf8")) as MinionData;
const mods = JSON.parse(readFileSync("data/curated/minion_modifiers.json", "utf8")) as Modifiers;
const collections = (JSON.parse(readFileSync("data/generated/collections.json", "utf8")) as { collections: Collection[] }).collections;

const fuel = (id: string): Fuel => mods.fuels.find((f) => f.id === id)!;
const upgrade = (id: string): Upgrade => mods.upgrades.find((u) => u.id === id)!;
const none: [Upgrade, Upgrade] = [upgrade("NONE"), upgrade("NONE")];
const minion = (family: string): MinionProduction => data.minions.find((m) => m.family === family)!;

/* -------------------------------------------------------------- the parser */

test("a collects line is read in every shape the wiki writes it", () => {
  assert.deepEqual(parseCollects("|collects = 4 Acacia Log"), { amount: 4, item: "Acacia Log" });
  assert.deepEqual(parseCollects("|collects = Cobblestone"), { amount: 1, item: "Cobblestone" });
  assert.deepEqual(parseCollects("|collects = 1x Flower"), { amount: 1, item: "Flower" });
  // A bullet is list markup, not part of the figure — and a range is worth its midpoint over a
  // grind, with both ends kept so a caller can say so rather than quoting a midpoint as a fact.
  assert.deepEqual(parseCollects("|collects = * 2-5 String"), { amount: 3.5, low: 2, high: 5, item: "String" });
  assert.deepEqual(parseCollects("|collects = *0.4 Nether Quartz"), { amount: 0.4, item: "Nether Quartz" });
  assert.equal(parseCollects("|something else = 4"), null);
});

test("a collection line drops the unlock tier, roman or arabic", () => {
  assert.equal(parseCollection("|collection = Acacia Log 1"), "Acacia Log");
  assert.equal(parseCollection("|collection = Cobblestone I"), "Cobblestone");
  assert.equal(parseCollection("|collection = Spider Slayer 5"), "Spider Slayer");
  assert.equal(parseCollection("|nothing = here"), null);
});

test("cooldowns come out of the rendered table in tier order", () => {
  const html = `<td>Cooldown:&#160;<span class="c">14s</span><br />Storage: 64</td>
                <td>Cooldown:&#160;<span class="c">12.5s</span></td>`;
  assert.deepEqual(parseCooldowns(html), [14, 12.5]);
});

/* ------------------------------------------------------------ the scraped data */

/**
 * The whole model rests on one number per tier, scraped out of HTML, and the wiki hands us two
 * independent worked examples to check it against. The Minions page: "a Tier I Cobblestone Minion
 * does an action every 14 seconds". The Minion Fuel page: "For a Clay Minion XI ... the Base Time
 * Between Actions is 16 seconds". If either drifts, the scrape has moved under us.
 */
test("the scraped cooldowns reproduce both of the wiki's worked examples", () => {
  assert.equal(minion("Cobblestone Minion").cooldowns[0], 14, "Minions page, Cobblestone I");
  assert.equal(minion("Clay Minion").cooldowns[10], 16, "Minion Fuel page, Clay XI");
});

test("every minion has one cooldown per tier, positive and never rising", () => {
  assert.ok(data.minions.length >= 60, `only ${data.minions.length} minions scraped`);
  for (const m of data.minions) {
    assert.equal(m.cooldowns.length, m.maxTier, `${m.family} has ${m.cooldowns.length} cooldowns for ${m.maxTier} tiers`);
    for (let i = 0; i < m.cooldowns.length; i++) {
      assert.ok(m.cooldowns[i] > 0, `${m.family} tier ${i + 1} has a cooldown of ${m.cooldowns[i]}`);
      if (i > 0) assert.ok(m.cooldowns[i] <= m.cooldowns[i - 1], `${m.family} gets slower at tier ${i + 1}`);
    }
    assert.ok(m.collects.amount > 0, `${m.family} collects nothing`);
  }
});

/* -------------------------------------------------------------- the arithmetic */

/**
 * The factor of two, pinned. A minion generates on one action and harvests on the next, so a
 * cooldown of 14s is a drop every 28s — the wiki's own example, and the one mistake here that
 * would double every figure on the page while looking perfectly reasonable.
 */
test("a drop lands every other action, not every action", () => {
  const cobble = minion("Cobblestone Minion");
  const rate = itemsPerHour(cobble, data, { tier: 1, fuel: fuel("NONE"), upgrades: none, count: 1 })!;
  assert.equal(rate, 3600 / 28, "one cobblestone every 28 seconds, not every 14");
  assert.equal(data.actionsPerHarvest, 2);
});

/**
 * The fuel page states the shape — base / (1 + boost), not base x (1 - boost) — and works it on a
 * Clay XI. At +10% the two forms differ by a fifth of a second, which is small enough to look
 * right and large enough to be wrong.
 */
test("a speed boost divides rather than subtracts, as the fuel page works it", () => {
  const base = minion("Clay Minion").cooldowns[10];
  const boosted = actionSeconds(base, { fuel: fuel("ENCHANTED_COAL"), upgrades: none });
  assert.equal(base, 16);
  assert.ok(Math.abs(boosted - 14.5454) < 0.001, `expected ~14.55s, got ${boosted}`);
  assert.notEqual(Math.round(boosted * 100), Math.round(base * 0.9 * 100), "subtracting would give 14.4");
});

test("boosts from fuel and both upgrades add before dividing", () => {
  const base = 20;
  const two: [Upgrade, Upgrade] = [upgrade("MINION_EXPANDER"), upgrade("MINION_EXPANDER")];
  // Two expanders are +10% together, not 1.05 squared.
  assert.equal(actionSeconds(base, { fuel: fuel("NONE"), upgrades: two }), 20 / 1.1);
  // And a fuel joins the same sum: +40% and +20% is one division by 1.6.
  const mixed: [Upgrade, Upgrade] = [upgrade("FLYCATCHER"), upgrade("NONE")];
  assert.equal(actionSeconds(base, { fuel: fuel("EVERBURNING_FLAME"), upgrades: mixed }), 20 / 1.6);
});

/**
 * A multiplier fuel is not a speed fuel. A Hyper Catalyst is four times the items at the same
 * timer; adding it into the speed sum would both shorten the timer and miss the duplication.
 */
test("a multiplier fuel duplicates drops and leaves the timer alone", () => {
  const cobble = minion("Cobblestone Minion");
  const plain = itemsPerHour(cobble, data, { tier: 1, fuel: fuel("NONE"), upgrades: none, count: 1 })!;
  const hyper = itemsPerHour(cobble, data, { tier: 1, fuel: fuel("HYPER_CATALYST"), upgrades: none, count: 1 })!;

  assert.equal(fuel("HYPER_CATALYST").speed, 0, "it is not a speed fuel");
  assert.equal(hyper, plain * 4);
  assert.equal(
    actionSeconds(cobble.cooldowns[0], { fuel: fuel("HYPER_CATALYST"), upgrades: none }),
    cobble.cooldowns[0],
    "the timer is untouched",
  );
});

test("the soulflow engines halve the output they are asked about", () => {
  const cobble = minion("Cobblestone Minion");
  const plain = itemsPerHour(cobble, data, { tier: 1, fuel: fuel("NONE"), upgrades: none, count: 1 })!;
  const drained: [Upgrade, Upgrade] = [upgrade("SOULFLOW_ENGINE"), upgrade("NONE")];
  assert.equal(itemsPerHour(cobble, data, { tier: 1, fuel: fuel("NONE"), upgrades: drained, count: 1 }), plain / 2);
});

test("more minions is more items, linearly", () => {
  const cobble = minion("Cobblestone Minion");
  const one = itemsPerHour(cobble, data, { tier: 1, fuel: fuel("NONE"), upgrades: none, count: 1 })!;
  assert.equal(itemsPerHour(cobble, data, { tier: 1, fuel: fuel("NONE"), upgrades: none, count: 31 }), one * 31);
});

/** A tier a minion does not have is a question with no answer, not a rate of zero. */
test("asking for a tier a minion does not have returns nothing", () => {
  const voidling = data.minions.find((m) => m.maxTier < 12)!;
  assert.equal(itemsPerHour(voidling, data, { tier: 12, fuel: fuel("NONE"), upgrades: none, count: 1 }), null);
});

/* ------------------------------------------------------------- the distance */

const fake: Collection = {
  itemId: "X",
  name: "X",
  tiers: [
    { tier: 1, amountRequired: 100, xp: 4 },
    { tier: 2, amountRequired: 1_000, xp: 8 },
    { tier: 3, amountRequired: 10_000, xp: 16 },
  ],
};

/**
 * Collections are cumulative — one running total measured against every tier — so the distance is
 * the threshold minus what is held, never the sum of the tiers in between.
 */
test("the next tier is measured from the running total", () => {
  assert.deepEqual(target(fake, 0, false), { needed: 100, tier: 1, xp: 4, maxing: false });
  assert.deepEqual(target(fake, 150, false), { needed: 850, tier: 2, xp: 8, maxing: false });
  assert.equal(target(fake, 10_000, false), null, "nothing left to do");
});

test("maxing out counts every tier still open, and the distance to the last", () => {
  assert.deepEqual(target(fake, 0, true), { needed: 10_000, tier: 3, xp: 28, maxing: true });
  // 150 collected has tier 1 behind it, so its XP is not on offer any more.
  assert.deepEqual(target(fake, 150, true), { needed: 9_850, tier: 3, xp: 24, maxing: true });
});

/* -------------------------------------------------------------- the ranking */

test("the plan ranks real minions and its arithmetic reconciles", () => {
  const rows = planMinions({
    data,
    collections,
    collected: new Map(),
    ownedTier: new Map(),
    assumeTier: 12,
    useOwned: false,
    fuel: fuel("ENCHANTED_LAVA_BUCKET"),
    upgrades: none,
    count: 31,
    maxOut: false,
  });

  assert.ok(rows.length > 30, `only ${rows.length} minions planned`);
  for (const r of rows) {
    assert.ok(Math.abs(r.hours - r.needed / r.itemsPerHour) < 1e-9, `${r.family} hours do not reconcile`);
    assert.ok(Math.abs(r.xpPerHour - r.xp / r.hours) < 1e-9, `${r.family} xp/hr does not reconcile`);
    assert.ok(r.tier <= 12);
  }
  // Sorted on what it pays per hour of waiting.
  for (let i = 1; i < rows.length; i++) assert.ok(rows[i - 1].xpPerHour >= rows[i].xpPerHour - 1e-9);
});

test("a collection already finished is not offered", () => {
  const cobble = data.minions.find((m) => m.family === "Cobblestone Minion")!;
  const cobbleCollection = collections.find((c) => c.itemId === cobble.collectionId)!;
  const done = cobbleCollection.tiers[cobbleCollection.tiers.length - 1].amountRequired;

  const rows = planMinions({
    data, collections, collected: new Map([[cobble.collectionId!, done]]), ownedTier: new Map(),
    assumeTier: 12, useOwned: false, fuel: fuel("NONE"), upgrades: none, count: 1, maxOut: true,
  });
  assert.equal(rows.find((r) => r.generator === cobble.generator), undefined);
});

/**
 * "The best tier you own" and "the tier you are about to buy" are different questions, and the
 * toggle is which one is being asked. Owning nothing must not silently answer the second.
 */
test("the owned tier is used when asked for, and capped by what the minion has", () => {
  const cobble = data.minions.find((m) => m.family === "Cobblestone Minion")!;
  const base = {
    data, collections, collected: new Map<string, number>(), assumeTier: 12,
    fuel: fuel("NONE"), upgrades: none, count: 1, maxOut: false,
  };

  const owned = planMinions({ ...base, ownedTier: new Map([[cobble.generator, 4]]), useOwned: true });
  assert.equal(owned.find((r) => r.generator === cobble.generator)!.tier, 4);
  assert.equal(owned.find((r) => r.generator === cobble.generator)!.owned, true);

  // Not owned at all: falls back to the assumption rather than dropping the row.
  const missing = planMinions({ ...base, ownedTier: new Map(), useOwned: true });
  assert.equal(missing.find((r) => r.generator === cobble.generator)!.owned, false);

  // A minion that stops below the assumed tier is capped at its own maximum.
  const capped = planMinions({ ...base, ownedTier: new Map(), useOwned: false });
  for (const r of capped) {
    const m = data.minions.find((x) => x.generator === r.generator)!;
    assert.ok(r.tier <= m.maxTier, `${r.family} planned at tier ${r.tier} above its max ${m.maxTier}`);
  }
});
