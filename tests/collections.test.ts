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

/**
 * A maxed bag is recombobulated throughout — one real profile had done it to 124 of the 128
 * families it held — so buying an accessory is only half the magical power that family is
 * worth. Offering the step only on what is already owned quoted the rest of the bag at base
 * rarities, and the category's remaining XP read far below what is actually left to get.
 */
test("an accessory you have yet to buy still has a recombobulator step", () => {
  const { tasks, done } = catalogFor({ accessory_bag_storage: { unlocked_powers: [] } });
  const live = tasks.filter((t) => t.category === "accessory_bag" && !done.has(t.id));

  const buy = live.find((t) => t.id === "accessory_BAT_ARTIFACT");
  const recomb = live.find((t) => t.id === "recombobulate_BAT_ARTIFACT");
  assert.ok(buy, "the accessory itself is on offer");
  assert.ok(recomb, "and so is the recombobulator that follows it");

  // The step needs the accessory first, so the pair is priced as the pair.
  assert.deepEqual(recomb.requires, ["accessory_BAT_ARTIFACT"]);
  // Both belong to the family, so a total counts the better of the two rather than both.
  assert.equal(recomb.exclusiveGroup, buy.exclusiveGroup);
  assert.ok(recomb.xp > buy.xp, `${recomb.xp} should beat the ${buy.xp} of the plain accessory`);
});

/**
 * Six accessories climb past any rarity you can buy, and imbuing a Rift Prism pays eleven for
 * good. None can be priced, so all of it used to be absent — and the category came up short by
 * exactly that on every profile below the maximum. They belong in the browser as grind.
 */
test("what no purchase can reach is still listed, as grind", () => {
  const { tasks, done } = catalogFor({ accessory_bag_storage: { unlocked_powers: [] } });
  const live = tasks.filter((t) => t.category === "accessory_bag" && !done.has(t.id));

  const box = live.find((t) => t.id === "climb_PANDORAS_BOX");
  assert.ok(box, "Pandora's Box reaches mythic by being won, not bought");
  assert.equal(box.cost.kind, "none", "so it is grind, and stays out of the coin plans");
  assert.equal(box.xp, 22, "the mythic it actually reaches, not the common it starts at");

  const prism = live.find((t) => t.id === "climb_RIFT_PRISM");
  assert.ok(prism, "an unimbued prism is 11 magical power still to earn");
  assert.equal(prism.cost.kind, "none");
});

test("a climbing accessory competes with buying its family rather than adding to it", () => {
  const { tasks } = catalogFor({ accessory_bag_storage: { unlocked_powers: [] } });
  const climb = tasks.find((t) => t.id === "climb_PULSE_RING")!;
  const buy = tasks.find((t) => t.id === "accessory_PULSE_RING")!;
  // Same family, so a total counts the better of the two rather than both.
  assert.equal(climb.exclusiveGroup, buy.exclusiveGroup);
  assert.ok(climb.xp > buy.xp);
});

/**
 * The Abicase's magical power scales with Abiphone contacts, and the contacts come from the task
 * list rather than from the wiki's pricing table — the table names 71 and the game has 84, which
 * capped it seven short. It is offered whether or not there is an Abicase in the bag yet: on a
 * sample of 49 live profiles most had none, and holding the row back left 28 of them 42 magical
 * power below a ceiling they can reach by buying one.
 */
test("the Abicase's contacts are offered before you own an Abicase", () => {
  const { tasks, done } = catalogFor({ accessory_bag_storage: { unlocked_powers: [] } });
  const row = tasks.find((t) => t.id === "abicase_contacts" && !done.has(t.id));
  assert.ok(row, "an empty bag still has the whole Abiphone book ahead of it");
  assert.deepEqual(row.requires, ["accessory_ABICASE"], "the Abicase is a prerequisite, not a gate");
  assert.equal(row.cost.kind, "none", "the contacts are priced in their own category");

  const contacts = data.tasks.tasks.filter((t) => t.id.startsWith("ABIPHONE_")).length;
  assert.equal(contacts, 84, "the task list holds every contact");
  assert.equal(row.xp, Math.floor(contacts / 2), "one magical power per two contacts");
});

/**
 * A contact's XP and a contact's magical power are earned on different terms, and reading both
 * off one field gets one of them wrong.
 *
 * The XP is paid once when the contact is first saved and survives deleting it. The magical
 * power does not: the Abicase reads the phone as it stands. A real profile has XP for 45
 * contacts, stored data for 51, and only 12 in the phone — and its magical power reconciles on
 * the 12 while its XP reconciles on the 45.
 */
test("a deleted contact keeps its XP and loses its magical power", () => {
  const member = {
    // Saved once, so the XP is banked...
    leveling: { completed_tasks: ["ABIPHONE_agatha", "ABIPHONE_bartender", "ABIPHONE_zog"] },
    // ...but only one of the three is still in the phone.
    nether_island_player_data: { abiphone: { active_contacts: ["agatha"], contact_data: { agatha: {}, zog: {} } } },
    accessory_bag_storage: { unlocked_powers: [] },
  };
  const { tasks, done } = catalogFor(member);

  for (const id of ["ABIPHONE_agatha", "ABIPHONE_bartender", "ABIPHONE_zog"]) {
    assert.ok(done.has(id), `${id} was saved once, so its XP is kept`);
  }

  // One contact in the phone is worth no magical power at all, so everything is still to gain.
  const row = tasks.find((t) => t.id === "abicase_contacts");
  const contacts = data.tasks.tasks.filter((t) => t.id.startsWith("ABIPHONE_")).length;
  assert.ok(row, "the Abicase row is still on offer");
  assert.equal(row.xp, Math.floor(contacts / 2), "one active contact is half a point, which rounds to none");
  assert.match(row.note ?? "", /1 of \d+ active/, "the note counts what is in the phone, not what was saved");
});

test("an accessory that refuses a recombobulator is not offered one", () => {
  const { tasks } = catalogFor({ accessory_bag_storage: { unlocked_powers: [] } });
  for (const id of ["VOTER_BADGE_SUPREME", "PANDORAS_BOX", "RIFT_PRISM"]) {
    assert.equal(
      tasks.find((t) => t.id === `recombobulate_${id}`),
      undefined,
      `${id} cannot take one`,
    );
  }
});

/* ------------------------------------------------------------------ pets */

/**
 * The catalogue is keyed by the wiki's page titles and the profile by the game's own ids, and
 * for two pets those are different words entirely. Two maxed profiles were being told to go and
 * buy a T-Rex and the whole Wisp line, both of which were sitting in their pet menus.
 */
test("a pet the game names differently is still recognised", () => {
  const owned = (type: string, tier: string) =>
    catalogFor({ pets_data: { pets: [{ type, tier }] }, accessory_bag_storage: { unlocked_powers: [] } });

  // The game calls the T-Rex a TYRANNOSAURUS.
  const trex = owned("TYRANNOSAURUS", "LEGENDARY");
  assert.ok(trex.done.has("pet_PET:T_REX_LEGENDARY"), "a held T-Rex is not offered again");

  // And the Wisp renames as it climbs, so it has four ids rather than one.
  for (const [id, tier] of [
    ["DROPLET_WISP", "UNCOMMON"],
    ["FROST_WISP", "RARE"],
    ["GLACIAL_WISP", "EPIC"],
    ["SUBZERO_WISP", "LEGENDARY"],
  ]) {
    const cat = owned(id, tier);
    assert.ok(cat.done.has(`pet_PET:WISP_${tier}`), `${id} is a ${tier.toLowerCase()} Wisp`);
  }
});

test("every pet alias points at a pet the catalogue actually has", () => {
  const keys = new Set(data.pets.pets.map((p) => p.key));
  for (const [id, target] of Object.entries(data.petApiKeys.aliases)) {
    assert.ok(keys.has(target), `${id} is aliased to ${target}, which is not in the catalogue`);
  }
});

/* ------------------------------------------------------------ attributes */

/**
 * When the game moves an attribute it writes the same key with `_new` on the end and leaves the
 * old one holding whatever it had at the time. A maxed profile carries humanoid_ruler at 48 and
 * humanoid_ruler_new at 64, and reading the first offered the last level of an attribute that
 * was already full.
 */
test("a migrated attribute is read from the key the game moved it to", () => {
  const { tasks, done } = catalogFor({ attributes: { stacks: { humanoid_ruler: 48, humanoid_ruler_new: 64 } } });
  const rows = tasks.filter((t) => t.id.startsWith("attribute_humanoid_ruler_"));
  assert.ok(rows.length > 0, "the attribute is modelled");
  assert.deepEqual(rows.filter((t) => !done.has(t.id)), [], "64 shards is the uncommon maximum");
});

test("an attribute with only the old key still reads", () => {
  // The fallback matters: most attributes have never been moved and carry no `_new` at all.
  const { done } = catalogFor({ attributes: { stacks: { humanoid_ruler: 64 } } });
  assert.ok(done.has("attribute_humanoid_ruler_10"), "the plain key is still matched");
});

/* --------------------------------------------------------------- harp songs */

/**
 * Four of a song's five recorded percentages pay SkyBlock XP. The wiki's task table lists 50, 70,
 * 80 and 90 for each of the thirteen songs — 52 rows, each percentage appearing exactly thirteen
 * times — and 100 appears nowhere in it. The game does record a SONG_..._100 for finishing a song
 * outright, and a maxed profile carries all thirteen, but that pays intelligence and Melody's
 * Hair rather than levels XP.
 */
test("finishing a harp song outright pays no SkyBlock XP", () => {
  const songs = data.tasks.tasks.filter((t) => t.id.startsWith("SONG_"));
  assert.equal(songs.length, 52, "thirteen songs at four paying percentages");
  assert.deepEqual(songs.filter((t) => t.id.endsWith("_100")), []);
  assert.equal(songs.reduce((s, t) => s + t.xp, 0), 236);
});

/* ---------------------------------------------------------------- museum */

/**
 * A set's upgrade parent is carried by its pieces, and by *some* of them rather than all. The
 * Crimson Hunter is upgraded by the Vanquished set, and the two pieces that say so are the Ghast
 * Cloak and the Glowstone Gauntlet — its Blaze Helmet only knows that Blaze becomes Frozen
 * Blaze. Reading the parent off whichever piece came first lost it, and a maxed player was told
 * to donate a Blaze set they had long since upgraded away.
 */
test("a set's upgrade parent is found on whichever piece states it", () => {
  const sets = new Map(data.museum.armorSets.map((s) => [s.setId, s]));
  assert.equal(sets.get("CRIMSON_HUNTER")?.parentId, "VANQUISHED");
  assert.equal(sets.get("BLAZE")?.parentId, "FROZEN_BLAZE");
});

test("no two armour sets answer to the same name", () => {
  // Every set takes its name from a piece, and a piece can belong to more than one set — which
  // left two sets called "Blaze", two "Prismarine Necklace" and two "Skeleton's". A row naming a
  // set that is not the one it means cannot be acted on.
  const byName = new Map<string, string[]>();
  for (const set of data.museum.armorSets) byName.set(set.name, [...(byName.get(set.name) ?? []), set.setId]);
  const shared = [...byName].filter(([, ids]) => ids.length > 1);
  assert.deepEqual(shared, []);
  assert.equal(sets(data).get("CRIMSON_HUNTER")?.name, "Crimson Hunter");
});

const sets = (d: typeof data) => new Map(d.museum.armorSets.map((s) => [s.setId, s]));

/**
 * The two halves are credited from different places because only one of them is knowable. The
 * milestones are exact and come off the profile; the tiers are computed from the kills, which is
 * short wherever a mob id cannot be placed. Neither is inflated to cover the other, and the pair
 * is checked against the category total — crediting more than the bestiary holds is what the old
 * reading did, at 10,260 against a stated 4,370.
 */
test("bestiary milestones pay ten for every ten of them", () => {
  const { earnedOutsideTasks } = catalogFor({ bestiary: { milestone: { last_claimed_milestone: 314 } } });
  // No kills here, so no tiers — what is left is the milestone half alone.
  assert.equal(earnedOutsideTasks.bestiary, 310);
});

test("bestiary XP earned can never exceed what the category holds", () => {
  const absurd = catalogFor({ bestiary: { milestone: { last_claimed_milestone: 99_999 } } });
  assert.equal(absurd.earnedOutsideTasks.bestiary, data.bestiary.totals.statedTotal);
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

/**
 * The wiki writes Arthropod Ruler where the game writes arachno, and about a sixth of the list
 * disagrees like that. The join used to be guessed at runtime, where a miss was indistinguishable
 * from an attribute the player had never started — so every unmatched attribute was held back,
 * and with them every attribute the player simply had not begun. A profile with 170 of 320
 * started was offered 747 XP where 2,309 were outstanding.
 *
 * The join is settled at build time now, against the id list three maxed profiles agree on, so
 * an attribute absent from a profile means zero shards and is offered in full.
 */
test("an attribute the player has not started is offered in full", () => {
  const started = catalogFor({ attributes: { stacks: { speed: 96 } } });
  const offered = started.tasks.filter((t) => t.category === "attributes" && !started.done.has(t.id));
  const arthropod = offered.filter((t) => t.name.startsWith("Arthropod Ruler "));
  assert.equal(arthropod.length, 10, "no arachno shards on this profile, so all ten levels are ahead");

  // And the one the profile *has* maxed is not offered at all. Matched on the id, because
  // "Speed Ruler" and "Speed Wisdom" are different attributes that start with the same word.
  const speed = started.tasks.filter((t) => /^attribute_speed_d+$/.test(t.id) && !started.done.has(t.id));
  assert.deepEqual(speed, [], "96 shards is past the uncommon maximum of 64");

  // A profile that reports nothing is the same case, not a special one.
  const fresh = catalogFor({});
  assert.ok(fresh.tasks.filter((t) => t.category === "attributes").length > 3_000);
});

/**
 * What is still held back: the handful whose id no evidence can single out. Four of the wiki's
 * attributes have no counterpart the game reports — its list carries 321 against the game's 320
 * — and offering ten levels of one a player may already have maxed is the error worth avoiding.
 */
test("an attribute with no id at all is held back", () => {
  const unplaceable = data.attributeShards.attributes.filter((a) => !a.apiKey);
  assert.ok(unplaceable.length > 0 && unplaceable.length < 10, `${unplaceable.length} unplaceable`);
  const offered = catalogFor({ attributes: { stacks: { speed: 96 } } }).tasks.filter(
    (t) => t.category === "attributes",
  );
  for (const attribute of unplaceable) {
    assert.equal(
      offered.some((t) => t.id.startsWith(`attribute_${attribute.key}_`)),
      false,
      `${attribute.name} has no id, so its progress cannot be read`,
    );
  }
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

/**
 * A profile with every attribute at its maximum has nothing left in the category. This is the
 * check the old runtime guess could never pass honestly: it hid unmatched attributes, so a maxed
 * profile looked finished for the wrong reason, and a half-finished one looked far closer to
 * done than it was — 747 XP outstanding against a real 2,309.
 */
test("a profile with every attribute maxed is offered nothing", () => {
  const stacks: Record<string, number> = {};
  // 96 is the largest of the five maxima, so this is at or past every one of them.
  for (const key of data.attributeApiKeys.gameKeys.keys) stacks[key] = 96;
  const cat = catalogFor({ attributes: { stacks } });
  const open = cat.tasks.filter((t) => t.category === "attributes" && !cat.done.has(t.id));
  assert.deepEqual(open, [], `${open.length} levels offered to a profile that has them all`);
});

/**
 * And one with nothing has the whole category ahead of it, which must come to what the game
 * publishes: 320 attributes at ten levels each. What is short of 3,200 is the handful whose id
 * no evidence can settle, and that is reported rather than quietly missing.
 */
test("an untouched profile is offered the whole category", () => {
  const cat = catalogFor({});
  const rows = cat.tasks.filter((t) => t.category === "attributes");
  const unplaceable = data.attributeShards.attributes.filter((a) => !a.apiKey).length;
  const placeable = data.attributeApiKeys.gameKeys.total - Object.keys(data.attributeApiKeys.gameKeys.stale ?? {}).length;

  assert.equal(rows.length % 10, 0, "ten levels an attribute");
  assert.equal(rows.length / 10, data.attributeShards.attributes.length - unplaceable);
  assert.ok(
    rows.length >= (placeable - unplaceable) * 10,
    `${rows.length} levels modelled, short of the ${placeable * 10} the game publishes`,
  );
});
