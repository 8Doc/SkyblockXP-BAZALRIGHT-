import { NET_OF_TAX } from "./bazaar";
import { itemsPerHour, offlineAmount, type MinionData, type MinionProduction, type Setup } from "./minions";
import type { BasisPrice, Trust, Variance } from "./priceVariance";
import { trustedPrice } from "./priceVariance";

/**
 * What a minion actually pays, and how long it pays it for.
 *
 * The minions tab next door answers "which minion finishes a collection fastest" and never needs a
 * price. This answers the other question people put to a minion — what is it worth an hour — and
 * that question has three traps in it that a division does not.
 *
 * **A minion that is full is a minion earning nothing.** Every rate here is capped by storage, and
 * storage is where the interesting arithmetic lives: a Tier XII minion holds 960 items and makes
 * a few thousand an hour, so an unattended one is idle within the hour and a table quoting its
 * uncapped rate is describing a minion nobody has. Compaction is what changes that, and it changes
 * it enormously — 160 cobblestone become one Enchanted Cobblestone, so the same 960 slots hold
 * 153,600 cobblestone instead. The gap between those two numbers is the difference between
 * claiming every hour and claiming every week, and it is the whole reason this tab asks how often
 * you actually visit.
 *
 * **What you sell into decides what you earn, and the bazaar takes a cut.** Instaselling pays the
 * top buy order less 2.25% tax; instabuying is what someone else pays and is not available to you
 * as a seller; the shopkeeper pays a fixed price and takes nothing. For a lot of low-value minion
 * output the shopkeeper wins outright, which is a result worth surfacing rather than assuming.
 *
 * **The best-looking row is often the least believable one.** A live top-of-book quote on a thin
 * item is not a price you can hit nine thousand times an hour, and ranking on it is how these
 * tables end up recommending whatever is being manipulated today. `priceVariance.ts` is the guard;
 * this module takes its verdict rather than making its own.
 */

/* ---------------------------------------------------------------- tables */

export type StorageChest = { id: string; name: string; slots: number };
export type Hopper = { id: string; name: string; npcShare: number };
export type Compactor = { id: string; name: string; kind: "none" | "block" | "enchanted" };

export type StorageTables = {
  slotItems: number;
  chests: StorageChest[];
  hoppers: Hopper[];
  compactors: Compactor[];
};

/** Where a minion's drop is priced, when the automatic resolution gets it wrong or gets nothing. */
export type DropOverride = {
  itemId: string | null;
  why: string;
  alsoDrops?: string[];
  partial?: number;
  unmodelled?: string;
};

export type DropTable = { overrides: Record<string, DropOverride> };

/* ---------------------------------------------------------------- prices */

/** One item's three prices, all per unit, before anything is decided about which to use. */
export type ItemPrices = {
  /** Top buy order — what one fetches, before the bazaar's cut. */
  instasell: number | null;
  /** Top sell offer — what one costs. Not a figure a seller can get. */
  instabuy: number | null;
  /** What a shopkeeper pays for one. No tax, no book, no depth. */
  npcSell: number | null;
};

/**
 * Which market the row is priced against.
 *
 * `instasell` is the honest default for a producer: you have items and want coins now. `order`
 * assumes you place a sell offer and wait, which fetches the ask instead — better coins for worse
 * certainty, and only real for items with buyers. `npc` is the shopkeeper, which is worse than
 * both for anything valuable and better than both for the bulk items several minions produce.
 */
export type Basis = "instasell" | "order" | "npc";

export const BASIS_LABELS: Record<Basis, string> = {
  instasell: "Instasell",
  order: "Sell offer",
  npc: "Shopkeeper",
};

/**
 * Coins for one unit, on the chosen basis, after everything the market takes.
 *
 * The tax applies to both bazaar routes and not to the shopkeeper — a shop is a fixed price with
 * no cut, which is exactly why it wins on cheap bulk. Null where the basis has no price at all,
 * which the caller must treat as "this row cannot be quoted" rather than as zero.
 */
export function unitValue(prices: ItemPrices, basis: Basis, variance: Variance | null, trust: Trust): BasisPrice | null {
  if (basis === "npc") {
    // A shopkeeper's price is set by Hypixel and does not move, so there is nothing for the month
    // to have an opinion about. Reporting it as "normal" is not a dodge; it is the fact.
    return prices.npcSell === null ? null : { price: prices.npcSell, substituted: false, z: null, confidence: "normal" };
  }

  const live = basis === "order" ? prices.instabuy : prices.instasell;
  if (live === null || !(live > 0)) return null;

  const guarded = trustedPrice(live, variance, trust);
  return { ...guarded, price: guarded.price * NET_OF_TAX };
}

/* -------------------------------------------------------------- compaction */

/**
 * How many raw drops fit in the space of one, once the compactor has had them.
 *
 * One, with no compactor. Otherwise the ratio comes from the compacted item's own crafting
 * recipe — a single-ingredient recipe whose ingredient is the drop, which is what the Super
 * Compactor is doing anyway. Reading it from the recipe rather than assuming 160 matters: the
 * ratio genuinely differs per item, and a wrong one is wrong by a factor of hundreds in a fill
 * time rather than by a few percent.
 *
 * Returns 1 for an item with no such recipe, which is the correct answer for a drop nothing
 * compacts — and is why the caller can apply this unconditionally.
 */
export type Recipe = { output: string; yield: number; ingredients: { id: string; qty: number }[] };

export function compactionRatio(itemId: string, compactor: Compactor, recipes: Recipe[]): number {
  if (compactor.kind === "none") return 1;

  let best = 1;
  for (const recipe of recipes) {
    if (recipe.ingredients.length !== 1) continue;
    const only = recipe.ingredients[0];
    if (only.id !== itemId || !(recipe.yield > 0)) continue;
    // A block recipe is nine, an enchanted one is a hundred and sixty. A Compactor only does the
    // first; a Super Compactor does the enchanted form, which is the bigger of the two.
    const ratio = only.qty / recipe.yield;
    if (compactor.kind === "block" && ratio > 64) continue;
    if (ratio > best) best = ratio;
  }
  return best;
}

/* ------------------------------------------------------------------ setup */

export type ProfitSetup = Setup & {
  chest: StorageChest;
  hopper: Hopper;
  compactor: Compactor;
  /** Hours between visits to the island. The number that turns a rate into an income. */
  claimHours: number;
};

/* -------------------------------------------------------------------- row */

export type MinionProfitRow = {
  generator: string;
  family: string;
  tier: number;
  /** Null where the minion's drop cannot be priced as one item — the Flower Minion, and only it. */
  itemId: string | null;
  itemName: string;

  /** Raw drops an hour, uncapped by storage. The figure other calculators stop at. */
  itemsPerHour: number;
  /** Raw drops the minion and its chest hold together, after compaction. */
  capacity: number;
  /** Hours from empty to full and idle. Infinite where a hopper keeps emptying it. */
  hoursToFill: number;
  /** Raw drops actually banked per claim, once the fill cap bites. */
  itemsPerClaim: number;
  /** Raw drops the minion never made because it was standing full. */
  itemsLost: number;

  /** Coins one drop is worth on the chosen basis, after tax. */
  unitValue: number;
  /** Whether that price was the live quote or the month's median, and how odd today looks. */
  price: BasisPrice;

  /** Coins an hour if storage never filled. The optimistic number, kept so the gap is visible. */
  grossPerHour: number;
  /** Coins an hour actually realised at this claim interval, including anything a hopper sold. */
  coinsPerHour: number;
  /** Coins a hopper contributed by selling the overflow at the shopkeeper's discount. */
  hopperPerHour: number;
  /** Fuel burnt, per hour, across the whole setup. Zero for the fuels that never run out. */
  fuelPerHour: number;
  /** coinsPerHour less fuel. The ranking figure. */
  netPerHour: number;
  /** What one visit hands you. */
  perClaim: number;

  /** Anything a reader should know before believing the row. */
  caveats: string[];
};

export type ProfitOptions = {
  data: MinionData;
  storage: StorageTables;
  drops: DropTable;
  recipes: Recipe[];
  /** Item id to its three prices. Missing means the row cannot be priced. */
  prices: Map<string, ItemPrices>;
  /** Item id to its month, where one has been fetched. */
  variance: Map<string, Variance>;
  /** Display names, for the rows the drop table does not name. */
  names: Record<string, string>;
  setup: ProfitSetup;
  basis: Basis;
  trust: Trust;
};

/**
 * The item a minion's drop is priced as.
 *
 * Three sources in order, and the order is the point: a curated pin wins because it was written
 * after looking at the minion, the drop's own display name wins next because it is what the
 * minion's page says it collects, and the collection id is the last resort because it is right
 * far more often than it is wrong but is wrong in ways that look right — the Cow Minion's
 * collection is Leather and its drop is Raw Beef.
 */
export function dropIdFor(minion: MinionProduction, drops: DropTable, byName: Map<string, string>): string | null {
  const pinned = drops.overrides[minion.generator];
  if (pinned) return pinned.itemId;
  return byName.get(minion.collects.item.trim().toLowerCase()) ?? minion.collectionId;
}

/**
 * What a whole setup earns an hour, minion by minion.
 *
 * Rows come back for every minion, including the ones that cannot be priced, because a minion
 * missing from the table reads as a minion that earns nothing rather than as one nobody has a
 * price for. Unpriceable rows carry a zero rate and the reason on the row.
 */
export function planProfit(o: ProfitOptions): MinionProfitRow[] {
  const byName = new Map<string, string>();
  for (const [id, name] of Object.entries(o.names)) {
    const key = name.toLowerCase();
    if (!byName.has(key)) byName.set(key, id);
  }

  const fuelUnit = fuelCostPerHour(o);
  const out: MinionProfitRow[] = [];

  for (const minion of o.data.minions) {
    const tier = Math.min(o.setup.tier, minion.maxTier);
    const rate = itemsPerHour(minion, o.data, { ...o.setup, tier });
    if (rate === null || rate <= 0) continue;

    const itemId = dropIdFor(minion, o.drops, byName);
    const override = o.drops.overrides[minion.generator];
    const itemName = itemId ? (o.names[itemId] ?? itemId) : minion.collects.item;

    const caveats: string[] = [];
    if (override?.why) caveats.push(override.why);
    if (override?.unmodelled) caveats.push(override.unmodelled);
    if (override?.alsoDrops?.length) {
      caveats.push(`also drops ${override.alsoDrops.map((id) => o.names[id] ?? id).join(" and ")}, which is not priced here`);
    }
    if (minion.collects.low !== undefined && minion.collects.high !== undefined) {
      caveats.push(`the wiki quotes ${minion.collects.low}–${minion.collects.high} a drop, so this uses the midpoint`);
    }

    const prices = itemId ? o.prices.get(itemId) : undefined;
    const variance = itemId ? (o.variance.get(itemId) ?? null) : null;
    const value = prices ? unitValue(prices, o.basis, variance, o.trust) : null;

    const ratio = itemId ? compactionRatio(itemId, o.setup.compactor, o.recipes) : 1;
    const slots = o.storage.chests.find((c) => c.id === o.setup.chest.id)?.slots ?? o.setup.chest.slots;
    const own = minion.storage?.[tier - 1] ?? 0;
    // The chest's slots hold compacted items too, so the whole capacity scales together.
    const capacity = (own + slots * o.storage.slotItems) * ratio;

    const hoursToFill = capacity > 0 ? capacity / rate : Infinity;
    const claim = Math.max(0, o.setup.claimHours);
    const overflowHours = Math.max(0, claim - hoursToFill);

    const itemsPerClaim = Math.min(rate * claim, capacity);
    const overflowItems = rate * overflowHours;
    // A hopper does not raise the cap, it drains past it — and at the shopkeeper's price times its
    // own cut, which is why it is valued separately rather than folded into the rate.
    const hopperUnit = (prices?.npcSell ?? 0) * o.setup.hopper.npcShare;
    const hopperPerClaim = o.setup.hopper.npcShare > 0 ? overflowItems * hopperUnit : 0;
    const itemsLost = o.setup.hopper.npcShare > 0 ? 0 : overflowItems;

    const unit = value?.price ?? 0;
    const perClaim = itemsPerClaim * unit + hopperPerClaim;
    const coinsPerHour = claim > 0 ? perClaim / claim : 0;
    const grossPerHour = rate * unit;
    const fuelPerHour = fuelUnit;

    if (!prices) caveats.push("nothing on the bazaar or at a shopkeeper prices this drop");
    else if (!value) caveats.push(`no ${BASIS_LABELS[o.basis].toLowerCase()} price for this item`);
    if (value?.substituted) {
      caveats.push("today's quote is far enough off this item's month that the median was used instead");
    }
    if (itemsLost > 0) {
      caveats.push(`fills after ${hoursToFill.toFixed(1)}h and stands idle for the rest of the interval`);
    }

    out.push({
      generator: minion.generator,
      family: minion.family,
      tier,
      itemId,
      itemName,
      itemsPerHour: rate,
      capacity,
      hoursToFill,
      itemsPerClaim,
      itemsLost,
      unitValue: unit,
      price: value ?? { price: 0, substituted: false, z: null, confidence: "normal" },
      grossPerHour,
      coinsPerHour,
      hopperPerHour: claim > 0 ? hopperPerClaim / claim : 0,
      fuelPerHour,
      netPerHour: coinsPerHour - fuelPerHour,
      perClaim,
      caveats,
    });
  }

  return out.sort((a, b) => b.netPerHour - a.netPerHour);
}

/**
 * What the fuel costs to keep burning, per hour, across every minion placed.
 *
 * A fuel with no duration is a one-off purchase and costs nothing per hour — an Everburning Flame
 * is a capital cost, not a running one, and amortising it over an arbitrary horizon would be
 * inventing the horizon. A fuel that runs out is a genuine subscription and is charged as one.
 *
 * Priced at what it costs to buy rather than what it fetches to sell, because that is the
 * transaction: you are buying fuel, and the ask is what buying costs.
 */
export function fuelCostPerHour(o: Pick<ProfitOptions, "setup" | "prices">): number {
  const { fuel, count } = o.setup;
  if (fuel.hours === null || fuel.hours <= 0) return 0;
  const price = o.prices.get(fuel.id)?.instabuy;
  if (!price || price <= 0) return 0;
  return (price / fuel.hours) * Math.max(0, count);
}

/**
 * The drops a whole setup makes an hour, ignoring storage. Exposed for the tab's own notes.
 *
 * Identical to `itemsPerHour` from the minions module and re-exported through here so a caller
 * pricing a minion never has to reach into two files to describe one.
 */
export function rawItemsPerHour(minion: MinionProduction, data: MinionData, setup: Setup): number | null {
  return itemsPerHour(minion, data, setup);
}

export { offlineAmount };
