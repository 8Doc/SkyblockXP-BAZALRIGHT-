import { test } from "node:test";
import assert from "node:assert/strict";
import { groupTaskRuns } from "../src/lib/grouping";
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
