import type { Task } from "./types";

/**
 * The static task tables, and the pure logic that reads them.
 *
 * Deliberately platform-free: no fs, no server-only, no fetch. The Next route loads these
 * tables from disk and the standalone HTML has them inlined at build time, but everything
 * below runs identically in both, so there is one implementation of the game rules.
 */

export type SkillsData = {
  generatedAt: string;
  totalXp: number;
  skills: {
    key: string;
    name: string;
    maxLevel: number;
    levels: { level: number; totalExpRequired: number; xp: number }[];
  }[];
};

export type CollectionsData = {
  generatedAt: string;
  totalXp: number;
  collections: {
    group: string;
    itemId: string;
    name: string;
    maxTiers: number;
    tiers: { tier: number; amountRequired: number; xp: number }[];
  }[];
};

export type MinionsData = {
  generatedAt: string;
  totalXp: number;
  minions: {
    generator: string;
    family: string;
    maxTier: number;
    tiers: { tier: number; itemId: string; name: string; xp: number }[];
  }[];
};

export type AccessoriesData = {
  generatedAt: string;
  accessories: {
    id: string;
    name: string;
    tier: string;
    museum: boolean;
    soulbound: boolean;
    tradeable: boolean;
  }[];
};

export type MagicalPowerData = {
  source: string;
  verified: boolean;
  byRarity: Record<string, number>;
  rarityOrder: string[];
  excludedItems: { ids: string[] };
};

export type AccessoryFamiliesData = {
  source: string;
  verified: boolean;
  endsWithFamilies: string[];
  patternFamilies: { match: string; family: string }[];
};

export type MuseumData = {
  generatedAt: string;
  totalXp: number;
  donations: { itemId: string; name: string; xp: number; category: string; stage: string | null; tradeable: boolean }[];
  armorSets: { setId: string; name: string; xp: number; category: string; stage: string | null; pieces: string[] }[];
};

/** Discrete tasks: real ids harvested from live profiles, XP from wiki-derived rules. */
export type TasksData = {
  generatedAt: string;
  playersScanned: number;
  totals: { tasks: number; xp: number; byCategory: Record<string, number> };
  tasks: { id: string; category: string; xp: number; rule: string; players: number }[];
};

/** Level thresholds the API doesn't publish, scraped from the wiki. */
export type CurvesData = {
  generatedAt: string;
  dungeoneering: { levels: { level: number; xpForLevel: number; totalXp: number }[] };
  slayer: { levelXp: number[]; bosses: Record<string, number[]> };
  /** Cumulative shards per attribute level — the same table for every attribute. */
  attributes: { cumulativeShards: number[] };
  /** XP awarded for reaching each tier of the perk-tree tracks. */
  progressTracks: {
    heartOfTheMountain: number[];
    peakOfTheMountain: number[];
    heartOfTheForest: number[];
    centerOfTheForest: number[];
  };
};

export type TravelScrollsData = {
  generatedAt: string;
  /** Fast-travel task id -> the scroll that unlocks it, where one can be bought at all. */
  scrolls: { taskId: string; itemId: string; name: string }[];
};

/** Costs scraped from the wiki and resolved to bazaar ids — see scripts/build-cost-table.mjs. */
export type CostsData = {
  generatedAt: string;
  /**
   * generator -> tier -> either a plain ingredient list, or ingredients plus the minion tiers
   * this one requires (some minions are crafted from other minions).
   */
  minions: Record<
    string,
    Record<string, { id: string; qty: number }[] | { items: { id: string; qty: number }[]; requires: string[] }>
  >;
  essence: Record<string, { essence: string; tiers: Record<string, number> }>;
  bank: Record<string, number>;
  coverage: Record<string, number>;
};

/** Every attribute, the shard that feeds it, and that shard's bazaar id. */
export type AttributesData = {
  generatedAt: string;
  totalAttributes: number;
  tradeableAttributes: number;
  attributes: {
    key: string;
    name: string;
    rarity: string;
    shardName: string;
    shardId: string;
    tradeable: boolean;
  }[];
};

/** Observed completion rates, from scripts/harvest-difficulty.mjs. */
export type DifficultyData = {
  generatedAt: string;
  playersScanned: number;
  completionRate: Record<string, number>;
};

/** Jacobus's accessory bag upgrades: +2 slots and +2 XP each, in rising cost bands. */
export type BagUpgradesData = {
  slotsPerUpgrade: number;
  xpPerUpgrade: number;
  maxUpgrades: number;
  costBands: { from: number; to: number; coins: number }[];
};

export type GameData = {
  skills: SkillsData;
  collections: CollectionsData;
  minions: MinionsData;
  accessories: AccessoriesData;
  magicalPower: MagicalPowerData;
  accessoryFamilies: AccessoryFamiliesData;
  museum: MuseumData;
  tasks: TasksData;
  curves: CurvesData;
  travelScrolls: TravelScrollsData;
  costs: CostsData;
  petScore: { byRarity: Record<string, number> };
  difficulty: DifficultyData;
  attributeShards: AttributesData;
  bagUpgrades: BagUpgradesData;
  /** Shards per attribute level, keyed by the rarity of the attribute. */
  attributeLevels: { perLevel: Record<string, number[]> };
  /** Bridges wiki attribute names to the ids the profile actually uses. */
  attributeApiKeys: { wordAliases: Record<string, string>; droppableSuffixes: string[] };
};

/** What the nth accessory bag upgrade costs. */
export function bagUpgradeCost(data: GameData, upgrade: number): number | null {
  const band = data.bagUpgrades.costBands.find((b) => upgrade >= b.from && upgrade <= b.to);
  return band ? band.coins : null;
}

/**
 * Turn an observed completion rate into an effort score and a coarse band.
 *
 * Bands rather than raw percentages because the underlying signal doesn't justify more
 * precision: it says Catacombs 40 is a bigger job than Combat 20, not that it is 3.1× bigger.
 * A task nobody in the sample has finished is treated as the hardest thing there is.
 */
export function effortOf(data: GameData, taskId: string): { effort: number; band: Task["effortBand"] } {
  const rate = data.difficulty.completionRate[taskId];
  if (rate === undefined) return { effort: 1, band: "marathon" };
  const effort = 1 - rate;
  const band = rate >= 0.8 ? "quick" : rate >= 0.5 ? "short" : rate >= 0.2 ? "long" : "marathon";
  return { effort, band };
}

/* ------------------------------------------------------------ magical power */

export function magicalPowerOf(data: GameData, rarity: string): number {
  return data.magicalPower.byRarity[rarity] ?? 0;
}

/** Recombobulator bumps an accessory one step up the rarity ladder. */
export function bumpRarity(data: GameData, rarity: string, steps: number): string {
  if (steps <= 0) return rarity;
  const order = data.magicalPower.rarityOrder;
  const index = order.indexOf(rarity);
  if (index < 0) return rarity;
  return order[Math.min(index + steps, order.length - 1)] ?? rarity;
}

/* ----------------------------------------------------------------- families */

/**
 * Which family an accessory belongs to. Only the best member of a family grants magical power,
 * so getting this wrong in either direction matters: merge too eagerly and real XP disappears,
 * merge too little and a plan buys the same magical power twice over.
 *
 * Three structural patterns cover most of it; the stragglers are named in
 * data/curated/accessory_families.json.
 */
// The nouns a family climbs through. Heirloom, Badge and Chronomicon were missing, which
// split four families down the middle — "Bingo Heirloom" sat apart from the rest of Bingo, so
// the bag offered a legendary you already had the epic of.
const UPGRADE_WORD = "Talisman|Ring|Artifact|Relic|Orb|Heirloom|Badge|Chronomicon";
/** "Bat Person Artifact" -> "bat person" */
const FAMILY_SUFFIX = new RegExp(`\\s+(${UPGRADE_WORD})$`);
/** "Relic of Coins" -> "of coins" */
const FAMILY_OF = new RegExp(`^(${UPGRADE_WORD}) (of .+)$`);
/** "Master Skull - Tier 3", "Personal Compactor 6000" -> drop the tier marker */
const TIER_MARKER = /(\s+-\s+Tier\s+\d+|\s+\d+)$/;

export function familyOf(data: GameData, name: string, id: string): string {
  for (const phrase of data.accessoryFamilies.endsWithFamilies) {
    if (name.endsWith(phrase)) return phrase.toLowerCase();
  }
  for (const rule of data.accessoryFamilies.patternFamilies) {
    if (new RegExp(rule.match).test(name)) return rule.family;
  }

  const untiered = name.replace(TIER_MARKER, "");
  const ofMatch = FAMILY_OF.exec(untiered);
  if (ofMatch) return ofMatch[2].toLowerCase();

  const stem = untiered.replace(FAMILY_SUFFIX, "");
  if (stem !== untiered) return stem.toLowerCase();
  // No family pattern matched. Same-named accessories at different rarities still belong
  // together, so key on the name rather than the id.
  return untiered.toLowerCase() || `#${id}`;
}

/* --------------------------------------------------------------- bag scoring */

export type BagItem = { id: string; rarityUpgrades: number };

export type BagState = {
  /** family -> magical power already granted by the best owned member. */
  familyPower: Map<string, number>;
  /** Item ids the player already holds. */
  owned: Set<string>;
  /** Magical power we computed from the bag contents. */
  computedMp: number;
  /** Magical power the API reports. A gap means our model is missing something. */
  reportedMp: number | null;
  readable: boolean;
  /** Slots the bag container has, and how many hold an accessory. */
  capacity: number;
  used: number;
};

/** Score a bag the way the game does: one accessory per family, best rarity wins. */
export function scoreBag(
  data: GameData,
  items: BagItem[] | null,
  reportedMp: number | null,
  capacity = 0,
): BagState {
  const byId = new Map(data.accessories.accessories.map((a) => [a.id, a]));
  const excluded = new Set(data.magicalPower.excludedItems.ids);

  const familyPower = new Map<string, number>();
  const owned = new Set<string>();

  for (const item of items ?? []) {
    owned.add(item.id);
    if (excluded.has(item.id)) continue;
    const meta = byId.get(item.id);
    if (!meta) continue;
    const rarity = bumpRarity(data, meta.tier, item.rarityUpgrades);
    const family = familyOf(data, meta.name, meta.id);
    familyPower.set(family, Math.max(familyPower.get(family) ?? 0, magicalPowerOf(data, rarity)));
  }

  let computedMp = 0;
  for (const power of familyPower.values()) computedMp += power;

  return {
    familyPower,
    owned,
    computedMp,
    reportedMp,
    readable: items !== null,
    capacity,
    used: items?.length ?? 0,
  };
}

/**
 * Lowercased display name -> item id for everything we price off the auction house:
 * accessories, museum donations and travel scrolls.
 */
export function auctionNameIndex(data: GameData): Map<string, string> {
  const index = new Map<string, string>();
  for (const a of data.accessories.accessories) index.set(a.name.toLowerCase(), a.id);
  for (const d of data.museum.donations) index.set(d.name.toLowerCase(), d.itemId);
  for (const s of data.travelScrolls.scrolls) index.set(s.name.toLowerCase(), s.itemId);
  return index;
}
