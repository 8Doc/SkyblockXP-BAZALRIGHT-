import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCatalog } from "../src/lib/catalog";
import { buildReport } from "../src/lib/report";
import { CATEGORIES, type Category, type ResolvedTask } from "../src/lib/types";
import { groupTaskRuns } from "../src/lib/grouping";
import { resolveTasks } from "../src/lib/resolve";
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

test("the filter is only offered where it removes something", () => {
  for (const entry of report().browser) {
    if (entry.unpriced === undefined) continue;
    // Measured against the category, not against the forty rows that survived the cut: bag
    // slots are priced and sort to wherever the bag runs out of room, which can be past it.
    const unpriced = entry.unpriced.length + (entry.unpricedTruncated ?? 0);
    assert.ok(
      unpriced < entry.summary.remainingTasks,
      `${entry.category} has nothing priced, so the filter is noise`,
    );
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

/**
 * Buying an accessory and recombobulating it are two purchases, so they are two rows. Folded
 * into one they were named for the second half of the job and priced as the pair, which double
 * counted against the accessory's own row sitting just above.
 */
test("buying an accessory and recombobulating it are separate rows", () => {
  const catalog = buildCatalog({} as ProfileMember, data, { items: [], capacity: 400 });
  const recomb = catalog.tasks.filter((task) => task.id.startsWith("recombobulate_"));
  assert.ok(recomb.length > 0);
  for (const row of recomb) {
    assert.match(row.name, /^Recomb /, `${row.name} should name its own step`);
    // Its own cost is one Recombobulator, whatever it depends on.
    assert.equal(row.cost.kind, "bazaar");
    assert.deepEqual((row.cost as { items: { id: string }[] }).items.map((i) => i.id), ["RECOMBOBULATOR_3000"]);
  }
  // And the accessory it needs is a row in its own right.
  const needsBuying = recomb.filter((row) => row.requires.length > 0);
  assert.ok(needsBuying.length > 0, "some are bought before they are recombobulated");
  for (const row of needsBuying) {
    assert.ok(
      catalog.tasks.some((task) => task.id === row.requires[0]),
      `${row.name} depends on a row that is not listed`,
    );
  }
});

/**
 * You sell what you replace, never what you build on. Recombobulating the Lumberjack Artifact
 * needs the Artifact in hand, so quoting it net of the Artifact's sale price described selling
 * the very thing being upgraded — 9.6M of Recombobulator reading as 6.4M.
 */
test("a step that builds on the row above it takes no trade-in", () => {
  const bazaar: Record<string, unknown> = { RECOMBOBULATOR_3000: { quick_status: { buyPrice: 10_000_000 } } };
  const built = buildReport(
    buildCatalog({} as ProfileMember, data, { items: [], capacity: 400 }),
    { bazaar: bazaar as never, bins: null, reference: { LUMBERJACK_ARTIFACT: 3_000_000 } },
    {
      categories: new Set(CATEGORIES),
      minXp: 0,
      packageSize: 1e9,
      packageCount: 3,
      targetXp: Number.POSITIVE_INFINITY,
      budget: null,
    } as never,
  );
  const bag = built.browser.find((entry) => entry.category === "accessory_bag")!;
  for (const row of bag.tasks) {
    if (!row.id.startsWith("recombobulate_")) continue;
    if (row.netCoins === undefined || row.grossCoins === undefined) continue;
    assert.equal(row.netCoins, row.grossCoins, `${row.name} is quoted net of something it has to keep`);
  }
});

/**
 * Jacobus's slots belong to no particular accessory, so they are their own rows placed where the
 * bag runs out of room: one upgrade per two accessories that need somewhere to go. Upgrading a
 * family already in the bag takes no room — the artifact goes where the ring was — and
 * recombobulating takes none either.
 */
test("bag slots are listed where the room runs out", () => {
  const full = { accessory_bag_storage: { bag_upgrades_purchased: 13 } } as unknown as ProfileMember;
  const built = buildReport(
    buildCatalog(full, data, { items: [], capacity: 0 }),
    { bazaar: {}, bins: null },
    {
      categories: new Set(CATEGORIES),
      minXp: 0,
      packageSize: 1e9,
      packageCount: 3,
      targetXp: Number.POSITIVE_INFINITY,
      budget: null,
    } as never,
  );
  const rows = built.browser.find((entry) => entry.category === "accessory_bag")!.tasks;
  const upgrades = rows.filter((row) => row.id.startsWith("bag_upgrade_"));
  assert.ok(upgrades.length > 0, "a bag with no room should be told to buy some");
  assert.match(upgrades[0]!.note ?? "", /bag is full at this point/);

  // Between one upgrade and the next there can be at most two accessories needing a new slot.
  let sinceUpgrade = 0;
  for (const row of rows) {
    if (row.id.startsWith("bag_upgrade_")) { sinceUpgrade = 0; continue; }
    if (row.id.startsWith("accessory_") && (row.groupBase ?? 0) <= 0) sinceUpgrade++;
    assert.ok(sinceUpgrade <= 2, `${row.name} is the ${sinceUpgrade}th accessory since the last slot was bought`);
  }
});

/**
 * Bag slots are interchangeable — each is +2 at the going rate — so a run of them is a quantity
 * to buy, not a span of numbered things. A package saying "Accessory bag upgrade 14–23" makes
 * you count them yourself; "Upgrade Jacobus 10×" is the instruction, and buying them first is
 * what makes the rest of the package fit.
 */
test("a package stacks Jacobus upgrades into a count", () => {
  const member = { accessory_bag_storage: { bag_upgrades_purchased: 13 } } as unknown as ProfileMember;
  const catalog = buildCatalog(member, data, { items: [], capacity: 0 });
  const { tasks } = resolveTasks(catalog.tasks, catalog.done, { bazaar: {}, bins: null });
  const upgrades = tasks.filter((t) => t.id.startsWith("bag_upgrade_") && !catalog.done.has(t.id)).slice(0, 10);

  const runs = groupTaskRuns(upgrades);
  assert.equal(runs.length, 1, "ten upgrades are one instruction");
  assert.equal(runs[0]!.name, "Upgrade Jacobus 10×");
  assert.equal(runs[0]!.xp, 20, "two XP apiece");
  assert.match(runs[0]!.note ?? "", /\+20 slots/);

  // One on its own is still named for itself rather than as "1×".
  assert.equal(groupTaskRuns(upgrades.slice(0, 1))[0]!.name, upgrades[0]!.name);
});

/**
 * Jacobus's rows are named for the shop rather than the thing. Every other row in this category
 * is an accessory, so "Accessory bag upgrade 15" read like one at a glance when it is the slot
 * you put one in.
 */
test("bag slots are named for Jacobus", () => {
  const member = { accessory_bag_storage: { bag_upgrades_purchased: 13 } } as unknown as ProfileMember;
  const catalog = buildCatalog(member, data, { items: [], capacity: 0 });
  const upgrades = catalog.tasks.filter((t) => t.id.startsWith("bag_upgrade_"));
  assert.equal(upgrades.length, data.bagUpgrades.maxUpgrades);
  assert.equal(upgrades[13]!.name, "Jacobus 14", "numbered by the upgrade, named by the shop");

  // The stacked package row still reads as an instruction rather than a range.
  const { tasks } = resolveTasks(catalog.tasks, catalog.done, { bazaar: {}, bins: null });
  const open = tasks.filter((t) => t.id.startsWith("bag_upgrade_") && !catalog.done.has(t.id)).slice(0, 10);
  assert.equal(groupTaskRuns(open)[0]!.name, "Upgrade Jacobus 10×");
});
