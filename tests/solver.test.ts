import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveTasks, type PriceBook } from "../src/lib/resolve";
import { solve, solvePackages, type PackageOptions, type SolveOptions } from "../src/lib/solver";
import type { Task } from "../src/lib/types";

const EMPTY_BOOK: PriceBook = { bazaar: {}, bins: null };

function npc(id: string, xp: number, coins: number, requires: string[] = []): Task {
  return {
    id,
    category: "minions",
    name: id,
    xp,
    requires,
    cost: { kind: "npc", coins },
    repeatable: false,
  };
}

function options(over: Partial<SolveOptions> = {}): SolveOptions {
  return {
    targetXp: 10,
    minXp: 0,
    budget: null,
    categories: new Set(["minions", "accessory_bag", "skills"]),
    strategy: "greedy",
    ...over,
  };
}

test("a bundle costs the whole unmet prerequisite chain, not the leaf", () => {
  const tasks = [npc("t1", 1, 10), npc("t2", 1, 20, ["t1"]), npc("t3", 5, 30, ["t2"])];
  const { byId } = resolveTasks(tasks, new Set(), EMPTY_BOOK);

  const leaf = byId.get("t3")!;
  assert.deepEqual(leaf.bundle, ["t1", "t2"]);
  assert.equal(leaf.coins, 30);
  assert.equal(leaf.bundleCoins, 60);
  assert.equal(leaf.bundleXp, 7);
});

test("completed prerequisites drop out of the bundle", () => {
  const tasks = [npc("t1", 1, 10), npc("t2", 1, 20, ["t1"]), npc("t3", 5, 30, ["t2"])];
  const { byId } = resolveTasks(tasks, new Set(["t1", "t2"]), EMPTY_BOOK);

  const leaf = byId.get("t3")!;
  assert.deepEqual(leaf.bundle, []);
  assert.equal(leaf.bundleCoins, 30);
  assert.equal(leaf.efficiency, 6);
});

test("an unpriceable step makes the whole bundle unpriceable", () => {
  const grind: Task = { ...npc("t1", 1, 0), cost: { kind: "none" } };
  const tasks = [grind, npc("t2", 5, 30, ["t1"])];
  const { byId } = resolveTasks(tasks, new Set(), EMPTY_BOOK);

  assert.equal(byId.get("t2")!.bundleCoins, null);
  assert.equal(byId.get("t2")!.efficiency, null);
});

test("grind-only tasks never enter a coin plan", () => {
  const tasks: Task[] = [
    { ...npc("free", 100, 0), cost: { kind: "none" } },
    npc("paid", 10, 500),
  ];
  const plan = solve(tasks, new Set(), EMPTY_BOOK, options({ targetXp: 10 }));

  assert.equal(plan.reachedXp, 10);
  assert.deepEqual(
    plan.groups.flatMap((g) => g.tasks.map((t) => t.id)),
    ["paid"],
  );
});

test("the XP floor hides filler", () => {
  const tasks = [npc("filler", 1, 1), npc("chunk", 10, 100)];
  const plan = solve(tasks, new Set(), EMPTY_BOOK, options({ targetXp: 10, minXp: 5 }));

  assert.deepEqual(
    plan.groups.flatMap((g) => g.tasks.map((t) => t.id)),
    ["chunk"],
  );
});

test("recomputing after each pick shares a chain between two deep tiers", () => {
  // Tiers I-IV are dead weight bought once; after that the second deep tier is nearly free.
  const chain: Task[] = [
    npc("m1", 1, 1_000),
    npc("m2", 1, 1_000, ["m1"]),
    npc("m3", 1, 1_000, ["m2"]),
    npc("m4", 1, 1_000, ["m3"]),
    npc("m5", 12, 2_000, ["m4"]),
    npc("m6", 24, 2_000, ["m5"]),
  ];
  const plan = solve(chain, new Set(), EMPTY_BOOK, options({ targetXp: 40, minXp: 0 }));

  // Both deep tiers land, and the shared I-IV run is paid for exactly once.
  const ids = plan.groups.flatMap((g) => g.tasks.map((t) => t.id)).sort();
  assert.deepEqual(ids, ["m1", "m2", "m3", "m4", "m5", "m6"]);
  assert.equal(plan.coins, 8_000);
  assert.equal(plan.reachedXp, 40);
});

test("prune drops a pick the plan outgrew", () => {
  // Greedy takes the efficient small one first, then a chunk that covers the target alone.
  const tasks = [npc("small", 5, 40), npc("chunk", 20, 200)];
  const plan = solve(tasks, new Set(), EMPTY_BOOK, options({ targetXp: 20 }));

  assert.deepEqual(
    plan.groups.flatMap((g) => g.tasks.map((t) => t.id)),
    ["chunk"],
  );
  assert.equal(plan.coins, 200);
});

test("exact wins where the best rate is a trap", () => {
  // The 9/xp pick leaves an awkward 4 XP that only a bad rate can fill. Two 10/xp picks
  // tile the target exactly and come out cheaper. Greedy commits to the best rate first
  // and can't unwind it; prune can't help because dropping either piece misses the target.
  const tasks = [npc("best_rate", 6, 54), npc("even_a", 5, 50), npc("even_b", 5, 50), npc("dear", 4, 60)];

  const greedy = solve(tasks, new Set(), EMPTY_BOOK, options({ targetXp: 10, strategy: "greedy" }));
  const exact = solve(tasks, new Set(), EMPTY_BOOK, options({ targetXp: 10, strategy: "exact" }));

  assert.equal(greedy.coins, 104);
  assert.equal(exact.coins, 100);
  assert.deepEqual(
    exact.groups.flatMap((g) => g.tasks.map((t) => t.id)).sort(),
    ["even_a", "even_b"],
  );
});

/** An accessory family: three items, one slot's worth of magical power between them. */
function familyMember(id: string, mp: number, coins: number, base = 0): Task {
  return {
    id,
    category: "accessory_bag",
    name: id,
    xp: Math.max(mp - base, 0),
    requires: [],
    cost: { kind: "npc", coins },
    repeatable: false,
    exclusiveGroup: "accessory:bat",
    groupLevel: mp,
    groupBase: base,
  };
}

test("a second buy in the same family is only worth the difference", () => {
  // Talisman 3 MP, Ring 8, Artifact 12. Buying all three is worth 12 XP, not 23.
  const family = [familyMember("talisman", 3, 30), familyMember("ring", 8, 40), familyMember("artifact", 12, 60)];

  const plan = solve(family, new Set(), EMPTY_BOOK, options({ targetXp: 12, minXp: 0 }));

  assert.equal(plan.reachedXp, 12, "the family ceiling is 12 XP however many members you buy");
  assert.ok(plan.coins <= 130, "and it never pays for more than the family is worth");
});

test("greedy tops up a family instead of double-counting it", () => {
  // The talisman is the best rate, but it alone can't reach 12 — the artifact has to follow,
  // and it may only claim the 9 XP it adds on top.
  const family = [familyMember("talisman", 3, 3), familyMember("artifact", 12, 900)];

  const plan = solve(family, new Set(), EMPTY_BOOK, options({ targetXp: 12, minXp: 0 }));
  const tasks = plan.groups.flatMap((g) => g.tasks);

  assert.equal(plan.reachedXp, 12);
  const artifact = tasks.find((t) => t.id === "artifact");
  if (tasks.length === 2) {
    assert.equal(artifact?.xp, 9, "the artifact adds 9 on top of the talisman's 3");
  } else {
    assert.equal(artifact?.xp, 12, "bought alone, the artifact is worth its full 12");
  }
});

test("magical power already owned is not sold back to the player", () => {
  // The bag already gives 8 from this family, so the 12 MP artifact is a 4 XP upgrade.
  const family = [familyMember("artifact", 12, 100, 8)];
  const { byId } = resolveTasks(family, new Set(), EMPTY_BOOK);
  assert.equal(byId.get("artifact")!.xp, 4);

  const plan = solve(family, new Set(), EMPTY_BOOK, options({ targetXp: 4, minXp: 0 }));
  assert.equal(plan.reachedXp, 4);
});

test("the budget is a hard cap", () => {
  const tasks = [npc("cheap", 5, 100), npc("dear", 50, 5_000)];
  const plan = solve(tasks, new Set(), EMPTY_BOOK, options({ targetXp: 50, budget: 1_000 }));

  assert.equal(plan.coins, 100);
  assert.equal(plan.reachedXp, 5);
  assert.equal(plan.short, true);
});

test("the plan comes back grouped by category, biggest chunk first", () => {
  const tasks: Task[] = [
    { ...npc("ring", 16, 500), category: "accessory_bag" },
    { ...npc("stone", 24, 400), category: "minions" },
  ];
  const plan = solve(tasks, new Set(), EMPTY_BOOK, options({ targetXp: 40 }));

  assert.deepEqual(
    plan.groups.map((g) => g.category),
    ["minions", "accessory_bag"],
  );
  assert.equal(plan.levelsGained, 0);
  assert.equal(plan.reachedXp, 40);
});

/* ---------------------------------------------------------------- packages */

function packageOptions(over: Partial<PackageOptions> = {}): PackageOptions {
  return {
    ...options(),
    targetXp: Number.POSITIVE_INFINITY,
    packageSize: 1_000,
    packageCount: 3,
    ...over,
  };
}

test("packages spend up to the size and never over it", () => {
  const tasks = [npc("a", 10, 600), npc("b", 10, 600), npc("c", 10, 600), npc("d", 10, 600)];
  const plan = solvePackages(tasks, new Set(), EMPTY_BOOK, packageOptions({ packageSize: 1_000 }));

  assert.equal(plan.packages.length, 3);
  for (const pkg of plan.packages) {
    assert.ok(pkg.coins <= 1_000, `package ${pkg.index} spent ${pkg.coins}`);
    assert.equal(pkg.coins, 600, "only one 600-coin task fits in a 1,000 budget");
  }
});

test("each package picks up where the last one left off", () => {
  const tasks = [npc("a", 10, 500), npc("b", 10, 500), npc("c", 10, 500)];
  const plan = solvePackages(tasks, new Set(), EMPTY_BOOK, packageOptions({ packageSize: 500, packageCount: 3 }));

  const picked = plan.packages.flatMap((p) => p.groups.flatMap((g) => g.tasks.map((t) => t.id)));
  assert.deepEqual(picked.sort(), ["a", "b", "c"], "no task is sold twice");
  assert.deepEqual(
    plan.packages.map((p) => p.cumulativeXp),
    [10, 20, 30],
  );
});

test("the cheapest XP goes into the first package", () => {
  const tasks = [npc("cheap", 10, 100), npc("mid", 10, 500), npc("dear", 10, 900)];
  const plan = solvePackages(tasks, new Set(), EMPTY_BOOK, packageOptions({ packageSize: 900, packageCount: 3 }));

  // Package 1 is always the best value, because the fill is cheapest-first over the whole pool.
  const best = Math.min(...plan.packages.map((p) => p.rate));
  assert.equal(plan.packages[0].rate, best);
  assert.ok(plan.packages[0].rate < plan.packages[plan.packages.length - 1].rate, "value decays overall");
});

test("later packages are not strictly monotonic, and that is fine", () => {
  // A package closes when nothing left *fits its remaining headroom*, not when the pool is
  // empty — so a package can end early and cheap while the next one, with a fresh budget,
  // affords a bigger item. Real profiles do this; the guarantee is only that nothing exceeds
  // the package size.
  const tasks = [npc("a", 10, 600), npc("b", 20, 900), npc("c", 10, 700)];
  const plan = solvePackages(tasks, new Set(), EMPTY_BOOK, packageOptions({ packageSize: 1_000, packageCount: 3 }));

  for (const pkg of plan.packages) assert.ok(pkg.coins <= 1_000);
  assert.equal(
    plan.packages.reduce((s, p) => s + p.xp, 0),
    40,
    "everything still gets bought across the packages",
  );
});

test("a prerequisite bought in one package is already paid for in the next", () => {
  // The chain costs 900 up front, which eats most of package 1; the deep tier is then cheap.
  const tasks = [
    npc("m1", 1, 300),
    npc("m2", 1, 300, ["m1"]),
    npc("m3", 1, 300, ["m2"]),
    npc("m4", 24, 100, ["m3"]),
  ];
  const plan = solvePackages(tasks, new Set(), EMPTY_BOOK, packageOptions({ packageSize: 1_000, packageCount: 2, minXp: 0 }));

  const total = plan.packages.reduce((s, p) => s + p.coins, 0);
  assert.equal(total, 1_000, "the whole chain is bought exactly once");
  assert.equal(
    plan.packages.reduce((s, p) => s + p.xp, 0),
    27,
  );
});

test("running out of affordable work is reported, not padded", () => {
  const tasks = [npc("only", 10, 400)];
  const plan = solvePackages(tasks, new Set(), EMPTY_BOOK, packageOptions({ packageSize: 500, packageCount: 4 }));

  assert.equal(plan.packages.length, 1);
  assert.equal(plan.exhausted, true);
});

test("exact packages beat greedy ones when the budget tiles awkwardly", () => {
  // 900 of budget: greedy takes the best rate (500 for 6xp) then can't fit another; the exact
  // fill sees that two 450s buy 10 XP for the same money.
  const tasks = [npc("best_rate", 6, 500), npc("pair_a", 5, 450), npc("pair_b", 5, 450)];

  const greedy = solvePackages(tasks, new Set(), EMPTY_BOOK, packageOptions({ packageSize: 900, packageCount: 1, minXp: 0 }));
  const exact = solvePackages(
    tasks,
    new Set(),
    EMPTY_BOOK,
    packageOptions({ packageSize: 900, packageCount: 1, minXp: 0, strategy: "exact" }),
  );

  assert.equal(greedy.packages[0].xp, 6);
  assert.equal(exact.packages[0].xp, 10);
  assert.ok(exact.packages[0].coins <= 900);
});

test("packages come back grouped by category like the batch plan", () => {
  const tasks: Task[] = [
    { ...npc("ring", 16, 300), category: "accessory_bag" },
    { ...npc("stone", 24, 300), category: "minions" },
  ];
  const plan = solvePackages(tasks, new Set(), EMPTY_BOOK, packageOptions({ packageSize: 1_000, packageCount: 1 }));

  assert.deepEqual(
    plan.packages[0].groups.map((g) => g.category),
    ["minions", "accessory_bag"],
  );
});

test("the XP floor is where the convenience is paid for", () => {
  // The 4 XP task is the best value per coin in the pool, and a floor of 5 hides it. The ideal
  // frontier ignores the floor, so the gap is what tidiness cost.
  const tasks = [npc("great_value_tiny", 4, 100), npc("chunky", 10, 900)];
  const plan = solvePackages(tasks, new Set(), EMPTY_BOOK, packageOptions({ packageSize: 1_000, packageCount: 1, minXp: 5 }));

  const pkg = plan.packages[0];
  assert.equal(pkg.xp, 10, "the floor keeps the small task out of the package");
  assert.ok(pkg.idealXp > pkg.xp, "the unfiltered frontier does better with the same coins");
  assert.ok(pkg.bleedXp > 0);
});

test("the bleed is never negative, because the baseline is a fractional bound", () => {
  // A package that lands on a chunky item could otherwise appear to beat a stepped frontier
  // that hasn't cleared that purchase yet.
  const tasks = [npc("tiny", 1, 50), npc("chunky", 20, 800)];
  const plan = solvePackages(tasks, new Set(), EMPTY_BOOK, packageOptions({ packageSize: 900, packageCount: 2, minXp: 0 }));

  for (const pkg of plan.packages) assert.ok(pkg.bleedXp >= 0, `package ${pkg.index} bled ${pkg.bleedXp}`);
});

test("no floor and a clean tiling means nothing is bled", () => {
  const tasks = [npc("a", 10, 500), npc("b", 10, 500)];
  const plan = solvePackages(tasks, new Set(), EMPTY_BOOK, packageOptions({ packageSize: 500, packageCount: 2, minXp: 0 }));

  for (const pkg of plan.packages) assert.equal(pkg.bleedXp, 0);
  assert.equal(plan.totalBleedXp, 0);
});

test("bleed is reported per package and as a running total", () => {
  const tasks = [npc("tiny_a", 4, 100), npc("tiny_b", 4, 100), npc("chunky", 10, 700)];
  const plan = solvePackages(tasks, new Set(), EMPTY_BOOK, packageOptions({ packageSize: 800, packageCount: 2, minXp: 5 }));

  const last = plan.packages[plan.packages.length - 1];
  assert.equal(plan.totalBleedXp, last.bleedXp, "the total is the final cumulative gap");
  assert.equal(plan.totalIdealXp, last.idealXp);
  assert.ok(plan.totalBleedXp > 0, "the two hidden tasks are the bleed");
});

test("a package wall that blocks a good item shows up as bleed", () => {
  // The best value item costs more than one package, so packaging can never reach it while
  // the unpackaged frontier walks straight to it.
  const tasks = [npc("best_value", 40, 900), npc("filler", 5, 500)];
  const plan = solvePackages(tasks, new Set(), EMPTY_BOOK, packageOptions({ packageSize: 500, packageCount: 3, minXp: 0 }));

  assert.equal(plan.packages[0].xp, 5, "only the filler fits in a 500 package");
  assert.ok(plan.packages[0].bleedXp > 0, "the frontier was part-way into the better item");
});

/* ------------------------------------------------- accessory bag slots */

test("a full accessory bag adds the slot cost to every accessory", () => {
  const withSlot: Task = {
    id: "ring",
    category: "accessory_bag",
    name: "Ring",
    xp: 8,
    requires: [],
    // 10M surcharge = half a 20M Jacobus upgrade, which grants 2 slots.
    cost: { kind: "auction", itemId: "RING", surcharge: 10_000_000 },
    repeatable: false,
  };
  const book: PriceBook = {
    bazaar: {},
    bins: { prices: { RING: { RARE: 500_000 } }, scannedAt: 0, pages: 1, listings: 1 },
  };

  const { byId } = resolveTasks([withSlot], new Set(), book);
  assert.equal(byId.get("ring")!.coins, 10_500_000, "the slot is part of what the accessory costs");
});

test("with slots to spare there is no surcharge", () => {
  const noSurcharge: Task = {
    id: "ring",
    category: "accessory_bag",
    name: "Ring",
    xp: 8,
    requires: [],
    cost: { kind: "auction", itemId: "RING" },
    repeatable: false,
  };
  const book: PriceBook = {
    bazaar: {},
    bins: { prices: { RING: { RARE: 500_000 } }, scannedAt: 0, pages: 1, listings: 1 },
  };

  const { byId } = resolveTasks([noSurcharge], new Set(), book);
  assert.equal(byId.get("ring")!.coins, 500_000);
});
