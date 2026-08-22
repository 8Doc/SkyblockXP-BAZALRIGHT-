import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCatalog } from "../src/lib/catalog";
import { buildReport } from "../src/lib/report";
import { CATEGORIES, type Category, type ResolvedTask } from "../src/lib/types";
import { gameData } from "./gameDataFixture";
import type { ProfileMember } from "../src/lib/profile";

const data = gameData();
const report = (categories: Category[] = CATEGORIES, member: ProfileMember = {} as ProfileMember) =>
  buildReport(buildCatalog(member, data, { items: [], capacity: 400 }), { bazaar: {}, bins: null }, {
    categories: new Set(categories),
    minXp: 0,
    packageSize: 1e9,
    packageCount: 3,
    targetXp: Number.POSITIVE_INFINITY,
    budget: null,
  } as never);

/**
 * An accessory nobody may sell is a grind with an item at the end of it. It was priced as
 * "unknown" — the kind meaning a price exists and we could not find it — which kept it out of
 * the grind order entirely, so the one list for planning an evening's work never mentioned them.
 */
test("accessories that cannot be bought are priced as a grind", () => {
  const catalog = buildCatalog({} as ProfileMember, data, { items: [], capacity: 400 });
  const rows = catalog.tasks.filter((task) => task.id.startsWith("accessory_") && task.cost.kind === "grind");
  assert.ok(rows.length > 0, "expected accessories nobody can buy");

  for (const row of rows) {
    const id = row.id.replace("accessory_", "");
    const accessory = data.accessories.accessories.find((a) => a.id === id)!;
    assert.equal(accessory.tradeable, false, `${row.name} is tradeable and should carry a price`);
    assert.match((row.cost as { note: string }).note, /Soulbound|Not tradeable/);
  }
});

test("they reach the grind order, and priceless-but-buyable rows do not", () => {
  // Narrowed to the one category, because the grind order is capped at the sixty easiest things
  // across the whole game and an accessory only a tenth of players own does not belong near the
  // top of that. Eligibility is the thing being tested, not rank.
  const grind = report(["accessory_bag"]).grind;
  assert.ok(
    grind.some((task: ResolvedTask) => task.cost.kind === "grind"),
    "no unbuyable accessory reached the grind order",
  );
  assert.ok(
    !grind.some((task: ResolvedTask) => task.cost.kind === "unknown"),
    "a task we merely failed to price is not something to send someone grinding for",
  );
});

/**
 * The grind order ranks on how many sampled players have already done a thing. Accessories are
 * the one grind whose completion is an item in a gzipped blob rather than a flag on the profile,
 * which is why they had no difficulty behind them until the harvester learned to read bags.
 */
test("unbuyable accessories carry a measured difficulty", () => {
  const rates = data.difficulty.completionRate;
  const measured = Object.keys(rates).filter((id) => id.startsWith("accessory_"));
  assert.ok(measured.length > 50, `only ${measured.length} accessories have a completion rate`);

  const grind = report(["accessory_bag"]).grind.filter((task: ResolvedTask) => task.cost.kind === "grind");
  const ranked = grind.filter((task: ResolvedTask) => rates[task.id] !== undefined);
  assert.ok(ranked.length > 0, "no unbuyable accessory in the grind order has a rate behind it");

  // Easiest first is the whole ordering, so a row with a rate must never sit below one without.
  const firstUnmeasured = grind.findIndex((task: ResolvedTask) => rates[task.id] === undefined);
  const lastMeasured = grind.map((task: ResolvedTask) => rates[task.id] !== undefined).lastIndexOf(true);
  if (firstUnmeasured >= 0 && lastMeasured >= 0) {
    assert.ok(firstUnmeasured > lastMeasured, "an unmeasured grind sorted above a measured one");
  }
});

/**
 * The category browser offers the same rows with everything buyable taken out. Only where a
 * category has both kinds: a list with nothing purchasable in it needs no button to say so.
 */
test("a category with both kinds offers the unpriced slice", () => {
  const bag = report().browser.find((entry) => entry.category === "accessory_bag")!;
  assert.ok(bag.unpriced && bag.unpriced.length > 0, "the accessory bag should offer the filter");
  for (const task of bag.unpriced!) {
    assert.equal(task.bundleCoins, null, `${task.name} has a price and should not be in this slice`);
  }
  assert.ok(bag.unpriced!.length < bag.summary.remainingTasks, "the filter should remove something");
});

test("a category with nothing buyable does not offer it", () => {
  for (const entry of report().browser) {
    if (entry.unpriced === undefined) continue;
    const priced = entry.tasks.some((task) => task.bundleCoins !== null);
    assert.ok(priced, `${entry.category} has nothing priced, so the filter is noise`);
  }
});

/**
 * "One row per thing" and "only what I cannot buy" are independent questions, so both can be on
 * at once. Turning the second on used to hide the first's button, which made the pair of them
 * unreachable — a category where the unbuyable half is a dozen attributes is exactly where you
 * want to see it grouped.
 */
test("grouping and the no-price filter compose", () => {
  // A price book with the bazaar in it, so a category ends up with both kinds in it. Attributes
  // are priced from the shards that feed them, and eleven of those shards do not trade.
  const bazaar: Record<string, unknown> = {};
  for (const attribute of data.attributeShards.attributes) {
    if (attribute.tradeable) bazaar[attribute.shardId] = { quick_status: { buyPrice: 100 } };
  }
  const built = buildReport(
    buildCatalog({} as ProfileMember, data, { items: [], capacity: 400 }),
    { bazaar: bazaar as never, bins: null },
    {
      categories: new Set(CATEGORIES),
      minXp: 0,
      packageSize: 1e9,
      packageCount: 3,
      targetXp: Number.POSITIVE_INFINITY,
      budget: null,
    } as never,
  );

  const attributes = built.browser.find((entry) => entry.category === "attributes")!;
  assert.ok(attributes.maxed?.length, "attributes group");
  assert.ok(attributes.unpriced?.length, "and some of them cannot be bought");
  assert.ok(attributes.unpricedMaxed?.length, "so the pair of them has to produce rows");

  // Grouped *then* filtered would leave rows half-made of purchases. Filtered then grouped means
  // a row is the whole of what it takes to max that attribute by grinding.
  for (const run of attributes.unpricedMaxed!) {
    for (const task of run.tasks) {
      assert.equal(task.bundleCoins, null, `${run.name} contains a level that can be bought`);
    }
  }
  assert.ok(
    attributes.unpricedMaxed!.length <= attributes.maxed!.length,
    "the filter cannot produce more rows than grouping alone",
  );
});

/** A category with nothing groupable offers no combined view rather than an empty one. */
test("the combined view is absent where there is nothing to group", () => {
  const built = report();
  for (const entry of built.browser) {
    if (entry.unpricedMaxed === undefined) continue;
    assert.ok(entry.maxed !== undefined, `${entry.category} has a combined view but nothing to group`);
    assert.ok(entry.unpriced !== undefined, `${entry.category} has a combined view but nothing unpriced`);
  }
});
