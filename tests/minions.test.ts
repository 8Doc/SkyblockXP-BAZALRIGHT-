import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
// @ts-expect-error - a plain build script, imported for its pure parsers only.
import { parseCollects, parseAllCollects, parseCollection, parseCooldowns } from "../scripts/fetch-minion-production.mjs";
import { MILESTONES, actionSeconds, itemsPerHour, offlineAmount, planMinions, target, tierSteps } from "../src/lib/minions";
import type { Collection, Fuel, MinionData, MinionProduction, Modifiers, OfflineRules, Upgrade } from "../src/lib/minions";

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

test("every line of a collects list is read, not only the first", () => {
  // The Revenant Minion, as its page writes it. Read one line deep it is a rotten flesh minion and
  // one of the worst on the page; the diamonds are most of why anyone builds a wall of them.
  const revenant = "|collects = * 2-5 Rotten Flesh\n* 1 Diamond %20%%\n|upgrade_with = * Revenant Flesh";
  assert.deepEqual(parseAllCollects(revenant), [
    { amount: 3.5, low: 2, high: 5, item: "Rotten Flesh" },
    { amount: 1, item: "Diamond", chance: 0.2 },
  ]);
  // The single-drop contract is unchanged: the primary is still the first entry.
  assert.deepEqual(parseCollects(revenant), { amount: 3.5, low: 2, high: 5, item: "Rotten Flesh" });
});

test("a drop chance is a chance and not part of the item's name", () => {
  // "Raw Cod %54%%" matches nothing in the bazaar, so the Fishing Minion priced at nothing.
  assert.deepEqual(parseAllCollects("|collects = Raw Cod %54%%\n|x = 1"), [
    { amount: 1, item: "Raw Cod", chance: 0.54 },
  ]);
});

test("a conditional drop is labelled rather than counted as a chance", () => {
  // `%Enchanted Egg%` names an upgrade, not a probability. Read as a chance it would be output
  // every Chicken Minion makes; read as a name it is an item nothing prices.
  assert.deepEqual(parseAllCollects("|collects = 1 Raw Chicken\n* 1 Egg %Enchanted Egg%\n|x = 1"), [
    { amount: 1, item: "Raw Chicken" },
    { amount: 1, item: "Egg", condition: "Enchanted Egg" },
  ]);
});

test("the slayer four carry a slayer requirement rather than a collection", () => {
  // "Zombie Slayer 5" is what it takes to craft one, not what its drops feed. Kept apart so the
  // collection resolver lands on the drop on purpose rather than by falling through.
  for (const family of ["Revenant Minion", "Tarantula Minion", "Voidling Minion", "Inferno Minion"]) {
    const m = minion(family);
    assert.equal(m.category, "Slayer", `${family} is filed under the wiki's Slayer tab`);
    assert.equal(m.collection, null, `${family} has no collection name, only a slayer requirement`);
    assert.match(String(m.unlockRequirement), /Slayer$/);
  }
});

test("the minions with a second drop have it, and it is priced-shaped", () => {
  const revenant = minion("Revenant Minion");
  assert.deepEqual(revenant.alsoCollects, [{ amount: 1, item: "Diamond", chance: 0.2 }]);
  // The Voidling's obsidian is the largest of these corrections — it is 2.5 an harvest against a
  // primary drop of 0.4 nether quartz, so leaving it out understated the minion many times over.
  assert.ok(minion("Voidling Minion").alsoCollects!.some((d) => d.item === "Obsidian" && d.amount === 2.5));
  // And a minion with one drop still has none, rather than an empty second stream.
  assert.deepEqual(minion("Cobblestone Minion").alsoCollects, []);
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
  const mixed: [Upgrade, Upgrade] = [upgrade("FLYCATCHER_UPGRADE"), upgrade("NONE")];
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
  assert.deepEqual(target(fake, 0, "next"), { needed: 100, tier: 1, xp: 4, maxing: false });
  assert.deepEqual(target(fake, 150, "next"), { needed: 850, tier: 2, xp: 8, maxing: false });
  assert.equal(target(fake, 10_000, "next"), null, "nothing left to do");
});

test("maxing out counts every tier still open, and the distance to the last", () => {
  assert.deepEqual(target(fake, 0, "max"), { needed: 10_000, tier: 3, xp: 28, maxing: true });
  // 150 collected has tier 1 behind it, so its XP is not on offer any more.
  assert.deepEqual(target(fake, 150, "max"), { needed: 9_850, tier: 3, xp: 24, maxing: true });
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
    goal: "next" as const,
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
    assumeTier: 12, useOwned: false, fuel: fuel("NONE"), upgrades: none, count: 1, goal: "max" as const,
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
    fuel: fuel("NONE"), upgrades: none, count: 1, goal: "next" as const,
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

/* --------------------------------------------------------- offline vs online */

const offlineRules = JSON.parse(readFileSync("data/curated/minion_offline.json", "utf8")) as OfflineRules;
const withOffline: MinionData = { ...data, offline: offlineRules };

/**
 * The infobox quotes what a minion drops with a player standing there, and for two of them that is
 * not the offline figure. Pumpkin is the one that bites: the infobox says 1 and the offline
 * simulation gives 3, so a calculator built on the scrape alone is a third of the real answer for
 * the minion people actually use.
 */
test("the offline amount overrides the infobox where the wiki says they differ", () => {
  const pumpkin = minion("Pumpkin Minion");
  const acacia = minion("Acacia Minion");

  assert.equal(pumpkin.collects.amount, 1, "the infobox figure, which is the online one");
  assert.equal(offlineAmount(pumpkin, withOffline), 3, "Pumpkin Minion, Bugs: 3x per harvest while offline");
  assert.equal(acacia.collects.amount, 4);
  assert.equal(offlineAmount(acacia, withOffline), 3, "Acacia Minion, Bugs: 3 instead of 4 when offline");

  // Everything else falls through to the scrape untouched.
  assert.equal(offlineAmount(minion("Cobblestone Minion"), withOffline), 1);
  assert.equal(offlineAmount(minion("Clay Minion"), withOffline), 4);
});

test("the rate uses the offline amount, so Pumpkin trebles and Acacia drops a quarter", () => {
  const setup = { tier: 12, fuel: fuel("NONE"), upgrades: none, count: 1 } as const;
  const naive = (family: string) => itemsPerHour(minion(family), data, setup)!;
  const real = (family: string) => itemsPerHour(minion(family), withOffline, setup)!;

  assert.ok(Math.abs(real("Pumpkin Minion") / naive("Pumpkin Minion") - 3) < 1e-9);
  assert.ok(Math.abs(real("Acacia Minion") / naive("Acacia Minion") - 0.75) < 1e-9);
  assert.equal(real("Cobblestone Minion"), naive("Cobblestone Minion"), "untouched where nothing is documented");
});

/**
 * The four minions whose loaded behaviour is documented have to be real minions, or the note the
 * tab prints names something that does not exist.
 */
test("every minion named in the offline rules is one we actually have", () => {
  const generators = new Set(data.minions.map((m) => m.generator));
  for (const id of [
    ...Object.keys(offlineRules.amountOverrides),
    ...Object.keys(offlineRules.fasterOnline),
    ...Object.keys(offlineRules.slowerOnline),
  ]) {
    assert.ok(generators.has(id), `${id} is in the offline rules but not in the scrape`);
  }
  // And the two directions are disjoint: nothing can be both faster and slower with a player there.
  for (const id of Object.keys(offlineRules.fasterOnline)) {
    assert.equal(offlineRules.slowerOnline[id], undefined, `${id} cannot be both`);
  }
});

/**
 * 100M Gold is a threshold past the last tier of the collection — two hundred times it — and it
 * pays an in-game buff rather than SkyBlock XP. Quoting XP for it would be inventing some, so the
 * row carries zero and the mode ranks on the wait instead.
 */
test("the 100M Gold milestone is a real distance past the last tier", () => {
  const gold = collections.find((c) => c.itemId === "GOLD_INGOT")!;
  const last = gold.tiers[gold.tiers.length - 1].amountRequired;
  assert.equal(MILESTONES.GOLD_INGOT.amount, 100_000_000);
  assert.ok(MILESTONES.GOLD_INGOT.amount > last, "a milestone below the last tier would be pointless");

  assert.deepEqual(target(gold, 0, "milestone"), {
    needed: 100_000_000, tier: null, xp: 0, maxing: true, milestone: "100M Gold",
  });
  assert.equal(target(gold, 40_000_000, "milestone")!.needed, 60_000_000, "measured from what you hold");
  assert.equal(target(gold, 100_000_000, "milestone"), null, "already there");

  // A collection with no milestone is simply not a row in this mode.
  assert.equal(target(collections.find((c) => c.itemId === "COBBLESTONE")!, 0, "milestone"), null);
});

test("milestone mode lists only the gold minions, ranked by the shortest wait", () => {
  const base = {
    data, collections, collected: new Map<string, number>(), ownedTier: new Map<string, number>(),
    assumeTier: 12, useOwned: false, fuel: fuel("NONE"), upgrades: none, count: 5,
  };
  const rows = planMinions({ ...base, goal: "milestone" });
  assert.ok(rows.length > 0, "the Gold Minion should be here");
  for (const r of rows) {
    assert.equal(r.collectionId, "GOLD_INGOT");
    assert.equal(r.milestone, "100M Gold");
    assert.equal(r.xp, 0, "a buff is not XP");
    assert.equal(r.needed, 100_000_000);
  }
  for (let i = 1; i < rows.length; i++) assert.ok(rows[i - 1].hours <= rows[i].hours, "shortest wait first");

  // And the other two modes are unaffected by any of this.
  assert.ok(planMinions({ ...base, goal: "next" }).length > 30);
});

/* --------------------------------------------------------- the tier ladder */

/**
 * The table ranks on one target, which cannot answer the question you ask standing in front of
 * it: is one more tier here cheaper than the first tier over there? Collection rungs multiply
 * rather than step evenly, so the answer is often no — and the step figure is where it shows.
 */
test("the ladder lists every open tier, measured from where you stand", () => {
  const cobble = collections.find((c) => c.itemId === "COBBLESTONE")!;
  const tiers = cobble.tiers.filter((t) => t.tier > 0).sort((a, b) => a.tier - b.tier);

  // 100 an hour makes the arithmetic readable: hours are hundredths of the distance.
  const steps = tierSteps(cobble, 0, 100);
  assert.equal(steps.length, tiers.length, "nothing collected, so every tier is open");
  assert.equal(steps[0].tier, tiers[0].tier);
  assert.equal(steps[0].needed, tiers[0].amountRequired, "cumulative, so the first is the threshold");
  assert.equal(steps[0].hours, tiers[0].amountRequired / 100);

  // The rung's own cost is the gap to the one below it, not the whole climb.
  for (let i = 1; i < steps.length; i++) {
    assert.equal(steps[i].needed, tiers[i].amountRequired, `tier ${steps[i].tier} is measured from zero`);
    assert.ok(steps[i].hours > steps[i - 1].hours, "the climb only gets longer");
    assert.equal(
      Math.round(steps[i].stepHours * 1e6) / 1e6,
      Math.round((steps[i].hours - steps[i - 1].hours) * 1e6) / 1e6,
      `tier ${steps[i].tier}'s step is the gap to the tier below`,
    );
  }
});

test("tiers already behind you are not listed, and the first step is measured from you", () => {
  const cobble = collections.find((c) => c.itemId === "COBBLESTONE")!;
  const tiers = cobble.tiers.filter((t) => t.tier > 0).sort((a, b) => a.tier - b.tier);
  const have = tiers[2].amountRequired; // exactly on tier 3

  const steps = tierSteps(cobble, have, 100);
  assert.equal(steps[0].tier, tiers[3].tier, "a tier you have reached is done, not open");
  assert.equal(steps[0].needed, tiers[3].amountRequired - have, "the distance from here, not the threshold");
  assert.equal(steps[0].stepHours, steps[0].hours, "the first rung's step is the whole wait so far");
});

/**
 * The comparison the whole feature exists for: a minion can win on its next tier and lose on the
 * one after, because the rungs multiply. If that never happened the ladder would be decoration.
 */
test("a later rung can cost more than a rival's first, which is the point", () => {
  const cobble = collections.find((c) => c.itemId === "COBBLESTONE")!;
  const steps = tierSteps(cobble, 0, 100);
  const climbs = steps.some((s, i) => i > 0 && s.stepHours > steps[0].hours);
  assert.ok(climbs, "a later tier should cost more than the first — otherwise there is nothing to compare");
});

test("a minion that produces nothing has no ladder rather than an infinite one", () => {
  const cobble = collections.find((c) => c.itemId === "COBBLESTONE")!;
  assert.deepEqual(tierSteps(cobble, 0, 0), []);
  assert.deepEqual(tierSteps(cobble, Number.MAX_SAFE_INTEGER, 100), [], "nothing left to climb");
});
