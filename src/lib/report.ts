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
 *
 * The five views below are each worked out the first time they are read and remembered from
 * then on. Only one of them is ever on screen, and they are not the same size: the package
 * view solves seven fills including the unpackaged baseline, and costs several times what the
 * other four cost put together. Building all five on every knob change spent most of that on
 * answers nobody had asked for — so a category toggle now costs whichever tab is showing, and
 * the expensive one is paid for only by opening it. The figures on the header line — progress,
 * coverage and the bag — are read every render, so those stay eager.
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
    /**
     * The same remaining work with everything buyable taken out, so what is left is what no
     * amount of coins will finish. Emitted only where a category has both kinds.
     */
    unpriced?: ResolvedTask[];
    unpricedTruncated?: number;
    /** Both at once: one row per thing, counting only what coins cannot finish. */
    unpricedMaxed?: TaskRun[];
    unpricedMaxedTruncated?: number;
    /**
     * Pets, with the rarity ladder taken out — one row each, at the best rarity that pet
     * reaches. Buying a pet outright is a different decision from climbing to it a rarity at a
     * time, and the ladder is most of what the list is.
     */
    topRarity?: ResolvedTask[];
    topRarityTruncated?: number;
    /** Both at once: the top rarity only, counting only what nobody is selling. */
    topRarityUnpriced?: ResolvedTask[];
    topRarityUnpricedTruncated?: number;
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
  /** Pet score as it stands, against the highest ever reached — which is what the XP was paid on. */
  petScore: Catalog["petScore"];
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
 * How close to finished counts as "you may as well finish it" in the grind order.
 *
 * Five percent left. The figure is a judgement rather than a measurement, and it is the right
 * *shape* of judgement: below it the remaining work is small in absolute terms for any collection
 * worth grinding, and the tier is worth XP the player is effectively already holding.
 */
const NEARLY_DONE = 0.95;

/**
 * Is this a task the player is all but standing on top of?
 *
 * Only true where the profile publishes a running count to measure against — collections today.
 * A task with no `progress` is not nearly done, it is unmeasured, and the two must not collapse
 * into each other: guessing would float every unmeasured task to the front of the list.
 */
function isNearlyDone(t: { progress?: number }): boolean {
  return t.progress !== undefined && t.progress >= NEARLY_DONE && t.progress < 1;
}

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

/** Worked out on first read and remembered. `undefined` is a legitimate answer, hence the flag. */
function once<T>(make: () => T): () => T {
  let value: T;
  let made = false;
  return () => {
    if (!made) {
      value = make();
      made = true;
    }
    return value;
  };
}

export function buildReport(catalog: Catalog, book: PriceBook, raw: ReportOptions): Report {
  // The category toggles are a live set the UI turns on and off in place, and a view worked out
  // on first read may be read a good deal later than the report was built. Taken as a copy so
  // every view answers the question that was asked, and the five of them agree with each other.
  const options: ReportOptions = { ...raw, categories: new Set(raw.categories) };

  // Room in the bag, handed to the solvers so a plan that buys accessories also buys the slots
  // to put them in — the same rule bagSlotsWhereNeeded places them by in the browser below.
  //
  // Withheld when the bag reports no capacity at all, which is what an unreadable talisman bag
  // looks like: capacity and used both come back zero, so a bag we cannot see would read as a
  // bag we know is full, and the plan would spend twenty million on room the player may
  // already have.
  const bag =
    catalog.bag.readable && catalog.bag.capacity > 0
      ? {
          freeSlots: Math.max(catalog.bag.capacity - catalog.bag.used, 0),
          slotsPerUpgrade: catalog.bag.slotsPerUpgrade ?? 2,
        }
      : undefined;

  const plan = once(() => solve(catalog.tasks, catalog.done, book, { ...options, bag }));
  // The package view answers a different question, so it gets its own solve rather than a
  // post-hoc slicing of the plan above: slicing by cost would strand prerequisite bundles
  // across package boundaries.
  const packages = once(() =>
    solvePackages(catalog.tasks, catalog.done, book, {
      ...options,
      bag,
      targetXp: Number.POSITIVE_INFINITY,
      budget: null,
      packageSize: options.packageSize,
      packageCount: options.packageCount,
    }),
  );
  const { tasks: resolved, byId } = resolveTasks(catalog.tasks, catalog.done, book);

  /* --------------------------------------------- query B: category browser */

  const browser = once(() => buildBrowser(catalog, resolved, byId, options));

  // The grind order is the one ranking that ignores category walls: if you're going to spend an
  // evening on something free, this is the list to spend it on, easiest first. XP breaks ties,
  // so equally-common tasks lead with the ones that actually pay.
  const grind = once(() => buildGrind(resolved, options));

  // Query D: value ranking across every category at once. Ordered on the same figure the rows
  // display — bundle coins per bundle XP — so the list reads as monotonic rather than as a sort
  // by one number and a display of another.
  const cheapest = once(() => buildCheapest(resolved, byId, options));

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
    get plan() {
      return plan();
    },
    get packages() {
      return packages();
    },
    get browser() {
      return browser();
    },
    get cheapest() {
      return cheapest();
    },
    get grind() {
      return grind();
    },
    reconciliation: catalog.reconciliation,
    petScore: catalog.petScore,
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

/* --------------------------------------------- query B: category browser */

function buildBrowser(
  catalog: Catalog,
  resolved: ResolvedTask[],
  byId: Map<string, ResolvedTask>,
  options: ReportOptions,
): Report["browser"] {
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
    let stepped = progressive(shown, byId);

    // Pets with the ladder taken out: one row each, at the best rarity that pet reaches.
    // Filtered *before* the sequence is built, not after, and that is the whole trick — trimming
    // afterwards would leave the top rarity priced as an upgrade from a tier the player was
    // never going to buy, quoting the difference between two of them instead of what the pet
    // actually costs from where they stand.
    // Taken off `shown` rather than off `remaining`, so it inherits the same XP floor and the
    // same coins-per-XP ordering the ungrouped list is built from.
    const topRarity = category === "pets" ? progressive(topRarityOnly(shown), byId) : null;

    // Bag slots come out of the price ranking and go back in where the bag runs out of room.
    if (category === "accessory_bag") {
      const upgrades = stepped.filter((task) => task.id.startsWith("bag_upgrade_"));
      const rest = stepped.filter((task) => !task.id.startsWith("bag_upgrade_"));
      stepped = bagSlotsWhereNeeded(
        rest,
        upgrades,
        Math.max(catalog.bag.capacity - catalog.bag.used, 0),
        catalog.bag.slotsPerUpgrade ?? 2,
      );
    }

    // What coins will never finish, from the untruncated set for the same reason the grouped
    // view is: these rows are the tail of a list sorted by price, so a cut made before the
    // filter would leave almost none of them. Only worth offering where a category has both
    // kinds — a list with nothing buyable in it needs no button to say so.
    const unpricedRows = stepped.filter((task) => task.bundleCoins === null);
    const hasBoth = unpricedRows.length > 0 && unpricedRows.length < stepped.length;

    // The two views are independent questions — "one row per thing" and "only what I cannot buy"
    // — so they have to compose. Grouped from the same untruncated set the other grouping uses,
    // and filtered before grouping rather than after, so a row says what it takes to max the
    // thing by grinding rather than what is left of a purchase.
    const unpricedMaxed =
      maxed && hasBoth
        ? groupToMax(remaining.filter((task) => task.bundleCoins === null)).filter(
            (run) => run.xp >= options.minXp,
          )
        : null;

    // "just the top rarity" and "only what nobody is selling" are independent questions too, so
    // the fourth combination is its own list rather than one toggle quietly cancelling the other.
    const topRarityUnpriced = topRarity && hasBoth ? topRarity.filter((task) => task.bundleCoins === null) : null;

    browser.push({
      category,
      summary,
      tasks: stepped.slice(0, BROWSER_LIMIT),
      truncated: Math.max(stepped.length - BROWSER_LIMIT, 0),
      ...(topRarity
        ? {
            topRarity: topRarity.slice(0, BROWSER_LIMIT),
            topRarityTruncated: Math.max(topRarity.length - BROWSER_LIMIT, 0),
          }
        : {}),
      ...(topRarityUnpriced
        ? {
            topRarityUnpriced: topRarityUnpriced.slice(0, BROWSER_LIMIT),
            topRarityUnpricedTruncated: Math.max(topRarityUnpriced.length - BROWSER_LIMIT, 0),
          }
        : {}),
      ...(maxed
        ? { maxed: maxed.slice(0, BROWSER_LIMIT), maxedTruncated: Math.max(maxed.length - BROWSER_LIMIT, 0) }
        : {}),
      ...(hasBoth
        ? {
            unpriced: unpricedRows.slice(0, BROWSER_LIMIT),
            unpricedTruncated: Math.max(unpricedRows.length - BROWSER_LIMIT, 0),
          }
        : {}),
      ...(unpricedMaxed
        ? {
            unpricedMaxed: unpricedMaxed.slice(0, BROWSER_LIMIT),
            unpricedMaxedTruncated: Math.max(unpricedMaxed.length - BROWSER_LIMIT, 0),
          }
        : {}),
    });
  }

  return browser;
}

const RARITY_ORDER = ["COMMON", "UNCOMMON", "RARE", "EPIC", "LEGENDARY", "MYTHIC"];

/**
 * One row per pet: the best rarity it reaches, whatever that is.
 *
 * Every pet stays in the list and every one is shown at its own ceiling — mythic where there is
 * a mythic, common for the Precursor Drone, which never goes past it. Capping the rung at
 * legendary was tried and is wrong twice over: it stops short of the purchase for the twenty
 * pets that go higher, and it drops the ones that stop lower out of a list they can never come
 * back to. The point of the view is to skip the rungs on the way up, not to pick a rung.
 */
function topRarityOnly(tasks: ResolvedTask[]): ResolvedTask[] {
  const best = new Map<string, ResolvedTask>();
  // A rarity the ladder does not name ranks below every one that it does, so an unrecognised
  // row is kept when it is all a pet has and passed over the moment something known turns up.
  const rank = (task: ResolvedTask): number =>
    RARITY_ORDER.indexOf(task.cost.kind === "auction" ? (task.cost.tier ?? "") : "");

  for (const task of tasks) {
    const key = task.exclusiveGroup ?? task.id;
    const held = best.get(key);
    if (!held || rank(task) > rank(held)) best.set(key, task);
  }
  // Back into the order they arrived in, so the coins-per-XP ranking survives the filter.
  const kept = new Set(best.values());
  return tasks.filter((task) => kept.has(task));
}

/**
 * The grind order: the one ranking that ignores category walls. If you're going to spend an
 * evening on something free, this is the list to spend it on, easiest first. XP breaks ties, so
 * equally-common tasks lead with the ones that actually pay.
 */
function buildGrind(resolved: ResolvedTask[], options: ReportOptions): ResolvedTask[] {
  return resolved
    .filter(
      (t) =>
        !t.done &&
        t.xp > 0 &&
        // An accessory nobody may sell is a grind with an item at the end of it, and belongs
        // here as much as a skill level does. "unknown" stays out: those have a price we simply
        // could not find, so sending someone off to grind for one would be wrong.
        (t.cost.kind === "none" || t.cost.kind === "grind") &&
        options.categories.has(t.category),
    )
    .filter((t) => t.xp >= options.minXp)
    .sort((a, b) => {
      // Anything already all-but-finished jumps the queue, whatever the effort scale says about
      // it. Effort is a population statistic — the share of players who have not done this — so
      // it describes the task from a standing start and cannot see that *this* player is 325
      // items from the end of it. A tier that close is not a grind, it is a formality, and
      // burying it under genuinely easier work is how it goes unnoticed for months.
      const nearlyA = isNearlyDone(a);
      const nearlyB = isNearlyDone(b);
      if (nearlyA !== nearlyB) return nearlyA ? -1 : 1;
      // Within that band, closest to the finish line first. Between two formalities the one you
      // could finish this evening leads.
      if (nearlyA) return (b.progress ?? 0) - (a.progress ?? 0) || b.xp - a.xp;
      return (a.effort ?? 1) - (b.effort ?? 1) || b.xp - a.xp;
    })
    .slice(0, 60);
}

/**
 * Query D: value ranking across every category at once. Ordered on the same figure the rows
 * display — bundle coins per bundle XP — so the list reads as monotonic rather than as a sort by
 * one number and a display of another.
 */
function buildCheapest(
  resolved: ResolvedTask[],
  byId: Map<string, ResolvedTask>,
  options: ReportOptions,
): Report["cheapest"] {
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

  return {
    tasks: flat.slice(0, CHEAPEST_LIMIT),
    truncated: Math.max(flat.length - CHEAPEST_LIMIT, 0),
    grouped: folded.slice(0, CHEAPEST_LIMIT),
    groupedTruncated: Math.max(folded.length - CHEAPEST_LIMIT, 0),
  };
}

/**
 * Jacobus's slots, put in the list where the room actually runs out.
 *
 * A slot is not part of any accessory's price. It is its own purchase, needed once every two
 * accessories that go into a bag with no room — so charging it against whichever accessory
 * happened to sort first, whether as a markup or as a prerequisite, put a shared cost on one row
 * and hid it from the rest.
 *
 * Reading down the list is the only sense in which "when" is answerable here: the browser is a
 * ranking, not a schedule, so this walks it in the order shown, spends a slot on every accessory
 * that needs a new one, and inserts the next upgrade at the point the count hits zero. Only a
 * new family takes a slot — upgrading one already in the bag puts the artifact where the ring
 * was, and recombobulating takes no room at all.
 */
function bagSlotsWhereNeeded(
  rows: ResolvedTask[],
  upgrades: ResolvedTask[],
  freeSlots: number,
  slotsPerUpgrade: number,
): ResolvedTask[] {
  if (upgrades.length === 0 || slotsPerUpgrade <= 0) return rows;

  const queue = [...upgrades].sort(
    (a, b) => Number(a.id.replace("bag_upgrade_", "")) - Number(b.id.replace("bag_upgrade_", "")),
  );
  const out: ResolvedTask[] = [];
  let free = freeSlots;

  for (const row of rows) {
    // A family with nothing in it yet is the only kind that needs somewhere to put it.
    const needsSlot = row.id.startsWith("accessory_") && (row.groupBase ?? 0) <= 0;
    if (needsSlot && free <= 0) {
      const upgrade = queue.shift();
      // Jacobus stops at 99. Past that the bag holds what it holds, and there is nothing to add.
      if (upgrade) {
        out.push({ ...upgrade, note: `${upgrade.note ?? ""} · the bag is full at this point`.trim() });
        free += slotsPerUpgrade;
      }
    }
    if (needsSlot) free--;
    out.push(row);
  }

  // Whatever is left over still pays its XP, and still has to be listed.
  out.push(...queue);
  return out;
}

/**
 * XP a set of tasks can actually deliver. Members of an exclusive group compete rather than
 * add — every accessory in the Bat family is worth 12 MP at most between them, not 23 — so
 * each group contributes only what carries the family highest.
 *
 * Which is not the same as its biggest single row. Buying an accessory and then recombobulating
 * it are two rows of one group, and the second is measured from the first, so it is always the
 * smaller of the two while being the one that reaches furthest. Taking the biggest row threw
 * away every recombobulation of an accessory the player had yet to buy.
 */
export function achievableXp(tasks: ResolvedTask[]): number {
  let total = 0;
  const groups = new Map<string, { top: number; base: number; xp: number }>();
  for (const task of tasks) {
    if (!task.exclusiveGroup) {
      total += task.xp;
      continue;
    }
    const group = groups.get(task.exclusiveGroup);
    if (!group) {
      groups.set(task.exclusiveGroup, {
        top: task.groupLevel ?? 0,
        base: task.groupBase ?? 0,
        xp: task.xp,
      });
      continue;
    }
    group.top = Math.max(group.top, task.groupLevel ?? 0);
    group.base = Math.min(group.base, task.groupBase ?? 0);
    group.xp = Math.max(group.xp, task.xp);
  }
  // Groups that carry no level — pets before the catalogue knew their tiers — fall back to the
  // biggest row, which is what the whole group used to be measured by.
  for (const group of groups.values()) total += Math.max(group.top - group.base, group.xp);
  return total;
}

/**
 * Coins to buy the achievable set. Within an exclusive group only one member is bought — the
 * one that carries the family highest — plus anything that group still needs on top of it. A
 * recombobulation is exactly that: it costs a Recombobulator 3000 on top of the accessory it
 * is applied to, so both are paid, which is why this counts the step that reaches furthest and
 * everything that step depends on rather than a single row.
 */
export function bestMemberCost(tasks: ResolvedTask[]): number {
  let total = 0;
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const best = new Map<string, ResolvedTask>();
  for (const task of tasks) {
    if (!task.exclusiveGroup) {
      total += task.coins ?? 0;
      continue;
    }
    const current = best.get(task.exclusiveGroup);
    const reaches = (t: ResolvedTask) => t.groupLevel ?? t.xp;
    if (!current || reaches(task) > reaches(current)) best.set(task.exclusiveGroup, task);
  }
  for (const winner of best.values()) {
    // Walk what it depends on, so an upgrade is priced with the thing it upgrades.
    const seen = new Set<string>();
    const stack = [winner];
    while (stack.length) {
      const step = stack.pop()!;
      if (seen.has(step.id)) continue;
      seen.add(step.id);
      total += step.coins ?? 0;
      for (const need of step.requires ?? []) {
        const dependency = byId.get(need);
        if (dependency && !dependency.done) stack.push(dependency);
      }
    }
  }
  return total;
}
