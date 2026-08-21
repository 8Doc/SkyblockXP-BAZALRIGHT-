import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { familyOf, grantsMagicalPower, scoreBag } from "../src/lib/gameData";
import accessories from "../data/generated/accessories.json";
import accessoryFamilies from "../data/curated/accessory_families.json";
import accessoryUpgrades from "../data/generated/accessory_upgrades.json";
import magicalPower from "../data/curated/magical_power.json";

const data = { accessories, accessoryFamilies, accessoryUpgrades, magicalPower } as never;
const family = (name: string) => familyOf(data, name, name);

/**
 * Members of one family compete rather than stack, so a family we fail to detect makes the bag
 * offer a downgrade as an upgrade — the reported symptom was Scarf's Studies being sold to a
 * player who already owned Scarf's Thesis.
 */
test("a family climbing through Studies, Thesis and Grimoire is one family", () => {
  const scarf = ["Scarf's Studies", "Scarf's Thesis", "Scarf's Grimoire"].map(family);
  assert.equal(new Set(scarf).size, 1, `split into ${new Set(scarf).size}`);
});

test("the academic line is a different family, despite sharing all three nouns", () => {
  const academic = ["Student's Studies", "Master's Thesis", "PhD's Grimoire"].map(family);
  assert.equal(new Set(academic).size, 1);
  assert.notEqual(academic[0], family("Scarf's Thesis"), "Master's Thesis is not a Scarf accessory");
});

test("families whose tier is a leading adjective are still one family", () => {
  for (const [label, names] of [
    ["gift talismans", ["White Gift Talisman", "Green Gift Talisman", "Blue Gift Talisman", "Purple Gift Talisman", "Gold Gift Talisman"]],
    ["chocolate", ["Nibble Chocolate Stick", "Smooth Chocolate Bar", "Rich Chocolate Chunk", "Ganache Chocolate Slab", "Prestige Chocolate Realm"]],
    ["odger's teeth", ["Odger's Bronze Tooth", "Odger's Silver Tooth", "Odger's Gold Tooth", "Odger's Diamond Tooth"]],
    ["soulflow", ["Soulflow Pile", "Soulflow Battery", "Soulflow Supercell"]],
  ] as [string, string[]][]) {
    const found = new Set(names.map(family));
    assert.equal(found.size, 1, `${label} split into ${found.size}: ${[...found].join(", ")}`);
  }
});

test("Heirloom, Badge and Chronomicon are upgrade steps, not new families", () => {
  assert.equal(family("Bingo Heirloom"), family("Bingo Talisman"));
  assert.equal(family("Crux Chronomicon"), family("Crux Ring"));
  assert.equal(family("Pesthunter Badge"), family("Pesthunter Ring"));
});

/* ------------------------------------------------ lines that rename as they climb */

/**
 * The reported symptom: the bag kept listing accessories the player had already upgraded past.
 * A name rule cannot see these families, because no two tiers share a word — the wiki's
 * `upgrades_from` is the only thing that joins them, and nothing in the items resource does.
 */
test("an upgrade line that renames at every step is still one family", () => {
  for (const [label, names] of [
    ["the farming line", ["Cropie Talisman", "Squash Ring", "Fermento Artifact", "Helianthus Relic"]],
    ["the cat line", ["Cat Talisman", "Lynx Talisman", "Cheetah Talisman"]],
    ["the shady line", ["Shady Ring", "Crooked Artifact", "Seal of the Family"]],
    ["kuudra's organs", ["Kuudra's Kidney", "Kuudra's Lung", "Kuudra's Heart"]],
    ["the night line", ["Night Crystal", "Moonlight Crystal"]],
    ["the day line", ["Day Crystal", "Sunshine Crystal"]],
  ] as [string, string[]][]) {
    const found = new Set(names.map(family));
    assert.equal(found.size, 1, `${label} split into ${found.size}: ${[...found].join(", ")}`);
  }
});

test("the wiki's edges compose, so the ends of a long line meet in the middle", () => {
  // Three separate `upgrades_from` statements are what make Cropie and Helianthus one family.
  // Reading them one at a time, without a union, would leave the two ends apart.
  assert.equal(family("Cropie Talisman"), family("Helianthus Relic"));
  assert.equal(family("Crux Talisman"), family("Celestial Starstone"));
});

test("merging a renamed tier in leaves the family under the name most of it already had", () => {
  // Celestial Starstone joins the Crux line, but the family stays "crux" rather than being
  // renamed after its newest member — plans and group keys stay recognisable.
  assert.equal(family("Crux Ring"), "crux");
});

test("every upgrade edge the wiki states ends up inside one family", () => {
  const byId = new Map(
    (accessories as { accessories: { id: string; name: string }[] }).accessories.map((a) => [a.id, a]),
  );
  const split = accessoryUpgrades.edges.filter((e) => {
    const child = byId.get(e.child);
    const parent = byId.get(e.parent);
    return child && parent && family(child.name) !== family(parent.name);
  });
  assert.deepEqual(split, [], "an upgrade the planner would still offer as a separate purchase");
});

/**
 * Two ladders, not one. The pattern that catches the campfire badges was unanchored, so it also
 * swallowed the soul ones and counted 26 badges as tiers of a family they have nothing to do
 * with — magical power the player really holds, hidden.
 */
test("the soul campfire ladder is separate from the ordinary one", () => {
  const ordinary = ["Campfire Adept Badge I", "Campfire Cultist Badge V", "Campfire God Badge IX"].map(family);
  const soul = ["Soul Campfire Adept Badge I", "Soul Campfire Cultist Badge V", "Soul Campfire God Badge IX"].map(family);

  assert.equal(new Set(ordinary).size, 1, "the ordinary badges are one ladder");
  assert.equal(new Set(soul).size, 1, "the soul badges are one ladder");
  assert.notEqual(ordinary[0], soul[0], "but they are not the same ladder");
});

test("both campfire ladders are whole, so no badge is stranded on its own", () => {
  const list = (accessories as { accessories: { id: string; name: string }[] }).accessories;
  const badges = list.filter((a) => /Campfire .*Badge/.test(a.name));
  // 26 a side. A badge falling through to a family of its own would show up here as a third key.
  assert.equal(badges.length, 52, `expected 52 campfire badges, found ${badges.length}`);
  assert.deepEqual(new Set(badges.map((a) => family(a.name))).size, 2);
});

test("accessories that merely share a word are left apart", () => {
  assert.notEqual(family("Broken Piggy Bank"), family("Ring of Broken Love"));
  assert.notEqual(family("Grizzly Paw"), family("Wolf Paw"));
  assert.notEqual(family("Eternal Crystal"), family("Eternal Hoof"));
});

/* ------------------------------------------------------- attribute ladders */

import attributeLevels from "../data/curated/attribute_levels.json";

const cumulative = (rarity: string) => {
  let running = 0;
  return attributeLevels.perLevel[rarity as keyof typeof attributeLevels.perLevel].map((s) => (running += s));
};

/**
 * A rarer attribute levels on far fewer shards. Reading every attribute off the common ladder
 * made each maxed legendary look like level 5 of 10, so the app invented five levels, priced
 * them, and sold them.
 */
test("each rarity maxes at its own shard count", () => {
  assert.deepEqual(
    ["COMMON", "UNCOMMON", "RARE", "EPIC", "LEGENDARY"].map((r) => cumulative(r)[9]),
    [96, 64, 48, 32, 24],
    "these five are exactly the five largest values seen in member.attributes.stacks",
  );
});

test("every ladder has ten levels and never goes backwards", () => {
  for (const rarity of Object.keys(attributeLevels.perLevel)) {
    const ladder = cumulative(rarity);
    assert.equal(ladder.length, 10, `${rarity} has ${ladder.length} levels`);
    assert.equal(ladder[0], 1, `${rarity} level 1 should cost one shard`);
    for (let i = 1; i < ladder.length; i++) {
      assert.ok(ladder[i] > ladder[i - 1], `${rarity} level ${i + 1} is not above level ${i}`);
    }
  }
});

test("a rarer attribute never needs more shards than a commoner one", () => {
  const order = ["COMMON", "UNCOMMON", "RARE", "EPIC", "LEGENDARY"].map(cumulative);
  for (let r = 1; r < order.length; r++) {
    for (let level = 0; level < 10; level++) {
      assert.ok(order[r][level] <= order[r - 1][level], `rarity ${r} level ${level + 1} costs more than the tier below`);
    }
  }
});

/* ------------------------------------------------- accessory list coverage */

test("the base Talisman of a family is in the list, not dropped for want of a rarity", () => {
  // The items resource ships 38 accessories with no tier. Dropping them left the bag unable to
  // credit magical power for an accessory it didn't know, and made the family look empty — so
  // it offered the Ring of a family whose Talisman the player already wore.
  const byName = new Map(
    (accessories as { accessories: { name: string; tier: string }[] }).accessories.map((a) => [a.name, a]),
  );

  for (const name of ["Feather Talisman", "Sea Creature Talisman", "Talisman of Coins", "Bat Person Talisman"]) {
    const found = byName.get(name);
    assert.ok(found, `${name} is missing from the accessory list`);
    assert.equal(found.tier, "COMMON", `${name} should be the common base of its family`);
  }
});

test("a family's Talisman, Ring and Artifact all resolve to one family", () => {
  for (const stem of ["Feather", "Sea Creature", "Bat Person"]) {
    const tiers = [`${stem} Talisman`, `${stem} Ring`, `${stem} Artifact`].map(family);
    assert.equal(new Set(tiers).size, 1, `${stem} split into ${new Set(tiers).size} families`);
  }
});

/* ------------------------------- magical power the bag's contents don't show */

/**
 * Three accessories are scored by their own rule rather than by rarity, and two of them leave no
 * trace in the bag at all. Measured against a maxed profile they were worth 75 magical power
 * between them, which is most of what the model was missing.
 */
test("Hegemony grants its magical power twice over", () => {
  const bare = scoreBag(data, [{ id: "BAT_ARTIFACT", rarityUpgrades: 0, rarity: null }], null);
  const heg = scoreBag(
    data,
    [
      { id: "BAT_ARTIFACT", rarityUpgrades: 0, rarity: null },
      { id: "HEGEMONY_ARTIFACT", rarityUpgrades: 0, rarity: "MYTHIC" },
    ],
    null,
  );
  // 22 for the accessory, and 22 again for being the Hegemony.
  assert.equal(heg.computedMp - bare.computedMp, 44);
});

test("an Abicase turns Abiphone contacts into magical power, one per two", () => {
  const bag = [{ id: "ABICASE", rarityUpgrades: 0, rarity: null }];
  const none = scoreBag(data, bag, null, 0, { abiphoneContacts: 0 });
  const many = scoreBag(data, bag, null, 0, { abiphoneContacts: 84 });
  assert.equal(many.computedMp - none.computedMp, 42);
});

/**
 * The prism is consumed when it is imbued, so there is nothing left in the bag to find it by —
 * only `rift.access.consumed_prism` on the profile says it happened. Without reading that, the
 * planner both lost the 11 magical power and went on offering the prism as XP still to buy.
 */
test("an imbued Rift Prism keeps paying after it is consumed", () => {
  const without = scoreBag(data, [], null, 0, {});
  const imbued = scoreBag(data, [], null, 0, { riftPrismConsumed: true });
  assert.equal(imbued.computedMp - without.computedMp, 11);

  const family = familyOf(data, "Rift Prism", "RIFT_PRISM");
  assert.equal(imbued.familyPower.get(family), 11, "the family reads as filled, so it stops being offered");
  assert.equal(without.familyPower.get(family), undefined);
});

/* ------------------------------------------- what can grant magical power */

/**
 * A rift accessory that cannot leave the rift cannot go in the accessory bag, so its magical
 * power is unreachable and must never be offered as XP to buy. Seventeen of the twenty-nine
 * were, worth about 140 magical power between them.
 */
test("rift accessories that cannot leave the rift grant no magical power", () => {
  const list = (accessories as { accessories: { id: string; name: string; rift: boolean; riftTransferrable: boolean }[] })
    .accessories;
  const byId = new Map(list.map((a) => [a.id, a]));

  // CRUX_TALISMAN_6 is the Crux Chronomicon, the 22-MP top of a line that is entirely rift-bound.
  for (const id of ["CRUX_TALISMAN_6", "SATELITE", "PUNCHCARD_ARTIFACT", "RING_OF_BROKEN_LOVE"]) {
    const acc = byId.get(id);
    assert.ok(acc, `${id} is missing from the accessory list`);
    assert.equal(grantsMagicalPower(acc), false, `${id} never reaches the bag`);
  }
  // The transferrable ones do count, and an ordinary non-rift accessory is unaffected.
  for (const id of ["RIFT_PRISM", "BLUETOOTH_RING", "BAT_ARTIFACT"]) {
    const acc = byId.get(id);
    assert.ok(acc, `${id} is missing from the accessory list`);
    assert.equal(grantsMagicalPower(acc), true, `${id} should still count`);
  }
});

/**
 * Nine accessories refuse a Recombobulator and the resource says which. On a maxed profile every
 * recombobulate row the app produced was one of them — four impossible tasks, each priced at a
 * real Recombobulator 3000, the Voter's Badge among them.
 */
test("the accessories that refuse a recombobulator are flagged", () => {
  const list = (accessories as { accessories: { id: string; recombobulatable: boolean }[] }).accessories;
  const byId = new Map(list.map((a) => [a.id, a]));

  for (const id of ["VOTER_BADGE_SUPREME", "PANDORAS_BOX", "BOOK_OF_PROGRESSION", "SAFETY_BADGE", "RIFT_PRISM"]) {
    assert.equal(byId.get(id)?.recombobulatable, false, `${id} cannot be recombobulated`);
  }
  assert.equal(byId.get("BAT_ARTIFACT")?.recombobulatable, true, "an ordinary accessory still can be");
});

/* --------------------------------------------------- what can be bought */

test("accessories the wiki says cannot be bought are not priced", () => {
  // The items resource leaves can_trade and soulbound unset on plenty of untradeable things, so
  // everything defaulted to buyable and the bag's cost to finish absorbed items nobody can sell.
  const list = (accessories as { accessories: { id: string; name: string; tradeable: boolean }[] }).accessories;
  const byId = new Map(list.map((a) => [a.id, a]));

  const trade = JSON.parse(readFileSync("data/generated/accessory_trade.json", "utf8")) as {
    untradeable: { id: string; name: string }[];
  };
  const stillBuyable = trade.untradeable.filter((u) => byId.get(u.id)?.tradeable);
  assert.deepEqual(stillBuyable, [], "the wiki said no; the generated list should agree");
});

test("rift accessories never leave the rift", () => {
  const list = (accessories as { accessories: { id: string; tradeable: boolean }[] }).accessories;
  const byId = new Map(list.map((a) => [a.id, a]));
  // Two of these were being priced at a billion coins each.
  for (const id of ["CRUX_TALISMAN_6", "CRUX_TALISMAN_7"]) {
    assert.equal(byId.get(id)?.tradeable, false, `${id} is rift-bound`);
  }
});
