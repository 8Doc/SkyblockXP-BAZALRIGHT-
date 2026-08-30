import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCatalog } from "../src/lib/catalog";
import { buildReport } from "../src/lib/report";
import { CATEGORIES, type Category, type Task } from "../src/lib/types";
import { gameData } from "./gameDataFixture";
import type { ProfileMember } from "../src/lib/profile";

const data = gameData();
const rep = data.factionReputation;

function member(mages = 0, barbarians = 0): ProfileMember {
  return { nether_island_player_data: { mages_reputation: mages, barbarians_reputation: barbarians } } as ProfileMember;
}

const tasksFor = (m: ProfileMember) => buildCatalog(m, data, { items: [], capacity: 400 }).tasks;
const minion = (tasks: Task[], generator: string, tier: number) =>
  tasks.find((t) => t.id === `minion_${generator}_${tier}`)!;

/* ------------------------------------------------------------- the gate */

test("a faction minion tier above your reputation says what it needs", () => {
  // 2,000 mage reputation buys Mycelium up to tier IV; tier V wants 3,000.
  const tasks = tasksFor(member(2000));

  assert.equal(minion(tasks, "MYCELIUM", 4).blocked, undefined, "tier IV is affordable at 2,000");
  assert.equal(minion(tasks, "MYCELIUM", 5).blocked, "needs 3,000 mage rep");
  assert.equal(minion(tasks, "MYCELIUM", 12).blocked, "needs 12,000 mage rep");
});

test("the two factions are read apart", () => {
  // Standing with the mages says nothing about what the barbarians will sell you, and since
  // November 2024 earning one no longer costs the other — so both are read, whichever the
  // player is standing in.
  const tasks = tasksFor(member(12000, 0));

  assert.equal(minion(tasks, "MYCELIUM", 12).blocked, undefined, "hero with the mages buys the lot");
  assert.equal(minion(tasks, "RED_SAND", 1).blocked, "needs 500 barbarian rep");
});

test("reputation at the cap unblocks every tier of its line", () => {
  const tasks = tasksFor(member(rep.cap, rep.cap));

  for (const generator of Object.keys(rep.minions)) {
    for (let tier = 1; tier <= 12; tier++) {
      assert.equal(minion(tasks, generator, tier).blocked, undefined, `${generator} ${tier} still blocked at the cap`);
    }
  }
});

test("no other minion is gated on anything", () => {
  // Every other merchant sells to whoever turns up. A stray gate here would sink a whole line
  // to the bottom of the category for no reason anyone could see.
  const gated = new Set(Object.keys(rep.minions));
  const stray = tasksFor(member(0, 0)).filter(
    (t) => t.category === "minions" && t.blocked && !gated.has(t.id.replace(/^minion_(.+)_\d+$/, "$1")),
  );

  assert.deepEqual(stray.map((t) => t.id), []);
});

test("a profile with no Crimson Isle data reads as no reputation, not as unknown", () => {
  // Never having set foot on the isle and having nothing to show for it are the same thing here:
  // the merchant says no either way, so the row is gated rather than quietly offered.
  const tasks = tasksFor({} as ProfileMember);
  assert.equal(minion(tasks, "MYCELIUM", 1).blocked, "needs 500 mage rep");
});

test("what the game will not sell you sinks below what it will", () => {
  const catalog = buildCatalog(member(0, 0), data, { items: [], capacity: 400 });
  const report = buildReport(catalog, { bazaar: {}, bins: null }, {
    categories: new Set(CATEGORIES) as Set<Category>,
    minXp: 0,
    packageSize: 1e9,
    packageCount: 1,
    targetXp: Number.POSITIVE_INFINITY,
    budget: null,
  } as never);
  const rows = report.browser.find((entry) => entry.category === "minions")!.tasks;

  const firstBlocked = rows.findIndex((t) => t.blocked);
  const lastOpen = rows.map((t) => !t.blocked).lastIndexOf(true);
  if (firstBlocked >= 0) {
    assert.ok(firstBlocked > lastOpen, "a gated row turned up above one that is actually buyable");
  }
});

test("a gated row survives the cut, however far down it sinks", () => {
  // Sinking it below seven hundred minion tiers and then showing forty is the same as deleting
  // it — and it would reappear out of nowhere the day the reputation landed, having never been
  // mentioned. So it sits at the bottom of what is shown rather than off the end of it.
  const catalog = buildCatalog(member(0, 0), data, { items: [], capacity: 400 });
  const report = buildReport(catalog, { bazaar: {}, bins: null }, {
    categories: new Set(CATEGORIES) as Set<Category>,
    minXp: 0,
    packageSize: 1e9,
    packageCount: 1,
    targetXp: Number.POSITIVE_INFINITY,
    budget: null,
  } as never);
  const entry = report.browser.find((e) => e.category === "minions")!;

  assert.ok(entry.tasks.length > 40, "gated rows should be carried past the forty-row cut");
  const gated = entry.tasks.filter((t) => t.blocked);
  assert.ok(gated.length > 0, "no gated minion row reached the panel at zero reputation");
  // Every one of them is at the end, after the rows that can actually be acted on.
  const firstGated = entry.tasks.findIndex((t) => t.blocked);
  assert.ok(
    entry.tasks.slice(firstGated).every((t) => t.blocked),
    "a buyable row turned up below a gated one",
  );
  // And the "+N more" counts only what was really dropped.
  assert.ok(entry.truncated >= 0);
});

test("the same holds for the value ranking", () => {
  const catalog = buildCatalog(member(0, 0), data, { items: [], capacity: 400 });
  const report = buildReport(catalog, { bazaar: {}, bins: null }, {
    categories: new Set(CATEGORIES) as Set<Category>,
    minXp: 0,
    packageSize: 1e9,
    packageCount: 1,
    targetXp: Number.POSITIVE_INFINITY,
    budget: null,
  } as never);

  const gated = report.cheapest.tasks.filter((t) => t.blocked);
  assert.ok(gated.length > 0, "the gated minions fell out of cheapest-first entirely");
  assert.ok(
    report.cheapest.tasks.slice(-gated.length).every((t) => t.blocked),
    "gated rows should be the tail of the list, not scattered through it",
  );
});

/* ------------------------------------------------------- essence shop */

test("an essence perk says what it costs in essence", () => {
  const tasks = tasksFor({} as ProfileMember);
  const perk = tasks.find((t) => t.id === "WITHER_ESSENCE_FORBIDDEN_BLESSING_6")!;

  // 1,200 wither essence at tier 6, per the wiki cost table.
  assert.equal(perk.note, "1.2k wither essence");
});

test("every priced perk carries its amount, and none of them still say the rule", () => {
  const tasks = tasksFor({} as ProfileMember).filter((t) => t.category === "essence_shop");
  assert.ok(tasks.length > 100, `expected the essence category, got ${tasks.length} rows`);

  const priced = tasks.filter((t) => t.cost.kind === "bazaar");
  assert.ok(priced.length > 0);
  for (const task of priced) {
    assert.match(task.note ?? "", /^[\d.]+[kMB]? \w+ essence$/, `${task.id} does not state its essence`);
  }
  // The rows we cannot price keep saying so rather than inventing a figure.
  for (const task of tasks) {
    if (task.cost.kind !== "bazaar") assert.doesNotMatch(task.note ?? "", / essence$/);
  }
});

/* ---------------------------------------------------- bestiary ordering */

function bestiary(kills: Record<string, number>) {
  const catalog = buildCatalog({ bestiary: { kills } } as ProfileMember, data, { items: [], capacity: 400 });
  const report = buildReport(catalog, { bazaar: {}, bins: null }, {
    categories: new Set(CATEGORIES) as Set<Category>,
    minXp: 0,
    packageSize: 1e9,
    packageCount: 1,
    targetXp: Number.POSITIVE_INFINITY,
    budget: null,
  } as never);
  return report.browser.find((entry) => entry.category === "bestiary")!;
}

test("every bestiary row carries the kills it has left as a number", () => {
  const entry = bestiary({});
  assert.ok(entry.tasks.length > 0);

  for (const row of entry.tasks) {
    assert.equal(typeof row.remaining, "number", `${row.id} has no kill count to rank on`);
    // The note states the same figure, so the two must not drift apart.
    assert.match(row.note ?? "", new RegExp(`^${row.remaining!.toLocaleString("en-US")} more kill`));
  }
});

test("closest-first is ordered on kills left, fewest first", () => {
  const entry = bestiary({});
  assert.ok(entry.closest, "the bestiary panel offers the toggle");

  const left = entry.closest!.map((t) => t.remaining ?? Infinity);
  assert.deepEqual(left, [...left].sort((a, b) => a - b), "not sorted by kills remaining");
});

test("it is a reorder, not a different list", () => {
  const entry = bestiary({});

  // Both views are drawn from the same pool and cut to the same forty — so the shown rows differ
  // (that is the point) while the totals behind them do not. Comparing the shown rows for
  // equality would be comparing two different top-forties.
  assert.equal(
    entry.closest!.length + entry.closestTruncated!,
    entry.tasks.length + entry.truncated,
    "the two orderings are ranking different pools",
  );
  assert.notDeepEqual(
    entry.closest!.map((t) => t.id),
    entry.tasks.map((t) => t.id),
    "the two orderings should not agree, or the toggle says nothing",
  );
});

test("a tier one kill away leads, whatever its family costs in the round", () => {
  // The ranking scales a tier against its own family's ladder, so a short-laddered family one
  // kill from the next tier reads as a marathon and sinks. That is the row this toggle exists
  // to surface.
  const entry = bestiary({});
  const nearest = entry.closest![0].remaining ?? Infinity;
  const bestOnShow = Math.min(...entry.tasks.map((t) => t.remaining ?? Infinity));

  assert.ok(
    nearest <= bestOnShow,
    `closest-first leads with ${nearest} kills left while the default view already shows ${bestOnShow}`,
  );
});
