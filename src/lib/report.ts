import type { Catalog } from "./catalog";
import { resolveTasks, type PriceBook } from "./resolve";
import { solve, solvePackages, type SolveOptions } from "./solver";
import { groupToMax, progressive, type TaskRun } from "./grouping";
import {
  CATEGORIES,
  XP_PER_LEVEL,
  type Category,
  type CategorySummary,
  type PackagePlan,
  type Plan,
  type ResolvedTask,
} from "./types";

/**
 * Everything the UI needs for one profile at one set of settings: the plan (query A/C), the
 * category browser (query B), and the coverage figures that keep the totals honest.
 *
 * Pure — the caller has already fetched prices and built the catalog — so the Next route and
 * the standalone HTML produce identical answers from identical inputs.
 *
 * Takes a prebuilt catalog rather than building one. The catalog depends only on the profile,
 * never on the solver knobs, so rebuilding ~5,000 tasks every time a slider moves is pure
 * waste — the caller builds it once per profile and re-solves as often as it likes.
 */

export type ReportOptions = SolveOptions & {
  /** Coins per package for the package view. */
  packageSize: number;
  packageCount: number;
};

export type Report = {
  progress: { xp: number; level: number; modelledEarnedXp: number; modelledRemainingXp: number };
  plan: Plan;
  packages: PackagePlan;
  browser: {
    category: Category;
    summary: CategorySummary;
    tasks: ResolvedTask[];
    truncated: number;
    /**
     * The same remaining work collapsed to one row per thing rather than one per tier — for
     * attributes, "max Arthropod Resistance" instead of its ten separate levels. Only emitted
     * where the tiers are numerous enough that listing them individually is the wrong view.
     */
    maxed?: TaskRun[];
    maxedTruncated?: number;
  }[];
  /** Every remaining grind, cheapest in effort first, across all categories at once. */
  grind: ResolvedTask[];
  /**
   * Everything buyable, cheapest per XP first, with the category walls down — the raw value
   * ranking. `grouped` is the same list with each multi-tier thing folded into the single
   * purchase it really is.
   */
  cheapest: { tasks: ResolvedTask[]; truncated: number; grouped: TaskRun[]; groupedTruncated: number };
  unmodelled: { category: Category; note: string; totalXp?: number; earnedXp?: number }[];
  /** Per category: what the profile says you have against what we could credit. */
  reconciliation: { category: Category; credited: number; reported: number }[];
  bag: {
    computedMp: number;
    reportedMp: number | null;
    readable: boolean;
    capacity: number;
    used: number;
    /** Magical power still to gain — the accessory bag category *without* its slot upgrades. */
    powerLeft: number;
  };
};

const BROWSER_LIMIT = 40;

/**
 * The value ranking is one list rather than seventeen, so it can afford to be longer — but not
 * unbounded: a full profile has thousands of buyable tasks and rendering all of them costs more
 * than anyone gets from row 2,000 of a list sorted worst-last.
 */
const CHEAPEST_LIMIT = 300;

/**
 * Categories that read better collapsed to one row per thing — the ones built from long ladders
 * whose rungs differ only in how many of the same input they want, so the per-level rows carry
 * almost no information the grouped row doesn't. Attributes are 181 things of ten levels each;
 * the essence shop is the same shape, a perk at a time.
 */
const GROUPABLE = new Set<Category>(["attributes", "essence_shop"]);

export function buildReport(catalog: Catalog, book: PriceBook, options: ReportOptions): Report {
  const plan = solve(catalog.tasks, catalog.done, book, options);
  // The package view answers a different question, so it gets its own solve rather than a
  // post-hoc slicing of the plan above: slicing by cost would strand prerequisite bundles
  // across package boundaries.
  const packages = solvePackages(catalog.tasks, catalog.done, book, {
    ...options,
    targetXp: Number.POSITIVE_INFINITY,
    budget: null,
    packageSize: options.packageSize,
    packageCount: options.packageCount,
  });
  const { tasks: resolved, byId } = resolveTasks(catalog.tasks, catalog.done, book);

  /* --------------------------------------------- query B: category browser */

  const modelled = new Set(catalog.tasks.map((t) => t.category));
  const browser: Report["browser"] = [];

  for (const category of CATEGORIES) {
    if (!modelled.has(category)) continue;
    const remaining = resolved.filter((t) => t.category === category && !t.done && t.xp > 0);
    const priced = remaining.filter((t) => t.bundleCoins !== null);

    const summary: CategorySummary = {
      category,
      modelled: true,
      remainingTasks: remaining.length,
      remainingXp: achievableXp(remaining),
      pricedXp: achievableXp(priced),
      pricedCoins: bestMemberCost(priced),
    };

    // Priced tasks rank on coins per XP. Grind tasks have no price, so they rank on observed
    // effort — easiest first — which is the only ordering those categories have ever had.
    const shown = remaining
      .filter((t) => t.bundleXp >= options.minXp)
      .sort((a, b) => {
        if (a.efficiency === null && b.efficiency === null) {
          const effort = (a.effort ?? 1) - (b.effort ?? 1);
          return effort !== 0 ? effort : b.xp - a.xp;
        }
        if (a.efficiency === null) return 1;
        if (b.efficiency === null) return -1;
        return a.efficiency - b.efficiency;
      });

    // Grouped from the *untruncated* remaining set: the point of the view is that maxing an
    // attribute is one decision, so it can't be assembled out of whichever forty levels
    // happened to survive the cut. The XP floor still applies, measured against the grouped
    // row — a floor is a statement about how small a purchase is worth making, and grouped,
    // these purchases are large.
    const maxed = GROUPABLE.has(category)
      ? groupToMax(remaining).filter((run) => run.xp >= options.minXp)
      : null;

    // Trimmed to a sequence: a chain's later rows carry on from where its earlier ones stopped
    // instead of restating the same purchase from the same starting tier.
    const stepped = progressive(shown, byId);

    browser.push({
      category,
      summary,
      tasks: stepped.slice(0, BROWSER_LIMIT),
      truncated: Math.max(stepped.length - BROWSER_LIMIT, 0),
      ...(maxed
        ? { maxed: maxed.slice(0, BROWSER_LIMIT), maxedTruncated: Math.max(maxed.length - BROWSER_LIMIT, 0) }
        : {}),
    });
  }

  // The grind order is the one ranking that ignores category walls: if you're going to spend an
  // evening on something free, this is the list to spend it on, easiest first. XP breaks ties,
  // so equally-common tasks lead with the ones that actually pay.
  const grind = resolved
    .filter((t) => !t.done && t.xp > 0 && t.cost.kind === "none" && options.categories.has(t.category))
    .filter((t) => t.xp >= options.minXp)
    .sort((a, b) => (a.effort ?? 1) - (b.effort ?? 1) || b.xp - a.xp)
    .slice(0, 60);

  // Query D: value ranking across every category at once. Ordered on the same figure the rows
  // display — bundle coins per bundle XP — so the list reads as monotonic rather than as a sort
  // by one number and a display of another.
  const buyable = resolved
    .filter((t) => !t.done && t.xp > 0 && options.categories.has(t.category) && t.cost.kind !== "none")
    .sort((a, b) => {
      if (a.efficiency === null) return b.efficiency === null ? 0 : 1;
      if (b.efficiency === null) return -1;
      return a.efficiency - b.efficiency;
    });

  const flat = progressive(buyable.filter((t) => t.bundleXp >= options.minXp), byId);
  // Grouped from the unfiltered set for the same reason the browser does it: a folded row is a
  // whole purchase, so it can't be assembled out of whichever tiers cleared the floor on their
  // own. The floor then applies to the folded row.
  const folded = groupToMax(buyable).filter((run) => run.xp >= options.minXp);

  const cheapest = {
    tasks: flat.slice(0, CHEAPEST_LIMIT),
    truncated: Math.max(flat.length - CHEAPEST_LIMIT, 0),
    grouped: folded.slice(0, CHEAPEST_LIMIT),
    groupedTruncated: Math.max(folded.length - CHEAPEST_LIMIT, 0),
  };

  const xp = catalog.currentXp;

  return {
    progress: {
      xp,
      level: Math.floor(xp / XP_PER_LEVEL),
      modelledEarnedXp:
        resolved.filter((t) => t.done).reduce((s, t) => s + t.xp, 0) +
        catalog.earnedOutsideTasks.magicalPower +
        catalog.earnedOutsideTasks.petScore +
        catalog.earnedOutsideTasks.bestiary,
      modelledRemainingXp: achievableXp(resolved.filter((t) => !t.done)),
    },
    plan,
    packages,
    browser,
    cheapest,
    reconciliation: catalog.reconciliation,
    grind,
    unmodelled: catalog.unmodelled,
    bag: {
      computedMp: catalog.bag.computedMp,
      reportedMp: catalog.bag.reportedMp,
      readable: catalog.bag.readable,
      capacity: catalog.bag.capacity,
      used: catalog.bag.used,
      // Magical power still to gain, which is not the same as the accessory bag category's XP:
      // the category also holds the bag's slot upgrades, and those are ordinary SkyBlock XP for
      // buying room from Jacobus rather than magical power. Adding the category to the magical
      // power you hold therefore overshoots the game's maximum by whatever slots you have left,
      // which reads exactly like a bug and is not one. Kept apart so the readout can say so.
      powerLeft: achievableXp(
        resolved.filter((t) => !t.done && t.category === "accessory_bag" && !t.id.startsWith("bag_upgrade_")),
      ),
    },
  };
}

/**
 * XP a set of tasks can actually deliver. Members of an exclusive group compete rather than
 * add — every accessory in the Bat family is worth 12 MP at most between them, not 23 — so
 * each group contributes only its best member.
 */
export function achievableXp(tasks: ResolvedTask[]): number {
  let total = 0;
  const best = new Map<string, number>();
  for (const task of tasks) {
    if (!task.exclusiveGroup) total += task.xp;
    else best.set(task.exclusiveGroup, Math.max(best.get(task.exclusiveGroup) ?? 0, task.xp));
  }
  for (const xp of best.values()) total += xp;
  return total;
}

/** Coins to buy the achievable set: one purchase per exclusive group, the one worth the most. */
export function bestMemberCost(tasks: ResolvedTask[]): number {
  let total = 0;
  const best = new Map<string, { xp: number; coins: number }>();
  for (const task of tasks) {
    const coins = task.coins ?? 0;
    if (!task.exclusiveGroup) {
      total += coins;
      continue;
    }
    const current = best.get(task.exclusiveGroup);
    if (!current || task.xp > current.xp) best.set(task.exclusiveGroup, { xp: task.xp, coins });
  }
  for (const entry of best.values()) total += entry.coins;
  return total;
}
