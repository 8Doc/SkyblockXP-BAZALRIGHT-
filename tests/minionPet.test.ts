import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
// @ts-expect-error - a plain build script, imported for its pure parsers only.
import { parseBrewing, parseMinionXp, parseXpTable, resolver, xpValue } from "../scripts/fetch-skill-xp.mjs";
import {
  bestPerSkill,
  dropsPerIngredient,
  petXpFrom,
  petXpMultiplier,
  planMinionXp,
  withWisdom,
} from "../src/lib/minionXp";
import type { PetXpRules, SkillKey, SkillXpTables } from "../src/lib/minionXp";
import {
  NET_OF_AUCTION_TAX,
  SLOW_HOURS,
  THIN_LISTINGS,
  absorbPetPage,
  createPetBinIndex,
  liquidityOf,
  maxLevelOf,
  planPetProfit,
} from "../src/lib/petLevelling";
import type { PetLevelTable } from "../src/lib/petLevelling";
import type { AuctionRecord } from "../src/lib/auctions";
import type { DropTable, Recipe } from "../src/lib/minionProfit";
import type { Fuel, MinionData, Modifiers, Upgrade } from "../src/lib/minions";

const data = JSON.parse(readFileSync("data/generated/minion-production.json", "utf8")) as MinionData;
const mods = JSON.parse(readFileSync("data/curated/minion_modifiers.json", "utf8")) as Modifiers;
const skillXp = JSON.parse(readFileSync("data/generated/skill-xp.json", "utf8")) as SkillXpTables & { unresolved: string[] };
const rules = JSON.parse(readFileSync("data/curated/pet_xp.json", "utf8")) as PetXpRules;
const levels = JSON.parse(readFileSync("data/curated/pet_levels.json", "utf8")) as PetLevelTable;
const recipes = JSON.parse(readFileSync("data/generated/recipes.json", "utf8")).recipes as Recipe[];
const names = JSON.parse(readFileSync("data/generated/bazaar_items.json", "utf8")).names as Record<string, string>;
const drops = JSON.parse(readFileSync("data/curated/minion_drops.json", "utf8")) as DropTable;

/* ------------------------------------------------------------- the scrape */

test("a blank cell is unknown and a zero is a measurement", () => {
  // The distinction the whole XP half turns on. Netherrack grants Mining XP by hand and carries a
  // blank in the minion column; Nether Wart carries a real, published +0.
  assert.equal(xpValue("{{bc}}"), null);
  assert.equal(xpValue(" class=\"ct\" | +0"), 0);
  assert.equal(xpValue(" class=\"ct\" | +0.3"), 0.3);
  assert.equal(xpValue("| +4.5"), 4.5);
  assert.equal(xpValue("0.2 {{confirm}}"), 0.2);
});

test("a rowspan carries down instead of stealing the next row's numbers", () => {
  // Red and Brown Mushroom share one XP cell. Without the carry, Brown silently inherits whatever
  // follows it in the table — a wrong number that looks entirely plausible.
  const table = `{| class="wikitable"
|{{Item|Red Mushroom}}
| rowspan="2" | +6
| rowspan="2" | +0.3
|-
|{{Item|Brown Mushroom}}
|-
|{{Item|Cocoa Beans}}
| +4
| +0.2`;
  const rows = parseMinionXp(table, "FARMING");
  const red = rows.find((r: { item: string }) => r.item === "Red Mushroom");
  const brown = rows.find((r: { item: string }) => r.item === "Brown Mushroom");
  const cocoa = rows.find((r: { item: string }) => r.item === "Cocoa Beans");
  assert.equal(red.minionXp, 0.3);
  assert.equal(brown.minionXp, 0.3);
  assert.equal(cocoa.minionXp, 0.2);
});

test("parseXpTable pads short rows and replaces on full ones", () => {
  const rows = parseXpTable(`{| class="wikitable"\n|a\n|1\n|2\n|-\n|b\n|-\n|c\n|9\n|8`, 3);
  assert.deepEqual(rows.map((r: string[]) => r[1]), ["1", "1", "9"]);
});

test("a brewing ingredient is listed once at its best yield", () => {
  const rows = parseBrewing(
    `{{Slot|Sugar}}{{Skill XP|5 Alchemy}}\n{{Slot|Sugar}}{{Skill XP|5 Alchemy}}\n{{Slot|Enchanted Sugar}}{{Skill XP|300 Alchemy}}`,
  );
  assert.equal(rows.length, 2);
  assert.equal(rows[0].xp, 300);
});

test("ore rows resolve to the item SkyBlock actually has", () => {
  // There is no ore item in SkyBlock — the Iron Minion's drop and collection are both Iron Ingot.
  const resolve = resolver(names, { SUGAR: { sell: 2 } });
  assert.equal(resolve("Iron Ore"), "IRON_INGOT");
  assert.equal(resolve("Gold Ore"), "GOLD_INGOT");
  // And the vanilla brewing ingredients no bazaar carries come off the shopkeeper table instead.
  assert.equal(resolve("Sugar"), "SUGAR");
  assert.equal(resolve("Not A Real Item"), null);
});

/* ------------------------------------------------------------ the sources */

test("the scraped table keeps unknown apart from zero", () => {
  const wart = skillXp.perItem.find((r) => r.item === "Nether Wart")!;
  const netherrack = skillXp.perItem.find((r) => r.item === "Netherrack")!;
  // Published as exactly nothing.
  assert.equal(wart.minionXp, 0);
  // Published as nothing at all, which is a different claim.
  assert.equal(netherrack.minionXp, null);
});

test("minion XP is not a fixed fraction of the player's, in either direction", () => {
  const wheat = skillXp.perItem.find((r) => r.item === "Wheat")!;
  const ice = skillXp.perItem.find((r) => r.item === "Ice")!;
  assert.ok(wheat.minionXp! < wheat.playerXp!);
  // Ice pays *more* from a minion than by hand. Any model that scaled one column from the other
  // would get this backwards.
  assert.ok(ice.minionXp! > ice.playerXp!);
});

/* --------------------------------------------------------------- the chain */

/**
 * A player, with Wisdom given as one number for brevity and spread across every skill.
 *
 * Wisdom is per skill in the model, but every test here exercises one skill at a time, so taking a
 * single figure and applying it to all of them keeps the cases readable without weakening them.
 */
const player = (over: Partial<{ wisdom: number; taming: number; petSkill: SkillKey | null }> = {}) => {
  const { wisdom = 0, ...rest } = over;
  const all: Partial<Record<SkillKey, number>> = {};
  for (const skill of ["FARMING", "MINING", "COMBAT", "FORAGING", "FISHING", "ALCHEMY", "ENCHANTING", "CARPENTRY", "TAMING"] as SkillKey[]) {
    all[skill] = wisdom;
  }
  return { wisdom: all, taming: 0, petSkill: null as SkillKey | null, ...rest };
};

test("wisdom scales the skill XP and taming scales the pet XP", () => {
  // The wiki's own worked example: +10 Combat XP at 10 Combat Wisdom is +11.
  assert.equal(withWisdom(10, 10), 11);
  // Zoologist is +1% a level, so Taming 60 is a flat x1.60 on a matching pet.
  assert.equal(petXpMultiplier("FARMING", player({ taming: 60, petSkill: "FARMING" }), rules), 1.6);
  assert.equal(petXpMultiplier("FARMING", player({ petSkill: "FARMING" }), rules), 1);
});

test("the order of the two matters, and additive goes first", () => {
  // 100 raw XP, 50 wisdom, taming 60, matching pet: 100 * 1.5 * 1.6.
  assert.equal(petXpFrom(100, "FARMING", player({ wisdom: 50, taming: 60, petSkill: "FARMING" }), rules), 240);
});

test("a mismatched pet keeps a third, and an alchemy mismatch keeps a twelfth", () => {
  const mismatch = petXpMultiplier("FARMING", player({ petSkill: "COMBAT" }), rules);
  assert.ok(Math.abs(mismatch - 1 / 3) < 1e-9);

  // The fact that decides the brewing route: 15,000 Alchemy XP reaches an ordinary pet as 1,250.
  const alchemy = petXpMultiplier("ALCHEMY", player({ petSkill: "COMBAT" }), rules);
  assert.ok(Math.abs(alchemy - 1 / 12) < 1e-9);
  // And the two penalties are alternatives rather than a stack.
  assert.ok(alchemy > 1 / 36);
});

test("carpentry levels the skill and no pet at all", () => {
  assert.equal(petXpMultiplier("CARPENTRY", player({ petSkill: "CARPENTRY" }), rules), 0);
  assert.equal(petXpFrom(1_000_000, "CARPENTRY", player({ taming: 60 }), rules), 0);
});

test("fishing is the one skill that pays a bonus rather than a penalty", () => {
  assert.equal(petXpMultiplier("FISHING", player({ petSkill: "FISHING" }), rules), 1.5);
});

/* ------------------------------------------------------------- the brewing */

test("a brewing ingredient costs the whole chain of drops beneath it", () => {
  // Enchanted Sugar Cane is 160 Enchanted Sugar and Enchanted Sugar is 160 Sugar Cane, so one
  // ingredient is 25,600 drops. Assuming a single step values it at 160 times what it is worth
  // and puts sugar cane at the top of every list in the app.
  assert.equal(dropsPerIngredient("ENCHANTED_SUGAR_CANE", "SUGAR_CANE", recipes), 25_600);
  // Cactus is the same shape: Enchanted Cactus is 160 Enchanted Cactus Green and that is 160
  // Cactus, so the chain is two steps here too.
  assert.equal(dropsPerIngredient("ENCHANTED_CACTUS", "CACTUS", recipes), 25_600);
  // One step where there is only one step.
  assert.equal(dropsPerIngredient("ENCHANTED_CACTUS_GREEN", "CACTUS", recipes), 160);
  // An ingredient no chain of single-ingredient recipes reaches is not this minion's route.
  assert.equal(dropsPerIngredient("ENCHANTED_SUGAR_CANE", "COBBLESTONE", recipes), null);
});

/* ---------------------------------------------------------------- the plan */

const fuel = (id: string): Fuel => mods.fuels.find((f) => f.id === id)!;
const upgrade = (id: string): Upgrade => mods.upgrades.find((u) => u.id === id)!;

function xpPlan(over: Partial<Parameters<typeof planMinionXp>[0]> = {}) {
  const byName = new Map<string, string>();
  for (const [id, name] of Object.entries(names)) {
    const key = name.toLowerCase();
    if (!byName.has(key)) byName.set(key, id);
  }
  return planMinionXp({
    data,
    tables: skillXp,
    rules,
    player: player({ petSkill: null }),
    setup: { tier: 12, fuel: fuel("NONE"), upgrades: [upgrade("NONE"), upgrade("NONE")], count: 1 },
    dropIdFor: (m) => drops.overrides[m.generator]?.itemId ?? byName.get(m.collects.item.trim().toLowerCase()) ?? m.collectionId,
    names,
    recipes,
    ...over,
  });
}

test("only the most compacted brewing form of a drop is planned", () => {
  const cactus = xpPlan().filter((r) => r.generator === "CACTUS" && r.route === "brewing");
  // Cactus reaches three entries in the alchemy table — cactus at 10 XP, Enchanted Cactus Green at
  // 250, Enchanted Cactus at 500 — and they are three descriptions of one decision. The shallow two
  // pay about the same an hour and ask for hundreds of times the brews to do it, so nobody would
  // stand and brew them. One row, and it is the deepest chain.
  assert.equal(cactus.length, 1);
  assert.equal(cactus[0].itemId, "ENCHANTED_CACTUS");
  assert.equal(Math.round(cactus[0].itemsPerBrew ?? 0), 25_600);
});

test("a brewing route carries the skill that collecting the same drops pays", () => {
  const melon = xpPlan().find((r) => r.generator === "MELON" && r.route === "brewing")!;
  // The drops do two jobs: collecting the minion pays Farming, brewing what you collected pays
  // Alchemy. Crediting only the Alchemy half was throwing the larger of the two away.
  assert.equal(melon.skill, "ALCHEMY");
  assert.equal(melon.baseSkill, "FARMING");
  assert.ok((melon.baseXpPerHour ?? 0) > 0);
  assert.ok(melon.caveats.some((c) => /do two jobs/i.test(c)));

  // A drop with no published direct rate has no second half to claim, and says nothing rather than
  // claiming a zero — the same rule the direct rows follow.
  const blaze = xpPlan().find((r) => r.generator === "BLAZE" && r.route === "brewing")!;
  assert.equal(blaze.baseSkill, undefined);
});

test("a minion with no published rate scores zero and says why", () => {
  const rows = xpPlan().filter((r) => r.route === "direct");
  const oak = rows.find((r) => r.generator === "OAK")!;
  assert.equal(oak.petXpPerHour, 0);
  assert.ok(oak.caveats.some((c) => /not published|unknown/i.test(c)));
  // It still files under a skill, so it is visible rather than missing.
  assert.equal(oak.skill, "FORAGING");
});

test("a minion with a published rate carries it through to pet XP", () => {
  const rows = xpPlan({ player: player({ wisdom: 100, taming: 60, petSkill: "FARMING" }) }).filter((r) => r.route === "direct");
  const wheat = rows.find((r) => r.generator === "WHEAT")!;
  assert.equal(wheat.xpPerItem, 0.3);
  assert.ok(Math.abs(wheat.skillXpPerHour - wheat.baseSkillXpPerHour * 2) < 1e-6);
  assert.ok(Math.abs(wheat.petXpPerHour - wheat.skillXpPerHour * 1.6) < 1e-6);
});

test("the item infoboxes cover the skills the two tables never mention", () => {
  const best = bestPerSkill(xpPlan().filter((r) => r.route === "direct"));
  // Farming and Mining come from the skill pages' Minion XP columns.
  assert.ok(best.get("FARMING"));
  assert.ok(best.get("MINING"));
  // These three come from `|minion_xp=` on individual item pages, which is the only place they are
  // published at all — the skill pages carry no such column. Before that source was added, all
  // three read "not published" and a Fishing Minion looked like it granted nothing.
  assert.ok(best.get("FORAGING"), "Jungle Log publishes 0.1 Foraging");
  assert.ok(best.get("FISHING"), "Raw Cod publishes 0.5 Fishing");
  assert.ok(best.get("COMBAT"), "Spider Eye publishes 0.3 Combat");
  // Enchanting genuinely has no minion route in either source, and still says so.
  assert.equal(best.get("ENCHANTING") ?? null, null);
});

test("a rate off an item infobox carries the skill the infobox names", () => {
  const rows = xpPlan().filter((r) => r.route === "direct");
  const fishing = rows.find((r) => r.generator === "FISHING")!;
  assert.equal(fishing.skill, "FISHING");
  assert.equal(fishing.xpPerItem, 0.5);

  // The skill is read per item rather than inferred from which page the row came off, which is how
  // a Cave Spider Minion files under Combat without a Combat table existing.
  const caveSpider = rows.find((r) => r.generator === "CAVESPIDER")!;
  assert.equal(caveSpider.skill, "COMBAT");
  assert.equal(caveSpider.xpPerItem, 0.3);
});

test("compaction is XP-neutral, which is what lets the XP model ignore the compactor", () => {
  // An enchanted item's published minion XP is its recipe quantity times the base item's, and the
  // scrape checks every pair where both ends exist. Sponge is the load-bearing one: its recipe is
  // 40 rather than 160 and its XP ratio is 40 to match, so the rule is real and not a coincidence
  // of everything being 160.
  const checked = skillXp as unknown as { linearityChecks: number; nonLinear: { from: string; to: string }[] };
  assert.ok(checked.linearityChecks >= 15, "expected the scrape to have checked a useful number of pairs");
  // One known exception, recorded rather than silently corrected: Spider Eye is published at 0.3
  // with an Enchanted Spider Eye at 480 where the rule says 48. Sixteen exact agreements make a
  // typo the likeliest reading, but the wiki is not edited from here.
  assert.deepEqual(
    checked.nonLinear.map((c) => c.from),
    ["SPIDER_EYE"],
  );
});

test("a Dwarven Mines block does not borrow an enchanted item's id", () => {
  // Pure Coal, Pure Gold and Pure Diamond are blocks in the Dwarven Mines with no item behind them.
  // They were briefly aliased onto Enchanted Coal Block and friends because the wiki links them
  // there, which filed a block's 2.7 under an item whose own page says 7,680. Left unresolved now.
  const pures = skillXp.perItem.filter((r) => /^(Pure |Block of Gold)/.test(r.item));
  assert.ok(pures.length > 0, "the Pure rows should still be scraped");
  for (const row of pures) assert.equal(row.itemId, null, `${row.item} should claim no item id`);
});

/* ----------------------------------------------------------------- the pets */

const listing = (name: string, tier: string, price: number): AuctionRecord => ({
  bin: true,
  tier,
  item_name: name,
  starting_bid: price,
});

test("a pet's level comes out of its display name, which is the only place it is", () => {
  const index = createPetBinIndex();
  absorbPetPage(
    index,
    [
      listing("[Lvl 1] Rabbit", "LEGENDARY", 10_000_000),
      listing("[Lvl 100] Rabbit", "LEGENDARY", 40_000_000),
      listing("[Lvl 4] Rabbit", "LEGENDARY", 9_000_000),
      // Not a pet, and filtered on the bracket rather than on a category field.
      listing("Tarantula Ring", "RARE", 500),
    ],
    levels,
  );

  const rabbit = index.prices["PET:RABBIT"].LEGENDARY;
  // The lower level wins over the lower price: those three levels are XP you did not have to make.
  assert.deepEqual(rabbit.base, { level: 1, price: 10_000_000 });
  assert.deepEqual(rabbit.max, { level: 100, price: 40_000_000 });
  assert.equal(index.prices["PET:TARANTULA_RING"], undefined);
});

test("a golden dragon is not finished at level 100", () => {
  assert.equal(maxLevelOf("GOLDEN_DRAGON", levels), 200);
  assert.equal(maxLevelOf("RABBIT", levels), 100);

  const index = createPetBinIndex();
  absorbPetPage(index, [listing("[Lvl 100] Golden Dragon", "LEGENDARY", 900_000_000)], levels);
  // At level 100 a Golden Dragon has just hatched, so this is the cheap end, not the dear one.
  assert.equal(index.prices["PET:GOLDEN_DRAGON"].LEGENDARY.max, null);
  assert.equal(index.prices["PET:GOLDEN_DRAGON"].LEGENDARY.base!.level, 100);
});

test("pets rank on coins per XP, not on the margin", () => {
  const index = createPetBinIndex();
  absorbPetPage(
    index,
    [
      // A big margin over an enormous amount of XP.
      listing("[Lvl 1] Golden Dragon", "LEGENDARY", 500_000_000),
      listing("[Lvl 200] Golden Dragon", "LEGENDARY", 900_000_000),
      // A small margin over very little XP, which is the better trade per hour of grinding.
      listing("[Lvl 1] Rabbit", "COMMON", 100_000),
      listing("[Lvl 100] Rabbit", "COMMON", 20_000_000),
    ],
    levels,
  );

  const rows = planPetProfit({ index, levels, requireMarket: false });
  assert.equal(rows[0].name, "RABBIT");
  const dragon = rows.find((r) => r.name === "GOLDEN DRAGON")!;
  // Ranked on margin the dragon wins outright and is the wrong answer for anyone who has to
  // actually generate the XP.
  assert.ok(dragon.profit > rows[0].profit);
  assert.ok(dragon.coinsPerXp < rows[0].coinsPerXp);
  assert.equal(dragon.xpNeeded, 210_255_385);
});

test("the auction house's cut comes off the sale", () => {
  const index = createPetBinIndex();
  absorbPetPage(index, [listing("[Lvl 1] Bat", "COMMON", 1_000_000), listing("[Lvl 100] Bat", "COMMON", 5_000_000)], levels);
  const row = planPetProfit({ index, levels, requireMarket: false })[0];
  assert.equal(row.profit, 5_000_000 * NET_OF_AUCTION_TAX - 1_000_000);
});

test("a pet listed at only one end is not a trade", () => {
  const index = createPetBinIndex();
  absorbPetPage(index, [listing("[Lvl 1] Bat", "COMMON", 1_000_000)], levels);
  assert.equal(planPetProfit({ index, levels, requireMarket: false }).length, 0);
});

test("a pet nobody is selling is not a pet you can sell", () => {
  // The failure this exists for. A levelled Common Rock clears a healthy margin on paper and has
  // exactly one listing behind it on the real auction house — that is one person's asking price,
  // not a market, and a table that recommends levelling one is recommending an unsellable pet.
  const thin = createPetBinIndex();
  absorbPetPage(
    thin,
    [listing("[Lvl 1] Rock", "COMMON", 1_000_000), listing("[Lvl 100] Rock", "COMMON", 20_000_000)],
    levels,
  );
  assert.equal(thin.prices["PET:ROCK"].COMMON.maxCount, 1);
  assert.equal(planPetProfit({ index: thin, levels }).length, 0);
  // Still reachable for anyone who wants to see it, and it says why.
  const shown = planPetProfit({ index: thin, levels, requireMarket: false })[0];
  assert.equal(shown.liquidity, "thin");
  assert.ok(shown.caveats.some((c) => /not a market/.test(c)));
});

test("depth and age both count, and are measured rather than guessed", () => {
  // Three listings is the floor for a market at all; past a mean of 72 hours it has stopped.
  assert.equal(liquidityOf(1, 1), "thin");
  assert.equal(liquidityOf(2, 1), "thin");
  assert.equal(liquidityOf(THIN_LISTINGS, 1), "ok");
  assert.equal(liquidityOf(30, SLOW_HOURS + 1), "slow");
  assert.equal(liquidityOf(30, 12), "ok");
});

test("listing age comes off the auction's own start time", () => {
  const now = 1_000_000_000_000;
  const index = createPetBinIndex();
  absorbPetPage(
    index,
    [
      { ...listing("[Lvl 100] Bat", "COMMON", 5_000_000), start: now - 10 * 3_600_000 },
      { ...listing("[Lvl 100] Bat", "COMMON", 6_000_000), start: now - 20 * 3_600_000 },
      { ...listing("[Lvl 100] Bat", "COMMON", 7_000_000), start: now - 30 * 3_600_000 },
      { ...listing("[Lvl 1] Bat", "COMMON", 1_000_000), start: now },
    ],
    levels,
    now,
  );
  const ends = index.prices["PET:BAT"].COMMON;
  assert.equal(ends.maxCount, 3);
  assert.equal(ends.baseCount, 1);
  // 10 + 20 + 30 hours over three listings.
  assert.equal(ends.maxAgeHours / ends.maxCount, 20);
  assert.equal(planPetProfit({ index, levels })[0].liquidity, "ok");
});

test("a cheap end above level 1 is flagged rather than quietly overstated", () => {
  const index = createPetBinIndex();
  absorbPetPage(index, [listing("[Lvl 45] Bat", "COMMON", 1_000_000), listing("[Lvl 100] Bat", "COMMON", 9_000_000)], levels);
  const row = planPetProfit({ index, levels, requireMarket: false })[0];
  assert.equal(row.approximate, true);
  assert.ok(row.caveats.some((c) => /level 45/.test(c)));
});
