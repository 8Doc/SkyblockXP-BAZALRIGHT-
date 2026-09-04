import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { bestPerMinion, petXpPerHourFor, planPetPairs, DAY_HOURS } from "../src/lib/petPlan";
import type { PetCatalogueEntry, PetPlanOptions } from "../src/lib/petPlan";
import type { MinionXpRow, PetXpRules, SkillKey } from "../src/lib/minionXp";
import type { PetProfitRow } from "../src/lib/petLevelling";
import { extrasFor, compactionOf } from "../src/lib/minionProfit";
import type { Compactor, ExtrasTable, Recipe } from "../src/lib/minionProfit";
import type { Modifiers, Upgrade } from "../src/lib/minions";

const rules = JSON.parse(readFileSync("data/curated/pet_xp.json", "utf8")) as PetXpRules;
const extras = JSON.parse(readFileSync("data/curated/minion_extras.json", "utf8")) as ExtrasTable;
const mods = JSON.parse(readFileSync("data/curated/minion_modifiers.json", "utf8")) as Modifiers;
const recipes = JSON.parse(readFileSync("data/generated/recipes.json", "utf8")).recipes as Recipe[];
const storage = JSON.parse(readFileSync("data/curated/minion_storage.json", "utf8"));
const pets = JSON.parse(readFileSync("data/generated/pets.json", "utf8")).pets as {
  key: string;
  name: string;
  skill?: string | null;
}[];

const upgrade = (id: string): Upgrade => mods.upgrades.find((u) => u.id === id)!;
const compactor = (id: string): Compactor => storage.compactors.find((c: Compactor) => c.id === id)!;

/* ------------------------------------------------------------ the catalogue */

test("pets carry the skill they level off, which is the field the pairing turns on", () => {
  const withSkill = pets.filter((p) => p.skill);
  assert.ok(withSkill.length > 70, `only ${withSkill.length} pets have a skill`);

  const find = (name: string) => pets.find((p) => p.name === name)!;
  // The three shapes the wiki writes the type line in, all resolving.
  assert.equal(find("Golden Dragon").skill, "COMBAT");
  assert.equal(find("Rabbit").skill, "FARMING");
  assert.equal(find("Enderman").skill, "COMBAT");
  // An Alchemy pet exists, which is the only thing that makes the brewing route worth anything.
  assert.ok(pets.some((p) => p.skill === "ALCHEMY"));
  // And a pet that levels off no skill at all stays null rather than defaulting to Combat.
  assert.equal(find("Wisp").skill ?? null, null);
});

/* --------------------------------------------------------- the corrupt soil */

test("corrupt soil adds two items a harvest, and only to minions that spawn mobs", () => {
  const soil = [upgrade("CORRUPT_SOIL"), upgrade("NONE")];
  // A Slime Minion spawns slimes, so there is something to corrupt.
  const slime = extrasFor("SLIME", soil, extras);
  assert.equal(slime.length, 2);
  assert.deepEqual(
    slime.map((e) => e.drop.itemId).sort(),
    ["CORRUPTED_FRAGMENT", "SULPHUR_ORE"],
  );
  // A Cobblestone Minion spawns nothing, so the slot is wasted rather than free sulphur.
  assert.equal(extrasFor("COBBLESTONE", soil, extras).length, 0);
  // And with no Corrupt Soil in a slot there is nothing extra at all.
  assert.equal(extrasFor("SLIME", [upgrade("NONE"), upgrade("NONE")], extras).length, 0);
});

test("sulphur is SULPHUR_ORE, because SULPHUR is gunpowder", () => {
  // The single most confusable pair in this data. SULPHUR is the Creeper Minion's gunpowder at a
  // shop price of 4; SULPHUR_ORE is the Sulphur that Corrupt Soil makes, at 10. Getting it the
  // wrong way round quietly halves the whole strategy.
  const npc = JSON.parse(readFileSync("data/generated/npc-prices.json", "utf8")).prices as Record<
    string,
    { sell?: number }
  >;
  const names = JSON.parse(readFileSync("data/generated/bazaar_items.json", "utf8")).names as Record<string, string>;
  assert.equal(names["SULPHUR"], "Gunpowder");
  assert.equal(names["SULPHUR_ORE"], "Sulphur");
  assert.equal(npc["SULPHUR_ORE"]?.sell, 10);

  const soil = extras.extras.find((e) => e.upgrade === "CORRUPT_SOIL")!;
  assert.ok(soil.drops.some((d) => d.itemId === "SULPHUR_ORE"));
  assert.ok(!soil.drops.some((d) => d.itemId === "SULPHUR"));
});

test("a hopper is told what the compactor actually made", () => {
  // The minion's inventory holds the enchanted item, and the shop pays for what is in the
  // inventory. Returning only a ratio priced the overflow as the raw drop.
  const packed = compactionOf("SULPHUR_ORE", compactor("SUPER_COMPACTOR_3000"), recipes);
  assert.equal(packed.itemId, "ENCHANTED_SULPHUR");
  assert.equal(packed.ratio, 160);
  // With no compactor the item is its own compacted form, so callers need no special case.
  assert.deepEqual(compactionOf("SULPHUR_ORE", compactor("NONE"), recipes), { ratio: 1, itemId: "SULPHUR_ORE" });
});

/* ------------------------------------------------------------- the pairing */

const catalogue: PetCatalogueEntry[] = [
  { key: "ROCK", name: "Rock", skill: "MINING" },
  { key: "RABBIT", name: "Rabbit", skill: "FARMING" },
  { key: "WISP", name: "Wisp", skill: null },
];

const petRow = (key: string, profit: number, xpNeeded: number): PetProfitRow => ({
  key: `PET:${key}`,
  name: key,
  rarity: "COMMON",
  buy: { level: 1, price: 1_000_000 },
  sell: { level: 100, price: 1_000_000 + profit },
  profit,
  xpNeeded,
  coinsPerXp: profit / xpNeeded,
  approximate: false,
  listings: 10,
  meanAgeHours: 12,
  liquidity: "ok",
  caveats: [],
});

const xpRow = (over: Partial<MinionXpRow> = {}): MinionXpRow => ({
  generator: "COBBLESTONE",
  family: "Cobblestone Minion",
  tier: 12,
  skill: "MINING" as SkillKey,
  route: "direct",
  itemId: "COBBLESTONE",
  itemName: "Cobblestone",
  itemsPerHour: 10_000,
  baseSkillXpPerHour: 1_000,
  skillXpPerHour: 1_000,
  petXpPerHour: 1_000,
  xpPerItem: 0.1,
  caveats: [],
  ...over,
});

/**
 * A player, with Wisdom given as one number for brevity and spread across every skill.
 *
 * Wisdom is per skill in the model, but each case here exercises one skill at a time, so taking a
 * single figure and applying it to all of them keeps the tests readable without weakening them.
 */
const player = (over: Partial<{ wisdom: number; taming: number; petSkill: SkillKey | null }> = {}) => {
  const { wisdom = 0, ...rest } = over;
  const all: Partial<Record<SkillKey, number>> = {};
  for (const skill of ["FARMING", "MINING", "COMBAT", "FORAGING", "FISHING", "ALCHEMY"] as SkillKey[]) {
    all[skill] = wisdom;
  }
  return { wisdom: all, taming: 0, petSkill: null as SkillKey | null, ...rest };
};

const options = (over: Partial<PetPlanOptions> = {}): PetPlanOptions => ({
  xpRows: [xpRow()],
  pets: [petRow("ROCK", 1_000_000, 100_000), petRow("RABBIT", 1_000_000, 100_000)],
  catalogue,
  rules,
  player: player(),
  itemCoinsPerHour: new Map([["COBBLESTONE", 0]]),
  dropValue: new Map([["COBBLESTONE", 1]]),
  maxBrewsPerDay: 100,
  claimsPerDay: 1,
  ...over,
});

test("a matching pet gets three times the XP of a mismatched one", () => {
  const rows = planPetPairs(options());
  const rock = rows.find((r) => r.petKey === "PET:ROCK")!;
  const rabbit = rows.find((r) => r.petKey === "PET:RABBIT")!;
  // A Mining minion under a Mining pet keeps everything; under a Farming pet it keeps a third.
  assert.equal(rock.matched, true);
  assert.equal(rabbit.matched, false);
  assert.ok(Math.abs(rock.petXpPerDay / rabbit.petXpPerDay - 3) < 1e-9);
  assert.ok(rock.totalProfitPerDay > rabbit.totalProfitPerDay);
});

test("a pet with no skill is not planned for rather than guessed at", () => {
  const rows = planPetPairs(options({ pets: [petRow("WISP", 1_000_000, 100_000)] }));
  assert.equal(rows.length, 0);
});

test("the item half is counted alongside the pet half", () => {
  const withItems = planPetPairs(options({ itemCoinsPerHour: new Map([["COBBLESTONE", 1_000]]) }));
  const rock = withItems.find((r) => r.petKey === "PET:ROCK")!;
  // A minion levelling a pet is still a minion: 1,000 an hour is 24,000 a day on top.
  assert.equal(rock.itemProfitPerDay, 24_000);
  assert.equal(rock.totalProfitPerDay, rock.petProfitPerDay + 24_000);
});

test("the pet is chosen on the pet half, not on the total", () => {
  // Both pets see the same item income, so including it in the choice makes the comparison a tie
  // broken by nothing — which is how a mismatched pet keeping a third of the XP got recommended.
  const rows = bestPerMinion(planPetPairs(options({ itemCoinsPerHour: new Map([["COBBLESTONE", 1_000_000]]) })));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].petKey, "PET:ROCK");
  assert.equal(rows[0].matched, true);
});

test("a pet that would take longer than the horizon is not a plan", () => {
  const slow = options({ pets: [petRow("ROCK", 1_000_000, 1e12)] });
  assert.equal(planPetPairs({ ...slow, maxDaysPerPet: 365 }).length, 0);
  // Without a horizon the same pairing comes back, which is exactly the failure the horizon fixes.
  assert.equal(planPetPairs(slow).length, 1);
});

/* ------------------------------------------------------------- the brewing */

const brewRow = (over: Partial<MinionXpRow> = {}): MinionXpRow =>
  xpRow({
    generator: "SUGAR_CANE",
    family: "Sugar Cane Minion",
    skill: "ALCHEMY" as SkillKey,
    route: "brewing",
    itemsPerBrew: 1_000,
    itemsPerHour: 10_000,
    baseSkillXpPerHour: 150_000,
    ...over,
  });

test("brewing is capped by what a person will actually sit through", () => {
  // The minion supplies 240 brews a day; the cap says 100, so the XP is cut to match rather than
  // the table quoting a rate nobody would do.
  const capped = planPetPairs(
    options({
      xpRows: [brewRow()],
      pets: [petRow("ROCK", 1_000_000, 100_000)],
      catalogue: [{ key: "ROCK", name: "Rock", skill: "ALCHEMY" }],
      itemCoinsPerHour: new Map([["SUGAR_CANE", 0]]),
      dropValue: new Map([["SUGAR_CANE", 0]]),
      maxBrewsPerDay: 100,
    }),
  )[0];
  assert.equal(Math.round(capped.brewsPerDay), 100);
  assert.ok(capped.caveats.some((c) => /capped at 100 brews/.test(c)));

  const uncapped = planPetPairs(
    options({
      xpRows: [brewRow()],
      pets: [petRow("ROCK", 1_000_000, 100_000)],
      catalogue: [{ key: "ROCK", name: "Rock", skill: "ALCHEMY" }],
      itemCoinsPerHour: new Map([["SUGAR_CANE", 0]]),
      dropValue: new Map([["SUGAR_CANE", 0]]),
      maxBrewsPerDay: 10_000,
    }),
  )[0];
  // Capping the brews caps the XP with them, which is the whole point.
  assert.ok(uncapped.petXpPerDay > capped.petXpPerDay);
});

test("a brewing plan levels two pets off the same drops, and counts both", () => {
  // The drops do two jobs. Brewing pays Alchemy, and collecting the same drops on the way pays the
  // minion's own skill — so the plan names an Alchemy pet for the stand and a Farming pet for the
  // collection, and both margins are income.
  const both = options({
    xpRows: [brewRow({ baseSkill: "FARMING" as SkillKey, baseXpPerHour: 150_000 })],
    pets: [petRow("ROCK", 1_000_000, 100_000), petRow("RABBIT", 2_000_000, 100_000)],
    catalogue: [
      { key: "ROCK", name: "Rock", skill: "ALCHEMY" },
      { key: "RABBIT", name: "Rabbit", skill: "FARMING" },
    ],
    itemCoinsPerHour: new Map([["SUGAR_CANE", 0]]),
    dropValue: new Map([["SUGAR_CANE", 0]]),
  });
  const row = planPetPairs(both).find((r) => r.petKey === "PET:ROCK")!;

  assert.equal(row.baseSkill, "FARMING");
  assert.equal(row.partner?.petKey, "PET:RABBIT");
  // The partner is a Farming pet on a Farming stream, so it keeps all of it.
  assert.equal(row.partner?.matched, true);
  assert.ok((row.partner?.profitPerDay ?? 0) > 0);

  // And it is in the profit rather than in a footnote: the day's pet income is both pets.
  const alone = planPetPairs({ ...both, xpRows: [brewRow()] }).find((r) => r.petKey === "PET:ROCK")!;
  assert.equal(alone.partner, undefined);
  assert.ok(Math.abs(row.petProfitPerDay - (alone.petProfitPerDay + row.partner!.profitPerDay)) < 1e-6);
  assert.ok(row.advantagePerDay > alone.advantagePerDay);
});

test("the second pet is held to the same horizon as the first", () => {
  // A collection stream too slow to finish a pet inside the horizon is not a second plan, and
  // saying so is the same rule the main pairing follows rather than a special case.
  const slow = options({
    xpRows: [brewRow({ baseSkill: "FARMING" as SkillKey, baseXpPerHour: 1 })],
    pets: [petRow("ROCK", 1_000_000, 100_000), petRow("RABBIT", 2_000_000, 100_000)],
    catalogue: [
      { key: "ROCK", name: "Rock", skill: "ALCHEMY" },
      { key: "RABBIT", name: "Rabbit", skill: "FARMING" },
    ],
    itemCoinsPerHour: new Map([["SUGAR_CANE", 0]]),
    dropValue: new Map([["SUGAR_CANE", 0]]),
    maxDaysPerPet: 365,
  });
  assert.equal(planPetPairs(slow).find((r) => r.petKey === "PET:ROCK")!.partner, undefined);
});

test("brewing charges the drops it consumes against the day's profit", () => {
  const free = planPetPairs(
    options({
      xpRows: [brewRow()],
      pets: [petRow("ROCK", 1_000_000, 100_000)],
      catalogue: [{ key: "ROCK", name: "Rock", skill: "ALCHEMY" }],
      itemCoinsPerHour: new Map([["SUGAR_CANE", 10_000]]),
      dropValue: new Map([["SUGAR_CANE", 0]]),
      maxBrewsPerDay: 100,
    }),
  )[0];
  const costly = planPetPairs(
    options({
      xpRows: [brewRow()],
      pets: [petRow("ROCK", 1_000_000, 100_000)],
      catalogue: [{ key: "ROCK", name: "Rock", skill: "ALCHEMY" }],
      itemCoinsPerHour: new Map([["SUGAR_CANE", 10_000]]),
      // 100 brews x 1,000 drops x 2 coins = 200,000 a day of sales given up.
      dropValue: new Map([["SUGAR_CANE", 2]]),
      maxBrewsPerDay: 100,
    }),
  )[0];

  assert.equal(free.brewingCostPerDay, 0);
  assert.equal(costly.brewingCostPerDay, 200_000);
  // The drops went into the stand instead of onto the market, so the item half falls by exactly
  // what they were worth — that is the opportunity cost, and it is the reason brewing is not free.
  assert.equal(free.itemProfitPerDay - costly.itemProfitPerDay, 200_000);
  assert.ok(costly.totalProfitPerDay < free.totalProfitPerDay);
  assert.ok(costly.caveats.some((c) => /would otherwise be sold/.test(c)));
});

test("a direct route has no brewing cost and asks for no brews", () => {
  const rows = planPetPairs(options({ dropValue: new Map([["COBBLESTONE", 500]]) }));
  for (const row of rows) {
    assert.equal(row.route, "direct");
    assert.equal(row.brewsPerDay, 0);
    assert.equal(row.brewingCostPerDay, 0);
  }
});

/* ------------------------------------------------------------ the arithmetic */

test("wisdom is per skill, and a route takes its own skill's", () => {
  // The reason this is not one number. A brewed route is Alchemy XP even when the minion feeding it
  // is a Farming minion, so it takes Alchemy Wisdom — and an account deep in Slayers with 30 Combat
  // Wisdom and 0 Alchemy would have had all six scaled by whichever figure it happened to type.
  const only = { wisdom: { MINING: 100 } as Partial<Record<SkillKey, number>>, taming: 0, petSkill: null };
  assert.equal(petXpPerHourFor(xpRow({ skill: "MINING" }), "MINING", only, rules), 2_000);
  // The same minion rate under a skill this player has no Wisdom in is unscaled.
  assert.equal(petXpPerHourFor(xpRow({ skill: "ALCHEMY" }), "ALCHEMY", only, rules), 1_000);
});

test("wisdom and taming reach the per-day figure intact", () => {
  const plain = petXpPerHourFor(xpRow(), "MINING", player(), rules);
  const boosted = petXpPerHourFor(xpRow(), "MINING", player({ wisdom: 100, taming: 60 }), rules);
  assert.equal(plain, 1_000);
  // 1,000 x 2 (wisdom 100) x 1.6 (taming 60).
  assert.ok(Math.abs(boosted - 3_200) < 1e-9);

  const row = planPetPairs(options({ player: player({ wisdom: 100, taming: 60 }) })).find(
    (r) => r.petKey === "PET:ROCK",
  )!;
  assert.ok(Math.abs(row.petXpPerDay - 3_200 * DAY_HOURS) < 1e-6);
});
