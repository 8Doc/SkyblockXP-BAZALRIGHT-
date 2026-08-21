import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { accessoryPowerOf, familyOf } from "../src/lib/gameData";
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

/**
 * Three upgrade lines the wiki records badly, all reported from NobelErso's maxed profile as
 * accessories he was told to buy while already holding the finished article. The Artifact of
 * the Century has no wiki page at all, and the Gratitude Artifact's page names itself as its
 * own upgrade, so neither line can be read from `upgrades_from` alone.
 */
test("half-documented upgrade lines still come out as one family", () => {
  const byName = new Map(accessories.accessories.map((a) => [a.name, a.id]));
  const lines = [
    ["Ring of the Century", "Talisman of the Century", "Artifact of the Century"],
    ["Raggedy Shark Tooth Necklace", "Dull Shark Tooth Necklace", "Honed Shark Tooth Necklace"],
    ["Gratitude Ring", "Gratitude Artifact"],
  ];
  for (const line of lines) {
    const families = line.map((name) => {
      const id = byName.get(name);
      assert.ok(id, `${name} is missing from the catalogue`);
      return familyOf(data, name, id!);
    });
    assert.equal(new Set(families).size, 1, `${line.join(" / ")} split into ${[...new Set(families)].join(", ")}`);
  }
});

/**
 * The game refuses a Recombobulator on nine accessories, and offering the upgrade anyway sells
 * a player something they cannot buy. The items resource states it outright.
 */
test("accessories the game will not recombobulate are marked as such", () => {
  const refused = accessories.accessories.filter((a) => a.recombobulable === false).map((a) => a.name);
  for (const name of ["Pandora's Box", "Book of Progression", "Safety Badge", "Supreme Voter's Badge", "Rift Prism"]) {
    assert.ok(refused.includes(name), `${name} should be flagged as un-recombobulatable`);
  }
  assert.ok(refused.length < 20, `${refused.length} refusals looks like the flag has inverted`);
});

/**
 * The community wiki is the only source for some of this. Its page for the Applicant's Statement
 * — which Fandom has never had — is the only place recording that it upgrades into Student's
 * Studies, and its Admin-only register is the only place naming the Old Boot and the Ring of
 * Space, two accessories with no page of their own on either wiki.
 */
test("the academic line starts at the Applicant's Statement", () => {
  const byName = new Map(accessories.accessories.map((a) => [a.name, a.id]));
  const line = ["Applicant's Statement", "Student's Studies", "Master's Thesis"];
  const families = line.map((name) => familyOf(data, name, byName.get(name)!));
  assert.equal(new Set(families).size, 1, `split into ${[...new Set(families)].join(", ")}`);
});

/**
 * Guarded in both directions, because both mistakes were made. Admin curios and items removed
 * from the game were being sold to a maxed player; then a Legacy banner was read as "gone",
 * which wrongly condemned three Hats of Celebration that are auctionable to this day and sit in
 * top players' bags.
 */
test("only what no player can hold is written off as unobtainable", () => {
  const written = new Map(accessories.accessories.filter((a) => a.unobtainable).map((a) => [a.name, a.unobtainable]));
  for (const name of ["Grizzly Paw", "Talisman of Space", "Ring of Space", "Old Boot"]) {
    assert.equal(written.get(name), "admin only", `${name} is an admin-only curio`);
  }
  for (const name of ["Compass Talisman", "Eternal Crystal", "Luck Talisman"]) {
    assert.equal(written.get(name), "removed from the game", `${name} was removed from the game`);
  }
  for (const name of ["Crab Hat of Celebration", "Sloth Hat of Celebration"]) {
    assert.ok(!written.has(name), `${name} is still auctionable and held by top players`);
  }
  assert.ok(written.size < 30, `${written.size} write-offs looks like a rule has gone too wide`);
});

/**
 * The whole accessory bag, measured against the figure the wiki publishes. A player reported the
 * category reaching only 1,850 of the 2,122 the game has, and every piece of that shortfall was
 * a rule we had wrong: Rift accessories written off wholesale when seven of them transfer out,
 * the Hegemony Artifact's doubling, the Rift Prism's fixed eleven, the Abicase's one per two
 * Abiphone contacts. What is left is the six accessories whose rarity climbs in place.
 */
test("our ceiling lands within the climbing accessories of the wiki's", () => {
  const order = magicalPower.rarityOrder;
  const contacts = 71;
  const best = new Map<string, number>();
  for (const accessory of accessories.accessories) {
    if ((accessory.rift && !accessory.riftTransferrable) || accessory.unobtainable) continue;
    const top =
      accessory.recombobulable === false
        ? accessory.tier
        : order[Math.min(order.indexOf(accessory.tier) + 1, order.length - 1)] ?? accessory.tier;
    const power = accessoryPowerOf(data, accessory.id, top, contacts);
    if (power <= 0) continue;
    const family = familyOf(data, accessory.name, accessory.id);
    best.set(family, Math.max(best.get(family) ?? 0, power));
  }
  let ceiling = 0;
  for (const power of best.values()) ceiling += power;

  const stated = magicalPower.maximum!.power;
  const climbing = magicalPower.climbing!.items.reduce((sum, item) => sum + item.forgone, 0);
  const allowed = climbing + magicalPower.unlisted!.power;
  assert.ok(
    ceiling <= stated,
    `our ceiling of ${ceiling} is above the wiki's stated ${stated}, so something is double counted`,
  );
  assert.ok(
    stated - ceiling <= allowed,
    `${stated - ceiling} accessory power unaccounted for, more than the ${allowed} that the climbing accessories and the wiki's own unlisted six explain`,
  );
});
