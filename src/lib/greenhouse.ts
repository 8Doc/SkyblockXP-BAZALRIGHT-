import { NET_OF_TAX } from "./bazaar";
import { packGreenhouse, type Packing } from "./greenhouseLayout";
import type { ProductSnapshot } from "./bazaarTypes";
import type { NpcPrice } from "./bazaarViews";

/**
 * Which Greenhouse mutation is worth growing.
 *
 * A mutation is an AFK trade with three costs and three revenues, and the ranking turns on the
 * parts nobody quotes. The costs are *time* — how many growth stages before it spawns, and how many
 * more before it can be harvested — and *space*, because the plants that spread it occupy the ring
 * around it and have to be bought.
 *
 * The revenue has three parts and they behave differently enough that the tab shows them apart.
 * The **crops** are the wiki's drop table, thousands at a time, and fortune multiplies them. The
 * **mutation itself** is one item per harvest — the wiki's drop table does not mention it, but 39
 * of the 40 trade on the bazaar and harvesting is the only way anyone gets one, so it drops. That
 * one is not a rounding error: a Snoozling's crops are ordinary and the Snoozling asks millions,
 * so pricing only the crops ranks the page on the smaller half of the income for exactly the
 * mutations where the item is the point. The **Ethereal Vine** is a chance on top.
 *
 * The setup is a *one-off* and the income repeats, so the two are never added. Coins an hour and
 * coins a day are gross; the bill comes off the first day and off no other, and payback time is
 * what puts the two in the same unit.
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
  /** What is written down anywhere about how fast plants rot. See `data/curated`. */
  decay?: DecayData;
  mutations: Mutation[];
};

/**
 * How long a plant lasts before it becomes a Dead Plant.
 *
 * The rule the whole setup cost hangs on, and it changed on 2026-08-20: base crops now rot too.
 * Hypixel's own designer note says why — before it, a ring of plain crops stood forever and a
 * greenhouse was set-and-forget. It is not any more, so the ring is a *recurring* cost and the
 * question worth asking of a mutation is how many harvests one planting buys.
 *
 * Almost none of it is published. `Dead Plant` states the mechanic and the floor, two changelogs
 * give base crops and Noctilume, three pages say their plant never rots, and everything else is
 * readable only from the in-game Plant Diagnostics Tool. So the unknown ones are pinned to the
 * floor and the answer is reported as a guaranteed minimum — see `setupLifeHours`.
 */
export type DecayData = {
  /** 72, from the changelog that added it. */
  baseCropHours: number;
  /** 72 again: `Dead Plant` says the shortest mutation timer is three days. */
  floorHours: number;
  /** Timers actually written down. Noctilume is the only one. */
  knownHours: Record<string, number>;
  /** Plants that never rot at all. */
  neverDecays: string[];
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
 * How long one planting of the ring stands before it has to be redone.
 *
 * The ring dies with its shortest-lived plant: one dead cell means the condition is no longer met
 * and nothing spawns in that spot again, so the whole arrangement is only as durable as its
 * weakest member. That is what turns setup from a one-off into a recurring cost, and it is the
 * figure the "per setup" answer divides by.
 *
 * `exact` is the part that matters for honesty. A base crop is 72 hours and Noctilume is 144, both
 * stated in changelogs; every other mutation has a timer nobody has written down, known only to be
 * at least three days. Those are pinned to the floor, which makes the result a **guaranteed
 * minimum** — the real lifetime can be longer and can never be shorter — and `exact` false is what
 * tells the caller to say so rather than presenting a bound as a measurement.
 *
 * Returns null lifetime for a ring that genuinely never rots, which is a real case: All-in Aloe,
 * Magic Jellybean and Fleshtrap stand forever, so a ring built only from those is planted once.
 */
export type SetupLife = { hours: number | null; exact: boolean };

export function setupLifeHours(items: { id: string; free?: boolean }[], byId: Map<string, Mutation>, decay?: DecayData): SetupLife {
  if (!decay) return { hours: null, exact: false };

  let shortest = Infinity;
  let exact = true;
  for (const item of items) {
    // Fire and Dead Plant are conditions rather than plants — a Dead Plant is what decay produces,
    // so it cannot rot further, and neither costs anything to renew.
    if (item.free) continue;
    if (decay.neverDecays.includes(item.id)) continue;

    const known = decay.knownHours[item.id];
    if (typeof known === "number") {
      shortest = Math.min(shortest, known);
      continue;
    }
    // A base crop's 72 hours is stated outright. An unlisted mutation is only known to be at least
    // three days, which is the same number — so the arithmetic is identical and only the claim
    // changes: one is a measurement, the other a floor.
    if (byId.has(item.id)) exact = false;
    shortest = Math.min(shortest, byId.has(item.id) ? decay.floorHours : decay.baseCropHours);
  }

  return shortest === Infinity ? { hours: null, exact: true } : { hours: shortest, exact };
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

/**
 * One drop of one mutation, priced — the line the breakdown is built from.
 *
 * There are three kinds and they behave differently. **Crops** are what the wiki's drop table
 * lists, they come in thousands, and fortune multiplies them. **The mutation itself** is one item
 * per harvest, fortune does not touch it, and the wiki's table does not mention it at all — but 39
 * of the 40 trade on the bazaar and harvesting is the only way anyone gets one, which is the
 * evidence that it drops. **The Ethereal Vine** is a chance rather than a certainty.
 *
 * Keeping them apart matters because they rank differently: a mutation whose crops are worth little
 * can still be the best row on the page if the item itself sells for millions, and the reverse is
 * just as common. Snoozling's own item is worth more than most mutations' entire crop haul.
 */
export type DropRevenue = {
  id: string;
  name: string;
  /** What the wiki says one harvest drops, before any fortune. */
  amount: number;
  /** What one sells for, taxed. Null when nothing is bidding. */
  each: number | null;
  /** The crop fortune that lifts this drop, when the player entered one. */
  crop: string | null;
  /** 1 + (farming + crop)/100, times any yield buffs — what fortune actually multiplied by. */
  multiplier: number;
  /** Coins this drop is worth in one harvest of one mutation. */
  coins: number;
};

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
  /** Coins one harvest brings in, after tax, at the given fortune. Crops, the item, and the vine. */
  revenue: number;
  /** The crop half of that, split by drop, so the total can be traced to what it came from. */
  drops: DropRevenue[];
  /** The mutation's own item, one per harvest. Null when nothing on the bazaar is bidding on it. */
  self: DropRevenue | null;
  /** Ethereal Vines are a second revenue stream and scale with rarity. */
  vineRevenue: number;
  /** How many greenhouses these figures cover. Setup is paid per greenhouse. */
  plots: number;
  /** Coins every mutation in every plot brings in, one harvest — the gross figure per cycle. */
  perHarvest: number;
  /** How many times that lands in a day. */
  harvestsPerDay: number | null;
  setup: Setup | null;
  /** The whole bill across every plot, which is the one-off `setup.coins` times `plots`. */
  setupTotal: number | null;
  coinsPerHour: number | null;
  coinsPerDay: number | null;
  /**
   * The first day's take with the ring paid for, which is where a mutation with an expensive setup
   * looks different from one without.
   */
  netFirstDay: number | null;
  /** Hours of being left alone before the setup has paid for itself. */
  paybackHours: number | null;
  /** How long one planting stands before the ring rots, and whether that is stated or a floor. */
  setupLife: SetupLife;
  /**
   * Harvests one planting yields before the ring has to be replaced.
   *
   * The figure the whole "is this worth it" question turns on, and the one a coins-per-day number
   * hides completely. A Devourer at 35 hours a harvest against a 72-hour ring gets **two**, so its
   * enormous setup is paid off twice and then paid again. Null where the ring never rots.
   */
  harvestsPerSetup: number | null;
  /** What one planting nets: everything it yields over its life, less what it cost to plant. */
  netPerSetup: number | null;
  /**
   * The honest daily rate once replanting is counted — gross a day, less the setup spread across
   * the days it survives. This is what `coinsPerDay` would be if the ring were free, and is not.
   */
  sustainedPerDay: number | null;
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
  const drops: DropRevenue[] = [];
  for (const drop of m.drops) {
    const price = unitPrice(drop.id, o.market, npcPrices);
    const crop = fortuneByCrop.get(drop.id) ?? null;
    const extra = crop ? (o.cropFortune?.[crop] ?? 0) : 0;
    const multiplier = fortuneMultiplier(o.farmingFortune, extra) * yieldBuffs;
    if (price === null) {
      unpriced.push(drop.name);
      drops.push({ id: drop.id, name: drop.name, amount: drop.amount, each: null, crop, multiplier, coins: 0 });
      continue;
    }
    if (crop && extra > 0) cropsLifted.push(crop);
    const coins = price * drop.amount * multiplier;
    revenue += coins;
    drops.push({ id: drop.id, name: drop.name, amount: drop.amount, each: price, crop, multiplier, coins });
  }

  // The mutation itself, one per harvest. The wiki's drop table does not list it — the evidence is
  // that 39 of the 40 have a bazaar entry with a live book and there is no other way to obtain one.
  // Fortune is deliberately not applied: it multiplies crop drops, and this is a single item.
  //
  // It is not a footnote. Snoozling's crops are ordinary and its item asks millions, so leaving it
  // out ranks the whole page on the smaller half of the income for exactly the mutations where the
  // item is the point.
  const selfPrice = unitPrice(m.id, o.market, npcPrices);
  const self: DropRevenue | null =
    selfPrice === null ? null : { id: m.id, name: m.name, amount: 1, each: selfPrice, crop: null, multiplier: 1, coins: selfPrice };
  if (self) revenue += self.coins;
  else unpriced.push(`${m.name} itself`);

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
  // The bill is per greenhouse — three plots is three rings to buy — where the takings are already
  // multiplied by the same three. Quoting a one-plot setup beside a three-plot income would flatter
  // exactly the mutations with the most expensive rings, which are the ones the figure is for.
  const setupTotal = setup?.coins === null || setup === null ? null : setup.coins * plots;
  const problem =
    m.spreading.prose
      ? `Needs a special act rather than a roll: ${m.spreading.raw}`
      : perPlot <= 0
        ? "No arrangement of this plot feeds even one of these."
        : stages === null
        ? "The wiki publishes no spawn chance for this one, so there is no cycle time to divide by."
        : revenue <= 0 && unpriced.length > 0
          ? `Nothing is bidding on ${unpriced.join(", ")}.`
          : null;

  const rankable = !problem && hoursPerHarvest !== null && hoursPerHarvest > 0;
  const coinsPerHour = rankable ? (total / hoursPerHarvest!) * plots : null;
  const coinsPerDay = coinsPerHour === null ? null : coinsPerHour * 24;

  // How many harvests one planting is actually worth. Floored, because half a harvest is no
  // harvest — the ring rots on its own schedule and a mutation half-grown when it dies is lost.
  const setupLife: SetupLife = setup ? setupLifeHours(setup.items, byId, data.decay) : { hours: null, exact: false };
  const harvestsPerSetup =
    !rankable || setupLife.hours === null ? null : Math.floor(setupLife.hours / hoursPerHarvest!);
  const perHarvestAll = total * plots;
  const netPerSetup =
    harvestsPerSetup === null || setupTotal === null ? null : harvestsPerSetup * perHarvestAll - setupTotal;
  const sustainedPerDay =
    coinsPerDay === null || setupTotal === null || setupLife.hours === null || setupLife.hours <= 0
      ? coinsPerDay
      : coinsPerDay - setupTotal / (setupLife.hours / 24);

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
    drops,
    self,
    vineRevenue,
    plots,
    perHarvest: total * plots,
    harvestsPerDay: hoursPerHarvest === null || hoursPerHarvest <= 0 ? null : 24 / hoursPerHarvest,
    setup,
    setupTotal,
    coinsPerHour,
    coinsPerDay,
    // A one-off against a repeating income, so it belongs to the first day and to no other. Left
    // as one figure it reads like a running cost and understates everything with a big ring.
    netFirstDay: coinsPerDay === null || setupTotal === null ? null : coinsPerDay - setupTotal,
    paybackHours: coinsPerHour === null || coinsPerHour <= 0 || setupTotal === null ? null : setupTotal / coinsPerHour,
    setupLife,
    harvestsPerSetup,
    netPerSetup,
    sustainedPerDay,
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
