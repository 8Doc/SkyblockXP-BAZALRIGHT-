/**
 * Which minion fills a collection fastest.
 *
 * A minion is a rate and a collection is a distance, so the question is a division — but every
 * term in it is somewhere a Hypixel endpoint is not, and one of them is a factor of two that
 * looks entirely plausible when it is wrong.
 *
 * **A cooldown is not a drop interval.** A minion's stats table quotes the time between *actions*,
 * and a minion generates on one action and harvests on the next. The Minions page states the rule
 * and works the example: a Tier I Cobblestone Minion at 14 seconds an action drops one cobblestone
 * every twenty-eight. Reading the cooldown as the drop interval doubles every rate on the page,
 * and nothing about the resulting number looks wrong.
 *
 * **Speed and duplication are different things and are never added.** Fuels quoted as a percentage
 * shorten the action timer, and the wiki gives the shape: `time = base / (1 + boost)`, not
 * `base × (1 - boost)`. Fuels quoted as x2/x3/x4 leave the timer alone and duplicate the drop.
 * A Hyper Catalyst is four times the items at the same speed; Foul Flesh is +90% speed, which is
 * not the same as 1.9× the items and does not stack with the multiplier by addition.
 *
 * The formula is self-checking against the wiki twice over, which is the reason to trust it: the
 * Minions page's own example is Cobblestone I at 14s, and the fuel page's is Clay XI at 16s.
 * Both are in the scraped table at exactly those values.
 */

/* ------------------------------------------------------------------ shapes */

export type MinionProduction = {
  generator: string;
  family: string;
  maxTier: number;
  /** What one harvest yields. `low`/`high` are set where the wiki quotes a range. */
  collects: { amount: number; item: string; low?: number; high?: number };
  /** The collection's display name as the wiki gives it, before resolution. */
  collection: string | null;
  /** The resolved collection item id, or null when the drop feeds no collection at all. */
  collectionId: string | null;
  /** Seconds between actions, one per tier, in tier order. */
  cooldowns: number[];
};

export type MinionData = {
  /** Two: a minion generates on one action and harvests on the next. */
  actionsPerHarvest: number;
  minions: MinionProduction[];
  /** What differs when nobody is on the island. See `data/curated/minion_offline.json`. */
  offline?: OfflineRules;
};

/**
 * The offline/online split, which is not a detail.
 *
 * Offline, Hypixel runs a *simulation* that accumulates actions — their own patch note says so,
 * having briefly capped it at 14,000 of them — and that simulation assumes a place-then-break pair
 * for every harvest. Online, the minion physically places and breaks blocks, so a crop that
 * regrows does not need replanting and the placement action is skipped entirely.
 *
 * This calculator models the **offline** case, because that is when minions are doing the work
 * anyone asks a minion calculator about. Two consequences are worth being explicit about rather
 * than leaving implicit:
 *
 *  - Two minions are roughly **twice as fast online** — Melon and Pumpkin, the regrowing crops.
 *    The Minion Upgrades page recommends Melon as the one to AFK beside for exactly this reason.
 *  - Two are **slower online** — Sugar Cane and Cactus break stalks that are not fully grown when
 *    a player is loading the island, which the offline simulation never does.
 *
 * And the per-harvest *amount* differs for two of them, which matters more than it sounds: the
 * infobox quotes the online figure, so a scraped Pumpkin is 1 where the offline answer is 3.
 */
export type OfflineRules = {
  amountOverrides: Record<string, { offline: number; online: number; source: string }>;
  fasterOnline: Record<string, string>;
  slowerOnline: Record<string, string>;
};

/**
 * What one harvest yields with nobody on the island.
 *
 * The scraped `collects` is the infobox's figure and the infobox quotes the online one, so two
 * minions need correcting before an offline rate means anything: Pumpkin drops 3 offline against
 * the 1 it shows, and Acacia drops 3 against the 4 it shows.
 */
export function offlineAmount(minion: MinionProduction, data: MinionData): number {
  return data.offline?.amountOverrides[minion.generator]?.offline ?? minion.collects.amount;
}

export type Fuel = {
  id: string;
  name: string;
  /** Fractional speed boost — 0.1 is +10%. Shortens the action timer. */
  speed: number;
  /** Item duplication — 3 is x3. Leaves the timer alone. */
  multiplier: number;
  /** How long one lasts, or null for infinite. */
  hours: number | null;
  note?: string;
};

export type Upgrade = {
  id: string;
  name: string;
  speed: number;
  /** Output scaling. The Soulflow engines halve it; everything else leaves it alone. */
  output: number;
  restrictedTo?: string;
  note?: string;
};

export type Modifiers = { fuels: Fuel[]; upgrades: Upgrade[] };

/* -------------------------------------------------------------------- rate */

export type Setup = {
  /** Which tier of the minion is placed. */
  tier: number;
  fuel: Fuel;
  /** The two upgrade slots. Either may be the empty one. */
  upgrades: [Upgrade, Upgrade];
  /** How many of this minion are down. */
  count: number;
};

/**
 * Seconds between actions once everything in the slots is counted.
 *
 * Boosts add together and then divide, which is what the wiki's formula says — `base / (1 + sum)`.
 * Two Minion Expanders are +10% together, not 1.05² , and a Flycatcher beside a fuel is one
 * division rather than two.
 */
export function actionSeconds(base: number, setup: Pick<Setup, "fuel" | "upgrades">): number {
  const boost = setup.fuel.speed + setup.upgrades.reduce((sum, u) => sum + u.speed, 0);
  return base / (1 + Math.max(0, boost));
}

/**
 * Items a whole setup collects per hour.
 *
 * Null where the tier is not one this minion has — asking for a tier XII of a minion that stops at
 * XI is a question with no answer, and returning zero would read as "this minion is useless".
 */
export function itemsPerHour(minion: MinionProduction, data: MinionData, setup: Setup): number | null {
  const base = minion.cooldowns[setup.tier - 1];
  if (base === undefined || base <= 0) return null;

  const seconds = actionSeconds(base, setup) * data.actionsPerHarvest;
  const output = setup.upgrades.reduce((m, u) => m * u.output, 1) * setup.fuel.multiplier;
  // The offline amount, not the infobox's: the infobox quotes what the minion drops with a player
  // standing there, and those differ for Pumpkin and Acacia.
  return (3600 / seconds) * offlineAmount(minion, data) * output * Math.max(0, setup.count);
}

/* -------------------------------------------------------- the collection */

export type CollectionTier = { tier: number; amountRequired: number; xp: number };
export type Collection = { itemId: string; name: string; tiers: CollectionTier[] };

/** What is left of a collection, and what finishing it is worth. */
export type Target = {
  /** How many more of the item are needed. */
  needed: number;
  /** Which tier that finishes. Null when the whole collection is already done. */
  tier: number | null;
  xp: number;
  /** True when this is the last tier rather than the next one. */
  maxing: boolean;
  /** Set when the target is a past-the-last-tier threshold, e.g. 100M Gold. */
  milestone?: string;
};

/**
 * How far to the next tier, or to the end of the collection.
 *
 * Collections are cumulative — one running total per item, measured against every tier at once —
 * so the distance is the tier's threshold minus what has been collected, and not the sum of the
 * tiers in between.
 */
/**
 * What you are aiming at.
 *
 * `next` and `max` are the collection's own tiers. `milestone` is neither: a few collections
 * carry a threshold past their last tier that grants something in game rather than SkyBlock XP,
 * and 100M Gold is the one people actually grind for. It is a real target with a real distance,
 * so it belongs here rather than in a note — it just pays a buff instead of XP.
 */
export type Goal = "next" | "max" | "milestone";

/** Thresholds past the last tier that grant an in-game buff. Curated: there is no table for these. */
export const MILESTONES: Record<string, { amount: number; label: string }> = {
  GOLD_INGOT: { amount: 100_000_000, label: "100M Gold" },
};
export function target(collection: Collection, have: number, goal: Goal): Target | null {
  const tiers = collection.tiers.filter((t) => t.tier > 0).sort((a, b) => a.tier - b.tier);
  if (tiers.length === 0) return null;

  if (goal === "milestone") {
    const milestone = MILESTONES[collection.itemId];
    // A collection with no milestone is not a row in this mode, rather than a row of zero.
    if (!milestone || have >= milestone.amount) return null;
    // No XP: the threshold is past the last tier, so every tier's XP is already banked. The
    // payoff is the buff, and quoting XP here would be inventing some.
    return { needed: milestone.amount - have, tier: null, xp: 0, maxing: true, milestone: milestone.label };
  }

  if (goal === "max") {
    const last = tiers[tiers.length - 1];
    if (have >= last.amountRequired) return null;
    return {
      needed: last.amountRequired - have,
      tier: last.tier,
      // Every tier still open, since maxing passes through all of them.
      xp: tiers.filter((t) => t.amountRequired > have).reduce((s, t) => s + t.xp, 0),
      maxing: true,
    };
  }

  const next = tiers.find((t) => t.amountRequired > have);
  if (!next) return null;
  return { needed: next.amountRequired - have, tier: next.tier, xp: next.xp, maxing: false };
}

/* ------------------------------------------------------------- the ranking */

export type MinionPlan = {
  generator: string;
  family: string;
  /** The tier actually used, after the "highest you own" or "assume this tier" decision. */
  tier: number;
  /** True when the tier came from the profile rather than from the assumption. */
  owned: boolean;
  collectionId: string;
  collectionName: string;
  itemsPerHour: number;
  /** How many more items the target needs. */
  needed: number;
  /** Hours to get there. */
  hours: number;
  targetTier: number | null;
  xp: number;
  /** XP per hour of waiting, which is what actually ranks one minion against another. */
  xpPerHour: number;
  /** Set where the wiki quotes the drop as a range rather than a fixed number. */
  dropRange?: { low: number; high: number };
  /** Set when the row is aiming at a past-the-last-tier threshold rather than a tier. */
  milestone?: string;
  /** Anything the caller should say out loud about this row. */
  caveats: string[];
};

export type PlanOptions = {
  data: MinionData;
  collections: Collection[];
  /** Collected totals by item id, island-wide where there is a co-op. */
  collected: Map<string, number>;
  /** Highest tier owned per generator, from the profile's crafted list. Empty means none known. */
  ownedTier: Map<string, number>;
  /** Tier to assume where the profile does not show one — or everywhere, if `useOwned` is false. */
  assumeTier: number;
  /** Use the highest tier the player has actually crafted, falling back to `assumeTier`. */
  useOwned: boolean;
  fuel: Fuel;
  upgrades: [Upgrade, Upgrade];
  count: number;
  /** What to aim at: the next tier, the last one, or a past-the-last threshold like 100M Gold. */
  goal: Goal;
};

/**
 * Every minion that feeds a collection you have not finished, soonest first.
 *
 * Ranked on XP per hour rather than raw hours, because "fastest" on its own picks whatever tier is
 * nearly done regardless of what it pays — and a tier worth 4 XP that lands in an hour is not
 * obviously better than one worth 60 that lands in six. Both figures are on the row.
 */
export function planMinions(o: PlanOptions): MinionPlan[] {
  const byId = new Map(o.collections.map((c) => [c.itemId, c]));
  const out: MinionPlan[] = [];

  for (const minion of o.data.minions) {
    if (!minion.collectionId) continue;
    const collection = byId.get(minion.collectionId);
    if (!collection) continue;

    const have = o.collected.get(minion.collectionId) ?? 0;
    const goal = target(collection, have, o.goal);
    if (!goal) continue;

    // The tier decision, and it is a decision rather than a lookup: someone planning a grind may
    // well upgrade first, so "the best tier you own" and "the tier you are about to buy" are both
    // real questions and the caller picks which one is being asked.
    const owned = o.ownedTier.get(minion.generator);
    const tier = o.useOwned && owned ? Math.min(owned, minion.maxTier) : Math.min(o.assumeTier, minion.maxTier);

    const setup: Setup = { tier, fuel: o.fuel, upgrades: o.upgrades, count: o.count };
    const rate = itemsPerHour(minion, o.data, setup);
    if (rate === null || rate <= 0) continue;

    const caveats: string[] = [];
    if (o.upgrades.some((u) => u.output !== 1)) caveats.push("an upgrade in this setup changes the output");
    if (o.fuel.hours !== null) {
      caveats.push(`${o.fuel.name} lasts ${o.fuel.hours}h, so this assumes you keep it topped up`);
    }
    if (tier < o.assumeTier && !o.useOwned) caveats.push(`caps at tier ${minion.maxTier}`);

    const hours = goal.needed / rate;
    out.push({
      generator: minion.generator,
      family: minion.family,
      tier,
      owned: o.useOwned && owned !== undefined,
      collectionId: minion.collectionId,
      collectionName: collection.name,
      itemsPerHour: rate,
      needed: goal.needed,
      hours,
      targetTier: goal.tier,
      xp: goal.xp,
      xpPerHour: hours > 0 ? goal.xp / hours : 0,
      ...(goal.milestone ? { milestone: goal.milestone } : {}),
      ...(minion.collects.low !== undefined && minion.collects.high !== undefined
        ? { dropRange: { low: minion.collects.low, high: minion.collects.high } }
        : {}),
      caveats,
    });
  }

  // Milestone rows pay a buff rather than XP, so there is no XP per hour to rank them on and
  // the honest ordering is simply the shortest wait.
  if (o.goal === "milestone") return out.sort((a, b) => a.hours - b.hours);
  return out.sort((a, b) => b.xpPerHour - a.xpPerHour || a.hours - b.hours);
}
