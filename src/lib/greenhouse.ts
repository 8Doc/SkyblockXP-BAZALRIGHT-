import { NET_OF_TAX } from "./bazaar";
import type { ProductSnapshot } from "./bazaarTypes";
import type { NpcPrice } from "./bazaarViews";

/**
 * Which Greenhouse mutation is worth growing.
 *
 * A mutation is an AFK trade with three costs and one revenue, and the ranking turns on the two
 * costs nobody quotes. The revenue is easy: a mutation drops a pile of one or two crops and the
 * bazaar prices them. The costs are *time* — how many growth stages before it spawns, and how
 * many more before it can be harvested — and *space*, because the plants that spread it occupy
 * the ring around it and have to be bought.
 *
 * **Fortune scales everything and ranks nothing.** Farming Fortune multiplies every mutation's
 * drops by the same factor, so it changes what a row pays and never which row is best. That is
 * worth knowing before agonising over the number: a wrong fortune makes every figure wrong by
 * the same proportion and leaves the answer to "which one" untouched. What does move the ranking
 * is setup cost and cycle time, which are per-mutation.
 *
 * **The wiki's own numbers have a date on them.** Every base crop's drop changed on 2026-08-20,
 * some by more than half, so this is only as current as the scrape under it — see the note in
 * `greenhouse.json`.
 */

/* ------------------------------------------------------------------ shapes */

export type GreenhouseData = {
  generatedAt: string;
  growth: { baseStageSeconds: number; fastestStageSeconds: number };
  water: { lossPerStageMin: number; lossPerStageMax: number };
  maxPlots: number;
  etherealVineByRarity: Record<string, number>;
  baseCrops: { id: string; name: string; baseYield: number; growthCycles: number }[];
  mutations: Mutation[];
};

export type SpreadOption = { id: string; name: string; cells: number; free?: boolean };

export type Mutation = {
  id: string;
  name: string;
  rarity: string | null;
  /** 1, 2 or 3 — the side of the square it occupies, and the ring cells one plant covers. */
  size: number;
  cellsPerPlant: number;
  /** Null where the wiki leaves it blank; zero means the staff table's "special conditions". */
  weight: number | null;
  /** Per-roll spawn chance as the wiki states it. Null when it does not. */
  chance: number | null;
  growthStages: number | null;
  spreading: { raw: string; options: SpreadOption[]; prose: boolean };
  /** The wiki's own arithmetic for the awkward multi-cell cases, keyed by required crop. */
  plantNotes: Record<string, { cells: number; plants: number }>;
  effects: string[];
  drops: { id: string; name: string; amount: number }[];
  farmingXp: number | null;
  layout?: (string | null)[][];
};

/* ------------------------------------------------------------------- time */

export type GrowthParams = {
  /** Unique non-mutated crops growing in any plot. Twelve is the documented maximum. */
  uniqueCrops: number;
  /** The Crop Growth stat, 0-210. */
  cropGrowth: number;
  /** The Greenhouse Speed attribute, 0-10. */
  speedAttribute: number;
  /** The Growth Speed garden upgrade, 0-9. Tier 9 is worth double tier 8. */
  growthSpeedUpgrade: number;
};

/**
 * Seconds in one growth stage.
 *
 * Straight from the formula the Greenhouse page publishes. The upgrade term has a step in it:
 * tiers 0 to 8 are five percent each, and tier 9 is fifty rather than the forty-five the pattern
 * would give — so the last tier is worth double a normal one. Worth knowing and easy to overstate;
 * it is a tenth on top of the four tenths already there, not a doubling of the whole term.
 *
 * Four hours flat becomes 1h 41m with everything maxed, which the wiki states independently and
 * is what this reproduces.
 */
export function stageSeconds(data: GreenhouseData, p: GrowthParams): number {
  const upgrade = p.growthSpeedUpgrade >= 9 ? 0.5 : 0.05 * Math.max(0, p.growthSpeedUpgrade);
  const speedup = 1 + 0.025 * p.uniqueCrops + 0.0025 * p.cropGrowth + 0.005 * p.speedAttribute + upgrade;
  return data.growth.baseStageSeconds / speedup;
}

/**
 * Growth stages before one mutation is ready to harvest, spawning included.
 *
 * Two waits, and for most of the list the first dominates. A mutation rolls against its own
 * chance each time the crops around it advance a stage, so the expected wait to *appear* is the
 * reciprocal of that chance — twenty stages for a Godseed at 5%, three and a bit for a Choconut
 * at 30%. Then it grows: nothing at all for most commons, forty more stages for a Godseed.
 *
 * Null when the wiki publishes no chance, which is not the same as a chance of zero — four
 * mutations need a special act rather than a roll, and quoting them as "never" would be wrong in
 * the opposite direction to quoting them as instant.
 */
export function stagesPerHarvest(m: Mutation): number | null {
  if (m.chance === null || m.chance <= 0 || m.growthStages === null) return null;
  return 1 / m.chance + m.growthStages;
}

/* ------------------------------------------------------------------ money */

/** What one of an item fetches, sold patiently into the bazaar and taxed, or to a shop untaxed. */
export function unitPrice(
  id: string,
  market: Map<string, ProductSnapshot>,
  npcPrices: Record<string, NpcPrice>,
): number | null {
  const product = market.get(id);
  // The bazaar's bid is what selling into it actually pays, and the tax comes off that. An item
  // with an empty buy book has no price rather than a price of zero — the rule the rest of this
  // codebase keeps.
  const bazaar = product && product.instabuy > 0 ? product.instabuy * NET_OF_TAX : null;
  const shop = npcPrices[id]?.sell ?? null;
  if (bazaar === null && shop === null) return null;
  return Math.max(bazaar ?? 0, shop ?? 0);
}

/** What one costs to buy, which is the other direction and a different side of the book. */
export function buyPrice(
  id: string,
  market: Map<string, ProductSnapshot>,
  npcPrices: Record<string, NpcPrice>,
): number | null {
  const product = market.get(id);
  const bazaar = product && product.instasell > 0 ? product.instasell : null;
  const shop = npcPrices[id]?.buy ?? null;
  if (bazaar === null && shop === null) return null;
  return Math.min(bazaar ?? Infinity, shop ?? Infinity);
}

/**
 * How many plants a spreading condition really costs you.
 *
 * The condition counts *ring cells* — the eight squares around the spot the mutation appears in —
 * and a plant bigger than one cell fills more than one of them. A 2x2 Noctilume covers two ring
 * cells, so a condition asking for three is met by two Noctilumes and not by three; a 3x3
 * Snoozling covers three, so six cells is two Snoozlings.
 *
 * The wiki works this out in a footnote for the six cases where it matters and those are used
 * verbatim. Everything else is `ceil(cells / cellsPerPlant)`, which agrees with all six.
 */
export function plantsFor(option: SpreadOption, required: Mutation | undefined, notes: Mutation["plantNotes"]): number {
  const note = notes[option.id];
  if (note && note.cells === option.cells) return note.plants;
  const perPlant = required?.cellsPerPlant ?? 1;
  return Math.ceil(option.cells / Math.max(1, perPlant));
}

export type Setup = {
  /** The alternative actually costed — the cheapest one that can be priced. */
  option: SpreadOption;
  plants: number;
  /** Null when the thing it needs has no price anywhere. */
  coins: number | null;
  /** True when the ingredient is itself a mutation, so it has to be grown before it is planted. */
  grown: boolean;
};

/**
 * The cheapest way to satisfy a mutation's spreading condition.
 *
 * The slash in "Soggybud x4 / Choconut x4" is an *or*, so the cheaper side is the one a player
 * would plant, and which is cheaper is a live price question rather than a property of the
 * mutation. Fire and Dead Plant cost nothing and are priced as such.
 */
export function cheapestSetup(
  m: Mutation,
  byId: Map<string, Mutation>,
  market: Map<string, ProductSnapshot>,
  npcPrices: Record<string, NpcPrice>,
): Setup | null {
  let best: Setup | null = null;
  for (const option of m.spreading.options) {
    const required = byId.get(option.id);
    const plants = plantsFor(option, required, m.plantNotes);
    const each = option.free ? 0 : buyPrice(option.id, market, npcPrices);
    const coins = each === null ? null : each * plants;
    const setup: Setup = { option, plants, coins, grown: required !== undefined };
    // A priced option always beats an unpriced one; between two priced ones, the cheaper wins.
    if (!best) best = setup;
    else if (best.coins === null && coins !== null) best = setup;
    else if (coins !== null && best.coins !== null && coins < best.coins) best = setup;
  }
  return best;
}

/* ------------------------------------------------------------- the ranking */

export type MutationProfit = {
  id: string;
  name: string;
  rarity: string | null;
  size: number;
  /** Cells of the 10x10 plot one of these occupies, ring plants included. */
  cellsUsed: number;
  stagesPerHarvest: number | null;
  hoursPerHarvest: number | null;
  /** Coins one harvest brings in, after tax, at the given fortune. */
  revenue: number;
  /** Ethereal Vines are a second revenue stream and scale with rarity. */
  vineRevenue: number;
  setup: Setup | null;
  coinsPerHour: number | null;
  coinsPerDay: number | null;
  /** Water falls 2-3 a stage, so this is how often a stage comes round. */
  hoursPerStage: number;
  /** Drops the market cannot price, named rather than counted as zero. */
  unpriced: string[];
  /** Why this row cannot be ranked, when it cannot. */
  problem: string | null;
};

export type ProfitOptions = {
  market: Map<string, ProductSnapshot>;
  npcPrices?: Record<string, NpcPrice>;
  growth: GrowthParams;
  /** Farming Fortune. Scales every row identically, so it moves the figures and not the order. */
  farmingFortune: number;
  /** Multiplied on top of fortune: plant yield upgrade, evergreen chips, adjacency buffs. */
  yieldMultiplier?: number;
  plots?: number;
};

/**
 * The standard farming yield: every hundred Farming Fortune is one more of everything.
 *
 * The Greenhouse page says mutation drops take "the normal farming yield formula" and then the
 * yield multipliers on top, which is what this is. Worth flagging that the wiki's Farming Fortune
 * page carries an `{{Outdated}}` banner saying it has not caught up with the Greenhouse update —
 * so this is the documented formula rather than a re-measured one, and it is the piece of this
 * model most likely to be wrong.
 */
export function fortuneMultiplier(farmingFortune: number): number {
  return 1 + Math.max(0, farmingFortune) / 100;
}

export function profitOf(m: Mutation, byId: Map<string, Mutation>, data: GreenhouseData, o: ProfitOptions): MutationProfit {
  const npcPrices = o.npcPrices ?? {};
  const multiplier = fortuneMultiplier(o.farmingFortune) * (o.yieldMultiplier ?? 1);

  let revenue = 0;
  const unpriced: string[] = [];
  for (const drop of m.drops) {
    const price = unitPrice(drop.id, o.market, npcPrices);
    if (price === null) unpriced.push(drop.name);
    else revenue += price * drop.amount * multiplier;
  }

  // An Ethereal Vine on harvest, at odds that rise with rarity. It is the only way to enlarge the
  // greenhouse and it trades on the bazaar, so it is real income rather than a curiosity.
  const vineChance = data.etherealVineByRarity[(m.rarity ?? "").toLowerCase()] ?? 0;
  const vinePrice = unitPrice("ETHEREAL_VINE", o.market, npcPrices) ?? 0;
  const vineRevenue = vineChance * vinePrice;

  const stages = stagesPerHarvest(m);
  const hoursPerStage = stageSeconds(data, o.growth) / 3600;
  const hoursPerHarvest = stages === null ? null : stages * hoursPerStage;

  const setup = cheapestSetup(m, byId, o.market, npcPrices);
  const plots = o.plots ?? 1;

  // One mutation plus the ring that spreads it. The ring is eight cells and the plants filling it
  // are shared between neighbouring mutations in a real layout, so this is the standalone cost of
  // one — an upper bound on space rather than a packing.
  const cellsUsed = m.size * m.size + (setup?.plants ?? 0) * (byId.get(setup?.option.id ?? "")?.size ?? 1) ** 2;

  const total = revenue + vineRevenue;
  const problem =
    m.spreading.prose
      ? `Needs a special act rather than a roll: ${m.spreading.raw}`
      : stages === null
        ? "The wiki publishes no spawn chance for this one, so there is no cycle time to divide by."
        : unpriced.length === m.drops.length && m.drops.length > 0
          ? `Nothing is bidding on ${unpriced.join(", ")}.`
          : null;

  return {
    id: m.id,
    name: m.name,
    rarity: m.rarity,
    size: m.size,
    cellsUsed,
    stagesPerHarvest: stages,
    hoursPerHarvest,
    revenue,
    vineRevenue,
    setup,
    coinsPerHour: problem || hoursPerHarvest === null || hoursPerHarvest <= 0 ? null : (total / hoursPerHarvest) * plots,
    coinsPerDay: problem || hoursPerHarvest === null || hoursPerHarvest <= 0 ? null : (total / hoursPerHarvest) * 24 * plots,
    hoursPerStage,
    unpriced,
    problem,
  };
}

/** Every mutation, best first. Rows that cannot be ranked sort last but are never dropped. */
export function rankMutations(data: GreenhouseData, o: ProfitOptions): MutationProfit[] {
  const byId = new Map(data.mutations.map((m) => [m.id, m]));
  return data.mutations
    .map((m) => profitOf(m, byId, data, o))
    .sort((a, b) => (b.coinsPerHour ?? -1) - (a.coinsPerHour ?? -1));
}
