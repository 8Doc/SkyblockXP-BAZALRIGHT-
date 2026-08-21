import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildCatalog } from "../src/lib/catalog";
import type { GameData } from "../src/lib/gameData";
import type { ProfileMember } from "../src/lib/profile";

const load = (path: string) => JSON.parse(readFileSync(`data/${path}`, "utf8"));
const data = {
  skills: load("generated/skills.json"),
  collections: load("generated/collections.json"),
  minions: load("generated/minions.json"),
  accessories: load("generated/accessories.json"),
  magicalPower: load("curated/magical_power.json"),
  accessoryFamilies: load("curated/accessory_families.json"),
  accessoryChains: load("generated/accessory_trade.json"),
  museum: load("generated/museum.json"),
  tasks: load("generated/tasks.json"),
  curves: load("generated/curves.json"),
  travelScrolls: load("generated/travel_scrolls.json"),
  costs: load("generated/costs.json"),
  petScore: load("curated/pet_score.json"),
  pets: load("generated/pets.json"),
  difficulty: load("generated/difficulty.json"),
  attributeShards: load("generated/attributes.json"),
  bestiary: load("generated/bestiary.json"),
  bestiaryMobs: load("curated/bestiary_mobs.json"),
  abiphone: load("generated/abiphone.json"),
  bagUpgrades: load("curated/accessory_bag_upgrades.json"),
  attributeLevels: load("curated/attribute_levels.json"),
  attributeApiKeys: load("curated/attribute_api_keys.json"),
  powerStones: load("generated/power_stones.json"),
  npcs: load("generated/npcs.json"),
} as unknown as GameData;

const member = {} as ProfileMember;
const emptyBag = { items: [], capacity: 0 };
const museumRows = (owned: Set<string> | null) => {
  const catalog = buildCatalog(member, data, emptyBag, null, null, null, null, owned);
  return catalog.tasks.filter((task) => task.category === "museum");
};

/**
 * A donation you already hold is a walk to the museum. Pricing it at what one costs on the
 * auction house buried the free donations under the bought ones, when they are the cheapest
 * experience on a profile by a distance — 58 of a real profile's 636 open slots were free.
 */
test("a donation already in the player's inventory costs nothing", () => {
  const held = data.museum.donations.find((donation) => donation.tradeable)!;
  const before = museumRows(null).find((task) => task.id === `museum_${held.itemId}`)!;
  assert.equal(before.cost.kind, "auction", "an item you do not hold is still a purchase");

  const after = museumRows(new Set([held.itemId])).find((task) => task.id === `museum_${held.itemId}`)!;
  assert.equal(after.cost.kind, "none", `${held.name} is in hand and should be free to donate`);
  assert.match(after.note ?? "", /already in your inventory/);
});

/**
 * Holding one item must not discount the rest, and a profile that publishes no inventory at all
 * — which is a setting a player can switch off — has to price exactly as it did before.
 */
test("holding one item leaves every other donation priced", () => {
  const held = data.museum.donations.find((donation) => donation.tradeable)!;
  const rows = museumRows(new Set([held.itemId]));
  const free = rows.filter((task) => task.cost.kind === "none");
  assert.equal(free.length, 1, `${free.length} rows went free on the strength of one held item`);

  const blind = museumRows(null);
  assert.equal(blind.filter((task) => task.cost.kind === "none").length, 0);
  assert.equal(blind.length, rows.length, "the row count should not depend on what is held");
});

/** An armour set is free only once every piece of it is in hand. */
test("an armour set costs nothing only when all its pieces are held", () => {
  const set = data.museum.armorSets.find((entry) => entry.pieces.length > 1)!;
  const partial = museumRows(new Set([set.pieces[0]!])).find((task) => task.id === `museum_set_${set.setId}`)!;
  assert.notEqual(partial.cost.kind, "none", "one piece is not a set");

  const whole = museumRows(new Set(set.pieces)).find((task) => task.id === `museum_set_${set.setId}`)!;
  assert.equal(whole.cost.kind, "none", `${set.name} is complete and should be free to donate`);
});
