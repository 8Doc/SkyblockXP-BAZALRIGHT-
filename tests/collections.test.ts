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
  museum?: { donatedItemIds: Set<string>; specialItemIds?: Set<string>; value: number },
) {
  return buildCatalog(
    member as never, data, { items: null, capacity: 0 }, museum ? { specialItemIds: new Set<string>(), ...museum } : null, null, null,
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

test("an upgraded donation fills the slots below it", () => {
  // Donate a Wand of Atonement and the Healing, Mending and Restoration slots are filled too.
  const cat = catalogFor({}, undefined, { donatedItemIds: new Set(["WAND_OF_ATONEMENT"]), value: 0 });
  for (const id of ["WAND_OF_HEALING", "WAND_OF_MENDING", "WAND_OF_RESTORATION", "WAND_OF_ATONEMENT"]) {
    assert.ok(cat.done.has(`museum_${id}`), `${id} should be filled by the Atonement`);
  }
});

test("a lower donation does not fill the slots above it", () => {
  const cat = catalogFor({}, undefined, { donatedItemIds: new Set(["WAND_OF_HEALING"]), value: 0 });
  assert.ok(cat.done.has("museum_WAND_OF_HEALING"));
  assert.equal(cat.done.has("museum_WAND_OF_ATONEMENT"), false, "the chain only runs upwards");
});

test("reconciliation counts both sides for the three categories it covers", () => {
  const cat = catalogFor(
    { attributes: { stacks: { speed: 10, NOT_AN_ATTRIBUTE: 5 } } },
    undefined,
    { donatedItemIds: new Set(["WAND_OF_HEALING", "NOT_A_MUSEUM_ITEM"]), value: 0 },
  );
  const by = new Map(cat.reconciliation.map((r) => [r.category, r]));

  assert.deepEqual(by.get("museum"), { category: "museum", credited: 1, reported: 2 });

  // Three pieces of a four-piece set are three real donations that finish no slot, so they
  // belong in the gap rather than being waved through as "recognised".
  const partialSet = catalogFor({}, undefined, {
    donatedItemIds: new Set(["PESTHUNTERS_BELT", "PESTHUNTERS_GLOVES", "PESTHUNTERS_NECKLACE"]),
    value: 0,
  });
  const museum = partialSet.reconciliation.find((r) => r.category === "museum")!;
  assert.deepEqual(museum, { category: "museum", credited: 0, reported: 3 });
  assert.equal(by.get("attributes")!.reported, 2, "both stacks are reported");
  assert.equal(by.get("attributes")!.credited, 1, "only the one we can place is credited");
});

test("special-section donations widen the museum gap rather than vanishing", () => {
  // They fill none of the 636 numbered slots — no Cake Soul or Singing Fish is a slot — but the
  // game counts them as donated, so leaving them out made our total read short by exactly their
  // number against the in-game one.
  const cat = catalogFor({}, undefined, {
    donatedItemIds: new Set(["WAND_OF_HEALING"]),
    specialItemIds: new Set(["CAKE_SOUL", "SINGING_FISH"]),
    value: 0,
  });
  const museum = cat.reconciliation.find((r) => r.category === "museum")!;
  assert.deepEqual(museum, { category: "museum", credited: 1, reported: 3 });
});

test("an upgraded armour set fills the set slot below it", () => {
  // Set upgrade links are carried by the pieces but keyed by the *set* id, so reading only the
  // self-keyed links dropped all 174 of them and left donated sets reading as outstanding.
  const sets = gameData().museum.armorSets;
  const child = sets.find((s) => s.parentId && sets.some((p) => p.setId === s.parentId))!;

  const cat = catalogFor({}, undefined, {
    donatedItemIds: new Set([child.parentId!]),
    specialItemIds: new Set<string>(),
    value: 0,
  });
  assert.ok(cat.done.has(`museum_set_${child.setId}`), `${child.parentId} should fill ${child.setId}`);
});

test("a lower set does not fill the one above it", () => {
  const sets = gameData().museum.armorSets;
  const child = sets.find((s) => s.parentId && sets.some((p) => p.setId === s.parentId))!;
  const cat = catalogFor({}, undefined, {
    donatedItemIds: new Set([child.setId]),
    specialItemIds: new Set<string>(),
    value: 0,
  });
  assert.equal(cat.done.has(`museum_set_${child.parentId}`), false, "the chain only runs upwards");
});

test("trophy fish are their own category, not misc", () => {
  // 120 tasks worth 1,800 XP were buried in misc with no way to switch them off on their own.
  const { tasks } = catalogFor({});
  const trophies = tasks.filter((t) => t.id.startsWith("TROPHY_"));

  assert.ok(trophies.length > 100, `only ${trophies.length} trophy tasks`);
  assert.deepEqual([...new Set(trophies.map((t) => t.category))], ["trophy_fish"]);
  assert.equal(tasks.some((t) => t.category === "misc" && t.id.startsWith("TROPHY_")), false);
});

/* ------------------------------------------------- fixed pet catalogue */

test("the pet catalogue is fixed, not whatever is listed today", () => {
  const { pets, maxScore } = gameData().pets;
  assert.ok(pets.length > 80, `only ${pets.length} pets`);
  assert.ok(maxScore > 500 && maxScore < 560, `max score ${maxScore} is nowhere near the game's 521`);
  assert.deepEqual(pets.filter((p) => !p.rarities.length), [], "every pet states the rarities it can be");
});

test("a pet nobody is selling is still a row", () => {
  // The list used to come off the auction house, so an unlisted pet did not exist at all.
  const { tasks } = catalogFor({});
  const golden = tasks.filter((t) => t.id.includes("GOLDEN_DRAGON"));
  assert.ok(golden.length > 0, "the catalogue carries it with no market involved");
});

test("attributes cover the whole game, not the third the old wiki listed", () => {
  const { tasks } = catalogFor({});
  const attributes = tasks.filter((t) => t.category === "attributes");
  // 320 attributes at ten levels apiece is 3,200 XP; the old Fandom list carried 181.
  assert.ok(attributes.length > 3_000, `only ${attributes.length} attribute levels`);
  assert.equal(attributes.reduce((s, t) => s + t.xp, 0), attributes.length, "one XP per level");
});

/* ------------------------------------------- false positives on a maxed profile */

test("an attribute we cannot place is held back, not offered as ten fresh levels", () => {
  // The wiki writes Arthropod Ruler where the game writes arachno. About twenty names disagree,
  // and offering all ten levels of each told a player with every attribute maxed that 171 levels
  // were outstanding. Unknown progress is not the same as no progress.
  const withAttributes = catalogFor({ attributes: { stacks: { speed: 96 } } });
  const offered = withAttributes.tasks.filter((t) => t.category === "attributes");
  const names = new Set(offered.map((t) => t.name.replace(/ \d+$/, "")));
  assert.ok(!names.has("Arthropod Ruler"), "no key in this profile matches it, so its progress is unknown");

  // A profile that reports nothing is a different case: there the category really is all ahead.
  const fresh = catalogFor({});
  assert.ok(fresh.tasks.filter((t) => t.category === "attributes").length > 3_000);
});

test("pets nobody can buy are not on a shopping list", () => {
  // Rift-bound pets were offered to a player who owned every purchasable one.
  const pets = catalogFor({}).tasks.filter((t) => t.category === "pets");
  for (const name of ["MONTEZUMA", "RIFT_FERRET", "KUUDRA", "GRANDMA_WOLF"]) {
    assert.equal(pets.some((t) => t.id.includes(name)), false, `the ${name} pet cannot be bought`);
  }
  assert.equal(pets.some((t) => t.id.includes("BINGO")), false, "the Bingo pet needs a Bingo profile");
  assert.ok(pets.length > 200, "the rest of the catalogue is still there");
});
