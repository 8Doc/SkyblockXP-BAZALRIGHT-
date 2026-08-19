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
      // Anything this purchase replaces is sold to offset it. Auction house tax is 1%, and
      // taking it off keeps the net honestly conservative rather than quoting a sale at its
      // shelf price. An item we can't price sells for nothing rather than blocking the row.
      const sold = cost.sells ? cheapestListing(book, cost.sells) : null;
      const credit = sold === null ? 0 : Math.round(sold * 0.99);
      const surcharge = (cost.surcharge ?? 0) - credit;
      if (cost.tier) {
        const exact = byTier[cost.tier];
        return exact === undefined ? null : exact + surcharge;
      }
      // Cheapest listing of the item at any rarity. If that copy happens to be recombobulated
      // the player gains more magical power than we credited — we under-promise, never over.
      const listed = Object.values(byTier);
      return listed.length ? Math.min(...listed) + surcharge : null;
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
      ...(bundle.length ? bundleLabels(task, bundle, index) : {}),
    };
  });

  return { tasks: resolved, byId: new Map(resolved.map((t) => [t.id, t])) };
}

/**
 * What a bundled row should actually say.
 *
 * A row that drags prerequisites is priced as the whole bundle, so naming it after the top tier
 * and noting only that tier's materials tells two lies side by side: "Extreme Pressure 6 · 4×
 * Lumisquid Shard" against a price covering levels 2 through 6 and seventeen shards. Worse, the
 * XP floor hides the intermediate levels, so level 6 looks like the next thing to buy when
 * really it is the first *bundle* big enough to clear the floor.
 *
 * So a bundled row is named for the span it covers and notes the whole bundle's materials.
 */
function bundleLabels(
  task: Task,
  bundle: string[],
  index: Map<string, Task>,
): { bundleSpan?: string; bundleNote?: string } {
  const members = [...bundle.map((id) => index.get(id)).filter((t): t is Task => Boolean(t)), task];
  if (members.length < 2) return {};

  const split = (name: string) => {
    const at = name.lastIndexOf(" ");
    return at < 0 ? { base: name, label: "" } : { base: name.slice(0, at), label: name.slice(at + 1) };
  };
  const first = split(members[0].name);
  const last = split(members[members.length - 1].name);

  // Only a genuine tier chain gets a span; unrelated prerequisites keep the leaf's own name.
  const span =
    first.base === last.base && first.label && last.label ? `${first.base} ${first.label}–${last.label}` : undefined;

  const parts = members.map((m) => /^(\d+)[x×]\s*(.+)$/.exec(m.note ?? ""));
  const note = parts.every((p) => p && p[2] === parts[0]![2])
    ? `${members.length} levels · ${parts.reduce((sum, p) => sum + Number(p![1]), 0)}× ${parts[0]![2]}`
    : undefined;

  return { ...(span ? { bundleSpan: span } : {}), ...(note ? { bundleNote: note } : {}) };
}

/** Cheapest listing of an item at any rarity, or null if nobody is selling one. */
function cheapestListing(book: PriceBook, itemId: string): number | null {
  const byTier = book.bins?.prices[itemId];
  if (!byTier) return null;
  const listed = Object.values(byTier);
  return listed.length ? Math.min(...listed) : null;
}
