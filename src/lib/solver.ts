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
 * Both honour exclusive groups: two members of one accessory family or one pet never stack,
 * they replace. So a plan holds at most one tier of each — the best one — and buying into a
 * family a second time is priced as the upgrade it is, with the superseded tier taken back out.
 */

export type SolveOptions = {
  targetXp: number;
  /** Hide anything whose whole bundle is worth less than this. The anti-filler knob. */
  minXp: number;
  budget: number | null;
  categories: Set<Category>;
  strategy: "greedy" | "exact";
  /**
   * Room in the accessory bag, and what one Jacobus upgrade adds to it.
   *
   * A plan that buys forty accessories into a bag with nowhere to put them is not a plan
   * anyone can follow, so a fill buys the slots as it goes and pays for them out of the same
   * budget — see slotsFor. Omit it and the plan is built as it was before, with no slots in it:
   * that is the honest answer when the talisman bag can't be read, since capacity comes back
   * as zero and a bag we can't see is not a bag we know is full.
   */
  bag?: BagRoom;
};

/** Slots free in the accessory bag when a plan starts, and what one upgrade adds. */
export type BagRoom = { freeSlots: number; slotsPerUpgrade: number };

const BAG_UPGRADE = "bag_upgrade_";

/** Jacobus sells his 99 in order, and the ids are numbered to match. */
const upgradeNumber = (id: string): number => Number(id.slice(BAG_UPGRADE.length));

/**
 * An accessory that needs somewhere to sit: one whose family the bag holds nothing of yet.
 *
 * The same rule the browser places slots by. Upgrading a family already in there takes no new
 * room — the artifact goes where the ring was — and recombobulating takes none at all.
 */
function needsSlot(task: ResolvedTask): boolean {
  return task.id.startsWith("accessory_") && (task.groupBase ?? 0) <= 0;
}

/** What occupies the slot: the family, so two tiers of one don't take two. */
const familyKey = (task: ResolvedTask): string => task.exclusiveGroup ?? task.id;

/**
 * Jacobus's next unsold upgrades, cheapest number first.
 *
 * Taken in order because each one requires the one below it, so buying them in sequence
 * satisfies the chain without the bundle machinery having to drag it in.
 */
function slotQueue(pool: ResolvedTask[], completed: Set<string>): ResolvedTask[] {
  return pool
    .filter((task) => task.id.startsWith(BAG_UPGRADE) && !completed.has(task.id) && task.coins !== null)
    .sort((a, b) => upgradeNumber(a.id) - upgradeNumber(b.id));
}

/**
 * Slots one pick would leave the bag short by — the new families in its bundle, less the room
 * already there. Counted per family rather than per row, because a bundle that climbs from the
 * ring to the artifact of one family still only puts one thing in the bag.
 */
function slotsWanted(task: ResolvedTask, byId: Map<string, ResolvedTask>, state: FillState): number {
  const families = new Set<string>();
  for (const id of [...task.bundle, task.id]) {
    const step = byId.get(id);
    if (!step || !needsSlot(step) || state.housed.has(familyKey(step))) continue;
    families.add(familyKey(step));
  }
  return Math.max(families.size - state.freeSlots, 0);
}

/**
 * The upgrades that cover a shortfall of `deficit` slots, and what they cost.
 *
 * Whole upgrades, never a fraction of one: Jacobus sells +2 at a time whether you needed one
 * slot or two. Comes up short only when the 99 have run out, at which point the bag holds what
 * it holds and there is nothing more to buy.
 */
function slotsFor(queue: ResolvedTask[], deficit: number, slotsPerUpgrade: number): { take: ResolvedTask[]; coins: number } {
  const take: ResolvedTask[] = [];
  let coins = 0;
  let gained = 0;
  for (const upgrade of queue) {
    if (gained >= deficit) break;
    take.push(upgrade);
    coins += upgrade.coins ?? 0;
    gained += slotsPerUpgrade;
  }
  return { take, coins };
}

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
  /**
   * What each exclusive group has cost the plan so far. Only the best tier of a pet or an
   * accessory family ever counts, so a second tier is an *upgrade*, not an addition, and has
   * to be ranked on the difference it costs rather than its sticker price. Ranking upgrades at
   * full price is what let a greedy buy Bee uncommon, then rare, then epic and call each one
   * good value. Kept plan-wide so the comparison holds across packages too.
   */
  picks: Map<string, { id: string; coins: number; xp: number }>;
  /**
   * Slots left in the accessory bag. Goes down as the fill finds families to house and up as it
   * buys Jacobus upgrades, so successive packages inherit the room the last one paid for.
   */
  freeSlots: number;
  /**
   * Families this fill has already found room for. A family takes one slot however many of its
   * tiers the plan climbs through, so the ring and the artifact of one don't buy two.
   */
  housed: Set<string>;
};

/** A fresh board for a plan that has bought nothing yet. */
function newFillState(done: Set<string>, bag: BagRoom | undefined): FillState {
  return {
    completed: new Set(done),
    groupLevels: new Map(),
    picks: new Map(),
    freeSlots: bag?.freeSlots ?? 0,
    housed: new Set(),
  };
}

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
    // Rebuilt each pass rather than carried: the greedy may buy an upgrade on its own merits,
    // and state.completed is where that shows up.
    const queue = opts.bag ? slotQueue(resolved, state.completed) : [];

    let best: ResolvedTask | null = null;
    let bestXp = 0;
    let bestRate = Infinity;

    for (const task of resolved) {
      const gain = effectiveXp(task, state.groupLevels);
      if (!eligible(task, opts, gain)) continue;

      // Upgrading within a group costs the difference, not the sticker price: the tier being
      // replaced stops counting the moment this one lands, so the plan gets those coins back.
      // Pricing the upgrade at full whack is what let a greedy pick Bee uncommon, then rare,
      // then epic and call all three good value.
      //
      // Two different figures fall out of that, and using one for both jobs is wrong:
      //   marginal — the difference, which is what the upgrade is really worth ranking at.
      //   outlay   — what *this* package hands over. A tier bought by an earlier package can't
      //              be refunded into this one's budget, however redundant it is about to be.
      const prior = task.exclusiveGroup ? state.picks.get(task.exclusiveGroup) : undefined;
      const marginalCoins = task.bundleCoins! - (prior?.coins ?? 0);
      const outlay = prior && chosen.has(prior.id) ? task.bundleCoins! - prior.coins : task.bundleCoins!;

      // A new family with nowhere to go drags a Jacobus upgrade in behind it, and that comes out
      // of the same budget. It is charged here and nowhere else: the slot is a shared cost — one
      // upgrade houses two accessories — so adding it to the *rate* would bill whichever
      // accessory happened to sort first for room the rest of them use. Affordability is a
      // different question from value, and only this one is the slot's business.
      const slots = opts.bag ? slotsFor(queue, slotsWanted(task, byId, state), opts.bag.slotsPerUpgrade) : null;
      if (limits.budget !== null && spent + outlay + (slots?.coins ?? 0) > limits.budget) continue;

      const bundleRate = marginalCoins / gain;
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
      // exception: a family's second purchase replaces the first rather than adding to it.
      let gain = step.exclusiveGroup ? effectiveXp(step, state.groupLevels) : step.xp;

      if (step.exclusiveGroup) {
        // Retire the tier this one supersedes. Dropping its row and refunding its coins is what
        // makes "buy the epic" cost the epic's price rather than uncommon + rare + epic; the
        // survivor then carries the family's whole gain, so the XP tally is unchanged.
        const prior = state.picks.get(step.exclusiveGroup);
        if (prior && chosen.has(prior.id)) {
          // Superseded inside this same package: drop it here and now, so its coins are back in
          // this package's budget for something else.
          chosen.delete(prior.id);
          state.completed.delete(prior.id);
          spent -= prior.coins;
          xp -= prior.xp;
          gain += prior.xp;
        }
        // A prior tier bought by an *earlier* package can't be refunded into this one's budget.
        // settleGroups() retires it from that package once every package is filled.
        state.groupLevels.set(step.exclusiveGroup, step.groupLevel ?? 0);
        state.picks.set(step.exclusiveGroup, { id, coins: step.coins ?? 0, xp: gain });
      }

      chosen.set(id, { ...step, xp: gain });
      xp += gain;
      spent += step.coins ?? 0;

      // Room in the bag, spent and bought. An upgrade the greedy picked for its own 2 XP still
      // adds its slots, so the next accessory to want one may find it already paid for.
      if (opts.bag) {
        if (step.id.startsWith(BAG_UPGRADE)) state.freeSlots += opts.bag.slotsPerUpgrade;
        else if (needsSlot(step) && !state.housed.has(familyKey(step))) {
          state.housed.add(familyKey(step));
          state.freeSlots--;
        }
      }
    }

    // Whatever the pick left homeless, buy the room for it now. Priced into the budget check
    // above, so this can only be spending the fill already knew it was committing to.
    if (opts.bag && state.freeSlots < 0) {
      for (const upgrade of slotsFor(queue, -state.freeSlots, opts.bag.slotsPerUpgrade).take) {
        state.completed.add(upgrade.id);
        chosen.set(upgrade.id, upgrade);
        state.freeSlots += opts.bag.slotsPerUpgrade;
        spent += upgrade.coins ?? 0;
        xp += upgrade.xp;
      }
      // Jacobus stops at 99. Past that the bag holds what it holds, and the shortfall stands.
      state.freeSlots = Math.max(state.freeSlots, 0);
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
  const state = newFillState(done, opts.bag);
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
  const state = newFillState(done, opts.bag);
  const chosen = greedyFill(tasks, state, book, opts, { targetXp: opts.targetXp, budget: opts.budget });
  return prune(chosen, opts.targetXp, opts.bag);
}

/**
 * Greedy overshoots: the last pick usually carries more XP than was left to buy, and an
 * earlier, chunkier pick can make a cheaper one redundant. Drop anything the plan no longer
 * needs, worst value first, keeping prerequisites of survivors intact.
 */
function prune(chosen: ResolvedTask[], targetXp: number, bag?: BagRoom): ResolvedTask[] {
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
    // A Jacobus upgrade is 20M for 2 XP, so it leads this list every time — and dropping one
    // still holding an accessory would leave the plan telling you to buy something with
    // nowhere to put it. Put it back. Once the accessories go, so does the reason to keep it,
    // and the same pass drops it on a later turn.
    if (bag && !slotsSuffice(keep, bag)) {
      keep.set(task.id, task);
      continue;
    }
    total -= task.xp;
  }
  return [...keep.values()];
}

/** True when a set has bought room for every new family in it. */
function slotsSuffice(keep: Map<string, ResolvedTask>, bag: BagRoom): boolean {
  const families = new Set<string>();
  let slots = bag.freeSlots;
  for (const task of keep.values()) {
    if (task.id.startsWith(BAG_UPGRADE)) slots += bag.slotsPerUpgrade;
    else if (needsSlot(task)) families.add(familyKey(task));
  }
  return slots >= families.size;
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

/**
 * Room for a set the knapsack chose.
 *
 * The DP ranks options on coins per XP and has no way to say "and somewhere to put it", so the
 * slots go on afterwards: the same arithmetic the greedy does inline — one upgrade per two new
 * families, taken in Jacobus's order — just applied to a finished set rather than as it grows.
 */
function houseChosen(
  chosen: ResolvedTask[],
  pool: ResolvedTask[],
  completed: Set<string>,
  bag: BagRoom,
): { chosen: ResolvedTask[]; coins: number } {
  const families = new Set<string>();
  let slots = bag.freeSlots;
  for (const task of chosen) {
    if (task.id.startsWith(BAG_UPGRADE)) slots += bag.slotsPerUpgrade;
    else if (needsSlot(task)) families.add(familyKey(task));
  }
  if (families.size <= slots) return { chosen, coins: 0 };

  const already = new Set(chosen.map((task) => task.id));
  const queue = slotQueue(pool, completed).filter((task) => !already.has(task.id));
  const { take, coins } = slotsFor(queue, families.size - slots, bag.slotsPerUpgrade);
  return { chosen: [...chosen, ...take], coins };
}

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

  const chosen = reconstruct(from, byId, target);
  return opts.bag ? houseChosen(chosen, resolved, done, opts.bag).chosen : chosen;
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
  const state = newFillState(done, opts.bag);
  const packages: PackageEntry[] = [];
  let cumulativeCoins = 0;
  let cumulativeXp = 0;
  let exhausted = false;

  // The unpackaged baseline, computed over the same pool and capped at the same total spend.
  const frontier = idealFrontier(tasks, done, book, opts, opts.packageSize * opts.packageCount);

  const fills: ResolvedTask[][] = [];
  for (let index = 1; index <= opts.packageCount; index++) {
    const chosen =
      opts.strategy === "exact"
        ? exactWithinBudget(tasks, state, book, opts, opts.packageSize)
        : greedyFill(tasks, state, book, opts, { targetXp: Number.POSITIVE_INFINITY, budget: opts.packageSize });

    if (!chosen.length) {
      exhausted = true;
      break;
    }
    fills.push(chosen);
  }

  // Only now, with every package filled, can a family be settled: an upgrade bought in package 5
  // retires the tier package 1 bought. Totals are therefore computed after the sweep, never
  // during the loop.
  settleGroups(fills);

  for (const [offset, chosen] of fills.entries()) {
    const index = offset + 1;
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
 * Keep one tier per exclusive group across the whole plan — the best one — and drop the rest.
 *
 * Within a package the fill already swaps a lower tier out as it goes, but a package can only
 * refund into its own budget. When package 5 upgrades a pet package 1 bought, package 1's
 * purchase is the one that has to go, and that can't be known until every package is filled.
 *
 * The survivor inherits the family's whole gain, so no XP is lost by the removal — only the
 * coins that were buying a pet the plan itself was about to make redundant. Package 1 ends up
 * a little under its size as a result, which is the honest outcome: that money was never
 * usefully spent.
 */
function settleGroups(fills: ResolvedTask[][]): void {
  const best = new Map<string, ResolvedTask>();
  for (const fill of fills) {
    for (const task of fill) {
      if (!task.exclusiveGroup) continue;
      const held = best.get(task.exclusiveGroup);
      if (!held || (task.groupLevel ?? 0) > (held.groupLevel ?? 0)) best.set(task.exclusiveGroup, task);
    }
  }

  for (const [offset, fill] of fills.entries()) {
    fills[offset] = fill.flatMap((task) => {
      if (!task.exclusiveGroup) return [task];
      const winner = best.get(task.exclusiveGroup)!;
      if (winner.id !== task.id) return [];
      // Credited with everything the family gains over what the player already owns, since the
      // tiers that were splitting that credit are gone.
      return [{ ...task, xp: (task.groupLevel ?? 0) - (task.groupBase ?? 0) }];
    });
  }
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

  /** The most XP a table can reach for a given spend, and the set that reaches it. */
  const bestWithin = (table: ReturnType<typeof knapsack>, spend: number): ResolvedTask[] => {
    if (spend <= 0) return [];
    for (let x = cap; x > 0; x--) if (table.dp[x] <= spend) return reconstruct(table.from, byId, x);
    return [];
  };

  const table = knapsack(groups, cap, budget);
  let chosen = bestWithin(table, budget);
  if (!chosen.length) return [];

  // Slots come out of the same package as the accessories that need them, so what they cost is
  // budget the picks above were never entitled to. Reserve it and choose again. Two passes and
  // no loop: the reserve only ever shrinks the pool, so the second answer can want no more room
  // than the first, and a third pass would find the same set.
  if (opts.bag) {
    const reserve = houseChosen(chosen, resolved, state.completed, opts.bag).coins;
    if (reserve > 0) {
      chosen = bestWithin(table, budget - reserve);
      // A package too small to buy even one upgrade can still buy plenty that isn't an
      // accessory, so an empty answer here means "not with these", not "nothing left". Solve
      // again over a pool with the homeless accessories taken out rather than calling the whole
      // package sequence exhausted over one 20M slot.
      if (!chosen.length) {
        const grounded = pool.filter((task) => !needsSlot(task));
        chosen = grounded.length
          ? bestWithin(knapsack(optionGroups(grounded, state.groupLevels), cap, budget), budget)
          : [];
      }
    }
    if (!chosen.length) return [];
    chosen = houseChosen(chosen, resolved, state.completed, opts.bag).chosen;
  }

  // Commit the picks to the running board so the next package starts from here.
  for (const task of chosen) {
    state.completed.add(task.id);
    if (opts.bag) {
      if (task.id.startsWith(BAG_UPGRADE)) state.freeSlots += opts.bag.slotsPerUpgrade;
      else if (needsSlot(task) && !state.housed.has(familyKey(task))) {
        state.housed.add(familyKey(task));
        state.freeSlots--;
      }
    }
    if (!task.exclusiveGroup) continue;
    state.groupLevels.set(task.exclusiveGroup, task.groupLevel ?? 0);
    state.picks.set(task.exclusiveGroup, { id: task.id, coins: task.coins ?? 0, xp: task.xp });
  }
  if (opts.bag) state.freeSlots = Math.max(state.freeSlots, 0);
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
      // Slots lead their group. They are the worst rate in it by a mile, so ranking on price
      // would bury them at the bottom of the one list whose other rows have nowhere to go until
      // they are bought — which is exactly what the row itself says to do.
      tasks: list.sort(
        (a, b) =>
          Number(b.id.startsWith(BAG_UPGRADE)) - Number(a.id.startsWith(BAG_UPGRADE)) ||
          (a.efficiency ?? 0) - (b.efficiency ?? 0),
      ),
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
