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

/* ------------------------------------------------------------------ caches */

/**
 * Resolving is the hot loop of the whole app.
 *
 * The greedy solvers re-resolve after every pick, and a package run does that a few thousand
 * times over a task list of ~13,000 — so the same closures and the same prices were being
 * rebuilt from scratch several thousand times per solve. Two caches sit under `resolveTasks`
 * to stop that, and both are keyed on identity rather than on content, so nothing about the
 * function's contract changes:
 *
 *   the price cache      keyed on (task list, price book). What a task costs, and whether that
 *                        price came from the reference feed, cannot be changed by anything a
 *                        solver does — only by new prices, and those arrive as a new book.
 *
 *   the completion cache keyed on the `done` set itself, which the solvers mutate in place as
 *                        they pick. Completing a task can only change the closures that
 *                        contained it, so a pick invalidates a handful of rows rather than all
 *                        13,000.
 *
 * Both are weak: a rebuilt catalog or a refreshed price book drops the lot.
 */

/** Facts about a task list priced against one book that a completion set cannot change. */
type Priced = {
  book: PriceBook;
  index: Map<string, Task>;
  coins: Map<string, number | null>;
  estimated: Map<string, boolean>;
  /** `note` read as "3× Lumisquid Shard", for the bundle labels. A note never changes. */
  materials: Map<string, RegExpExecArray | null>;
};

const pricedByTasks = new WeakMap<Task[], WeakMap<PriceBook, Priced>>();

function pricedFor(tasks: Task[], book: PriceBook): Priced {
  let byBook = pricedByTasks.get(tasks);
  if (!byBook) pricedByTasks.set(tasks, (byBook = new WeakMap()));
  let priced = byBook.get(book);
  if (!priced) {
    priced = {
      book,
      index: new Map(tasks.map((t) => [t.id, t])),
      coins: new Map(),
      estimated: new Map(),
      materials: new Map(),
    };
    byBook.set(book, priced);
  }
  return priced;
}

function coinsFor(priced: Priced, task: Task): number | null {
  let hit = priced.coins.get(task.id);
  if (hit === undefined) {
    hit = priceOf(task.cost, priced.book, REFERENCE_FIRST.has(task.category));
    priced.coins.set(task.id, hit);
  }
  return hit;
}

function estimatedFor(priced: Priced, task: Task): boolean {
  let hit = priced.estimated.get(task.id);
  if (hit === undefined) {
    hit = isReferencePriced(task.cost, priced.book);
    priced.estimated.set(task.id, hit);
  }
  return hit;
}

const MATERIAL = /^(\d+)[x×]\s*(.+)$/;

function materialOf(priced: Priced, task: Task): RegExpExecArray | null {
  let hit = priced.materials.get(task.id);
  if (hit === undefined) {
    hit = MATERIAL.exec(task.note ?? "");
    priced.materials.set(task.id, hit);
  }
  return hit;
}

/** One filtered list of resolved tasks, kept with the positions needed to patch it in place. */
type View = {
  list: ResolvedTask[];
  byId: Map<string, ResolvedTask>;
  at: Map<string, number>;
};

type Completions = {
  priced: Priced;
  /** Our own copy of `done`, so a mutation of it can be diffed against what we last saw. */
  seen: Set<string>;
  closure: Map<string, string[]>;
  /** Which cached closures a given id appears in — the invalidation index. */
  dependents: Map<string, Set<string>>;
  resolved: Map<string, ResolvedTask>;
  views: Map<unknown, View>;
};

const completionsByDone = new WeakMap<Set<string>, Completions>();

/** The view key for "no filter", since `undefined` cannot be told from an absent entry. */
const EVERYTHING = Symbol("everything");

/**
 * More filters than a single solve uses at once means the caller is churning predicates; hold
 * the newest and let the rest go rather than growing without bound.
 */
const MAX_VIEWS = 8;

function fresh(priced: Priced, done: Set<string>): Completions {
  return {
    priced,
    seen: new Set(done),
    closure: new Map(),
    dependents: new Map(),
    resolved: new Map(),
    views: new Map(),
  };
}

/**
 * Bring a cache up to date with a `done` set that has been added to since we last looked, and
 * report which rows that invalidated. `null` means it cannot be brought up to date at all.
 *
 * A completed prerequisite drops itself *and everything below it* out of a closure — but every
 * one of those was in that closure already, so a closure changes if and only if it contained
 * one of the newly completed ids. That is what makes the dependents index sufficient on its
 * own: no transitive walk is needed, because a task deep in a chain is in the closure of
 * everything above it too.
 *
 * Anything other than growth — an id taken back out — is a rebuild.
 */
function sync(cache: Completions, done: Set<string>): Set<string> | null {
  const added: string[] = [];
  for (const id of done) if (!cache.seen.has(id)) added.push(id);
  // Sizes disagreeing once the additions are accounted for means something was taken back out.
  if (cache.seen.size + added.length !== done.size) return null;
  if (!added.length) return new Set();

  const stale = new Set<string>(added);
  for (const id of added) {
    cache.seen.add(id);
    const dependents = cache.dependents.get(id);
    if (!dependents) continue;
    for (const dependent of dependents) stale.add(dependent);
    // Nothing can depend on it again: within one cache's life `done` only ever grows.
    cache.dependents.delete(id);
  }
  for (const id of stale) {
    cache.closure.delete(id);
    cache.resolved.delete(id);
  }
  return stale;
}

/** Unmet prerequisites of a task, deepest-first, excluding the task itself. */
function closureOf(cache: Completions, done: Set<string>, id: string, seen?: Set<string>): string[] {
  const cached = cache.closure.get(id);
  if (cached) return cached;
  const guard = seen ?? new Set<string>();
  if (guard.has(id)) return []; // cycle guard; the real graphs are chains, but don't hang on bad data
  guard.add(id);

  const task = cache.priced.index.get(id);
  const out: string[] = [];
  const held = new Set<string>();
  for (const req of task?.requires ?? []) {
    if (done.has(req)) continue;
    for (const deep of closureOf(cache, done, req, guard)) {
      if (held.has(deep)) continue;
      held.add(deep);
      out.push(deep);
    }
    if (held.has(req)) continue;
    held.add(req);
    out.push(req);
  }

  cache.closure.set(id, out);
  for (const member of out) {
    let dependents = cache.dependents.get(member);
    if (!dependents) cache.dependents.set(member, (dependents = new Set()));
    dependents.add(id);
  }
  return out;
}

function resolveOne(cache: Completions, done: Set<string>, task: Task): ResolvedTask {
  const cached = cache.resolved.get(task.id);
  if (cached) return cached;

  const { priced } = cache;
  const bundle = closureOf(cache, done, task.id);
  const own = coinsFor(priced, task);

  let bundleCoins: number | null = own;
  let bundleXp = task.xp;
  for (const id of bundle) {
    const dep = priced.index.get(id);
    if (!dep) continue;
    bundleXp += dep.xp;
    const depCoins = coinsFor(priced, dep);
    if (bundleCoins === null || depCoins === null) bundleCoins = null;
    else bundleCoins += depCoins;
  }

  const resolved: ResolvedTask = {
    ...task,
    done: done.has(task.id),
    coins: own,
    bundle,
    bundleCoins,
    bundleXp,
    efficiency: bundleCoins !== null && bundleXp > 0 ? bundleCoins / bundleXp : null,
    ...(estimatedFor(priced, task) ? { estimated: true } : {}),
    ...(bundle.length ? bundleLabels(priced, task, bundle) : {}),
  };
  cache.resolved.set(task.id, resolved);
  return resolved;
}

/**
 * Resolve every task, or only the ones that could plausibly be bought.
 *
 * The solver re-resolves after every pick, and a full profile carries ~5,000 tasks of which
 * only a few hundred are ever candidates — the rest are grind-only, already done, or in a
 * category that's switched off. Passing a filter cuts the per-pick work by an order of
 * magnitude. Prerequisites of a candidate are always resolved too, filter or not, because the
 * bundle maths needs them.
 *
 * Pass the *same* predicate object across a run of calls and the filtered list is assembled
 * once: a filter's membership can only shrink as tasks are completed, and a row that has
 * dropped out of it is a row that is now done, which every caller already skips.
 */
export function resolveTasks(
  tasks: Task[],
  done: Set<string>,
  book: PriceBook,
  only?: (task: Task) => boolean,
): ResolveResult {
  const priced = pricedFor(tasks, book);
  let cache = completionsByDone.get(done);
  let stale = cache && cache.priced === priced ? sync(cache, done) : null;
  if (!cache || stale === null) {
    cache = fresh(priced, done);
    completionsByDone.set(done, cache);
    stale = new Set();
  }

  // Patch what the new completions invalidated back into the lists already handed out, so a
  // list costs one row per change rather than a full rebuild.
  if (stale.size) {
    for (const view of cache.views.values()) {
      for (const id of stale) {
        const at = view.at.get(id);
        if (at === undefined) continue;
        const resolved = resolveOne(cache, done, priced.index.get(id)!);
        view.list[at] = resolved;
        view.byId.set(id, resolved);
      }
    }
  }

  const key = only ?? EVERYTHING;
  let view = cache.views.get(key);
  if (!view) {
    view = buildView(cache, tasks, done, only);
    if (cache.views.size >= MAX_VIEWS) cache.views.clear();
    cache.views.set(key, view);
  }
  return { tasks: view.list, byId: view.byId };
}

function buildView(cache: Completions, tasks: Task[], done: Set<string>, only?: (task: Task) => boolean): View {
  // Work out which tasks to resolve: the ones asked for, plus every prerequisite they drag in.
  let wanted = tasks;
  if (only) {
    const keep = new Set<string>();
    for (const task of tasks) {
      if (!only(task)) continue;
      keep.add(task.id);
      for (const id of closureOf(cache, done, task.id)) keep.add(id);
    }
    wanted = tasks.filter((t) => keep.has(t.id));
  }

  const list: ResolvedTask[] = [];
  const byId = new Map<string, ResolvedTask>();
  const at = new Map<string, number>();
  for (const task of wanted) {
    at.set(task.id, list.length);
    const resolved = resolveOne(cache, done, task);
    list.push(resolved);
    byId.set(task.id, resolved);
  }
  return { list, byId, at };
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
function bundleLabels(priced: Priced, task: Task, bundle: string[]): { bundleSpan?: string; bundleNote?: string } {
  const members = [...bundle.map((id) => priced.index.get(id)).filter((t): t is Task => Boolean(t)), task];
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

  const parts = members.map((m) => materialOf(priced, m));
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
