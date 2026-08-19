import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { coopProgress } from "../src/lib/profile";
import { buildCatalog } from "../src/lib/catalog";
import type { GameData } from "../src/lib/gameData";
import type { SkyblockProfile } from "../src/lib/profile";

const d = (p: string) => JSON.parse(readFileSync(`data/${p}`, "utf8"));
const data = {
  skills: d("generated/skills.json"), collections: d("generated/collections.json"),
  minions: d("generated/minions.json"), accessories: d("generated/accessories.json"),
  magicalPower: d("curated/magical_power.json"), accessoryFamilies: d("curated/accessory_families.json"),
  museum: d("generated/museum.json"), tasks: d("generated/tasks.json"), curves: d("generated/curves.json"),
  travelScrolls: d("generated/travel_scrolls.json"), costs: d("generated/costs.json"),
  petScore: d("curated/pet_score.json"), difficulty: d("generated/difficulty.json"),
  attributeShards: d("generated/attributes.json"), bagUpgrades: d("curated/accessory_bag_upgrades.json"),
  attributeLevels: d("curated/attribute_levels.json"), attributeApiKeys: d("curated/attribute_api_keys.json"),
} as GameData;

const figLog = (data as unknown as { collections: { collections: { itemId: string; name: string; tiers: { tier: number; amountRequired: number }[] }[] } })
  .collections.collections.find((c) => c.itemId === "FIG_LOG")!;

function catalogFor(member: Record<string, unknown>, profile?: SkyblockProfile) {
  return buildCatalog(
    member as never, data, { items: null, capacity: 0 }, null, null, null,
    profile ? coopProgress(profile) : null,
  );
}

/**
 * `unlocked_coll_tiers` reads like an event log, not a state: a maxed Fig Log turns up as
 * FIG_LOG_4, FIG_LOG_8 and FIG_LOG_-1 with the other six tiers simply absent. Trusting it alone
 * offers tiers the player passed long ago.
 */
test("a tier the amount collected covers is done, whatever the unlock list omits", () => {
  const member = {
    collection: { FIG_LOG: 3_520_965 },
    player_data: { unlocked_coll_tiers: ["FIG_LOG_4", "FIG_LOG_8", "FIG_LOG_-1"] },
  };

  const { done } = catalogFor(member);
  for (const tier of figLog.tiers) {
    if (tier.tier < 0) continue;
    assert.ok(done.has(`collection_FIG_LOG_${tier.tier}`), `Fig Log ${tier.tier} should be done at 3.5M collected`);
  }
});

test("a tier the amount has not reached is still offered", () => {
  const member = { collection: { FIG_LOG: 0 }, player_data: { unlocked_coll_tiers: [] } };
  const { done } = catalogFor(member);
  const last = figLog.tiers[figLog.tiers.length - 1];
  assert.equal(done.has(`collection_FIG_LOG_${last.tier}`), false);
});

test("the unlock list still counts when the amount does not reach the tier", () => {
  // Neither signal is dropped: the list catches a tier unlocked by some route the total misses.
  const member = { collection: {}, player_data: { unlocked_coll_tiers: [`FIG_LOG_${figLog.tiers[0].tier}`] } };
  const { done } = catalogFor(member);
  assert.ok(done.has(`collection_FIG_LOG_${figLog.tiers[0].tier}`));
});

test("a co-op's collections are the sum of what its members contributed", () => {
  const half = Math.ceil(figLog.tiers[figLog.tiers.length - 1].amountRequired / 2);
  const profile = {
    profile_id: "p", cute_name: "Test",
    members: {
      a: { collection: { FIG_LOG: half }, player_data: { unlocked_coll_tiers: [] } },
      b: { collection: { FIG_LOG: half }, player_data: { unlocked_coll_tiers: [] } },
    },
  } as unknown as SkyblockProfile;

  const coop = coopProgress(profile);
  assert.equal(coop.collected.get("FIG_LOG"), half * 2);

  // Neither member alone reaches the final tier; together they clear it.
  const alone = catalogFor({ collection: { FIG_LOG: half }, player_data: {} });
  const last = figLog.tiers[figLog.tiers.length - 1];
  assert.equal(alone.done.has(`collection_FIG_LOG_${last.tier}`), false, "one member is short");
  assert.ok(
    catalogFor({ collection: { FIG_LOG: half }, player_data: {} }, profile).done.has(`collection_FIG_LOG_${last.tier}`),
    "the co-op together is not",
  );
});
