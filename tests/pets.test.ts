import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCatalog } from "../src/lib/catalog";
import { buildReport } from "../src/lib/report";
import { CATEGORIES, type ResolvedTask } from "../src/lib/types";
import { gameData } from "./gameDataFixture";
import type { ProfileMember } from "../src/lib/profile";

const data = gameData();

/** Total pet XP a pet of this rarity needs to be sitting at its maximum level. */
const maxed = (rarity: string) => data.petLevels.maxLevelXp[rarity];

function member(pets: { type: string; tier: string; exp?: number }[], highest = 0): ProfileMember {
  return { leveling: { highest_pet_score: highest }, pets_data: { pets } } as ProfileMember;
}

const score = (pets: { type: string; tier: string; exp?: number }[], highest = 0) =>
  buildCatalog(member(pets, highest), data, { items: [], capacity: 400 }).petScore;

/* ------------------------------------------------------------------ score */

test("only the best rarity of a pet counts, and rarities do not stack", () => {
  const one = score([{ type: "BEE", tier: "LEGENDARY" }]);
  const both = score([
    { type: "BEE", tier: "EPIC" },
    { type: "BEE", tier: "LEGENDARY" },
  ]);

  assert.equal(one.current, 5, "a legendary is worth five");
  assert.equal(both.current, 5, "owning the epic as well adds nothing");
  assert.equal(both.owned, 1, "two copies of one pet are one pet");
});

test("different pets do add up", () => {
  assert.equal(
    score([
      { type: "BEE", tier: "LEGENDARY" },
      { type: "ROCK", tier: "COMMON" },
    ]).current,
    6,
  );
});

test("a pet at its maximum level is worth a point beyond its rarity", () => {
  const under = score([{ type: "BEE", tier: "LEGENDARY", exp: maxed("LEGENDARY") - 1 }]);
  const at = score([{ type: "BEE", tier: "LEGENDARY", exp: maxed("LEGENDARY") }]);

  assert.equal(under.current, 5);
  assert.equal(under.maxLevel, 0);
  assert.equal(at.current, 6, "five for legendary, one for the level");
  assert.equal(at.maxLevel, 1);
});

test("rarity and max level are read off the copies independently", () => {
  // A legendary short of its ceiling and a maxed epic: the game credits the legendary's five
  // and the epic's max-level point, because it asks each question of the whole family.
  const held = score([
    { type: "BEE", tier: "LEGENDARY", exp: 0 },
    { type: "BEE", tier: "EPIC", exp: maxed("EPIC") },
  ]);

  assert.equal(held.current, 6);
  assert.equal(held.maxLevel, 1);
});

test("Golden Dragon is maxed at 200, not at the legendary hundred", () => {
  const legendaryHundred = score([{ type: "GOLDEN_DRAGON", tier: "LEGENDARY", exp: maxed("LEGENDARY") }]);
  const two_hundred = score([
    { type: "GOLDEN_DRAGON", tier: "LEGENDARY", exp: data.petLevels.overrides.GOLDEN_DRAGON.maxLevelXp },
  ]);

  assert.equal(legendaryHundred.maxLevel, 0, "level 100 is halfway for a Golden Dragon");
  assert.equal(two_hundred.maxLevel, 1);
});

test("the pets the game does not score are not scored here either", () => {
  assert.equal(score([{ type: "FRACTURED_MONTEZUMA_SOUL", tier: "LEGENDARY" }]).current, 0);
});

test("a pet the profile names differently is still the same pet", () => {
  // TYRANNOSAURUS is the T-Rex, and the Wisp has four ids across its rarities. Counting them as
  // separate pets would let one family score four times over.
  const wisps = score([
    { type: "DROPLET_WISP", tier: "UNCOMMON" },
    { type: "FROST_WISP", tier: "RARE" },
    { type: "GLACIAL_WISP", tier: "EPIC" },
    { type: "SUBZERO_WISP", tier: "LEGENDARY" },
  ]);

  assert.equal(wisps.owned, 1, "four ids, one pet");
  assert.equal(wisps.current, 5, "and only its best rarity counts");
});

test("the highest ever reached is taken from the profile, never computed", () => {
  // Sell the pets and the score falls; the XP does not, and this is the number it was paid on.
  const sold = score([], 340);
  assert.equal(sold.current, 0);
  assert.equal(sold.highest, 340);
});

test("the ceiling is the whole catalogue, rift-bound pets included", () => {
  // Best rarity of each pet plus one apiece for maxing it. Counted over every pet rather than
  // the buyable ones, because a pet nobody sells still scores for the player who has it.
  const expected = data.pets.pets.reduce(
    (sum, pet) => sum + Math.max(...pet.rarities.map((r) => data.petScore.byRarity[r] ?? 0)) + 1,
    0,
  );

  assert.equal(score([]).max, expected);
  assert.ok(expected > 500, `expected a ceiling above 500, got ${expected}`);
});

/* ------------------------------------------------------ top rarity only */

function petRows(pets: { type: string; tier: string; exp?: number }[] = []) {
  const catalog = buildCatalog(member(pets), data, { items: [], capacity: 400 });
  const report = buildReport(catalog, { bazaar: {}, bins: null }, {
    categories: new Set(CATEGORIES),
    minXp: 0,
    packageSize: 1e9,
    packageCount: 1,
    targetXp: Number.POSITIVE_INFINITY,
    budget: null,
  } as never);
  return report.browser.find((entry) => entry.category === "pets")!;
}

const rarityOf = (task: ResolvedTask) => (task.cost.kind === "auction" ? task.cost.tier : undefined);

/**
 * Every pet in the catalogue at its best rarity, bar the ones named.
 *
 * The panel only ever shows forty rows, so a test that reaches for one pet out of eighty-odd is
 * really testing where it landed in the ranking. Owning the rest empties the list down to the
 * pets under test.
 */
function ownAllExcept(...spare: string[]): { type: string; tier: string }[] {
  return data.pets.pets
    .filter((pet) => !spare.includes(pet.key))
    .map((pet) => ({ type: pet.key, tier: pet.maxRarity }));
}

test("the top-rarity list is one row per pet", () => {
  const entry = petRows();
  assert.ok(entry.topRarity, "the pets panel offers the toggle");

  const groups = entry.topRarity!.map((t) => t.exclusiveGroup ?? t.id);
  assert.equal(new Set(groups).size, groups.length, "a pet appears at most once");
});

test("every row is the best rarity that pet reaches, mythic included", () => {
  const entry = petRows();
  const ceiling = new Map(data.pets.pets.map((pet) => [`pet:PET:${pet.key}`, pet.maxRarity]));

  for (const row of entry.topRarity!) {
    const key = row.exclusiveGroup ?? row.id;
    assert.equal(rarityOf(row), ceiling.get(key), `${key} is not offered at its ceiling`);
  }
  assert.ok(
    entry.topRarity!.some((t) => rarityOf(t) === "MYTHIC"),
    "a pet that goes mythic is offered there — the point is to skip the rungs, not to pick one",
  );
});

test("a pet that stops below legendary keeps its own ceiling rather than vanishing", () => {
  // The Precursor Drone never goes past common. Filtering to a fixed rarity would drop it, and a
  // pet you cannot see is a pet you will not buy. (The two epic-capped pets, Montezuma and the
  // Rift Ferret, are rift-bound and never become tasks at all, so this is the only one to test.)
  const entry = petRows(ownAllExcept("PRECURSOR_DRONE", "BEE"));
  const byGroup = new Map(entry.topRarity!.map((t) => [t.exclusiveGroup ?? t.id, t]));

  assert.equal(rarityOf(byGroup.get("pet:PET:PRECURSOR_DRONE")!), "COMMON");
  assert.equal(rarityOf(byGroup.get("pet:PET:BEE")!), "MYTHIC");
});

test("the toggle is what takes the rungs out", () => {
  // Left alone the list walks the ladder, so a pet can show up more than once on the way up.
  // Turned on it is one row, and that row is the end state.
  const entry = petRows(ownAllExcept("BEE"));
  const isBee = (t: ResolvedTask) => (t.exclusiveGroup ?? t.id) === "pet:PET:BEE";

  assert.ok(entry.tasks.filter(isBee).length >= 1);
  assert.deepEqual(entry.topRarity!.filter(isBee).map(rarityOf), ["MYTHIC"]);
});

test("a top-rarity row is priced from what you own, not from the rarity below it", () => {
  // The ranking walks the ladder, so a row taken out of it afterwards would be an upgrade over
  // the tier under it — quoting the gap between two of them to a player who owns neither.
  // Filtering has to happen before the sequence is built.
  const entry = petRows(ownAllExcept("BEE"));
  const bee = entry.topRarity!.find((t) => (t.exclusiveGroup ?? t.id) === "pet:PET:BEE")!;

  assert.equal(bee.xp, 18, "six score at three XP each, from a standing start");
  assert.doesNotMatch(bee.note ?? "", /upgrade from/, "not sold as a step up from a tier nobody owns");
});

test("owning a lower rarity already makes the top row worth only the difference", () => {
  const entry = petRows([...ownAllExcept("BEE"), { type: "BEE", tier: "EPIC" }]);
  const bee = entry.topRarity!.find((t) => (t.exclusiveGroup ?? t.id) === "pet:PET:BEE")!;

  assert.equal(bee.xp, 6, "mythic is six, and the epic already banked four");
});
