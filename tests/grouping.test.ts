import { test } from "node:test";
import assert from "node:assert/strict";
import { groupTaskRuns, groupToMax, progressive } from "../src/lib/grouping";
import type { ResolvedTask } from "../src/lib/types";

function task(id: string, name: string, xp: number, coins: number | null, note?: string): ResolvedTask {
  return {
    id,
    category: "attributes",
    name,
    xp,
    requires: [],
    cost: coins === null ? { kind: "none" } : { kind: "npc", coins },
    repeatable: false,
    note,
    done: false,
    coins,
    bundle: [],
    bundleCoins: coins,
    bundleXp: xp,
    efficiency: coins === null ? null : coins / xp,
  };
}

test("consecutive tiers of one attribute collapse into a single row", () => {
  const tasks = [
    task("attribute_arthropod_resistance_1", "Arthropod Resistance 1", 1, 9_500, "1× Voracious Spider Shard"),
    task("attribute_arthropod_resistance_2", "Arthropod Resistance 2", 1, 28_000, "3× Voracious Spider Shard"),
    task("attribute_arthropod_resistance_3", "Arthropod Resistance 3", 1, 47_000, "5× Voracious Spider Shard"),
  ];

  const [run, ...rest] = groupTaskRuns(tasks);
  assert.equal(rest.length, 0, "three rows become one");
  assert.equal(run.name, "Arthropod Resistance 1–3");
  assert.equal(run.xp, 3);
  assert.equal(run.coins, 84_500);
  assert.equal(run.note, "3 levels · 9× Voracious Spider Shard", "shard counts add up into a shopping figure");
});

test("minion tiers collapse across roman numerals", () => {
  const tasks = [
    task("minion_GRAVEL_1", "Gravel Minion I", 1, 96),
    task("minion_GRAVEL_2", "Gravel Minion II", 1, 160),
    task("minion_GRAVEL_3", "Gravel Minion III", 1, 320),
  ];

  const [run] = groupTaskRuns(tasks);
  assert.equal(run.name, "Gravel Minion I–III");
  assert.equal(run.coins, 576);
});

test("different families stay apart and keep their order", () => {
  const tasks = [
    task("attribute_ice_1", "Essence of Ice 1", 1, 7_400),
    task("attribute_spider_1", "Arthropod Resistance 1", 1, 9_500),
    task("attribute_ice_2", "Essence of Ice 2", 1, 22_000),
  ];

  const runs = groupTaskRuns(tasks);
  assert.equal(runs.length, 2);
  // The ice run takes the position of its first member, so cheapest-first still reads correctly.
  assert.equal(runs[0].name, "Essence of Ice 1–2");
  assert.equal(runs[1].name, "Arthropod Resistance 1");
});

test("a lone tier is left exactly as it was", () => {
  const tasks = [task("attribute_ice_4", "Essence of Ice 4", 1, 44_000, "6× Glacite Walker Shard")];

  const [run] = groupTaskRuns(tasks);
  assert.equal(run.name, "Essence of Ice 4");
  assert.equal(run.note, "6× Glacite Walker Shard", "its own note survives untouched");
  assert.equal(run.tasks.length, 1);
});

test("untiered tasks are never merged", () => {
  const tasks = [
    task("accessory_TARANTULA_RING", "Tarantula Ring", 8, 400_000),
    task("accessory_BAT_RING", "Bat Ring", 8, 500_000),
  ];

  const runs = groupTaskRuns(tasks);
  assert.equal(runs.length, 2, "two unrelated accessories are two lines");
});

test("an unpriced member makes the whole run unpriced", () => {
  const tasks = [
    task("minion_X_1", "X Minion I", 1, 100),
    task("minion_X_2", "X Minion II", 1, null),
  ];

  const [run] = groupTaskRuns(tasks);
  assert.equal(run.coins, null, "a run can't quote a total it doesn't have");
  assert.equal(run.xp, 2);
});

test("gaps in the tiers are listed, never smoothed into a range", () => {
  // The task table is harvested from live players, so a perk nobody sampled had at tier 3 has
  // no tier 3 at all. Writing "1-5" here would invent three purchases the plan isn't making.
  const tasks = [
    task("CRIMSON_ESSENCE_FUNGUS_FORTUNA_1", "Crimson essence fungus fortuna 1", 2, 96_000),
    task("CRIMSON_ESSENCE_FUNGUS_FORTUNA_5", "Crimson essence fungus fortuna 5", 7, 480_000),
  ];

  const [run] = groupTaskRuns(tasks);
  assert.equal(run.name, "Crimson essence fungus fortuna 1, 5");
  assert.equal(run.xp, 9);
  assert.equal(run.tasks.length, 2);
});

/* ------------------------------------------------------------ group maxed */

test("maxing an attribute is one row: the levels left, the shards, the price", () => {
  // Levels 1-6 are already held, so "max this" means 7 through 10.
  const tasks = [
    task("attribute_arthropod_resistance_7", "Arthropod Resistance 7", 1, 100_000, "10× Voracious Spider Shard"),
    task("attribute_arthropod_resistance_8", "Arthropod Resistance 8", 1, 140_000, "14× Voracious Spider Shard"),
    task("attribute_arthropod_resistance_9", "Arthropod Resistance 9", 1, 180_000, "18× Voracious Spider Shard"),
    task("attribute_arthropod_resistance_10", "Arthropod Resistance 10", 1, 240_000, "24× Voracious Spider Shard"),
  ];

  const [row, ...rest] = groupToMax(tasks);
  assert.equal(rest.length, 0);
  assert.equal(row.name, "Arthropod Resistance", "named for the attribute, not the level");
  assert.equal(row.xp, 4, "four levels left");
  assert.equal(row.coins, 660_000);
  assert.equal(row.note, "levels 7–10 · 66× Voracious Spider Shard");
});

test("a single remaining level reads as a level, not a range", () => {
  const tasks = [task("attribute_ice_10", "Essence of Ice 10", 1, 240_000, "24× Glacite Walker Shard")];

  const [row] = groupToMax(tasks);
  assert.equal(row.name, "Essence of Ice");
  assert.equal(row.note, "level 10 · 24× Glacite Walker Shard");
});

test("maxed rows rank on value, with the unbuyable ones last", () => {
  const tasks = [
    task("attribute_dear_1", "Dear 1", 1, 900_000, "1× Dear Shard"),
    task("attribute_cheap_1", "Cheap 1", 1, 10_000, "1× Cheap Shard"),
    task("attribute_untradeable_1", "Untradeable 1", 1, null, "1× Untradeable Shard"),
  ];

  assert.deepEqual(
    groupToMax(tasks).map((r) => r.name),
    ["Cheap", "Dear", "Untradeable"],
  );
});

test("a line numbered only in its ids says how many tiers, not 'tiers –'", () => {
  // The museum drills are MITHRIL_DRILL_1 and _2 but read "SX-R226" and "SX-R326".
  const museum = (id: string, name: string, coins: number): ResolvedTask => ({
    ...task(id, name, 8, coins),
    category: "museum",
  });
  const tasks = [
    museum("museum_MITHRIL_DRILL_1", "Mithril Drill SX-R226", 9_000_000),
    museum("museum_MITHRIL_DRILL_2", "Mithril Drill SX-R326", 10_890_000),
  ];

  const [row] = groupToMax(tasks);
  assert.equal(row.note, "2 tiers");
  assert.equal(row.xp, 16);
  assert.equal(row.coins, 19_890_000);
});

test("pets take the best tier alone — never the sum of their tiers", () => {
  const pet = (rarity: string, level: number, coins: number): ResolvedTask => ({
    ...task(`pet_BEE_${rarity}`, `Bee (${rarity})`, level, coins, "pet score"),
    exclusiveGroup: "pet:BEE",
    groupLevel: level,
    groupBase: 0,
  });
  const tasks = [pet("uncommon", 6, 190_000), pet("rare", 9, 500_000), pet("epic", 12, 1_600_000)];

  const [row, ...rest] = groupToMax(tasks);
  assert.equal(rest.length, 0);
  assert.equal(row.name, "Bee (epic)", "named for the tier you actually buy");
  assert.equal(row.xp, 12);
  assert.equal(row.coins, 1_600_000, "the epic's price, not uncommon + rare + epic");
  assert.match(row.note ?? "", /best of 3 tiers/);
});

/* --------------------------------------------------- progressive sequences */

import { resolveTasks } from "../src/lib/resolve";
import type { Task } from "../src/lib/types";

/** Levels 2..10 of one attribute, each requiring the one below and costing 10 coins a level. */
function chain(): Task[] {
  return [2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => ({
    id: `attribute_extreme_pressure_${n}`,
    category: "attributes",
    name: `Extreme Pressure ${n}`,
    xp: 1,
    requires: n > 2 ? [`attribute_extreme_pressure_${n - 1}`] : [],
    cost: { kind: "npc", coins: 10 },
    repeatable: false,
    note: `${n}× Lumisquid Shard`,
  }));
}

test("a chain's later rows carry on instead of restating the same purchase", () => {
  const { tasks, byId } = resolveTasks(chain(), new Set(), { bazaar: {}, bins: null });
  // Only bundles of five levels or more clear the floor, which is what produced 2–6, 2–7, 2–8…
  const shown = tasks.filter((t) => t.bundleXp >= 5);
  assert.deepEqual(
    shown.map((t) => t.bundleSpan),
    ["Extreme Pressure 2–6", "Extreme Pressure 2–7", "Extreme Pressure 2–8", "Extreme Pressure 2–9", "Extreme Pressure 2–10"],
    "before trimming, five rows all start at level 2",
  );

  const stepped = progressive(shown, byId);
  assert.deepEqual(
    stepped.map((t) => t.bundleSpan ?? t.name),
    ["Extreme Pressure 2–6", "Extreme Pressure 7", "Extreme Pressure 8", "Extreme Pressure 9", "Extreme Pressure 10"],
  );
});

test("a trimmed row is re-priced over what it actually adds", () => {
  const { tasks, byId } = resolveTasks(chain(), new Set(), { bazaar: {}, bins: null });
  const stepped = progressive(tasks.filter((t) => t.bundleXp >= 5), byId);

  const [head, next] = stepped;
  assert.equal(head.bundleXp, 5, "levels 2 through 6");
  assert.equal(head.bundleCoins, 50);
  assert.equal(next.bundleXp, 1, "level 7 alone, not levels 2 through 7");
  assert.equal(next.bundleCoins, 10, "and billed for one level, not six");
  assert.equal(next.note, "7× Lumisquid Shard", "a single level shows its own shards");

  // Read top to bottom the list must add up to the chain, with nothing counted twice.
  assert.equal(stepped.reduce((s, t) => s + t.bundleXp, 0), 9);
  assert.equal(stepped.reduce((s, t) => s + (t.bundleCoins ?? 0), 0), 90);
});

test("a row wholly covered further up the list disappears", () => {
  const { tasks, byId } = resolveTasks(chain(), new Set(), { bazaar: {}, bins: null });
  const top = tasks.find((t) => t.id === "attribute_extreme_pressure_10")!;
  const mid = tasks.find((t) => t.id === "attribute_extreme_pressure_5")!;

  // The whole chain first, then a row entirely inside it.
  const stepped = progressive([top, mid], byId);
  assert.equal(stepped.length, 1, "level 5 adds nothing once 2–10 is listed");
  assert.equal(stepped[0].bundleSpan, "Extreme Pressure 2–10");
});

test("a grouped range never spans tiers it doesn't contain", () => {
  // Essence perk ids are harvested off live players, so a tier nobody sampled simply isn't
  // there. "levels 1–10" over two of them would invent eight purchases.
  const tasks = [
    task("CRIMSON_ESSENCE_FUNGUS_FORTUNA_1", "Crimson essence fungus fortuna 1", 2, 96_000),
    task("CRIMSON_ESSENCE_FUNGUS_FORTUNA_10", "Crimson essence fungus fortuna 10", 12, 480_000),
  ];

  const [row] = groupToMax(tasks);
  assert.equal(row.tasks.length, 2);
  assert.equal(row.note, "2 levels", "a count, not a range it cannot back up");
  assert.equal(row.xp, 14);
});
