import type { BinIndex, BazaarProduct } from "./profile";
import type { CostSpec, ResolvedTask, Task } from "./types";

/**
 * Turning a CostSpec into coins, and a task into its prerequisite bundle.
 *
 * The bundle is the point of the whole exercise: "Lily Pad Minion V" costs nothing on its own
 * if you skip the fact that it needs I-IV first. Ranking on the closure — and recomputing it
 * after every pick — is what keeps the numbers honest as bundles start overlapping.
 */

export type PriceBook = {
  bazaar: Record<string, BazaarProduct>;
  bins: BinIndex | null;
};

export function priceOf(cost: CostSpec, book: PriceBook): number | null {
  switch (cost.kind) {
    case "npc":
      return cost.coins;
    case "bazaar": {
      let total = 0;
      for (const item of cost.items) {
        const price = book.bazaar[item.id]?.quick_status?.buyPrice;
        if (!price) return null;
        total += price * item.qty;
      }
      return total;
    }
    case "essence": {
      const price = book.bazaar[`ESSENCE_${cost.type}`]?.quick_status?.buyPrice;
      return price ? price * cost.amount : null;
    }
    case "auction": {
      const byTier = book.bins?.prices[cost.itemId];
      if (!byTier) return null;
      if (cost.tier) return byTier[cost.tier] ?? null;
      // Cheapest listing of the item at any rarity. If that copy happens to be recombobulated
      // the player gains more magical power than we credited — we under-promise, never over.
      const listed = Object.values(byTier);
      return listed.length ? Math.min(...listed) : null;
    }
    case "none":
    case "unknown":
      return null;
  }
}

export type ResolveResult = {
  tasks: ResolvedTask[];
  byId: Map<string, ResolvedTask>;
};

/**
 * Resolve every task, or only the ones that could plausibly be bought.
 *
 * The solver re-resolves after every pick, and a full profile carries ~5,000 tasks of which
 * only a few hundred are ever candidates — the rest are grind-only, already done, or in a
 * category that's switched off. Passing a filter cuts the per-pick work by an order of
 * magnitude. Prerequisites of a candidate are always resolved too, filter or not, because the
 * bundle maths needs them.
 */
export function resolveTasks(
  tasks: Task[],
  done: Set<string>,
  book: PriceBook,
  only?: (task: Task) => boolean,
): ResolveResult {
  const index = new Map(tasks.map((t) => [t.id, t]));
  const coinCache = new Map<string, number | null>();
  const coinsFor = (task: Task) => {
    let hit = coinCache.get(task.id);
    if (hit === undefined) {
      hit = priceOf(task.cost, book);
      coinCache.set(task.id, hit);
    }
    return hit;
  };

  /** Unmet prerequisites of a task, deepest-first, excluding the task itself. */
  const closureCache = new Map<string, string[]>();
  const closure = (id: string, seen = new Set<string>()): string[] => {
    const cached = closureCache.get(id);
    if (cached) return cached;
    if (seen.has(id)) return []; // cycle guard; the real graphs are chains, but don't hang on bad data
    seen.add(id);

    const task = index.get(id);
    const out: string[] = [];
    for (const req of task?.requires ?? []) {
      if (done.has(req)) continue;
      for (const deep of closure(req, seen)) if (!out.includes(deep)) out.push(deep);
      if (!out.includes(req)) out.push(req);
    }
    closureCache.set(id, out);
    return out;
  };

  // Work out which tasks to resolve: the ones asked for, plus every prerequisite they drag in.
  let wanted = tasks;
  if (only) {
    const keep = new Set<string>();
    for (const task of tasks) {
      if (!only(task)) continue;
      keep.add(task.id);
      for (const id of closure(task.id)) keep.add(id);
    }
    wanted = tasks.filter((t) => keep.has(t.id));
  }

  const resolved: ResolvedTask[] = wanted.map((task) => {
    const bundle = closure(task.id);
    const own = coinsFor(task);

    let bundleCoins: number | null = own;
    let bundleXp = task.xp;
    for (const id of bundle) {
      const dep = index.get(id);
      if (!dep) continue;
      bundleXp += dep.xp;
      const depCoins = coinsFor(dep);
      if (bundleCoins === null || depCoins === null) bundleCoins = null;
      else bundleCoins += depCoins;
    }

    return {
      ...task,
      done: done.has(task.id),
      coins: own,
      bundle,
      bundleCoins,
      bundleXp,
      efficiency: bundleCoins !== null && bundleXp > 0 ? bundleCoins / bundleXp : null,
    };
  });

  return { tasks: resolved, byId: new Map(resolved.map((t) => [t.id, t])) };
}
