/** The shape of the Hypixel profile fields the planner reads. Shared by both front ends. */

export type ProfileMember = {
  bestiary?: {
    /** Raw kills keyed by internal mob id and level, e.g. `crypt_lurker_121`. */
    kills?: Record<string, number>;
    milestone?: { last_claimed_milestone?: number };
  };
  leveling?: {
    experience?: number;
    completed_tasks?: string[];
    highest_pet_score?: number;
    /** Two event tasks the game counts up rather than ticking off. */
    mining_fiesta_ores_mined?: number;
    fishing_festival_sharks_killed?: number;
  };
  /** Seasonal events. Prestiging the Chocolate Factory is an XP task in its own right. */
  events?: { easter?: { rabbits?: { prestige?: number } } };
  /** Item id -> how much this member has personally contributed to the co-op's collection. */
  collection?: Record<string, number>;
  player_data?: {
    experience?: Record<string, number>;
    unlocked_coll_tiers?: string[];
    crafted_generators?: string[];
  };
  accessory_bag_storage?: {
    /** Powers already unlocked, by name. */
    unlocked_powers?: string[]; highest_magical_power?: number; bag_upgrades_purchased?: number };
  /**
   * Abiphone contacts. An Abicase turns every two of them into magical power, and the count has
   * to come from `active_contacts`: `contact_data` carries only the contacts with state attached
   * and ran four short of the real list on the profile this was checked against.
   */
  nether_island_player_data?: {
    abiphone?: { active_contacts?: string[]; contact_data?: Record<string, unknown> };
  };
  /** `access.consumed_prism` says a Rift Prism has been imbued, which is worth 11 magical power. */
  rift?: { access?: { consumed_prism?: boolean } };
  fairy_soul?: { total_collected?: number };
  inventory?: {
    bag_contents?: Record<string, { data?: string } | undefined>;
    inv_contents?: { data?: string };
    inv_armor?: { data?: string };
    ender_chest_contents?: { data?: string };
    backpack_contents?: Record<string, { data?: string } | undefined>;
    wardrobe_contents?: { data?: string };
    personal_vault_contents?: { data?: string };
    equipment_contents?: { data?: string };
  };
  dungeons?: {
    dungeon_types?: { catacombs?: { experience?: number } };
    player_classes?: Record<string, { experience?: number } | undefined>;
  };
  slayer?: { slayer_bosses?: Record<string, { xp?: number } | undefined> };
  pets_data?: { pets?: { type?: string; tier?: string }[] };
  /** Perk trees. HOTM and the forest equivalents live here, keyed by node name -> level. */
  skill_tree?: { nodes?: Record<string, Record<string, number | boolean> | undefined> };
  /** Attribute shard counts, keyed by attribute name. Levels are derived from these. */
  attributes?: { stacks?: Record<string, number> };
};

/**
 * Progress that belongs to the island rather than to one player.
 *
 * A co-op shares its minions and collections, but the API records `crafted_generators` and
 * `unlocked_coll_tiers` per *member* — whoever personally did the crafting. On a seven-person
 * co-op that means one member's list is full of holes: a real profile showed Gravel tiers 7-11
 * against a co-op mate's 1-6, and reading only one member's list made the planner recommend
 * crafting a tier I minion that had been sitting on the island at tier XI for months.
 *
 * Unioning the members reconstructs what the island actually has. It is self-checking, too:
 * minion tiers are strictly sequential upgrades, and on that profile the union closed all 278
 * gaps below a generator's highest tier, leaving exactly zero.
 */
export function coopProgress(profile: SkyblockProfile): {
  craftedGenerators: string[];
  unlockedCollectionTiers: string[];
  collected: Map<string, number>;
} {
  const crafted = new Set<string>();
  const collections = new Set<string>();
  // Collections are a co-op total: each member's map records what they personally contributed,
  // and the profile's progress is the sum. Reading one member's map alone understates a shared
  // profile and would offer tiers the co-op has long since passed.
  const collected = new Map<string, number>();

  for (const member of Object.values(profile.members)) {
    for (const id of member.player_data?.crafted_generators ?? []) crafted.add(id);
    for (const id of member.player_data?.unlocked_coll_tiers ?? []) collections.add(id);
    for (const [item, amount] of Object.entries(member.collection ?? {})) {
      if (typeof amount === "number") collected.set(item, (collected.get(item) ?? 0) + amount);
    }
  }

  return { craftedGenerators: [...crafted], unlockedCollectionTiers: [...collections], collected };
}

/** What the museum endpoint tells us: which items are already donated. */
export type MuseumState = {
  donatedItemIds: Set<string>;
  /**
   * Donations in the museum's Special section. They sit outside the 636 numbered slots — none
   * of them is an item this app has a slot for — but the game still counts them as donated, so
   * ignoring them made our total read short against the in-game one by exactly their number.
   */
  specialItemIds: Set<string>;
  value: number;
};

/**
 * The garden lives on its own endpoint rather than inside the profile member, because it
 * belongs to the whole co-op rather than to one player.
 */
export type GardenState = {
  /** Plot ids the co-op has unlocked. */
  unlockedPlots: number;
  /** crop id -> upgrade level. */
  cropUpgrades: Record<string, number>;
  /** composter upgrade name -> tier. */
  composterUpgrades: Record<string, number>;
};

export type SkyblockProfile = {
  profile_id: string;
  cute_name: string;
  selected?: boolean;
  game_mode?: string;
  members: Record<string, ProfileMember>;
};

export type BazaarProduct = {
  quick_status: { buyPrice: number; sellPrice: number; buyVolume: number; sellVolume: number };
};

export type BinIndex = {
  /** itemId -> rarity -> lowest BIN price. Rarity matters: a recombobulated copy is a different buy. */
  prices: Record<string, Record<string, number>>;
  scannedAt: number;
  pages: number;
  listings: number;
};
