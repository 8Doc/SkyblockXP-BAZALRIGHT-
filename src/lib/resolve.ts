import type { BinIndex, BazaarProduct } from "./profile";
import type { Category, CostSpec, ResolvedTask, Task } from "./types";

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
  /**
   * A reference price per item id, for things the auction house isn't listing right now.
   *
   * Most museum donations are never on the auction house at any given moment — of 460 tradeable
   * ones, a full sweep finds a few hundred — so pricing them from listings alone silently drops
   * the rest out of every cost ranking. A reference price is not something you can click "buy"
   * on, so it is only ever a fallback, never allowed to undercut a real listing.
   */
  reference?: Record<string, number>;
};

/**
 * Categories priced from the reference feed first, live markets second.
 *
 * The feed is a maintained, whole-catalogue read where a live market is only whatever happens
 * to be listed this minute, so for the categories it covers well it is the steadier number:
 * 92% of accessories, 94% of museum donations, and every minion ingredient.
 *
 * Attribute shards are deliberately absent. The feed carries no SHARD_* prices at all — nought
 * of 175 — while the bazaar carries every one of them, live. Preferring the feed there would
 * price nothing.
 */
const REFERENCE_FIRST = new Set<Category>(["accessory_bag", "accessory_grind", "museum", "minions"]);

export function priceOf(cost: CostSpec, book: PriceBook, preferReference = false): number | null {
  const referenced = (id: string): number | undefined => (preferReference ? book.reference?.[id] : undefined);

  switch (cost.kind) {
    case "npc":
      return cost.coins;
    case "bazaar": {
      let total = 0;
      for (const item of cost.items) {
        const price = referenced(item.id) ?? book.bazaar[item.id]?.quick_status?.buyPrice;
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
      // Anything this purchase replaces is sold to offset it, priced the same way round so the
      // buy and the sale don't come from different markets. Auction tax is 1%, and taking it off
      // keeps the net conservative rather than quoting a sale at shelf price.
      const sold = cost.sells ? (referenced(cost.sells) ?? cheapestListing(book, cost.sells)) : null;
      const surcharge = (cost.surcharge ?? 0) - (sold === null ? 0 : Math.round(sold * 0.99));

      const preferred = referenced(cost.itemId);
      if (preferred !== undefined && !cost.tier) return preferred + surcharge;

      const byTier = book.bins?.prices[cost.itemId];
      if (!byTier) return referencePrice(cost, book, surcharge);
      if (cost.tier) {
        const exact = byTier[cost.tier];
        return exact === undefined ? null : exact + surcharge;
      }
      // Cheapest listing of the item at any rarity. If that copy happens to be recombobulated
      // the player gains more magical power than we credited — we under-promise, never over.
      const listed = Object.values(byTier);
      return listed.length ? Math.min(...listed) + surcharge : referencePrice(cost, book, surcharge);
    }
    // Nothing left to pay: the item is in the player's inventory already.
    case "owned":
      return 0;
    case "none":
    case "grind":
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
      hit = priceOf(task.cost, book, REFERENCE_FIRST.has(task.category));
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
      ...(isReferencePriced(task.cost, book) ? { estimated: true } : {}),
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

/** The fallback price for an item nothing is currently listing. */
function referencePrice(cost: { itemId: string }, book: PriceBook, surcharge: number): number | null {
  const price = book.reference?.[cost.itemId];
  return price === undefined ? null : price + surcharge;
}

/** True when this price came from the reference feed rather than a live listing. */
export function isReferencePriced(cost: CostSpec, book: PriceBook): boolean {
  if (cost.kind !== "auction") return false;
  const byTier = book.bins?.prices[cost.itemId];
  const listed = byTier ? Object.values(byTier) : [];
  return listed.length === 0 && book.reference?.[cost.itemId] !== undefined;
}
