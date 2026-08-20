import { test } from "node:test";
import assert from "node:assert/strict";
import { coopProgress } from "../src/lib/profile";
import { buildCatalog } from "../src/lib/catalog";
import { gameData } from "./gameDataFixture";
import type { SkyblockProfile } from "../src/lib/profile";

const data = gameData();

const figLog = (data as unknown as { collections: { collections: { itemId: string; name: string; tiers: { tier: number; amountRequired: number }[] }[] } })
  .collections.collections.find((c) => c.itemId === "FIG_LOG")!;

function catalogFor(
  member: Record<string, unknown>,
  profile?: SkyblockProfile,
  museum?: { donatedItemIds: Set<string>; value: number },
) {
  return buildCatalog(
    member as never, data, { items: null, capacity: 0 }, museum ?? null, null, null,
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

/* ---------------------------------------------------------------- powers */

test("a power already unlocked is not offered again", () => {
  const member = { accessory_bag_storage: { unlocked_powers: ["shaded", "silky"] } };
  const { tasks, done } = catalogFor(member);
  const powers = tasks.filter((t) => t.id.startsWith("power_"));

  assert.equal(powers.length, 22);
  assert.ok(done.has("power_shaded"));
  assert.ok(done.has("power_silky"));
  assert.equal(done.has("power_frozen"), false);
});

test("a power costs nine of its stone", () => {
  const { tasks } = catalogFor({ accessory_bag_storage: { unlocked_powers: [] } });
  const frozen = tasks.find((t) => t.id === "power_frozen")!;

  assert.equal(frozen.category, "powers", "powers are their own category, not part of the bag");
  assert.equal(frozen.name, "Unlock Frozen power");
  assert.equal(frozen.xp, 15);
  assert.deepEqual(frozen.cost, { kind: "bazaar", items: [{ id: "GLACITE_SHARD", qty: 9 }] });
  assert.match(frozen.note ?? "", /9× Glacite Chunk/);
});

test("every power stone resolves to a real item id", () => {
  // "Glacite Chunk" is GLACITE_SHARD and "Fang-tastic Chocolate Chip" is CHOCOLATE_CHIP — the
  // ids are looked up from the items resource rather than written down for exactly that reason.
  const { powers } = gameData().powerStones;
  assert.deepEqual(powers.filter((p) => !p.itemId), []);
});

test("magical power and pet score count as XP already earned", () => {
  // An accessory you own is worth nothing more, so its task carries zero XP. Left there, the
  // coverage figure reads as missing sources when the source is modelled and merely uncounted.
  const { earnedOutsideTasks } = catalogFor({
    leveling: { highest_pet_score: 289, completed_tasks: [] },
    accessory_bag_storage: { unlocked_powers: [] },
  });

  assert.equal(earnedOutsideTasks.petScore, 289 * 3, "the highest score reached is what paid out");
  assert.equal(earnedOutsideTasks.magicalPower, 0, "no bag decoded here, so nothing to credit");
});

test("bestiary XP is credited from the milestone count", () => {
  // Ten family tiers are worth 20 XP between them: 1 apiece, plus a milestone reward of 10.
  const { earnedOutsideTasks } = catalogFor({ bestiary: { milestone: { last_claimed_milestone: 314 } } });
  assert.equal(earnedOutsideTasks.bestiary, 6_280);
});

test("a profile that has never opened the bestiary earns nothing from it", () => {
  assert.equal(catalogFor({}).earnedOutsideTasks.bestiary, 0);
});

/* ---------------------------------------------------------------- museum */

test("a donated armour set is filed under the set id, not its pieces", () => {
  // The museum files a donated set under its own id. Requiring every piece marked all 73 of a
  // real profile's donated sets as outstanding, telling the player to hand in armour the museum
  // was already displaying.
  const sets = gameData().museum.armorSets;
  const set = sets.find((s) => s.pieces.length === 4)!;

  const bySetId = catalogFor({}, undefined, { donatedItemIds: new Set([set.setId]), value: 0 });
  assert.ok(bySetId.done.has(`museum_set_${set.setId}`), `${set.setId} donated as a set`);

  const byPieces = catalogFor({}, undefined, { donatedItemIds: new Set(set.pieces), value: 0 });
  assert.ok(byPieces.done.has(`museum_set_${set.setId}`), "the piece-by-piece route still works");

  const partial = catalogFor({}, undefined, { donatedItemIds: new Set(set.pieces.slice(0, 2)), value: 0 });
  assert.equal(partial.done.has(`museum_set_${set.setId}`), false, "half a set is not a set");
});

test("an item taken back out still counts as donated", () => {
  // Borrowed items stay in the museum's items map with borrowing: true, and the XP is permanent.
  const donation = gameData().museum.donations[0];
  const cat = catalogFor({}, undefined, { donatedItemIds: new Set([donation.itemId]), value: 0 });
  assert.ok(cat.done.has(`museum_${donation.itemId}`));
});

test("a starred dungeon copy counts as the donation it is", () => {
  // Donate a Starred Shadow Fury and the museum files it under STARRED_SHADOW_FURY, which
  // matches nothing unless the alternate ids come along.
  const withAlts = gameData().museum.donations.find((d) => (d.mappedIds ?? []).length > 0)!;
  const starred = withAlts.mappedIds![0];

  const cat = catalogFor({}, undefined, { donatedItemIds: new Set([starred]), value: 0 });
  assert.ok(cat.done.has(`museum_${withAlts.itemId}`), `${starred} should satisfy ${withAlts.itemId}`);
});

test("donations the app has no slot for are counted and reported", () => {
  const cat = catalogFor({}, undefined, { donatedItemIds: new Set(["NOT_A_MUSEUM_ITEM"]), value: 0 });
  const note = cat.unmodelled.find((u) => u.category === "museum");
  assert.ok(note, "an unmatched donation should raise a note rather than silently read as missing");
  assert.match(note.note, /1 museum donation/);
});
