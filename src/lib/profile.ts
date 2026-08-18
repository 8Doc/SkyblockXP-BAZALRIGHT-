/** The shape of the Hypixel profile fields the planner reads. Shared by both front ends. */

export type ProfileMember = {
  leveling?: {
    experience?: number;
    completed_tasks?: string[];
    highest_pet_score?: number;
  };
  player_data?: {
    experience?: Record<string, number>;
    unlocked_coll_tiers?: string[];
    crafted_generators?: string[];
  };
  accessory_bag_storage?: { highest_magical_power?: number; bag_upgrades_purchased?: number };
  fairy_soul?: { total_collected?: number };
  inventory?: { bag_contents?: { talisman_bag?: { data?: string } } };
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

/** What the museum endpoint tells us: which items are already donated. */
export type MuseumState = {
  donatedItemIds: Set<string>;
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
