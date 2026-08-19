import type { Catalog } from "./catalog";
import { resolveTasks, type PriceBook } from "./resolve";
import { solve, solvePackages, type SolveOptions } from "./solver";
import { groupToMax, type TaskRun } from "./grouping";
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
  unmodelled: { category: Category; note: string; totalXp?: number; earnedXp?: number }[];
  bag: { computedMp: number; reportedMp: number | null; readable: boolean; capacity: number; used: number };
};

const BROWSER_LIMIT = 40;

/**
 * Categories that read better collapsed to one row per thing. Attributes are the clear case:
 * 181 of them, ten levels each, every level fed by the same shard, so the per-level rows carry
 * almost no information the grouped row doesn't.
 */
const GROUPABLE = new Set<Category>(["attributes"]);

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
  const { tasks: resolved } = resolveTasks(catalog.tasks, catalog.done, book);

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

    browser.push({
      category,
      summary,
      tasks: shown.slice(0, BROWSER_LIMIT),
      truncated: Math.max(shown.length - BROWSER_LIMIT, 0),
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

  const xp = catalog.currentXp;

  return {
    progress: {
      xp,
      level: Math.floor(xp / XP_PER_LEVEL),
      modelledEarnedXp: resolved.filter((t) => t.done).reduce((s, t) => s + t.xp, 0),
      modelledRemainingXp: achievableXp(resolved.filter((t) => !t.done)),
    },
    plan,
    packages,
    browser,
    grind,
    unmodelled: catalog.unmodelled,
    bag: {
      computedMp: catalog.bag.computedMp,
      reportedMp: catalog.bag.reportedMp,
      readable: catalog.bag.readable,
      capacity: catalog.bag.capacity,
      used: catalog.bag.used,
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
