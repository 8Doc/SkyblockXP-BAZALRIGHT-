import { NET_OF_TAX } from "./bazaar";
import { itemsPerHour, offlineAmount, type MinionData, type MinionProduction, type Setup, type Upgrade } from "./minions";
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

/**
 * What the compactor turns a drop into, and how many of the drop that takes.
 *
 * The id matters as much as the ratio and used not to be returned at all. A minion with a Super
 * Compactor does not hold cobblestone; it holds Enchanted Cobblestone, and a hopper bolted to it
 * sells *that* — at the enchanted item's shop price, which is not always 160 times the raw one.
 * Returning only the ratio meant the overflow was priced as the raw drop, which understates every
 * item whose enchanted form is worth more than its parts and is exactly the case the automated
 * shipping strategy lives on.
 *
 * `{ ratio: 1, itemId }` for an item nothing compacts, so the caller can apply it unconditionally.
 */
export type Compaction = { ratio: number; itemId: string };

export function compactionOf(itemId: string, compactor: Compactor, recipes: Recipe[]): Compaction {
  if (compactor.kind === "none") return { ratio: 1, itemId };

  let best: Compaction = { ratio: 1, itemId };
  for (const recipe of recipes) {
    if (recipe.ingredients.length !== 1) continue;
    const only = recipe.ingredients[0];
    if (only.id !== itemId || !(recipe.yield > 0)) continue;
    // A block recipe is nine, an enchanted one is a hundred and sixty. A Compactor only does the
    // first; a Super Compactor does the enchanted form, which is the bigger of the two.
    const ratio = only.qty / recipe.yield;
    if (compactor.kind === "block" && ratio > 64) continue;
    if (ratio > best.ratio) best = { ratio, itemId: recipe.output };
  }
  return best;
}

/** The ratio alone, for callers that only care how much longer the minion runs. */
export function compactionRatio(itemId: string, compactor: Compactor, recipes: Recipe[]): number {
  return compactionOf(itemId, compactor, recipes).ratio;
}

/* ------------------------------------------------------------------ setup */

export type ProfitSetup = Setup & {
  chest: StorageChest;
  hopper: Hopper;
  compactor: Compactor;
  /** Hours between visits to the island. The number that turns a rate into an income. */
  claimHours: number;
};

/* ------------------------------------------------------------------ extras */

/**
 * An upgrade that adds a second item to what the minion produces.
 *
 * Modelled separately from the speed and output fields on `Upgrade` because it is a different kind
 * of fact: a Flycatcher multiplies a number the minion already had, and Corrupt Soil adds a stream
 * the minion did not have at all. Folding it into `output` would be arithmetically wrong — the
 * extra item is not the drop and is not worth the same — and it would hide the one setup this
 * whole table most needs to surface.
 */
export type MinionExtra = {
  upgrade: string;
  name: string;
  drops: { itemId: string; perHarvest: number }[];
  /** Generators this upgrade can go in, or null for any. */
  restrictedTo: string[] | null;
};

export type ExtrasTable = { extras: MinionExtra[] };

/**
 * The extra drops a setup actually produces, per harvest, for one minion.
 *
 * Empty unless an upgrade in one of the two slots adds items *and* is allowed in this minion. Both
 * halves matter: Corrupt Soil in a Cobblestone Minion is a wasted slot, not free sulphur, because
 * a minion that spawns no mobs has nothing to corrupt.
 */
export function extrasFor(
  generator: string,
  upgrades: readonly Upgrade[],
  table: ExtrasTable,
): { extra: MinionExtra; drop: { itemId: string; perHarvest: number } }[] {
  const out: { extra: MinionExtra; drop: { itemId: string; perHarvest: number } }[] = [];
  for (const upgrade of upgrades) {
    const extra = table.extras.find((e) => e.upgrade === upgrade.id);
    if (!extra) continue;
    if (extra.restrictedTo && !extra.restrictedTo.includes(generator)) continue;
    for (const drop of extra.drops) out.push({ extra, drop });
  }
  return out;
}

/**
 * One thing a minion produces, priced.
 *
 * The main drop and every extra go through identical machinery from here on, which is the point of
 * the shape: storage, compaction, the hopper and the claim interval all treat a sulphur exactly as
 * they treat a slimeball, and nothing downstream has to remember which was the minion's "real"
 * output.
 */
export type Stream = {
  itemId: string | null;
  itemName: string;
  /** Raw items an hour from this stream alone. */
  perHour: number;
  /** How many raw items the compactor packs into one stored item. */
  ratio: number;
  /** Coins one raw item is worth on the chosen basis, after tax. */
  unit: number;
  /** Coins a hopper fetches per raw item — the compacted item's shop price, times its own cut. */
  hopperUnit: number;
  price: BasisPrice | null;
  /** True for a stream an upgrade added rather than the minion's own drop. */
  fromUpgrade: string | null;
  /**
   * The item this stream is actually sold as.
   *
   * The compacted form wherever a compactor is fitted and that form has a market, otherwise the
   * drop itself. Worth carrying so a row can say "priced as Enchanted Ice" rather than leaving a
   * reader to wonder why an item with no buy orders has a price.
   */
  soldAs?: string | null;
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

  /** Every item this setup produces, priced. The first is the minion's own drop. */
  streams: Stream[];

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
  /** Upgrades that add a second item to the output — Corrupt Soil and friends. */
  extras: ExtrasTable;
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

    // How many harvests an hour, which is the unit every extra is quoted in. The minion's own drop
    // is `amount` per harvest, so dividing the rate back out recovers the harvest count — and an
    // extra that says "one per harvest" then means one, whatever the minion's own stack size is.
    const perHarvest = Math.max(1e-9, offlineAmount(minion, o.data));
    const harvests = rate / perHarvest;

    const streams: Stream[] = [];
    const priceStream = (id: string | null, name: string, perHour: number, fromUpgrade: string | null): Stream => {
      const raw = id ? o.prices.get(id) : undefined;
      const packed = id ? compactionOf(id, o.setup.compactor, o.recipes) : { ratio: 1, itemId: "" };

      /**
       * Price what you are actually holding.
       *
       * With a compactor fitted the minion's inventory contains the enchanted item, not the drop,
       * so that is what gets collected and that is what gets sold — and the two markets are not the
       * same market divided by 160. Raw Ice has no buy orders at all on the bazaar while Enchanted
       * Ice trades at 67; pricing the collected stream as ice values an Ice Minion at nothing and
       * quietly drops it out of every ranking it should win.
       *
       * Falls back to the raw item wherever the compacted form has no price of its own, which is
       * the right way round: an item nobody trades in bulk is still worth its parts.
       */
      const packedPrices = packed.ratio > 1 && packed.itemId ? o.prices.get(packed.itemId) : undefined;
      const packedVariance = packed.ratio > 1 && packed.itemId ? (o.variance.get(packed.itemId) ?? null) : null;
      const packedValue = packedPrices ? unitValue(packedPrices, o.basis, packedVariance, o.trust) : null;

      const rawVariance = id ? (o.variance.get(id) ?? null) : null;
      const rawValue = raw ? unitValue(raw, o.basis, rawVariance, o.trust) : null;

      // Per raw drop either way, so everything downstream keeps counting in drops.
      const value = packedValue ? { ...packedValue, price: packedValue.price / packed.ratio } : rawValue;

      // A hopper sells out of that same inventory, at the shopkeeper's price and its own cut.
      const packedNpc = packedPrices?.npcSell ?? null;
      const npcPerRaw = packedNpc !== null ? packedNpc / packed.ratio : (raw?.npcSell ?? 0);

      return {
        itemId: id,
        itemName: name,
        perHour,
        ratio: packed.ratio,
        unit: value?.price ?? 0,
        hopperUnit: npcPerRaw * o.setup.hopper.npcShare,
        price: value,
        /** What the stream is actually sold as, which is the compacted item where there is one. */
        soldAs: packedValue && packed.itemId ? packed.itemId : id,
        fromUpgrade,
      };
    };

    /**
     * The headline drop, scaled by its own chance where the wiki gives one.
     *
     * A Fishing Minion is 54% cod and a Mushroom Minion 50% red — the remainder is not nothing, it
     * is the other entries in `alsoCollects`, and the percentages sum to one harvest between them.
     * Counting the primary at 100% *and* adding the rest would invent output the minion never made.
     */
    const primaryChance = minion.collects.chance ?? 1;
    const primaryPerHour = rate * primaryChance;
    if (primaryChance < 1) {
      caveats.push(
        `${itemName} is ${(primaryChance * 100).toFixed(1)}% of this minion's harvests — the rest is its other drops`,
      );
    }

    streams.push(priceStream(itemId, itemName, primaryPerHour, null));

    /**
     * The minion's own second and third drops, priced like any other stream.
     *
     * Distinct from the upgrade extras below: nothing has to be fitted for these, they are simply
     * what the minion makes. Leaving them out is what made the Revenant Minion look worthless — its
     * diamonds are a fifth of its harvests and many times the value of the flesh they come with.
     *
     * A conditional drop is skipped rather than counted: it needs an upgrade, and the upgrade that
     * grants it is modelled in the extras table with the rest of its effects.
     */
    for (const also of minion.alsoCollects ?? []) {
      if (also.condition) {
        caveats.push(`also drops ${also.item} with ${also.condition} fitted, which is counted under that upgrade`);
        continue;
      }
      const alsoId = byName.get(also.item.toLowerCase()) ?? null;
      if (!alsoId) {
        caveats.push(`also drops ${also.item}, which nothing on the bazaar or at a shopkeeper prices`);
        continue;
      }
      streams.push(priceStream(alsoId, also.item, harvests * also.amount * (also.chance ?? 1), null));
    }

    for (const { extra, drop } of extrasFor(minion.generator, o.setup.upgrades, o.extras)) {
      streams.push(
        priceStream(drop.itemId, o.names[drop.itemId] ?? drop.itemId, harvests * drop.perHarvest, extra.name),
      );
    }

    // Storage is shared, and it is counted in *stored* items — so a stream the compactor packs 160
    // to one takes a hundred and sixtieth of the room per drop. Summing the streams in stored units
    // is the only way a minion producing three different things at three different ratios gets one
    // honest fill time.
    const slots = o.storage.chests.find((c) => c.id === o.setup.chest.id)?.slots ?? o.setup.chest.slots;
    const capacityStored = (minion.storage?.[tier - 1] ?? 0) + slots * o.storage.slotItems;
    const storedPerHour = streams.reduce((sum, s) => sum + s.perHour / s.ratio, 0);
    const hoursToFill = storedPerHour > 0 && capacityStored > 0 ? capacityStored / storedPerHour : Infinity;

    const claim = Math.max(0, o.setup.claimHours);
    const bankedHours = Math.min(claim, hoursToFill);
    const overflowHours = Math.max(0, claim - hoursToFill);
    const shipping = o.setup.hopper.npcShare > 0;

    let perClaim = 0;
    let hopperPerClaim = 0;
    let grossPerHour = 0;
    let itemsPerClaim = 0;
    let itemsLost = 0;

    for (const stream of streams) {
      const banked = stream.perHour * bankedHours;
      const overflow = stream.perHour * overflowHours;
      perClaim += banked * stream.unit;
      grossPerHour += stream.perHour * stream.unit;
      itemsPerClaim += banked;
      if (shipping) hopperPerClaim += overflow * stream.hopperUnit;
      else itemsLost += overflow;
    }
    perClaim += hopperPerClaim;

    const coinsPerHour = claim > 0 ? perClaim / claim : 0;
    const mainPrices = itemId ? o.prices.get(itemId) : undefined;
    const value = streams[0].price;

    if (!mainPrices) caveats.push("nothing on the bazaar or at a shopkeeper prices this drop");
    else if (!value) caveats.push(`no ${BASIS_LABELS[o.basis].toLowerCase()} price for this item`);
    if (value?.substituted) {
      caveats.push("today's quote is far enough off this item's month that the median was used instead");
    }
    for (const stream of streams.slice(1)) {
      const worth = `worth ${Math.round(stream.perHour * stream.unit)} coins an hour here`;
      caveats.push(
        stream.fromUpgrade
          ? `${stream.fromUpgrade} adds ${stream.itemName}, ${worth}`
          : `also drops ${stream.itemName}, ${worth}`,
      );
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
      itemsPerHour: primaryPerHour,
      capacity: capacityStored * (streams[0].ratio || 1),
      hoursToFill,
      itemsPerClaim,
      itemsLost,
      unitValue: streams[0].unit,
      price: value ?? { price: 0, substituted: false, z: null, confidence: "normal" },
      grossPerHour,
      coinsPerHour,
      hopperPerHour: claim > 0 ? hopperPerClaim / claim : 0,
      fuelPerHour: fuelUnit,
      netPerHour: coinsPerHour - fuelUnit,
      perClaim,
      streams,
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
