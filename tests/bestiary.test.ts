import { test } from "node:test";
import assert from "node:assert/strict";
import { bestiaryFamilyOf, bestiaryLadder, bestiaryTierOf } from "../src/lib/gameData";
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
    // Whichever of the two tables it belongs to: critters and hunting mobs cap at 125 kills
    // where the main brackets run to a million, and the identity is what places them.
    const ladder = bestiaryLadder(bestiary as never, family as never);
    assert.equal(
      ladder[family.maxTier - 1],
      family.maxKills,
      `${family.island}/${family.name}: bracket ${family.bracket} tier ${family.maxTier}`,
    );
  }
});

test("brackets are strictly increasing, and as long as their table runs", () => {
  for (const [table, depth, columns] of [
    ["brackets", 25, bestiary.brackets],
    ["huntingBrackets", 10, bestiary.huntingBrackets],
  ] as const) {
    for (const [id, ladder] of Object.entries(columns as Record<string, number[]>)) {
      assert.equal(ladder.length, depth, `${table} ${id}`);
      for (let i = 1; i < ladder.length; i++)
        assert.ok(ladder[i]! > ladder[i - 1]!, `${table} ${id} stalls at tier ${i + 1}`);
    }
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
  // A milestone is ten tiers and every ten milestones pay 10 XP, so the milestone half is not a
  // separate grind — it is a tenth of the tier count, awarded in lumps of ten.
  assert.equal(bestiary.totals.milestoneXp, Math.floor(tiers / 100) * 10, "milestones follow the tiers");
  assert.equal(
    bestiary.totals.xp + bestiary.totals.milestoneXp,
    bestiary.totals.statedTotal,
    "the tiers and the milestones together are the whole category",
  );
  // The game states 5,660. What is short of it is families neither wiki lists.
  assert.ok(bestiary.totals.statedTotal <= 5_660, "we cannot hold more than the game does");
  assert.ok(bestiary.totals.statedTotal > 5_000, `only ${bestiary.totals.statedTotal} of the game's 5,660`);
});

/** Is this family being offered a tier? Matched on the id's own shape rather than a name. */
const offersTier = (catalog: { tasks: { id: string }[]; done: Set<string> }, family: string): boolean =>
  catalog.tasks.some((t) => {
    const prefix = `bestiary_${family}_`;
    if (!t.id.startsWith(prefix) || catalog.done.has(t.id)) return false;
    const rest = t.id.slice(prefix.length);
    return rest.length > 0 && [...rest].every((c) => c >= "0" && c <= "9");
  });

/**
 * A family whose every word appears in a mob id we could not place is a family whose kills we
 * are probably misreading, so it is held back rather than offered at tier 0.
 *
 * This used to be far wider: any unplaced id at all held back *every* family with no kills. With
 * 249 families and a third of a maxed profile's ids unreadable that was the safer reading; with
 * 319 it hid 1,470 XP on one profile, two thirds of everything the category had left, because
 * most of what it caught were families the player had simply never fought.
 */
test("a family whose name clashes with an unplaceable id is held back", () => {
  const clash = buildCatalog(
    {
      bestiary: {
        kills: { zombie_1: 4, golden_ghoul_variant_99: 5_000 },
        milestone: { last_claimed_milestone: 0 },
      },
    } as never,
    full,
    { items: null, capacity: 0 },
  );
  assert.ok(!offersTier(clash, "golden_ghoul"), "its kills may be hiding in the id we could not read");
  assert.ok(offersTier(clash, "zombie"), "a family we did see kills for is still offered");
});

/** But a family that clashes with nothing is offered, even while other ids go unplaced. */
test("an untouched family is offered even when some ids cannot be placed", () => {
  const blind = buildCatalog(
    {
      bestiary: {
        kills: { zombie_1: 4, some_mob_we_cannot_place_99: 5_000 },
        milestone: { last_claimed_milestone: 0 },
      },
    } as never,
    full,
    { items: null, capacity: 0 },
  );
  assert.ok(offersTier(blind, "golden_ghoul"), "nothing about that id suggests it fed the Golden Ghoul");
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
  const ladder = bestiaryLadder(bestiary as never, family as never);
  assert.equal(bestiaryTierOf(family as never, ladder, 0), 0);
  assert.equal(bestiaryTierOf(family as never, ladder, ladder[0]!), 1);
  assert.equal(bestiaryTierOf(family as never, ladder, ladder[0]! - 1), 0);
  assert.equal(
    bestiaryTierOf(family as never, ladder, family.maxKills * 10),
    family.maxTier,
    "a maxed family stops at its cap rather than running off the ladder",
  );
});

/**
 * The milestones pay a tenth of the category and were modelled as nothing at all. A milestone is
 * ten family tiers and every ten milestones pay 10 XP, so this is the tier count read again in
 * lumps of a hundred — not a separate grind, but not nothing either. What a profile had earned
 * was always credited; what it had left was simply absent, 230 XP of it on one real profile.
 */
test("the milestones are offered, not just credited", () => {
  const fresh = buildCatalog({} as never, full, { items: null, capacity: 0 });
  const rungs = fresh.tasks.filter((t) => t.id.startsWith("bestiary_milestone_"));
  assert.equal(rungs.length, Math.floor((bestiary.totals.milestoneXp ?? 0) / 10), "one rung per ten milestones");
  assert.equal(rungs.reduce((s, t) => s + t.xp, 0), bestiary.totals.milestoneXp, "worth what the table says");
  assert.equal(rungs.filter((t) => fresh.done.has(t.id)).length, 0, "a fresh profile has claimed none");

  // Counted off the profile's own claim rather than off our tier total: the two disagree, and
  // using ours would hand back XP the game has already paid.
  const partway = buildCatalog(
    { bestiary: { kills: {}, milestone: { last_claimed_milestone: 237 } } } as never,
    full,
    { items: null, capacity: 0 },
  );
  const claimed = partway.tasks.filter((t) => t.id.startsWith("bestiary_milestone_") && partway.done.has(t.id));
  assert.equal(claimed.reduce((s, t) => s + t.xp, 0), 230, "237 claimed milestones is 23 lots of ten");
});

/**
 * A tier's cost is a share of its own family's ladder, so a boss two kills from a tier and a
 * zombie two hundred from one are ranked by how much work each really is. Maxing the cheapest
 * family takes 7 kills and the dearest 40,000 — sorting on raw kills sorts on bracket.
 */
test("tiers are ranked on a share of their family's ladder", () => {
  const cat = buildCatalog({ bestiary: { kills: { zombie_1: 4 }, milestone: {} } } as never, full, {
    items: null,
    capacity: 0,
  });
  const rows = cat.tasks.filter((t) => t.category === "bestiary" && t.effort !== undefined);
  assert.ok(rows.length > 100);
  for (const row of rows) {
    assert.ok(row.effort! >= 0 && row.effort! <= 1, `${row.name} scores ${row.effort}`);
  }
  // Nothing is cut for being far off: the category's total is what the player really has left.
  const families = new Set(cat.tasks.filter((t) => t.category === "bestiary").map((t) => t.id.split("_").slice(1, -1).join("_")));
  assert.ok(families.size > 300, `only ${families.size} families reach the list`);
});
