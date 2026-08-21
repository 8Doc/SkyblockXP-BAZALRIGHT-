import { test } from "node:test";
import assert from "node:assert/strict";
import { bestiaryFamilyOf, bestiaryTierOf } from "../src/lib/gameData";
import { buildCatalog } from "../src/lib/catalog";
import { gameData } from "./gameDataFixture";
import bestiary from "../data/generated/bestiary.json";
import bestiaryMobs from "../data/curated/bestiary_mobs.json";

const data = { bestiary, bestiaryMobs } as never;
/** The whole table, for the tests that need to build a catalog rather than read the join. */
const full = gameData();

/**
 * The scrape's own cross-check, kept as a test so a wiki edit can't quietly change the answer.
 *
 * A family lists its bracket, its tier cap and its max kills, and max kills is by definition
 * the bracket's value at the tier cap. That makes all 249 families independent assertions
 * about one 7x25 table: if a column were read in the wrong order, or a comma parsed as a
 * decimal point, they would not agree.
 */
test("every family's max kills is its bracket's value at its tier cap", () => {
  for (const family of bestiary.families) {
    const ladder = bestiary.brackets[String(family.bracket) as keyof typeof bestiary.brackets];
    assert.equal(
      ladder[family.maxTier - 1],
      family.maxKills,
      `${family.island}/${family.name}: bracket ${family.bracket} tier ${family.maxTier}`,
    );
  }
});

test("brackets are 25 tiers long and strictly increasing", () => {
  for (const [id, ladder] of Object.entries(bestiary.brackets)) {
    assert.equal(ladder.length, 25, `bracket ${id}`);
    for (let i = 1; i < ladder.length; i++)
      assert.ok(ladder[i] > ladder[i - 1], `bracket ${id} stalls at tier ${i + 1}`);
  }
});

/**
 * One XP per tier, and the milestones are the rest of the category rather than a share of each
 * tier. The task table says "Each Tier: +1" and "Every 10 Milestones: +10", and reading the
 * second as every tenth *tier* doubled every row: the category advertised 7,840 against a
 * stated 4,370, and a maxed profile was credited 10,260 — more than twice everything in it.
 */
test("a tier is worth one XP, and the milestones are the remainder", () => {
  const tiers = bestiary.families.reduce((sum, f) => sum + f.maxTier, 0);
  assert.equal(bestiary.totals.tiers, tiers);
  assert.equal(bestiary.totals.xp, tiers, "the tiers pay one apiece");
  assert.equal(bestiary.totals.statedTotal, 4_370, "what the task table says the category holds");
  assert.equal(
    bestiary.totals.xp + bestiary.totals.milestoneXp,
    bestiary.totals.statedTotal,
    "the tiers and the milestones together are the whole category",
  );
});

/**
 * A family with no kills against it is only at tier 0 if its kills could have been seen. When
 * the profile carries mob ids the map cannot place, "no kills" means we looked in the wrong
 * place. A maxed profile had 163 such ids and 201,000 unplaced kills, and was being told to go
 * and get tier 1 of a Golden Ghoul it had certainly killed.
 */
test("a family is not offered when the profile is carrying kills we cannot place", () => {
  const withGap = buildCatalog(
    {
      bestiary: {
        kills: { zombie_1: 100, some_mob_we_cannot_place_99: 5_000 },
        milestone: { last_claimed_milestone: 0 },
      },
    } as never,
    full,
    { items: null, capacity: 0 },
  );
  const offered = withGap.tasks.filter((t) => t.category === "bestiary" && !withGap.done.has(t.id));
  const families = new Set(offered.map((t) => /^bestiary_(.*)_\d+$/.exec(t.id)?.[1]));
  assert.ok(families.has("zombie"), "a family we did see kills for is still offered");
  assert.ok(!families.has("golden_ghoul"), "one we saw nothing for, while blind, is not");
});

test("with nothing unplaced, a family with no kills is genuinely at tier zero", () => {
  // The rule must not swallow a real beginner: no unplaced ids means no blind spot.
  const clean = buildCatalog(
    { bestiary: { kills: { zombie_1: 100 }, milestone: { last_claimed_milestone: 0 } } } as never,
    full,
    { items: null, capacity: 0 },
  );
  const offered = clean.tasks.filter((t) => t.category === "bestiary" && !clean.done.has(t.id));
  assert.ok(offered.some((t) => t.id.startsWith("bestiary_golden_ghoul_")), "still offered when we can see clearly");
});

/**
 * The profile writes a mob id per *level* — `crypt_lurker_121` and `crypt_lurker_111` are the
 * same family — and the bestiary counts master mode and garden pests under the plain name. Get
 * any of those wrong and a family reads as a fraction of the kills the player really has.
 */
test("a mob id resolves to its family through level, master and pest forms", () => {
  assert.equal(bestiaryFamilyOf(data, "crypt_lurker_121"), "crypt_lurker");
  assert.equal(bestiaryFamilyOf(data, "master_crypt_lurker_121"), "crypt_lurker");
  assert.equal(bestiaryFamilyOf(data, "pest_cricket_1"), "cricket");
  assert.equal(bestiaryFamilyOf(data, "unburried_zombie_30"), "crypt_ghoul", "curated alias");
});

/**
 * Three-way on purpose. A mob we know has no family is not the same as a mob we can't place,
 * and collapsing them would let the catalog credit a family kills it never saw without ever
 * noticing it had done so.
 */
test("a mob with no family and a mob we can't place are different answers", () => {
  assert.equal(bestiaryFamilyOf(data, "sadan_golem_100"), null, "boss summon, positively excluded");
  assert.equal(bestiaryFamilyOf(data, "not_a_real_mob_7"), undefined, "unknown, not excluded");
});

test("every curated alias points at a family that exists", () => {
  const ids = new Set(bestiary.families.map((f) => f.id));
  for (const [mob, family] of Object.entries(bestiaryMobs.aliases))
    assert.ok(ids.has(family), `${mob} -> ${family}, which is not a family`);
});

test("no mob id is both aliased and declared family-less", () => {
  for (const mob of Object.keys(bestiaryMobs.aliases))
    assert.ok(!(mob in bestiaryMobs.noFamily), `${mob} is claimed twice`);
});

/** Tier is the last threshold passed, so the boundary itself counts and one kill short doesn't. */
test("a tier is reached exactly at its cumulative kill count", () => {
  const family = bestiary.families.find((f) => f.id === "crypt_ghoul")!;
  const ladder = bestiary.brackets[String(family.bracket) as keyof typeof bestiary.brackets];
  assert.equal(bestiaryTierOf(family, bestiary.brackets, 0), 0);
  assert.equal(bestiaryTierOf(family, bestiary.brackets, ladder[0]), 1);
  assert.equal(bestiaryTierOf(family, bestiary.brackets, ladder[0] - 1), 0);
  assert.equal(
    bestiaryTierOf(family, bestiary.brackets, family.maxKills * 10),
    family.maxTier,
    "a maxed family stops at its cap rather than running off the ladder",
  );
});
