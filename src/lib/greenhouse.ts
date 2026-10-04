import { NET_OF_TAX } from "./bazaar";
import { packGreenhouse, type Packing } from "./greenhouseLayout";
import {
  effectsAtTargets,
  effectsOf,
  inForce,
  rollsBounty,
  sharedEffects,
  yieldModifier,
  type CropEffect,
} from "./greenhouseEffects";
import { fullRingMaximum, isCapped, optimise, type Optimised } from "./greenhouseOptimise";
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
  water: WaterData;
  /**
   * How much the yield buffs are worth. The adjacency pair — Harvest Boost and its improved form —
   * is applied per mutation from what is planted beside it; the rest are player stats and live in
   * `yieldMultiplierOf`.
   */
  yieldBuffs?: {
    plantYieldUpgrade?: [number, number];
    evergreenChip?: [number, number];
    harvestBoost?: number;
    improvedHarvestBoost?: number;
    harvestLoss?: number;
    xpBoost?: number;
    improvedXpBoost?: number;
    xpLoss?: number;
    perUniqueCrop?: number;
    allTwelveUnique?: number;
  };
  /** The extra loot pool a Bonus Drops neighbour unlocks, from the Greenhouse page. */
  harvestBounty?: { id: string; chance: number }[];
  /** Rare Crops that drop per plant harvested, and the stat that scales them. See `data/curated`. */
  rareCrops?: RareCropData;
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
  /** What it grows on — Farmland, Soul Sand, Sand, End Stone, Mycelium. Scraped, never inferred from. */
  surface: string | null;
  growthStages: number | null;
  /**
   * Whether it has to be watered while it grows.
   *
   * Scraped from each item page's own sentence for the 29 that grow, and false by construction for
   * the 11 that do not: those appear the moment their condition is met and are harvested on sight,
   * so there is no growing phase and nothing to water — which is what their pages say by saying
   * nothing, and what Skymutations lists for them.
   *
   * Optional only as a guard. If the wiki's sentence ever changes shape, a mutation that grows will
   * come back unset rather than quietly reading as dry, and the scrape warns.
   */
  needsWater?: boolean;
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
  /**
   * Unique non-mutated crops growing in any plot. Twelve is the documented maximum.
   *
   * Null means "count them from the ring", which is the right default and twelve was not. The bonus
   * is for *non-mutated* crops, and a greenhouse given over to one mutation grows whatever base
   * crops that mutation's ring happens to contain — none at all for Phantomleaf, whose ring is
   * Chorus Fruit and Shellfruit. Defaulting to twelve credited every such row with +36% yield and
   * +30% growth speed it does not get, and a real harvest showed it: crops came in at ×1.73 on top
   * of fortune where the model said ×2.16. A typed number still wins, for anyone who grows a corner
   * of base crops on purpose to collect the bonus.
   */
  uniqueCrops: number | null;
  /** The Crop Growth stat, 0-210. */
  cropGrowth: number;
  /** The Greenhouse Speed attribute, 0-10. */
  speedAttribute: number;
  /** The Growth Speed garden upgrade, 0-9. Tier 9 is worth double tier 8. */
  growthSpeedUpgrade: number;
  /** The Plant Yield greenhouse upgrade, 0-9. Tier 9 is worth double tier 8, as above. */
  plantYieldUpgrade?: number;
  /** The Evergreen Chip's yield bonus as a percentage, 0-60. Absent or 0 for no chip. */
  evergreenChip?: number;
};

/**
 * Everything that multiplies the *base crops* a harvest gives, before fortune touches them.
 *
 * A second, separate lever from fortune, and the Greenhouse page keeps them apart deliberately:
 * "In addition to Farming Fortune, the base crops given when harvesting crops in the Greenhouse are
 * also affected by various Yield buffs". Three of the four are things this model already had the
 * inputs for and was not spending:
 *
 * **Plant Yield upgrade**, +2% a tier to +20% at nine. The step at the last tier is the same shape
 * as Growth Speed's — eight tiers of two, then four rather than two — which is worth stating
 * because the pattern would otherwise give 18%, and the tooltip on the page says 20%.
 *
 * **The unique crop bonus**, +3% a unique non-mutated crop, +36% with all twelve. The same twelve
 * crops already drive the growth-speed term, so this was an input the page had and did not use.
 *
 * **The Evergreen Chip**, +2% to +60%.
 *
 * Summed rather than compounded. The wiki lists them in one table of "Yield buffs" without a word
 * about how they combine, and additive is how SkyBlock's percentage buffs of this kind behave; the
 * two readings differ by about six percent at the top end, which is smaller than the uncertainty in
 * the fortune formula sitting next to it. Adjacency buffs — Harvest Boost and its improved form —
 * are deliberately not here: they depend on what is planted beside what, which is a layout question
 * the caller answers, not a player stat.
 */
export function yieldMultiplierOf(p: GrowthParams): number {
  const tier = Math.max(0, Math.min(9, p.plantYieldUpgrade ?? 0));
  const plantYield = tier >= 9 ? 0.2 : 0.02 * tier;
  const unique = 0.03 * Math.max(0, Math.min(12, p.uniqueCrops ?? 0));
  const chip = Math.max(0, Math.min(60, p.evergreenChip ?? 0)) / 100;
  return 1 + plantYield + unique + chip;
}

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
/**
 * How many distinct base crops a mutation's own ring grows — the unique-crop count you get from
 * planting it and nothing else.
 *
 * Only crops on the base-crop table count. Mutations do not ("non-mutated" is the page's word), and
 * neither do the free requirements like Fire, which are not plants at all.
 */
export function uniqueBaseCrops(m: Mutation, data: GreenhouseData): number {
  const base = new Set((data.baseCrops ?? []).map((c) => c.id));
  const planted = m.spreading.requires
    .filter((r) => !r.free)
    .map((r) => PLANTED_AS[r.id] ?? r.id)
    .filter((id) => base.has(id));
  return new Set(planted).size;
}

/**
 * Where a ring names the planted block and the crop table names the item it drops.
 *
 * One case in the whole table: melon is planted as `BUILDER_MELON` and harvested as `MELON`, the
 * slice. Matching on the raw id dropped melon from every ring that grows it, so Gloomgourd's
 * Pumpkin-and-Melon ring counted one unique crop instead of two.
 */
const PLANTED_AS: Record<string, string> = { BUILDER_MELON: "MELON" };

export function stageSeconds(data: GreenhouseData, p: GrowthParams): number {
  const upgrade = p.growthSpeedUpgrade >= 9 ? 0.5 : 0.05 * Math.max(0, p.growthSpeedUpgrade);
  const speedup = 1 + 0.025 * Math.max(0, Math.min(12, p.uniqueCrops ?? 0)) + 0.0025 * p.cropGrowth + 0.005 * p.speedAttribute + upgrade;
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

/* ------------------------------------------------------------------ water */

/**
 * What a plant loses to thirst in one growth stage, and how the ring around it changes that.
 *
 * **The rate is not the wiki's.** The Greenhouse page says a crop "loses between 2-3 Water Level"
 * after each stage, and against the -100 floor that works out at eighty stages — most of a week —
 * which would mean nothing in a greenhouse ever needs watering. Two independent sources put it near
 * twenty, and they agree with each other: NamuWiki measures "nearly a full day" for the whole 200,
 * and a forums thread quotes twenty a cycle at roughly two hours a cycle, which is that same day.
 * The likely reading is that 2-3 describes the sixteen-bar meter moving rather than the integer
 * underneath. See `data/curated/greenhouse_water.json` for both numbers and the sources.
 *
 * **The unit is a growth stage, not an hour**, and two things fall out of that which a timer would
 * get wrong. A fully grown plant has no stages left to advance through, so it stops losing water
 * entirely and what ends it after that is decay, on its own separate clock. And growth speed buys
 * no survival at all — the same five stages simply arrive sooner, which is exactly why players find
 * that speeding a greenhouse up makes it harder to keep alive.
 *
 * **A mutation spawns at 0**, not full, so it has 100 to spend rather than 200: five stages bare.
 */
export function waterLossPerStage(data: GreenhouseData): number {
  return data.water.lossPerStage ?? data.water.lossPerStageMax ?? 3;
}

/** Water a fresh plant has to spend before it dies: 0 down to -100. */
export function waterBudget(data: GreenhouseData): number {
  return (data.water.spawnsAt ?? 0) - (data.water.deathAt ?? -100);
}

/**
 * The net effect on one plant of everything standing beside it.
 *
 * **Present or absent, never counted.** In game a crop shows a list of the effects on it, ticked or
 * not — two neighbours granting Water Retain is the same tick as one, not twice the buff. This was
 * modelled as a sum at first, which quietly turned every second retaining neighbour into a plant
 * that never dries out; the effects are flags and this reads them as flags.
 *
 * It also used to read its own effects, one per plant, returning on the first match — so Shellfruit,
 * which retains water *and* grants immunity, was granting only the water. It now shares the reader
 * in `greenhouseEffects` with everything else that asks what a ring is doing.
 *
 * **Improved overrides plain.** The wiki states this outright for exactly one pair — "Improved
 * Harvest Boost ... Overrides Harvest Boost" — and the buffs are built to one pattern, so the
 * improved retain is taken to replace the plain one rather than add to it. It makes no difference
 * to any mutation on the list today, where no ring carries both, but a guessed sum would.
 *
 * **Immunity cancels the drain.** It "provides Immunity to negative effects", and a Water Drain is
 * one, so a ring holding both comes out at the retain alone.
 */
export function waterModifier(effects: Iterable<CropEffect>, data: GreenhouseData): number {
  const ring = new Set(effects);
  const retain = ring.has("improved-water-retain")
    ? (data.water.improvedRetain ?? 1)
    : ring.has("water-retain")
      ? (data.water.retain ?? 0.5)
      : 0;
  const drained = inForce(ring, "water-drain") ? (data.water.drain ?? -0.3) : 0;
  return retain + drained;
}

/**
 * How many growth stages a plant lasts with no watering, given what its neighbours are doing.
 *
 * `Infinity` when the ring retains everything, which is not a rounding artefact — two Water
 * Retains reaching one plant is +100%, and a plant losing nothing never runs dry however long it
 * grows. That case is most of the reason this is worth modelling at all: it is what makes a
 * Chocoberry ringed with Gloomgourds safe to plant and walk away from, where the same mutation in
 * a bare ring would be dead in five stages.
 */
export function stagesBeforeDrought(data: GreenhouseData, retain = 0): number {
  const loss = waterLossPerStage(data) * Math.max(0, 1 - retain);
  if (loss <= 0) return Infinity;
  return Math.floor(waterBudget(data) / loss);
}

/**
 * The retain reaching each of a mutation's targets, read off the plot it is actually planted in.
 *
 * One figure per target rather than an average, because they differ: a target against the plot edge
 * has fewer neighbours than one in the middle, and on some layouts that is the difference between a
 * mutation that survives and one that does not. The caller decides what to do with the spread.
 */
export function retainAtTargets(m: Mutation, byId: Map<string, Mutation>, packing: Packing, data: GreenhouseData): number[] {
  return effectsAtTargets(m.spreading.requires, (id) => byId.get(id), packing, m.size).map((ring) =>
    waterModifier(ring, data),
  );
}

/**
 * Which of a mutation's required crops are worth seating on its edges rather than its corners.
 *
 * A spreading condition counts ring cells and a ring has corners; a crop effect reaches orthogonal
 * neighbours only. So the cheapest way to satisfy the count is often to put the plant exactly where
 * its effect cannot reach — a corner cell lies in four rings at once, an edge cell in one, so a
 * packer economising on a crop will always drift towards the corners.
 *
 * Asked for only where it changes something: the mutation has to drink, and it has to be one that
 * would not survive on its own. Where the answer is the same either way this returns nothing, and
 * the layout is chosen on price as before — there is no reason to pay for a buff that changes no
 * outcome, and every reason not to disturb a layout that was already the cheapest.
 */
export function seatingFor(m: Mutation, byId: Map<string, Mutation>, data: GreenhouseData): boolean[] | undefined {
  if (m.needsWater !== true) return undefined;
  if ((m.growthStages ?? 0) <= stagesBeforeDrought(data, 0)) return undefined;
  const seat = m.spreading.requires.map((r) => {
    const granted = effectsOf(byId.get(r.id));
    return granted.has("water-retain") || granted.has("improved-water-retain");
  });
  return seat.some(Boolean) ? seat : undefined;
}

/**
 * Whether a plant that would retain water is in the ring but sitting where it cannot reach.
 *
 * The difference between "nothing here retains water" and "the Gloomgourd is on the corner" is the
 * difference between a fact about the mutation and a fact about the arrangement, and only one of
 * them is something a reader can do anything about. Saying the first when the second is true reads
 * like the app has not noticed the Gloomgourd it is drawing three cells away.
 */
export function retainStranded(m: Mutation, byId: Map<string, Mutation>, packing: Packing, data: GreenhouseData): boolean {
  const retainers = new Set(
    m.spreading.requires
      .map((r, i) => [i, effectsOf(byId.get(r.id))] as const)
      .filter(([, granted]) => granted.has("water-retain") || granted.has("improved-water-retain"))
      .map(([i]) => i),
  );
  if (retainers.size === 0) return false;

  const modifiers = retainAtTargets(m, byId, packing, data);
  // Reaching anywhere means it is not stranded; the question is only about the ones it misses.
  if (modifiers.every((value) => value > 0)) return false;

  const grid = packing.grid;
  const height = grid.length;
  const width = height > 0 ? grid[0].length : 0;
  const size = Math.max(1, m.size || 1);
  const claimed = new Uint8Array(width * height);

  let at = 0;
  for (let r = 0; r + size <= height; r++) {
    for (let c = 0; c + size <= width; c++) {
      let whole = true;
      for (let rr = r; rr < r + size && whole; rr++)
        for (let cc = c; cc < c + size && whole; cc++)
          if (grid[rr][cc] !== "target" || claimed[rr * width + cc]) whole = false;
      if (!whole) continue;
      for (let rr = r; rr < r + size; rr++) for (let cc = c; cc < c + size; cc++) claimed[rr * width + cc] = 1;

      const reaches = modifiers[at++] > 0;
      if (reaches) continue;
      // The whole ring this time, corners included — which is what the spreading condition counts.
      for (let rr = r - 1; rr <= r + size; rr++) {
        for (let cc = c - 1; cc <= c + size; cc++) {
          if (rr < 0 || cc < 0 || rr >= height || cc >= width) continue;
          if (rr >= r && rr < r + size && cc >= c && cc < c + size) continue;
          const cell = grid[rr][cc];
          if (typeof cell === "number" && retainers.has(cell)) return true;
        }
      }
    }
  }
  return false;
}

/**
 * Whether you will ever have to pick up a watering can for this one, in this layout.
 *
 * Layout-dependent, which is new and is correct: the answer is a fact about the mutation *and* the
 * ring it is sitting in. Swapping to a cheaper arrangement can take the Gloomgourds off a
 * Chocoberry's sides and turn a plant-and-leave mutation into one that dies in five stages.
 *
 * Yes if *any* of the targets would run dry, because a plot where three of sixteen die is a plot
 * you have to tend.
 */
export function needsWatering(m: Mutation, data: GreenhouseData, retains: number[] = [0]): boolean {
  if (m.needsWater !== true) return false;
  const stages = m.growthStages ?? 0;
  const seen = retains.length > 0 ? retains : [0];
  return seen.some((retain) => stages > stagesBeforeDrought(data, retain));
}

/** The drought arithmetic for one mutation in one plot, summarised for the row. */
function drought(m: Mutation, data: GreenhouseData, retains: number[], stranded: boolean): MutationProfit["drought"] {
  const stages = m.growthStages ?? 0;
  const seen = retains.length > 0 ? retains : [0];
  const lives = seen.map((retain) => stagesBeforeDrought(data, retain));
  return {
    stages,
    survives: { worst: Math.min(...lives), best: Math.max(...lives) },
    retain: { worst: Math.min(...seen), best: Math.max(...seen) },
    safeTargets: lives.filter((n) => stages <= n).length,
    targets: seen.length,
    stranded,
  };
}

/* ------------------------------------------------------------------ money */

/** What one of an item fetches, sold patiently into the bazaar and taxed, or to a shop untaxed. */
/**
 * Whether you are willing to wait for the book to come to you.
 *
 * Two ways to trade a bazaar item and they are not close together on a thin one. Taking the book —
 * an instant sell into the best buy order, an instant buy from the cheapest sell offer — happens
 * now and pays the spread. Placing an order at the other side of the spread costs nothing extra
 * but only fills when somebody crosses it.
 *
 * On a deep book the difference is a rounding error; on a mutation it is the whole answer. A
 * Devourer's ask has sat at a million while its best bid was a single coin, so "what is a Devourer
 * worth" has two answers three million percent apart, and which one is right depends entirely on
 * whether you are prepared to leave a sell offer up.
 *
 * Crops are exempt and always priced as an instant sell: a harvest is tens of thousands of them,
 * their books are deep enough that the spread is noise, and nobody sits on a sell offer for
 * pumpkins. So this governs the mutations, which is where it bites.
 */
export type PriceMode = "instant" | "order";

export function unitPrice(
  id: string,
  market: Map<string, ProductSnapshot>,
  npcPrices: Record<string, NpcPrice>,
  mode: PriceMode = "order",
): number | null {
  const product = market.get(id);
  // Selling instantly means taking the best *buy order* — `instasell`, the bid. Selling patiently
  // means posting an offer at the *ask* — `instabuy` — and waiting for someone to take it. Either
  // way the tax comes off. An item with an empty book has no price rather than a price of zero,
  // which is the rule the rest of this codebase keeps.
  const side = mode === "instant" ? product?.instasell : product?.instabuy;
  const bazaar = side !== undefined && side > 0 ? side * NET_OF_TAX : null;
  const shop = npcPrices[id]?.sell ?? null;
  if (bazaar === null && shop === null) return null;
  // The shopkeeper is always instant and never taxed, so it stays in the running in both modes —
  // for the cheap crops it is often the better of the two.
  return Math.max(bazaar ?? 0, shop ?? 0);
}

/** What one costs to buy, which is the other direction and a different side of the book. */
export function buyPrice(
  id: string,
  market: Map<string, ProductSnapshot>,
  npcPrices: Record<string, NpcPrice>,
  mode: PriceMode = "order",
): number | null {
  const product = market.get(id);
  // Buying instantly means taking the cheapest *sell offer* — `instabuy`, the ask. Buying patiently
  // means posting a buy order at the *bid* — `instasell` — and waiting to be filled.
  const side = mode === "instant" ? product?.instabuy : product?.instasell;
  const bazaar = side !== undefined && side > 0 ? side : null;
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
  mode: PriceMode = "order",
  data?: GreenhouseData,
): Setup | null {
  if (m.spreading.requires.length === 0) return null;

  const requires = m.spreading.requires.map((r) => ({ cells: r.cells, size: byId.get(r.id)?.size ?? 1 }));
  // Priced before the plot is laid out, not after. The arrangement is a choice between layouts
  // that grow the same number of mutations, and which of them is worth building is a question the
  // bill answers — see `weights` on `PackingOptions`.
  const prices = m.spreading.requires.map((r) => (r.free ? 0 : buyPrice(r.id, market, npcPrices, mode)));
  // A crop whose effect only reaches orthogonally has to be seated on the mutation's edge, not just
  // dropped anywhere in its ring — see `seatingFor` for when that is worth asking for.
  const seat = data ? seatingFor(m, byId, data) : undefined;
  const packing = packFor(plot, requires, m.size, weightsFor(prices), seat);

  const items: SetupItem[] = m.spreading.requires.map((r, i) => {
    const grown = byId.has(r.id);
    const each = prices[i];
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

/**
 * A bazaar id as a person would read it. The Harvest Bounty table is scraped as ids alone.
 *
 * Title case over the underscores, which is what every one of these happens to be — "Burrowing
 * Spores", "Overclocker 3000", "Synthesis Garden Chip". Good enough for a line in a breakdown, and
 * it fails visibly rather than silently if the table ever carries something odder.
 */
export function readableItem(id: string): string {
  return id
    .toLowerCase()
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/** One drop that arrives as odds rather than as a quantity: a chance, and what it is worth. */
export type ChanceDrop = {
  id: string;
  name: string;
  /** Per plant harvested, after Overbloom. */
  chance: number;
  each: number;
  /** chance x price — what one harvest of one mutation is worth in this drop on average. */
  coins: number;
};

export type RareCropSet = {
  label: string;
  drops: { id: string; name: string; chance: number; pieces?: number }[];
  source?: string;
};

export type RareCropData = {
  sets: Record<string, RareCropSet>;
  /** Measured against the wiki rates in a real harvest. See the curated file for the evidence. */
  greenhouseMultiplier?: number;
  /** The same, for the Ethereal Vine on top of Overbloom. */
  vineMultiplier?: number;
  defaultSet?: string;
  defaultOverbloom?: number;
  note?: string;
  armourNote?: string;
};

/**
 * What is known about drying out. Scraped figures, overwritten at build time by `curated`.
 *
 * `lossPerStageMin`/`Max` are the wiki's 2-3 and are kept only so the disagreement is visible;
 * `lossPerStage` is the figure actually used. See `data/curated/greenhouse_water.json`.
 */
export type WaterData = {
  lossPerStageMin: number;
  lossPerStageMax: number;
  /** The one in use, from players rather than from the wiki. */
  lossPerStage?: number;
  spawnsAt?: number;
  deathAt?: number;
  maxAt?: number;
  retain?: number;
  improvedRetain?: number;
  drain?: number;
  wikiSaysPerStage?: [number, number];
  note?: string;
};

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
 * Packings are memoised, because the answer depends on the plot, three small integers and the
 * shape of the bill — not on the prices themselves. Sixteen distinct shapes cover all forty
 * mutations, at about forty milliseconds apiece.
 */
const packings = new Map<string, Packing>();

/**
 * The prices, reduced to something a cache key can hold.
 *
 * The packer needs to know which plant it should be sparing with, and that is a question about
 * ratios: four cells of Puffercloud at 758k beside four of Zombud at 3k is the same problem
 * whether or not the book moved half a percent since the last poll. So prices are divided by the
 * dearest and rounded to twentieths, which takes a five per cent move to shift a weight — well
 * outside the noise of a twenty-second repricing, and still fine-grained enough to tell "much
 * dearer" from "about the same".
 *
 * Without it the memo would miss on every poll and re-pack all forty mutations three times a
 * minute, which is the reason the packing was price-free to begin with.
 */
function weightsFor(prices: (number | null)[]): number[] {
  const dearest = Math.max(...prices.map((p) => (p === null || !Number.isFinite(p) ? 0 : p)), 0);
  // Nothing has a price, or everything is free: every arrangement costs the same, so fall back to
  // the plant count rather than inventing a preference.
  if (dearest <= 0) return prices.map(() => 1);
  return prices.map((p) => Math.round(((p === null || !Number.isFinite(p) ? 0 : p) / dearest) * 20) / 20);
}

/**
 * Layouts the expensive search has settled, which stand in for the tile answer wherever they exist.
 *
 * Held apart from the memo above rather than written into it, because the two are not the same kind
 * of thing. The memo is a cache: throwing it away costs forty milliseconds and changes nothing. This
 * is a *result* — a second of searching, asked for by name — and it is the reason a caller can put
 * one here and have every figure on the page pick it up without a single one of them knowing that
 * an optimiser exists.
 */
const optimisedLayouts = new Map<string, Packing>();

/** The identity of a layout question: the plot, the shape of the condition, and the price ranks. */
export function layoutKey(
  plot: PlotShape,
  requires: { cells: number; size: number }[],
  targetSize: number,
  weights: number[],
  seat?: boolean[],
): string {
  const lockedKey = plot.locked && plot.locked.size > 0 ? [...plot.locked].sort().join("|") : "";
  const shape = requires.map((r) => `${r.cells}/${r.size}`).join(",");
  const seating = seat ? seat.map((on) => (on ? "1" : "0")).join("") : "";
  return `${plot.width}x${plot.height}:${lockedKey}:${shape}:${targetSize}:${weights.join("/")}:${seating}`;
}

/**
 * The packing for one mutation, memoised.
 *
 * Keyed on the prices as well as the shape, and that is not an oversight. The tile search uses them
 * to break ties between arrangements that grow the same number, and dropping them so that forty
 * mutations could share seventeen searches was tried and reverted: an unweighted tile is a worse
 * starting point for the exact assignment that follows, and where that assignment runs out of
 * budget the worse start is what survives. It cost 2.7% of the total ring bill to save three
 * seconds of the first render, which is the wrong way round.
 */
function packFor(
  plot: PlotShape,
  requires: { cells: number; size: number }[],
  targetSize: number,
  weights: number[],
  seat?: boolean[],
): Packing {
  const cacheKey = layoutKey(plot, requires, targetSize, weights, seat);
  const found = optimisedLayouts.get(cacheKey) ?? packings.get(cacheKey);
  if (found) return found;

  const packing = packGreenhouse({
    width: plot.width,
    height: plot.height,
    locked: plot.locked,
    requires,
    targetSize,
    weights,
    seat,
  });
  packings.set(cacheKey, packing);
  return packing;
}

/** What state one mutation's layout is in, without doing any of the work to change it. */
export type LayoutState = {
  key: string;
  /** Already the most that can ever grow, from the counting argument. Nothing to search. */
  capped: boolean;
  /** An optimised layout is what the figures on this row are being drawn from. */
  optimised: boolean;
};

function layoutInputs(
  m: Mutation,
  byId: Map<string, Mutation>,
  market: Map<string, ProductSnapshot>,
  npcPrices: Record<string, NpcPrice>,
  plot: PlotShape,
  mode: PriceMode,
  data?: GreenhouseData,
) {
  const requires = m.spreading.requires.map((r) => ({ cells: r.cells, size: byId.get(r.id)?.size ?? 1 }));
  const prices = m.spreading.requires.map((r) => (r.free ? 0 : buyPrice(r.id, market, npcPrices, mode)));
  const weights = weightsFor(prices);
  const seat = data ? seatingFor(m, byId, data) : undefined;
  return { requires, weights, seat, key: layoutKey(plot, requires, m.size, weights, seat) };
}

export function layoutStateOf(
  m: Mutation,
  byId: Map<string, Mutation>,
  market: Map<string, ProductSnapshot>,
  npcPrices: Record<string, NpcPrice>,
  plot: PlotShape = FULL_PLOT,
  mode: PriceMode = "order",
  data?: GreenhouseData,
): LayoutState | null {
  if (m.spreading.requires.length === 0) return null;
  const { requires, weights, seat, key } = layoutInputs(m, byId, market, npcPrices, plot, mode, data);
  const packing = packFor(plot, requires, m.size, weights, seat);
  return {
    key,
    capped: isCapped(requires, m.size) && packing.targets >= fullRingMaximum(m.size, plot.width, plot.height),
    optimised: optimisedLayouts.has(key),
  };
}

/**
 * Run the expensive search for one mutation and keep the answer.
 *
 * Everything downstream reads it through `packFor` from here on, so the caller's only job is to
 * redraw. Returns what changed, so a caller can say whether the wait bought anything.
 */
export function optimiseLayout(
  m: Mutation,
  byId: Map<string, Mutation>,
  market: Map<string, ProductSnapshot>,
  npcPrices: Record<string, NpcPrice>,
  plot: PlotShape = FULL_PLOT,
  mode: PriceMode = "order",
  data?: GreenhouseData,
): Optimised | null {
  if (m.spreading.requires.length === 0) return null;
  const { requires, weights, seat, key } = layoutInputs(m, byId, market, npcPrices, plot, mode, data);
  const result = optimise({
    width: plot.width,
    height: plot.height,
    locked: plot.locked,
    requires,
    targetSize: m.size,
    weights,
    seat,
  });
  // Kept even when it found nothing better, because "searched and there was nothing" is an answer
  // worth remembering — otherwise the button offers the same second of waiting over and over.
  optimisedLayouts.set(key, result.packing);
  return result;
}

/** Layouts already settled, for a caller that wants to remember them across a reload. */
export function settledLayouts(): [string, Packing][] {
  return [...optimisedLayouts.entries()];
}

/** Put back a layout settled in an earlier session. */
export function restoreLayout(key: string, packing: Packing): void {
  optimisedLayouts.set(key, packing);
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
  /** Whether the plant takes water while it grows, as its own page states it. */
  needsWater?: boolean;
  /**
   * Whether you will ever have to pick up a watering can for it, in this layout.
   *
   * Not the same question as `needsWater`, and not a property of the mutation alone: what decides
   * it is how many growth stages it needs against how many its ring lets it keep. See
   * `needsWatering`.
   */
  wateringNeeded: boolean;
  /**
   * The arithmetic behind that answer.
   *
   * `survives` is Infinity where the ring retains everything, which is a real answer and not an
   * overflow — a plant losing nothing never runs dry. `retain` is the spread across the plot's
   * targets, which is not always one number: an edge target has fewer neighbours than a middle one.
   */
  drought: {
    stages: number;
    /** Stages the worst-placed target survives, and the best. */
    survives: { worst: number; best: number };
    retain: { worst: number; best: number };
    /** How many of the plot's targets get through without a drink. */
    safeTargets: number;
    targets: number;
    /**
     * A retaining crop is in the ring, but on a corner where its effect cannot reach.
     *
     * Worth telling apart from a ring with nothing in it: a condition counts ring cells and a crop
     * effect only reaches orthogonal ones, so the two are satisfiable in different places.
     */
    stranded: boolean;
  };
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
  /**
   * Vines expected a harvest, after Overbloom and the measured correction — what the revenue above
   * was priced at. Can exceed one: a measured harvest gave 1.375 a block.
   */
  vineChance: number;
  /**
   * What the ring does to this mutation beyond feeding it.
   *
   * `yieldMultiplier` lifts or cuts the crop drops only: Yield is "the base crops given when
   * harvesting", so the mutation's own item and the vine are untouched by it.
   */
  ring: {
    /** The effects reaching every mutation in the plot, not merely some of them. */
    effects: CropEffect[];
    yieldMultiplier: number;
    /** Whether the ring unlocks the Harvest Bounty roll. */
    bounty: boolean;
  };
  /** The unique-crop count this row was worked out with, and whether it was counted or typed. */
  uniqueCrops: { count: number; counted: boolean };
  /** Rare Crops, which drop per plant harvested rather than per crop. Averaged, not rolled. */
  rareCrops: ChanceDrop[];
  rareRevenue: number;
  /** The Harvest Bounty pool, which only rolls behind a Bonus Drops neighbour. */
  bountyDrops: ChanceDrop[];
  bountyRevenue: number;
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
   * mutation dropping wheat and one dropping cocoa beans are lifted by different amounts.
   *
   * The game shows each crop's fortune as a stat of its own and adds Farming Fortune to it when
   * the crop is broken, so the figure wanted here is the one the game shows, tool and all. It used
   * to be assembled from parts — a tool read off item lore, added on top of whatever was typed —
   * which double-counted the tool for anyone who typed the number they could see, and read the
   * wrong item for anyone carrying a bigger crop line on something else.
   */
  cropFortune?: Record<string, number>;
  /**
   * Crop fortune that applies to one crop at a time, keyed the same way: the Overdrive Chip.
   *
   * Kept apart from `cropFortune` because the chip's +140 lifts the contest's *active* crop and no
   * other. So a mutation dropping wheat and cocoa beans gets it on one of them — whichever it is
   * worth most on — and the other crop comes out at its ordinary rate. Adding it to `cropFortune`
   * would hand it to every drop of a multi-crop mutation at once, which no contest does.
   */
  heldCropFortune?: Record<string, number>;
  /**
   * Which crop the held bonus applies to, or "best" to let each mutation choose.
   *
   * "best" is the honest default: the bonus goes on whichever of the mutation's drops it earns the
   * most on. Naming a crop pins it instead, which is what you want when comparing one contest
   * against another.
   */
  heldCrop?: string | "best" | null;
  /** Multiplied on top of fortune: plant yield upgrade, evergreen chips, adjacency buffs. */
  yieldMultiplier?: number;
  /**
   * The Overbloom stat, which multiplies every Rare Crop chance by `1 + overbloom/100`.
   *
   * A box rather than a lookup. It comes off equipment, reforges, enchantments and pets, none of
   * which the API publishes as a stat — the same shape of problem as Farming Fortune, and the same
   * answer. It also barely moves, so it is worth typing once.
   */
  overbloom?: number;
  /**
   * Which farming set is being worn, which decides *which* Rare Crops can drop at all.
   *
   * Not a difficulty setting. The sets are mutually exclusive and the best one does not drop
   * everything: Cropie needs Tater armour and Squash needs Cropie armour, and both pages say
   * outright that neither drops in the Greenhouse while wearing Fermento or Helianthus.
   */
  rareCropSet?: string;
  plots?: number;
  /**
   * Whether mutations are traded across the spread or by leaving an order up.
   *
   * Governs both directions at once, because that is how anyone actually plays it: someone patient
   * enough to leave a sell offer on the harvest is patient enough to leave a buy order on the ring.
   * Crops ignore it and are always dumped — see the loop in `profitOf`.
   */
  priceMode?: PriceMode;
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

/**
 * The Overdrive Chip: "up to +140 Crop Fortune for the active crop during Jacob's Farming Contest".
 *
 * A toggle rather than a number in the box because it is neither always on nor evenly spread. It
 * applies to *one* crop — whichever the contest is running — so adding it to every crop at once
 * would describe a day that cannot happen, and leaving it out entirely hides the only condition
 * under which one crop pulls far ahead of the rest. Per crop, on a switch, is the shape of the fact.
 */
export const OVERDRIVE_CHIP_FORTUNE = 140;

/**
 * The Garden's Crop Upgrades: +5 Crop Fortune a level, to +45 at level nine.
 *
 * Per crop and permanent, and the profile publishes the levels outright under
 * `garden.crop_upgrade_levels` — so this is one of the few parts of a farming setup that can be
 * read rather than typed.
 */
export const CROP_UPGRADE_FORTUNE_PER_LEVEL = 5;
export const CROP_UPGRADE_MAX_LEVEL = 9;

export function cropUpgradeFortune(level: number): number {
  return CROP_UPGRADE_FORTUNE_PER_LEVEL * Math.max(0, Math.min(CROP_UPGRADE_MAX_LEVEL, Math.floor(level)));
}

/**
 * Resolve whatever a crop is called — an item id, a stat, a display name — to the page's name.
 *
 * Three vocabularies describe the same thirteen crops and none of them agree. The Garden publishes
 * upgrade levels under Hypixel's item ids, which are their own dialect: `CARROT_ITEM`,
 * `POTATO_ITEM`, `INK_SACK:3` for cocoa beans, `NETHER_STALK` for nether wart, `DOUBLE_PLANT` for
 * sunflower. Item lore uses the stat's display name. The page uses the wiki's crop name, which is
 * "Melon Slice" where every other source says "Melon".
 *
 * Matching on a tidied-up key was enough for four of them and silently dropped the rest — which is
 * exactly what the filled and empty boxes showed: Wheat, Pumpkin, Sugar Cane and Cactus read their
 * upgrades, and Carrot, Potato, Cocoa Beans, Mushroom, Nether Wart and Melon did not, because those
 * are the six whose id is not their name.
 *
 * So every id the crop table already carries is a key here, and so is the stat, and so is the name.
 */
export function cropResolver(data: GreenhouseData): (raw: string) => string | null {
  const index = new Map<string, string>();
  const add = (key: string, crop: string) => {
    const clean = key.trim().toLowerCase();
    if (clean && !index.has(clean)) index.set(clean, crop);
  };

  for (const entry of data.cropFortunes ?? []) {
    add(entry.crop, entry.crop);
    add(entry.stat.replace(/\s*Fortune\s*$/i, ""), entry.crop);
    for (const id of entry.ids) {
      add(id, entry.crop);
      // `CARROT_ITEM` also as "carrot item", and `INK_SACK:3` without its damage value.
      add(id.replace(/_/g, " "), entry.crop);
      add(id.split(":")[0], entry.crop);
      add(id.replace(/_ITEM$/i, ""), entry.crop);
    }
  }

  // The Garden's own keys for the two that match no item id it lifts.
  add("mushroom collection", "Mushroom");
  add("mushroom_collection", "Mushroom");
  // Every other source calls it a melon; only the wiki's crop table says "Melon Slice".
  add("melon", "Melon Slice");

  return (raw: string) => index.get(raw.trim().toLowerCase()) ?? null;
}

/** Which crop fortune, if any, lifts a given drop. Built once per data set. */
export function cropFortuneIndex(data: GreenhouseData): Map<string, string> {
  const index = new Map<string, string>();
  for (const entry of data.cropFortunes ?? []) for (const id of entry.ids) index.set(id, entry.crop);
  return index;
}

export function profitOf(m: Mutation, byId: Map<string, Mutation>, data: GreenhouseData, o: ProfitOptions): MutationProfit {
  const npcPrices = o.npcPrices ?? {};
  const fortuneByCrop = o.cropFortuneIndex ?? cropFortuneIndex(data);
  const mode = o.priceMode ?? "order";

  // The plot comes first, because what is planted around a mutation changes what its harvest is
  // worth. Harvest Boost and its improved form lift the crop drops by a fifth or three tenths and
  // Harvest Loss cuts them by a fifth, and which of those reach the mutation is a fact about the
  // layout rather than about the player.
  const setup = setupFor(m, byId, o.market, npcPrices, o.plot ?? FULL_PLOT, mode, data);
  const ringEffects = setup ? effectsAtTargets(m.spreading.requires, (id) => byId.get(id), setup.packing, m.size) : [];
  // Shared rather than averaged: a figure quoted for the plot has to hold for every mutation in it,
  // and an effect only some of them see would flatter the rest.
  const shared = sharedEffects(ringEffects);
  const ringYield = yieldModifier(shared, data.yieldBuffs ?? {});
  // The unique-crop count belongs to the row, not the page: it is whatever this ring grows unless
  // the player has said otherwise. It moves the yield and the stage time together.
  const uniqueCrops = o.growth.uniqueCrops ?? uniqueBaseCrops(m, data);
  const growth: GrowthParams = { ...o.growth, uniqueCrops };
  const yieldBuffs = (o.yieldMultiplier ?? yieldMultiplierOf(growth)) * ringYield;

  // Per drop, not per mutation: each one carries its own crop fortune on top of the general one,
  // so a mutation dropping two different crops is lifted by two different amounts.
  let revenue = 0;
  const unpriced: string[] = [];
  const cropsLifted: string[] = [];
  const drops: DropRevenue[] = [];

  /**
   * The one crop this harvest is set up for — you can hold one tool.
   *
   * On "best", worked out per mutation rather than fixed, by asking which of *this* mutation's
   * drops the held bonus is worth most coins on. That is the choice a person makes standing in
   * front of it: the bonus goes on whichever drop it earns the most from, not on whichever crop
   * happens to have the largest fortune number attached.
   */
  const held = o.heldCropFortune ?? {};
  let heldCrop: string | null = null;
  if (o.heldCrop === "best") {
    let bestGain = 0;
    for (const drop of m.drops) {
      const crop = fortuneByCrop.get(drop.id) ?? null;
      const bonus = crop ? (held[crop] ?? 0) : 0;
      if (bonus <= 0) continue;
      const price = unitPrice(drop.id, o.market, npcPrices, "instant") ?? 0;
      // What the bonus is worth here: the extra multiplier it buys, times what this drop sells for.
      const gain = price * drop.amount * (bonus / 100) * yieldBuffs;
      if (gain > bestGain) {
        bestGain = gain;
        heldCrop = crop;
      }
    }
  } else if (o.heldCrop) {
    heldCrop = o.heldCrop;
  }

  for (const drop of m.drops) {
    // Crops are always dumped into the book, whatever the toggle says. A harvest is tens of
    // thousands of them, their books are deep enough that the spread is noise, and nobody leaves a
    // sell offer up for pumpkins. The toggle exists for the mutations, where the spread is the
    // whole story.
    const price = unitPrice(drop.id, o.market, npcPrices, "instant");
    const crop = fortuneByCrop.get(drop.id) ?? null;
    // Passive fortune on every drop; the held bonus on the one crop the tool is out for.
    const passive = crop ? (o.cropFortune?.[crop] ?? 0) : 0;
    const extra = passive + (crop && crop === heldCrop ? (held[crop] ?? 0) : 0);
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
  const selfPrice = unitPrice(m.id, o.market, npcPrices, mode);
  const self: DropRevenue | null =
    selfPrice === null ? null : { id: m.id, name: m.name, amount: 1, each: selfPrice, crop: null, multiplier: 1, coins: selfPrice };
  if (self) revenue += self.coins;
  else unpriced.push(`${m.name} itself`);

  // An Ethereal Vine on harvest, at odds that rise with rarity. It is the only way to enlarge the
  // greenhouse and it trades on the bazaar, so it is real income rather than a curiosity.
  // Overbloom lifts it, because an Ethereal Vine is a Rare Crop — the wiki lists it as one, and
  // Overbloom "increases chances of dropping Rare Crops". Even then it runs short: a measured
  // harvest of 48 Legendary blocks at 140 Overbloom gave 66 vines, 1.375 a harvest, where the
  // wiki's 40% with Overbloom gives 0.96. So it is calibrated on top — see `vineMultiplier` in the
  // curated rare-crop file — and not capped at one, since that harvest gave more than one a block.
  // It is an expected count per harvest, not a probability.
  const bloomed = 1 + Math.max(0, o.overbloom ?? data.rareCrops?.defaultOverbloom ?? 0) / 100;
  const vineChance =
    (data.etherealVineByRarity[(m.rarity ?? "").toLowerCase()] ?? 0) * bloomed * (data.rareCrops?.vineMultiplier ?? 1);
  // The vine follows the toggle for the same reason a mutation does: a thin book where the two
  // sides are far apart, and one you would plausibly leave an offer up for.
  const vinePrice = unitPrice("ETHEREAL_VINE", o.market, npcPrices, mode) ?? 0;
  const vineRevenue = vineChance * vinePrice;

  /**
   * Rare Crops, which are a different kind of income from everything above.
   *
   * They do not come off the drop table and they do not scale with fortune. Every page says the
   * same thing: a flat chance per "crop or mutation with a Harvestable status" broken, whatever
   * that plant happens to be, multiplied by `1 + Overbloom/100`.
   *
   * Which ones can drop at all is decided by the armour, and the sets are mutually exclusive in a
   * way that is easy to get backwards. The best set is not a superset: Cropie needs Tater armour
   * and Squash needs Cropie armour, and both pages state under Bugs that neither drops in the
   * Greenhouse while wearing Fermento or Helianthus. So a maxed farmer gets Fermento and
   * Helianthus and neither of the other two.
   *
   * Counted per mutation harvested. The ring's own base crops are harvestable too and would each
   * roll again, which is not counted here because the ring is modelled as a cost rather than a
   * crop — so this is a floor on the rare-crop income, not an estimate of it.
   */
  const bloom = bloomed;
  // The wiki's per-plant rates run several times short in the Greenhouse; see
  // `greenhouseMultiplier` in data/curated/greenhouse_rare_crops.json for the harvest that showed it.
  const calibrated = data.rareCrops?.greenhouseMultiplier ?? 1;
  const setName = o.rareCropSet ?? data.rareCrops?.defaultSet ?? "helianthus";
  const rareCrops: ChanceDrop[] = [];
  let rareRevenue = 0;
  for (const drop of data.rareCrops?.sets?.[setName]?.drops ?? []) {
    const each = unitPrice(drop.id, o.market, npcPrices, mode);
    if (each === null) continue;
    const chance = drop.chance * bloom * calibrated;
    const coins = chance * each;
    rareRevenue += coins;
    rareCrops.push({ id: drop.id, name: drop.name, chance, each, coins });
  }

  /**
   * The Harvest Bounty pool, which is not free income either.
   *
   * "Harvesting crops with the Bonus Drops effect in the Greenhouse rolls for Harvest Bounty" —
   * so it is worth whatever the ring makes it worth, and nothing at all on a ring with no Bonus
   * Drops in it. Eight mutations grant the effect, which makes it a reason to plant one.
   *
   * Overbloom is deliberately not applied. Some of this pool are Rare Crops and would scale, and
   * nothing anywhere states that the bounty roll is one — so it is left alone rather than lifted
   * on a guess, and the omission only ever understates.
   */
  const bounty = rollsBounty(shared);
  const bountyDrops: ChanceDrop[] = [];
  let bountyRevenue = 0;
  if (bounty) {
    for (const drop of data.harvestBounty ?? []) {
      const each = unitPrice(drop.id, o.market, npcPrices, mode);
      if (each === null) continue;
      const coins = drop.chance * each;
      bountyRevenue += coins;
      bountyDrops.push({ id: drop.id, name: readableItem(drop.id), chance: drop.chance, each, coins });
    }
  }

  const stages = stagesPerHarvest(m);
  const hoursPerStage = stageSeconds(data, growth) / 3600;
  const hoursPerHarvest = stages === null ? null : stages * hoursPerStage;

  const plots = o.plots ?? 1;

  // How many grow at once, which is the figure the whole ranking turns on. A mutation paying twice
  // as much per harvest is still the worse row if half as many fit.
  const perPlot = setup?.packing.targets ?? 0;

  // Watering is a fact about the mutation and the ring together, so it is read off the plot that
  // was actually laid out rather than from the mutation alone. A bare ring is the fallback.
  const retains = setup ? retainAtTargets(m, byId, setup.packing, data) : [];
  const cellsUsed = (setup?.packing.cells.reduce((a, b) => a + b, 0) ?? 0) + perPlot * m.size * m.size;

  const total = (revenue + vineRevenue + rareRevenue + bountyRevenue) * perPlot;
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
    needsWater: m.needsWater,
    wateringNeeded: needsWatering(m, data, retains),
    drought: drought(m, data, retains, setup ? retainStranded(m, byId, setup.packing, data) : false),
    stagesPerHarvest: stages,
    hoursPerHarvest,
    revenue,
    drops,
    self,
    vineRevenue,
    vineChance,
    ring: { effects: [...shared], yieldMultiplier: ringYield, bounty },
    uniqueCrops: { count: uniqueCrops, counted: o.growth.uniqueCrops === null || o.growth.uniqueCrops === undefined },
    rareCrops,
    rareRevenue,
    bountyDrops,
    bountyRevenue,
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
