import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { familyOf } from "../src/lib/gameData";
import accessories from "../data/generated/accessories.json";
import accessoryFamilies from "../data/curated/accessory_families.json";
import magicalPower from "../data/curated/magical_power.json";

import accessoryChains from "../data/generated/accessory_trade.json";

const data = { accessories, accessoryFamilies, magicalPower, accessoryChains } as never;
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

test("the Rift's accessories belong to the Rift's bag, not this one", () => {
  // 29 of them, 261 magical power. Counting them here told a player who owns every accessory
  // that reaches the main bag that a Crux line he can never put in it was still outstanding.
  const list = (accessories as { accessories: { id: string; name: string; rift?: boolean }[] }).accessories;
  const rift = list.filter((a) => a.rift);
  assert.ok(rift.length > 20, `only ${rift.length} rift accessories flagged`);
  assert.ok(rift.some((a) => a.name.startsWith("Crux ")), "the Crux line is rift-bound");
});

test("an accessory crafted from another is already one family", () => {
  // The wiki records what each accessory is made from; where an ingredient is itself an
  // accessory, the two are one progression because the ingredient is consumed. All 16 such
  // pairs are already detected, so recipes need no separate rule — this guards that.
  const links = JSON.parse(readFileSync("data/generated/accessory_trade.json", "utf8")).craftedFrom as {
    id: string; name: string; from: string; fromName: string;
  }[];
  assert.ok(links.length > 10, `only ${links.length} craft links found`);

  const byId = new Map(
    (accessories as { accessories: { id: string; name: string; rift?: boolean }[] }).accessories.map((a) => [a.id, a]),
  );
  for (const link of links) {
    const product = byId.get(link.id);
    const ingredient = byId.get(link.from);
    if (!product || !ingredient) continue;
    // Rift accessories never reach this bag, so their families are moot — and the wiki carries a
    // typo page for one of them that resolves to no accessory of its own.
    if (product.rift || ingredient.rift) continue;
    // Chains are keyed by item id, so the ids have to be the ones passed in.
    assert.equal(
      familyOf(data, product.name, product.id),
      familyOf(data, ingredient.name, ingredient.id),
      `${link.name} is crafted from ${link.fromName}, so they are one family`,
    );
  }
});

test("an upgrade line is one family however long it runs", () => {
  // Named by the wiki's upgrades_from, which raw_materials cannot give: that field breaks a
  // recipe down to bazaar goods, so Sunshine Crystal reads as quartz and sunflowers rather than
  // as a Day Crystal.
  const list = (accessories as { accessories: { id: string; name: string }[] }).accessories;
  const byName = new Map(list.map((a) => [a.name, a]));
  const oneFamily = (names: string[]) => {
    const found = names.map((n) => byName.get(n)).filter(Boolean) as { id: string; name: string }[];
    assert.equal(found.length, names.length, `missing one of ${names.join(", ")}`);
    const fams = new Set(found.map((a) => familyOf(data, a.name, a.id)));
    assert.equal(fams.size, 1, `${names.join(" / ")} split into ${fams.size} families`);
  };

  oneFamily(["Day Crystal", "Sunshine Crystal"]);
  oneFamily(["Night Crystal", "Moonlight Crystal"]);
  oneFamily(["Bait Ring", "Spiked Atrocity"]);
  oneFamily(["Kuudra's Kidney", "Kuudra's Lung", "Kuudra's Heart"]);
  // Four deep, and no two of them share a word.
  oneFamily(["Cropie Talisman", "Squash Ring", "Fermento Artifact", "Helianthus Relic"]);
});

test("accessories the items resource ships with no tier are still catalogued", () => {
  // Four of them were sitting in a top player's accessory bag, unreadable, so his magical power
  // came out short and their families read as untouched.
  const list = (accessories as { accessories: { id: string; tier: string }[] }).accessories;
  const byId = new Map(list.map((a) => [a.id, a]));
  for (const id of ["RUNEBOOK", "POCKET_ESPRESSO_MACHINE", "NIGHT_VISION_CHARM", "HANDY_BLOOD_CHALICE"]) {
    assert.ok(byId.get(id), `${id} should be catalogued from the wiki's rarity`);
  }
});
