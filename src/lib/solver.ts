import type { Category, PackageEntry, PackagePlan, Plan, PlanGroup, ResolvedTask, Task } from "./types";
import { XP_PER_LEVEL } from "./types";
import { resolveTasks, type PriceBook } from "./resolve";

/**
 * Two questions, two solvers.
 *
 *   solve()          "I want N XP — what's the cheapest set of tasks that gets me there?"
 *   solvePackages()  "I have 10M spare — what's the best thing to buy with it, and then the
 *                    next 10M, and the next?"
 *
 * Both run on either strategy:
 *
 *   greedy  — take the cheapest bundle per XP, apply it, recompute everything, repeat. The
 *             recompute is not optional: once you've bought minion tiers I-IV for one T12,
 *             every other deep tier in that family just got cheaper, and a sort computed once
 *             is wrong by the third pick.
 *
 *   exact   — a min-cost knapsack over XP. Prerequisite chains break the independence a plain
 *             knapsack needs, so a chain's prefixes become mutually-exclusive options in one
 *             group (buy the first k tiers of this minion), and accessory families become a
 *             group too (only the best member counts).
 *
 * Both honour exclusive groups: two members of one accessory family never stack, they replace,
 * so a second pick in the same group is only worth the difference.
 */

export type SolveOptions = {
  targetXp: number;
  /** Hide anything whose whole bundle is worth less than this. The anti-filler knob. */
  minXp: number;
  budget: number | null;
  categories: Set<Category>;
  strategy: "greedy" | "exact";
};

/** What a task is worth right now, given what has already been bought in its group. */
function effectiveXp(task: ResolvedTask, groupLevels: Map<string, number>): number {
  if (!task.exclusiveGroup) return task.bundleXp;
  const owned = groupLevels.get(task.exclusiveGroup) ?? task.groupBase ?? 0;
  return (task.groupLevel ?? 0) - owned;
}

function eligible(task: ResolvedTask, opts: SolveOptions, xp: number): boolean {
  if (task.done) return false;
  if (task.bundleCoins === null) return false; // grind-only or unpriced: never in a coin plan
  if (xp <= 0) return false;
  if (xp < opts.minXp) return false;
  if (!opts.categories.has(task.category)) return false;
  if (opts.budget !== null && task.bundleCoins > opts.budget) return false;
  return true;
}

/**
 * Tasks worth resolving at all. Anything grind-only, already done, or in a switched-off
 * category can never be picked, so re-resolving it after every pick is wasted work — and with
 * ~5,000 tasks in a full profile, that waste dominates the solve.
 */
function candidate(opts: SolveOptions) {
  return (task: Task) =>
    task.cost.kind !== "none" && task.cost.kind !== "unknown" && opts.categories.has(task.category);
}

export function solve(tasks: Task[], done: Set<string>, book: PriceBook, opts: SolveOptions): Plan {
  const picked = opts.strategy === "exact" ? solveExact(tasks, done, book, opts) : solveGreedy(tasks, done, book, opts);
  return assemble(picked, opts, opts.strategy);
}

/* ------------------------------------------------------------------ greedy */

/** Running board for a fill, so successive packages continue where the last one stopped. */
type FillState = {
  completed: Set<string>;
  groupLevels: Map<string, number>;
};

/**
 * Buy the cheapest XP available until a stop condition hits — an XP target, a coin budget, or
 * both. Recomputes the whole board after every pick, which is what keeps overlapping bundles
 * honest as prerequisites get paid off.
 */
function greedyFill(
  tasks: Task[],
  state: FillState,
  book: PriceBook,
  opts: SolveOptions,
  limits: { targetXp: number; budget: number | null },
  /** Optional running record of (coins, XP) after each pick — the spending frontier. */
  trace?: { coins: number; xp: number }[],
): ResolvedTask[] {
  const chosen = new Map<string, ResolvedTask>();
  const isCandidate = candidate(opts);
  let xp = 0;
  let spent = 0;

  // Hard stop: every iteration must retire at least one task, so this can't outrun the pool.
  for (let guard = 0; guard < tasks.length && xp < limits.targetXp; guard++) {
    const { tasks: resolved, byId } = resolveTasks(tasks, state.completed, book, isCandidate);

    let best: ResolvedTask | null = null;
    let bestXp = 0;
    let bestRate = Infinity;

    for (const task of resolved) {
      const gain = effectiveXp(task, state.groupLevels);
      if (!eligible(task, opts, gain)) continue;
      if (limits.budget !== null && spent + task.bundleCoins! > limits.budget) continue;

      const bundleRate = task.bundleCoins! / gain;
      // Cheapest coins per XP, then the bigger chunk — fewer trips for the same money.
      if (bundleRate < bestRate || (bundleRate === bestRate && gain > bestXp)) {
        best = task;
        bestXp = gain;
        bestRate = bundleRate;
      }
    }
    if (!best) break;

    for (const id of [...best.bundle, best.id]) {
      if (state.completed.has(id)) continue;
      const step = byId.get(id);
      if (!step) continue;
      state.completed.add(id);
      // Each step contributes its own XP — the bundle total belongs to the ranking, not to
      // the tally, or a shared chain would be counted once per member. Group members are the
      // exception: a family's second purchase is only worth the difference it adds.
      const gain = step.exclusiveGroup ? effectiveXp(step, state.groupLevels) : step.xp;
      chosen.set(id, { ...step, xp: gain });
      if (step.exclusiveGroup) state.groupLevels.set(step.exclusiveGroup, step.groupLevel ?? 0);
      xp += gain;
      spent += step.coins ?? 0;
    }
    // One point per pick, not per task: a bundle is bought as a unit.
    trace?.push({ coins: spent, xp });
  }

  return [...chosen.values()];
}

/**
 * The spending frontier with every convenience dropped: buy strictly in coins-per-XP order,
 * with no package walls and **no XP floor**, recording XP against coins along the way.
 *
 * Dropping the floor is the point. This tool is deliberately inefficient for convenience, and
 * the floor is where most of that goes: hiding "anything under 5 XP" also hides a 4 XP task
 * costing 1k, which is superb value per coin and just annoying to click. The frontier is what
 * you'd get if you tolerated all of it, so the gap against it prices the convenience.
 *
 * Category toggles are *not* dropped — excluding a category is a statement about what you're
 * willing to do, not a convenience the tool imposed.
 */
function idealFrontier(
  tasks: Task[],
  done: Set<string>,
  book: PriceBook,
  opts: SolveOptions,
  budget: number,
): { coins: number; xp: number }[] {
  const state: FillState = { completed: new Set(done), groupLevels: new Map() };
  const trace: { coins: number; xp: number }[] = [];
  greedyFill(tasks, state, book, { ...opts, minXp: 0 }, { targetXp: Number.POSITIVE_INFINITY, budget }, trace);
  return trace;
}

/**
 * XP the frontier reaches at a given spend, interpolating between purchases.
 *
 * Interpolating rather than stepping makes this the *fractional* efficiency bound — as if you
 * could buy nine tenths of the next item. That is deliberately slightly unreachable, and it is
 * the standard bound for exactly this comparison: because no integer selection can beat it, the
 * bleed can never come out negative, and a package that happens to land on a chunky item can't
 * flatter itself by clearing a step the frontier hasn't reached yet.
 */
function idealXpAt(frontier: { coins: number; xp: number }[], coins: number): number {
  if (!frontier.length || coins <= 0) return 0;

  let previous = { coins: 0, xp: 0 };
  for (const point of frontier) {
    if (point.coins >= coins) {
      const span = point.coins - previous.coins;
      if (span <= 0) return point.xp;
      const fraction = (coins - previous.coins) / span;
      return previous.xp + fraction * (point.xp - previous.xp);
    }
    previous = point;
  }
  // Spent past the end of the frontier: everything it could buy is already bought.
  return previous.xp;
}

function solveGreedy(tasks: Task[], done: Set<string>, book: PriceBook, opts: SolveOptions): ResolvedTask[] {
  const state: FillState = { completed: new Set(done), groupLevels: new Map() };
  const chosen = greedyFill(tasks, state, book, opts, { targetXp: opts.targetXp, budget: opts.budget });
  return prune(chosen, opts.targetXp);
}

/**
 * Greedy overshoots: the last pick usually carries more XP than was left to buy, and an
 * earlier, chunkier pick can make a cheaper one redundant. Drop anything the plan no longer
 * needs, worst value first, keeping prerequisites of survivors intact.
 */
function prune(chosen: ResolvedTask[], targetXp: number): ResolvedTask[] {
  const keep = new Map(chosen.map((t) => [t.id, t]));
  let total = chosen.reduce((s, t) => s + t.xp, 0);
  if (total < targetXp) return chosen;

  const worstFirst = [...chosen].sort((a, b) => (b.efficiency ?? 0) - (a.efficiency ?? 0));
  for (const task of worstFirst) {
    if (total - task.xp < targetXp) continue;
    const needed = [...keep.values()].some((other) => other.id !== task.id && other.requires.includes(task.id));
    if (needed) continue;
    // Dropping a lower family member would make a surviving one worth more, never less, so
    // the recomputed plan can only beat this total — safe to leave the arithmetic alone.
    keep.delete(task.id);
    total -= task.xp;
  }
  return [...keep.values()];
}

/* ------------------------------------------------------- knapsack machinery */

type Option = { xp: number; coins: number; ids: string[] };

/**
 * One group per set of competing options. Chains group by their root, because a longer prefix
 * contains the shorter one; accessory families group by their family key.
 */
function optionGroups(pool: ResolvedTask[], groupLevels: Map<string, number>): Map<string, Option[]> {
  const groups = new Map<string, Option[]>();
  for (const task of pool) {
    const key = task.exclusiveGroup ?? (task.bundle.length ? task.bundle[0] : task.id);
    const option: Option = {
      xp: effectiveXp(task, groupLevels),
      coins: task.bundleCoins!,
      ids: [...task.bundle, task.id],
    };
    const list = groups.get(key) ?? [];
    list.push(option);
    groups.set(key, list);
  }
  return groups;
}

/** dp[x] = cheapest way to have *at least* x XP. from[g][x] = the option group g contributed. */
function knapsack(groups: Map<string, Option[]>, cap: number, budget: number | null) {
  const INF = Number.POSITIVE_INFINITY;
  let dp = new Float64Array(cap + 1).fill(INF);
  dp[0] = 0;
  const from: (Option | null)[][] = [];

  for (const options of groups.values()) {
    const next = Float64Array.from(dp);
    const choice: (Option | null)[] = new Array(cap + 1).fill(null);
    for (const option of options) {
      if (budget !== null && option.coins > budget) continue;
      for (let x = cap; x >= 0; x--) {
        const prev = dp[Math.max(0, x - option.xp)];
        if (prev === INF) continue;
        const cost = prev + option.coins;
        if (cost < next[x]) {
          next[x] = cost;
          choice[x] = option;
        }
      }
    }
    dp = next;
    from.push(choice);
  }
  return { dp, from };
}

function reconstruct(from: (Option | null)[][], byId: Map<string, ResolvedTask>, at: number): ResolvedTask[] {
  const chosen = new Map<string, ResolvedTask>();
  let x = at;
  for (let g = from.length - 1; g >= 0; g--) {
    const option = from[g][x];
    if (!option) continue;
    for (const id of option.ids) {
      const task = byId.get(id);
      if (task) chosen.set(id, task);
    }
    x = Math.max(0, x - option.xp);
    if (x === 0) break;
  }
  return [...chosen.values()];
}

/* ------------------------------------------------------------------- exact */

function solveExact(tasks: Task[], done: Set<string>, book: PriceBook, opts: SolveOptions): ResolvedTask[] {
  const { tasks: resolved, byId } = resolveTasks(tasks, done, book, candidate(opts));
  const empty = new Map<string, number>();
  const pool = resolved.filter((t) => eligible(t, opts, effectiveXp(t, empty)));
  if (!pool.length) return [];

  const groups = optionGroups(pool, empty);
  const target = opts.targetXp;
  const { dp, from } = knapsack(groups, target, opts.budget);

  // Unreachable exactly — fall back and get as close as the pool allows.
  if (dp[target] === Number.POSITIVE_INFINITY) return solveGreedy(tasks, done, book, opts);

  return reconstruct(from, byId, target);
}

/* ---------------------------------------------------------------- packages */

export type PackageOptions = SolveOptions & {
  /** Coins per package. */
  packageSize: number;
  /** How many to plan ahead. */
  packageCount: number;
};

/** Past this the table costs more than the answer is worth; packages are spending-sized. */
const MAX_PACKAGE_XP = 20_000;

/**
 * Split the affordable work into fixed-size spending chunks.
 *
 * Each package is solved against the board the previous one left behind, so a prerequisite
 * bought in package 1 is already paid for by package 2 — which is the whole reason to solve per
 * package rather than slice one big plan into equal-cost pieces afterwards. Slicing would also
 * strand bundles across boundaries; solving never does.
 */
export function solvePackages(tasks: Task[], done: Set<string>, book: PriceBook, opts: PackageOptions): PackagePlan {
  const state: FillState = { completed: new Set(done), groupLevels: new Map() };
  const packages: PackageEntry[] = [];
  let cumulativeCoins = 0;
  let cumulativeXp = 0;
  let exhausted = false;

  // The unpackaged baseline, computed over the same pool and capped at the same total spend.
  const frontier = idealFrontier(tasks, done, book, opts, opts.packageSize * opts.packageCount);

  for (let index = 1; index <= opts.packageCount; index++) {
    const chosen =
      opts.strategy === "exact"
        ? exactWithinBudget(tasks, state, book, opts, opts.packageSize)
        : greedyFill(tasks, state, book, opts, { targetXp: Number.POSITIVE_INFINITY, budget: opts.packageSize });

    if (!chosen.length) {
      exhausted = true;
      break;
    }

    const coins = chosen.reduce((s, t) => s + (t.coins ?? 0), 0);
    const xp = chosen.reduce((s, t) => s + t.xp, 0);
    cumulativeCoins += coins;
    cumulativeXp += xp;

    const idealXp = idealXpAt(frontier, cumulativeCoins);

    packages.push({
      index,
      coins,
      xp,
      rate: xp > 0 ? coins / xp : 0,
      groups: groupByCategory(chosen),
      cumulativeCoins,
      cumulativeXp,
      cumulativeLevels: Math.floor(cumulativeXp / XP_PER_LEVEL),
      idealXp,
      bleedXp: idealXp - cumulativeXp,
    });
  }

  const last = packages[packages.length - 1];
  return {
    strategy: opts.strategy,
    packageSize: opts.packageSize,
    packages,
    exhausted,
    totalBleedXp: last?.bleedXp ?? 0,
    totalIdealXp: last?.idealXp ?? 0,
  };
}

/**
 * Most XP obtainable for at most `budget` coins. The min-cost knapsack already computes the
 * cheapest way to reach every XP value, so the answer is the largest one whose cost fits — a
 * scan of the same table rather than a second algorithm.
 */
function exactWithinBudget(
  tasks: Task[],
  state: FillState,
  book: PriceBook,
  opts: SolveOptions,
  budget: number,
): ResolvedTask[] {
  const { tasks: resolved, byId } = resolveTasks(tasks, state.completed, book, candidate(opts));
  const pool = resolved.filter((t) => eligible(t, opts, effectiveXp(t, state.groupLevels)));
  if (!pool.length) return [];

  const groups = optionGroups(pool, state.groupLevels);
  // Cap the table at what this pool could possibly yield, so it stays cheap to build.
  const cap = Math.min(
    pool.reduce((sum, task) => sum + effectiveXp(task, state.groupLevels), 0),
    MAX_PACKAGE_XP,
  );
  if (cap <= 0) return [];

  const { dp, from } = knapsack(groups, cap, budget);

  let best = 0;
  for (let x = cap; x > 0; x--) {
    if (dp[x] <= budget) {
      best = x;
      break;
    }
  }
  if (!best) return [];

  const chosen = reconstruct(from, byId, best);
  // Commit the picks to the running board so the next package starts from here.
  for (const task of chosen) {
    state.completed.add(task.id);
    if (task.exclusiveGroup) state.groupLevels.set(task.exclusiveGroup, task.groupLevel ?? 0);
  }
  return chosen;
}

/* ---------------------------------------------------------------- assembly */

/** Query C: regroup a winning set by category, so it reads as one trip per interface. */
function groupByCategory(chosen: ResolvedTask[]): PlanGroup[] {
  const byCategory = new Map<Category, ResolvedTask[]>();
  for (const task of chosen) {
    const list = byCategory.get(task.category) ?? [];
    list.push(task);
    byCategory.set(task.category, list);
  }

  return [...byCategory.entries()]
    .map(([category, list]) => ({
      category,
      xp: list.reduce((s, t) => s + t.xp, 0),
      coins: list.reduce((s, t) => s + (t.coins ?? 0), 0),
      tasks: list.sort((a, b) => (a.efficiency ?? 0) - (b.efficiency ?? 0)),
    }))
    .sort((a, b) => b.xp - a.xp);
}

function assemble(chosen: ResolvedTask[], opts: SolveOptions, strategy: "greedy" | "exact"): Plan {
  const groups = groupByCategory(chosen);
  const reachedXp = groups.reduce((s, g) => s + g.xp, 0);
  const coins = groups.reduce((s, g) => s + g.coins, 0);

  return {
    strategy,
    targetXp: opts.targetXp,
    reachedXp,
    coins,
    levelsGained: Math.floor(reachedXp / XP_PER_LEVEL),
    groups,
    short: reachedXp < opts.targetXp,
  };
}
