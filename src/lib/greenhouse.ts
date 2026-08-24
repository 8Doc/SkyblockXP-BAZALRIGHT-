import { NET_OF_TAX } from "./bazaar";
import { packGreenhouse, type Packing } from "./greenhouseLayout";
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
 * **Fortune is two stats, and only one of them is harmless to get wrong.** Farming Fortune lifts
 * every crop, so it multiplies every mutation by the same factor: a wrong figure scales all the
 * coins and leaves the *order* untouched. The thirteen Crop Fortunes do not behave that way. Wheat
 * Fortune lifts wheat and nothing else, so a mutation dropping wheat and one dropping cocoa beans
 * move apart — which makes crop fortune the one input here that can change which mutation is best.
 *
 * They meet by addition before the yield is worked out, which the Crop Fortune page states
 * outright: "their farming fortune is first added to their Crop Fortune stat corresponding to the
 * crop they are breaking". So the number that matters is per-drop, not per-player, and this module
 * computes revenue a drop at a time rather than scaling a mutation's total.
 *
 * The sources are worth knowing because they are lopsided: a farming tool carries crop fortune for
 * its own crop, and the Overdrive Chip adds up to +140 more — but only for the active crop during a
 * Jacob's Farming Contest. That is a contest-day figure rather than a standing one, and entering it
 * as though it were permanent overstates every mutation dropping that crop.
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
  /** The thirteen crop-specific fortunes and the item ids each one lifts. */
  cropFortunes?: { stat: string; crop: string; ids: string[] }[];
  mutations: Mutation[];
};

/** One clause of a spreading condition. Every clause is required — the slash means "and". */
export type SpreadRequirement = { id: string; name: string; cells: number; free?: boolean };

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
  spreading: { raw: string; requires: SpreadRequirement[]; prose: boolean };
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
export function plantsFor(option: SpreadRequirement, required: Mutation | undefined, notes: Mutation["plantNotes"]): number {
  const note = notes[option.id];
  if (note && note.cells === option.cells) return note.plants;
  const perPlant = required?.cellsPerPlant ?? 1;
  return Math.ceil(option.cells / Math.max(1, perPlant));
}

/** One crop a mutation needs, priced across the whole plot. */
export type SetupItem = {
  id: string;
  name: string;
  /** Ring cells of this crop the condition asks for at each target. */
  cells: number;
  /** Plants of it the layout puts in the plot. */
  plants: number;
  /** What those plants cost, or null when nothing sells it. */
  coins: number | null;
  /** What one costs, for the breakdown line. */
  each: number | null;
  /** True when it is itself a mutation, so it has to be grown before it can be planted. */
  grown: boolean;
  /** True when it is Fire or a Dead Plant: a real requirement that costs nothing. */
  free: boolean;
};

export type Setup = {
  /** Every crop the condition names. All of them are needed — the slash is "and". */
  items: SetupItem[];
  /** Plants across every requirement. */
  plants: number;
  /** The whole plot's bill, or null when any part of it has no price. */
  coins: number | null;
  /** How the plot was laid out, and how many mutations that feeds. */
  packing: Packing;
};

/**
 * What a mutation costs to set up across one greenhouse.
 *
 * Every clause of the condition is required — the slash on the wiki reads like "or" and means
 * "and", which the layouts settle: Stoplight Petal's ring holds four Noctilume *and* four
 * Snoozling, Scourroot's holds a Potato *and* a Carrot. Pricing one of them and calling it the
 * cheapest, as this did at first, halves every bill on the page and quietly doubles the ranking of
 * anything with an expensive second crop.
 *
 * Fire and Dead Plant are real requirements that cost nothing, and are priced as such rather than
 * being dropped or read as unpriceable.
 */
export function setupFor(
  m: Mutation,
  byId: Map<string, Mutation>,
  market: Map<string, ProductSnapshot>,
  npcPrices: Record<string, NpcPrice>,
  plot: PlotShape,
): Setup | null {
  if (m.spreading.requires.length === 0) return null;

  const requires = m.spreading.requires.map((r) => ({ cells: r.cells, size: byId.get(r.id)?.size ?? 1 }));
  const packing = packFor(plot, requires, m.size);

  const items: SetupItem[] = m.spreading.requires.map((r, i) => {
    const grown = byId.has(r.id);
    const each = r.free ? 0 : buyPrice(r.id, market, npcPrices);
    const plants = packing.plants[i] ?? 0;
    return {
      id: r.id,
      name: r.name,
      cells: r.cells,
      plants,
      each,
      coins: each === null ? null : each * plants,
      grown,
      free: r.free === true,
    };
  });

  // One unpriceable crop makes the whole bill unknown rather than cheap — the rule the rest of
  // this codebase keeps about a missing price.
  const coins = items.some((i) => i.coins === null) ? null : items.reduce((sum, i) => sum + (i.coins ?? 0), 0);
  return { items, plants: items.reduce((sum, i) => sum + i.plants, 0), coins, packing };
}

/**
 * The greenhouse to lay out on.
 *
 * Ten by ten, which is not on the wiki — it is read off a real profile's `greenhouse_slots`, where
 * the coordinates run 0..9 in both directions. `locked` is the cells that profile had not opened;
 * left empty, the packing assumes a fully unlocked plot.
 */
export type PlotShape = { width: number; height: number; locked?: Set<string> };

export const FULL_PLOT: PlotShape = { width: 10, height: 10 };

/**
 * Packings are memoised, because the answer depends on the plot and three small integers and not
 * at all on prices — so it survives the twenty-second repricing that redraws everything else.
 * Sixteen distinct shapes cover all forty mutations, at about forty milliseconds apiece.
 */
const packings = new Map<string, Packing>();

function packFor(plot: PlotShape, requires: { cells: number; size: number }[], targetSize: number): Packing {
  const lockedKey = plot.locked && plot.locked.size > 0 ? [...plot.locked].sort().join("|") : "";
  const shape = requires.map((r) => `${r.cells}/${r.size}`).join(",");
  const cacheKey = `${plot.width}x${plot.height}:${lockedKey}:${shape}:${targetSize}`;
  const cached = packings.get(cacheKey);
  if (cached) return cached;

  const packing = packGreenhouse({ width: plot.width, height: plot.height, locked: plot.locked, requires, targetSize });
  packings.set(cacheKey, packing);
  return packing;
}

/* ------------------------------------------------------------- the ranking */

export type MutationProfit = {
  id: string;
  name: string;
  rarity: string | null;
  size: number;
  /** Cells of the plot the whole arrangement occupies, support and mutations together. */
  cellsUsed: number;
  /** How many of this mutation grow at once in one greenhouse. */
  perPlot: number;
  /** The best arrangement found, and the ceiling it was measured against. */
  packing: Packing | null;
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
  /** Crop fortunes that actually applied to this row, so the figure can be traced. */
  cropsLifted: string[];
  /** Why this row cannot be ranked, when it cannot. */
  problem: string | null;
};

export type ProfitOptions = {
  market: Map<string, ProductSnapshot>;
  npcPrices?: Record<string, NpcPrice>;
  growth: GrowthParams;
  /** Farming Fortune, which lifts every crop. Scales every row identically and reorders nothing. */
  farmingFortune: number;
  /**
   * Crop Fortune, keyed by the crop name the wiki uses — "Wheat", "Cocoa Beans", "Mushroom".
   *
   * Unlike the above, this *does* move the ranking: it applies only to the crop it names, so a
   * mutation dropping wheat and one dropping cocoa beans are lifted by different amounts. Sources
   * are the tool being held, Anita's shop, Carrolyn, and the Overdrive Chip — which grants up to
   * +140 for the active crop but only during a Jacob's Farming Contest, so it is a contest-day
   * figure rather than a standing one.
   */
  cropFortune?: Record<string, number>;
  /** Multiplied on top of fortune: plant yield upgrade, evergreen chips, adjacency buffs. */
  yieldMultiplier?: number;
  plots?: number;
  /** The greenhouse to lay out on. Defaults to a fully unlocked 10x10. */
  plot?: PlotShape;
  /** Prebuilt by , so ranking forty rows does not rebuild it forty times. */
  cropFortuneIndex?: Map<string, string>;
};

/**
 * The expected yield multiplier for one crop, at one player's fortune.
 *
 * Fortune is not one number. Farming Fortune lifts every crop; the thirteen Crop Fortunes lift one
 * crop each, and the Crop Fortune page is explicit about how they meet — "their farming fortune is
 * first added to their Crop Fortune stat corresponding to the crop they are breaking". So the
 * figure that matters is a *sum*, and it differs from drop to drop.
 *
 * That is the whole reason this takes a crop id rather than a single number. A mutation dropping
 * Wheat and one dropping Cocoa Beans see different multipliers from the same player, so crop
 * fortune is the one kind of fortune that can change which mutation is best — where general
 * Farming Fortune scales every row identically and cannot.
 *
 * The mechanic underneath is a lottery: each point is a 1% chance of 100% more, and every whole
 * hundred is a guaranteed 100% more. The wiki's worked example is Cactus Fortune 233 giving 300%
 * drops with a 33% chance of 400%. Averaged, that is `1 + fortune / 100`, which is what this
 * returns — an expectation, so a single harvest will land above or below it.
 *
 * Flagged: the wiki's Farming Fortune page carries an `{{Outdated}}` banner saying it has not
 * caught up with the Greenhouse update, so this is the documented formula rather than a
 * re-measured one, and it is the piece of this model most likely to be wrong.
 */
export function fortuneMultiplier(farmingFortune: number, cropFortune = 0): number {
  return 1 + Math.max(0, farmingFortune + cropFortune) / 100;
}

/** Which crop fortune, if any, lifts a given drop. Built once per data set. */
export function cropFortuneIndex(data: GreenhouseData): Map<string, string> {
  const index = new Map<string, string>();
  for (const entry of data.cropFortunes ?? []) for (const id of entry.ids) index.set(id, entry.crop);
  return index;
}

export function profitOf(m: Mutation, byId: Map<string, Mutation>, data: GreenhouseData, o: ProfitOptions): MutationProfit {
  const npcPrices = o.npcPrices ?? {};
  const yieldBuffs = o.yieldMultiplier ?? 1;
  const fortuneByCrop = o.cropFortuneIndex ?? cropFortuneIndex(data);

  // Per drop, not per mutation: each one carries its own crop fortune on top of the general one,
  // so a mutation dropping two different crops is lifted by two different amounts.
  let revenue = 0;
  const unpriced: string[] = [];
  const cropsLifted: string[] = [];
  for (const drop of m.drops) {
    const price = unitPrice(drop.id, o.market, npcPrices);
    if (price === null) {
      unpriced.push(drop.name);
      continue;
    }
    const crop = fortuneByCrop.get(drop.id);
    const extra = crop ? (o.cropFortune?.[crop] ?? 0) : 0;
    if (crop && extra > 0) cropsLifted.push(crop);
    revenue += price * drop.amount * fortuneMultiplier(o.farmingFortune, extra) * yieldBuffs;
  }

  // An Ethereal Vine on harvest, at odds that rise with rarity. It is the only way to enlarge the
  // greenhouse and it trades on the bazaar, so it is real income rather than a curiosity.
  const vineChance = data.etherealVineByRarity[(m.rarity ?? "").toLowerCase()] ?? 0;
  const vinePrice = unitPrice("ETHEREAL_VINE", o.market, npcPrices) ?? 0;
  const vineRevenue = vineChance * vinePrice;

  const stages = stagesPerHarvest(m);
  const hoursPerStage = stageSeconds(data, o.growth) / 3600;
  const hoursPerHarvest = stages === null ? null : stages * hoursPerStage;

  const setup = setupFor(m, byId, o.market, npcPrices, o.plot ?? FULL_PLOT);
  const plots = o.plots ?? 1;

  // How many grow at once, which is the figure the whole ranking turns on. A mutation paying twice
  // as much per harvest is still the worse row if half as many fit.
  const perPlot = setup?.packing.targets ?? 0;
  const cellsUsed = (setup?.packing.cells.reduce((a, b) => a + b, 0) ?? 0) + perPlot * m.size * m.size;

  const total = (revenue + vineRevenue) * perPlot;
  const problem =
    m.spreading.prose
      ? `Needs a special act rather than a roll: ${m.spreading.raw}`
      : perPlot <= 0
        ? "No arrangement of this plot feeds even one of these."
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
    perPlot,
    packing: setup?.packing ?? null,
    stagesPerHarvest: stages,
    hoursPerHarvest,
    revenue,
    vineRevenue,
    setup,
    coinsPerHour: problem || hoursPerHarvest === null || hoursPerHarvest <= 0 ? null : (total / hoursPerHarvest) * plots,
    coinsPerDay: problem || hoursPerHarvest === null || hoursPerHarvest <= 0 ? null : (total / hoursPerHarvest) * 24 * plots,
    hoursPerStage,
    unpriced,
    cropsLifted: [...new Set(cropsLifted)],
    problem,
  };
}

/** Every mutation, best first. Rows that cannot be ranked sort last but are never dropped. */
export function rankMutations(data: GreenhouseData, o: ProfitOptions): MutationProfit[] {
  const byId = new Map(data.mutations.map((m) => [m.id, m]));
  const index = o.cropFortuneIndex ?? cropFortuneIndex(data);
  return data.mutations
    .map((m) => profitOf(m, byId, data, { ...o, cropFortuneIndex: index }))
    .sort((a, b) => (b.coinsPerHour ?? -1) - (a.coinsPerHour ?? -1));
}
