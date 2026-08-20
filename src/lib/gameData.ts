import type { Category, Task } from "./types";
import { CATEGORY_LABELS } from "./types";

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
  donations: {
    itemId: string;
    name: string;
    xp: number;
    /** Ids the same donation can be filed under — a dungeon-starred copy keeps its own. */
    mappedIds?: string[];
    /** The next item up this slot's upgrade line, if it has one. */
    parentId?: string | null;
    category: string;
    stage: string | null;
    tradeable: boolean;
  }[];
  armorSets: {
    setId: string;
    name: string;
    xp: number;
    /** The set this one upgrades into, if any. Donating that fills this slot too. */
    parentId?: string | null;
    category: string;
    stage: string | null;
    pieces: string[];
  }[];
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

/**
 * The bestiary's kill brackets and family list, scraped from the wiki.
 *
 * `brackets` is keyed by bracket number, each a 25-long ladder of *cumulative* kills: the
 * value at index n is the total kills that put a family at tier n+1. A family names the
 * bracket it climbs and the tier it stops at.
 */
export type BestiaryData = {
  generatedAt: string;
  source: string;
  brackets: Record<string, number[]>;
  families: { island: string; name: string; id: string; maxTier: number; maxKills: number; bracket: number }[];
  /** Families the wiki lists without a tier cap, so nothing can be offered for them. */
  undocumented: { island: string; name: string; id: string }[];
  totals: { families: number; islands: number; tiers: number; xp: number };
};

/** Internal mob id -> family id, for the ids no rule can derive. */
export type BestiaryMobsData = {
  source: string;
  verified: boolean;
  note: string;
  aliases: Record<string, string>;
  noFamily: Record<string, string>;
};

/**
 * What each Abiphone contact costs to add, from the wiki's contacts table.
 *
 * Contacts are 10 XP a piece and most are one item handed to an NPC, which makes them some of
 * the cheapest XP in the game — they were previously filed as grind and never ranked at all.
 */
export type AbiphoneData = {
  generatedAt: string;
  source: string;
  contacts: {
    taskId: string;
    npc: string;
    requirement: string;
    cost: Task["cost"];
    /** The part of the requirement that isn't a purchase, e.g. "having Sulphur VII". */
    caveat?: string;
    /** "64x Silent Pearl" — what the price is actually buying. */
    needs?: string;
  }[];
  totals: { contacts: number; free: number; coins: number; items: number; essence: number; unknown: number; quest: number };
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
  /** Every pet and the rarities it can be — a fixed catalogue, not whatever is listed today. */
  pets: {
    maxScore: number;
    pets: { name: string; key: string; rarities: string[]; maxRarity: string; buyable?: boolean }[];
  };
  difficulty: DifficultyData;
  attributeShards: AttributesData;
  bestiary: BestiaryData;
  bestiaryMobs: BestiaryMobsData;
  abiphone: AbiphoneData;
  bagUpgrades: BagUpgradesData;
  /** Shards per attribute level, keyed by the rarity of the attribute. */
  attributeLevels: { perLevel: Record<string, number[]> };
  /** Bridges wiki attribute names to the ids the profile actually uses. */
  attributeApiKeys: { wordAliases: Record<string, string>; droppableSuffixes: string[] };
  powerStones: {
    stonesPerPower: number;
    xpPerPower: number;
    powers: { stone: string; power: string; itemId: string | null }[];
  };
  /** Where the story objectives send you: real name, island and coordinates per NPC. */
  npcs: { npcs: Record<string, NpcEntry>; objectives: Record<string, string> };
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
  /**
   * family -> the item currently holding it, and whether it has been recombobulated. Upgrading
   * the family sells this one, and recombobulating it is an upgrade in its own right.
   */
  familyBest: Map<string, { id: string; rarity: string; recombobulated: boolean }>;
  /** Item ids the player already holds. */
  owned: Set<string>;
  /** Magical power we computed from the bag contents. */
  computedMp: number;
  /** Accessories in the bag, and how many of them this app recognises. */
  held: number;
  identified: number;
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
  const familyBest = new Map<string, { id: string; rarity: string; recombobulated: boolean }>();
  const owned = new Set<string>();

  let identified = 0;
  for (const item of items ?? []) {
    owned.add(item.id);
    if (excluded.has(item.id)) continue;
    const meta = byId.get(item.id);
    if (!meta) continue;
    identified++;
    const rarity = bumpRarity(data, meta.tier, item.rarityUpgrades);
    const family = familyOf(data, meta.name, meta.id);
    const power = magicalPowerOf(data, rarity);
    if (power > (familyPower.get(family) ?? -1)) {
      familyPower.set(family, power);
      familyBest.set(family, { id: meta.id, rarity, recombobulated: item.rarityUpgrades > 0 });
    }
  }

  let computedMp = 0;
  for (const power of familyPower.values()) computedMp += power;

  return {
    familyPower,
    familyBest,
    held: (items ?? []).filter((item) => !excluded.has(item.id)).length,
    identified,
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

/** One NPC, as the wiki's infobox describes them. */
export type NpcEntry = {
  name: string;
  location: string | null;
  quest: string | null;
  coords: { x: number; y: number; z: number } | null;
};

/* ----------------------------------------------------------------- bestiary */

/**
 * Which family a profile's mob id feeds, or `null` for a mob that has no family, or
 * `undefined` when we simply don't know.
 *
 * The three transformations are structural. A trailing `_127` is the mob's level, and the
 * bestiary counts a family across every level it spawns at. A `master_` prefix is the master
 * mode copy of a dungeon mob, which shares its family. A `pest_` prefix is how the garden
 * names the pests the bestiary lists under their bare names. Everything the rules can't reach
 * is named in `bestiary_mobs.json`, because nothing published joins ids to families.
 *
 * The three-way return matters: `null` is a mob we have positively established is outside the
 * bestiary (a dungeon boss, a summon), while `undefined` is an id we cannot place — and the
 * difference is what lets the catalog say how much of the profile it accounted for instead of
 * quietly treating both as zero.
 */
export function bestiaryFamilyOf(data: GameData, mobId: string): string | null | undefined {
  const stripped = mobId.replace(/_-?\d+$/, "");
  const candidates = [stripped];
  for (const prefix of [/^master_/, /^pest_/]) {
    if (prefix.test(stripped)) candidates.push(stripped.replace(prefix, ""));
  }
  const families = bestiaryFamilies(data);
  for (const candidate of candidates) {
    const alias = data.bestiaryMobs.aliases[candidate];
    if (alias) return alias;
    if (families.has(candidate)) return candidate;
  }
  for (const candidate of candidates) if (data.bestiaryMobs.noFamily[candidate]) return null;
  return undefined;
}

let familyCache: WeakMap<GameData, Map<string, BestiaryData["families"][number]>> = new WeakMap();

export function bestiaryFamilies(data: GameData): Map<string, BestiaryData["families"][number]> {
  let cached = familyCache.get(data);
  if (!cached) {
    cached = new Map(data.bestiary.families.map((f) => [f.id, f]));
    familyCache.set(data, cached);
  }
  return cached;
}

/** The highest tier `kills` has reached in this family. Tier 0 means the first tier is unmet. */
export function bestiaryTierOf(family: BestiaryData["families"][number], brackets: BestiaryData["brackets"], kills: number): number {
  const ladder = brackets[String(family.bracket)] ?? [];
  let tier = 0;
  for (let i = 0; i < family.maxTier && i < ladder.length; i++) if (kills >= ladder[i]) tier = i + 1;
  return tier;
}

/**
 * The label a category shows.
 *
 * Bestiary carries its full ceiling in the name on purpose. The list underneath is filtered
 * twice over — to the tiers within reach, and to families whose kills we could attribute — so
 * the header is the one place that can state what the whole category is worth without the
 * filtering making it look smaller than the game.
 */
export function categoryLabel(category: Category, data?: GameData): string {
  const label = CATEGORY_LABELS[category];
  if (category !== "bestiary" || !data) return label;
  return `${label} — ${data.bestiary.totals.xp.toLocaleString("en-US")} XP in all`;
}
