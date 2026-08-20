import { readFileSync } from "node:fs";
import type { GameData } from "../src/lib/gameData";

/**
 * The real data tables, loaded the way the build does.
 *
 * Shared rather than copied into each test: buildCatalog reads most of GameData, so a test that
 * assembles its own object breaks the moment a field is added — which is a failing test telling
 * you about the fixture rather than about the code.
 */
export function gameData(): GameData {
  const d = (p: string) => JSON.parse(readFileSync(`data/${p}`, "utf8"));
  return {
    skills: d("generated/skills.json"), collections: d("generated/collections.json"),
    minions: d("generated/minions.json"), accessories: d("generated/accessories.json"),
    magicalPower: d("curated/magical_power.json"), accessoryFamilies: d("curated/accessory_families.json"),
    museum: d("generated/museum.json"), tasks: d("generated/tasks.json"), curves: d("generated/curves.json"),
    travelScrolls: d("generated/travel_scrolls.json"), costs: d("generated/costs.json"),
    petScore: d("curated/pet_score.json"), pets: d("generated/pets.json"), difficulty: d("generated/difficulty.json"),
    attributeShards: d("generated/attributes.json"),
    bestiary: d("generated/bestiary.json"), bestiaryMobs: d("curated/bestiary_mobs.json"), abiphone: d("generated/abiphone.json"), bagUpgrades: d("curated/accessory_bag_upgrades.json"),
    attributeLevels: d("curated/attribute_levels.json"), attributeApiKeys: d("curated/attribute_api_keys.json"),
    npcs: d("generated/npcs.json"),
    powerStones: d("generated/power_stones.json"),
  };
}
