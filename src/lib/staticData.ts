import "server-only";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { GameData } from "./gameData";

/**
 * The committed task tables, loaded from disk. Generated ones come from
 * scripts/generate-data.mjs (Hypixel resources API); curated ones are hand-entered and carry
 * their own provenance flags. The standalone HTML build inlines these same files instead.
 */

const DATA = join(process.cwd(), "data");

function load<T>(relative: string): T {
  return JSON.parse(readFileSync(join(DATA, relative), "utf8")) as T;
}

let cached: GameData | null = null;

export function staticData(): GameData {
  // Cached for the life of the process in production; re-read in development, so editing a
  // curated table shows up on the next request instead of after a server restart.
  if (cached && process.env.NODE_ENV === "production") return cached;

  cached = {
    skills: load("generated/skills.json"),
    collections: load("generated/collections.json"),
    minions: load("generated/minions.json"),
    accessories: load("generated/accessories.json"),
    magicalPower: load("curated/magical_power.json"),
    accessoryFamilies: load("curated/accessory_families.json"),
    museum: load("generated/museum.json"),
    tasks: load("generated/tasks.json"),
    curves: load("generated/curves.json"),
    travelScrolls: load("generated/travel_scrolls.json"),
    costs: load("generated/costs.json"),
    petScore: load("curated/pet_score.json"),
    difficulty: load("generated/difficulty.json"),
    attributeShards: load("generated/attributes.json"),
    bagUpgrades: load("curated/accessory_bag_upgrades.json"),
    attributeLevels: load("curated/attribute_levels.json"),
    attributeApiKeys: load("curated/attribute_api_keys.json"),
  };
  return cached;
}
