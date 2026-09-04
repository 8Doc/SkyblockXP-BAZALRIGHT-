import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
// @ts-expect-error - a plain build script, imported for its pure parsers only.
import { parseWisdomEffect, parseAttributeEntries } from "../scripts/fetch-wisdom-sources.mjs";
import {
  attributeLevel,
  cumulativeShards,
  detectWisdom,
  wisdomFromAttributes,
  wisdomFromLore,
  wisdomFromSlayers,
} from "../src/lib/wisdom";
import type { WisdomSources } from "../src/lib/wisdom";

const sourcesFile = JSON.parse(readFileSync("data/generated/wisdom-sources.json", "utf8"));
const sources: WisdomSources = { attributes: sourcesFile.attributes, slayer: sourcesFile.slayer };
const perLevel = JSON.parse(readFileSync("data/curated/attribute_levels.json", "utf8")).perLevel as Record<string, number[]>;
const attributes = JSON.parse(readFileSync("data/generated/attributes.json", "utf8")).attributes as {
  name: string;
  key: string;
  apiKey?: string;
}[];
const apiKeyOf = (name: string) => attributes.find((a) => a.name === name)?.apiKey ?? attributes.find((a) => a.name === name)?.key ?? null;

/* ------------------------------------------------------------- the scrape */

test("an effect line yields the skill and both ends of the range", () => {
  assert.deepEqual(parseWisdomEffect("Grants {{Stat|Mining Wisdom|+0.5–5}}"), {
    skill: "MINING",
    atLevel1: 0.5,
    atLevel10: 5,
  });
  // Veteran is the outlier and the largest: Combat, and ten times the others.
  assert.deepEqual(parseWisdomEffect("Grants {{Stat|Combat Wisdom|+1–10}}"), {
    skill: "COMBAT",
    atLevel1: 1,
    atLevel10: 10,
  });
  // The dash is an en dash on every row. A pattern expecting a hyphen finds nothing and reports
  // zero wisdom attributes rather than wrong ones — the better failure, but still a silent one.
  assert.equal(parseWisdomEffect("Grants {{Stat|Mining Wisdom|+0.5-5}}")?.skill, "MINING");
  assert.equal(parseWisdomEffect("Grants {{Stat|Ferocity|+1–10}}"), null);
});

test("an entry's effect is read past the pipes inside its own template", () => {
  // The bug this pins: the value is `Grants {{Stat|Mining Wisdom|+0.5–5}}`, and a field reader that
  // stops at the next pipe truncates it to "Grants {{Stat" and finds nothing at all.
  const entry = `{{Attribute Table Entry
| id = E36
| shard = Cavernshade
| attribute = Cavern Wisdom
| effect = Grants {{Stat|Mining Wisdom|+0.5–5}}
| skill = Mining
}}`;
  const rows = parseAttributeEntries(entry, "Epic");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].attribute, "Cavern Wisdom");
  assert.equal(rows[0].skill, "MINING");
  assert.equal(rows[0].atLevel10, 5);
});

test("the scraped table covers the attributes the game actually has", () => {
  const byAttribute = new Map(sources.attributes.map((a) => [a.attribute, a]));
  assert.equal(byAttribute.get("Cavern Wisdom")?.skill, "MINING");
  assert.equal(byAttribute.get("Garden Wisdom")?.skill, "FARMING");
  assert.equal(byAttribute.get("Sea Wisdom")?.skill, "FISHING");
  // Veteran does not have "Wisdom" in its name and is the biggest Combat source of the lot, so a
  // scrape keyed on the attribute's name rather than its effect would miss exactly the one that
  // matters most.
  assert.equal(byAttribute.get("Veteran")?.skill, "COMBAT");
  assert.equal(byAttribute.get("Veteran")?.atLevel10, 10);
  // Echo of Wisdom multiplies the others rather than granting any, so it must not be summed in.
  assert.equal(byAttribute.has("Echo of Wisdom"), false);
});

/* --------------------------------------------------------------- the lore */

test("wisdom is read out of item lore, colour codes and all", () => {
  // Real lore, section signs included. A pattern expecting the number to follow the colon directly
  // matches nothing here — silently, returning zero rather than failing.
  const lore = "§7Combat Wisdom: §3+1\n§7Farming Wisdom: §3+1\n§7Enchanting Wisdom: §3+1";
  assert.deepEqual(wisdomFromLore(lore), { COMBAT: 1, FARMING: 1, ENCHANTING: 1 });
});

test("decimals survive and repeats add up", () => {
  // An Abicase grants +1.5, and two accessories granting the same stat both count.
  const lore = "§7Fishing Wisdom: §3+1.5\n§7Fishing Wisdom: §3+2";
  assert.deepEqual(wisdomFromLore(lore), { FISHING: 3.5 });
  assert.deepEqual(wisdomFromLore("nothing here"), {});
});

/* --------------------------------------------------------- the attributes */

test("shard counts become levels against the right rarity ladder", () => {
  assert.deepEqual(cumulativeShards([1, 1, 2, 2, 3, 3, 4, 4, 5, 7]), [1, 2, 4, 6, 9, 12, 16, 20, 25, 32]);
  // An epic maxes at 32 shards, a legendary at 24. Applying the common ladder to a legendary reads
  // a maxed attribute as level 5 and halves what it grants.
  assert.equal(attributeLevel(32, perLevel.EPIC), 10);
  assert.equal(attributeLevel(24, perLevel.LEGENDARY), 10);
  // The same 24 shards read against the common ladder come out as level 5 — the halving the
  // comment above describes, and the reason the rarity has to be looked up rather than assumed.
  assert.equal(attributeLevel(24, perLevel.COMMON), 5);
  assert.equal(attributeLevel(0, perLevel.EPIC), 0);
});

test("an attribute's value is interpolated between the two published ends", () => {
  const maxed = wisdomFromAttributes({ cavern_wisdom: 32 }, sources, perLevel, apiKeyOf);
  assert.equal(maxed.MINING, 5);
  // Level 1 is the low end exactly, not a tenth of the high end.
  const one = wisdomFromAttributes({ cavern_wisdom: 1 }, sources, perLevel, apiKeyOf);
  assert.equal(one.MINING, 0.5);
  // Veteran at max is ten Combat Wisdom, on the legendary ladder.
  assert.equal(wisdomFromAttributes({ veteran: 24 }, sources, perLevel, apiKeyOf).COMBAT, 10);
  // Shards short of level 1 grant nothing rather than a fraction.
  assert.deepEqual(wisdomFromAttributes({ cavern_wisdom: 0 }, sources, perLevel, apiKeyOf), {});
});

/* ------------------------------------------------------------- the slayers */

test("combat wisdom counts unique slayer tiers, and the counters are zero-indexed", () => {
  // boss_kills_tier_0 is tier I. Reading it as tier 0 and shifting everything up would credit a
  // tier nobody has done.
  const one = wisdomFromSlayers({ zombie: { boss_kills_tier_0: 5 } }, sources);
  assert.equal(one.COMBAT, 1);
  // Tiers I-III are one each and IV-V are two, so a boss taken to V is seven.
  const full = wisdomFromSlayers(
    { zombie: { boss_kills_tier_0: 1, boss_kills_tier_1: 1, boss_kills_tier_2: 1, boss_kills_tier_3: 1, boss_kills_tier_4: 1 } },
    sources,
  );
  assert.equal(full.COMBAT, 7);
  // Wolf, Enderman and Blaze have no tier V and the API omits the counter entirely, so nothing
  // phantom is credited — which is what keeps the real maximum at 36 rather than 42.
  const wolf = wisdomFromSlayers(
    { wolf: { boss_kills_tier_0: 1, boss_kills_tier_1: 1, boss_kills_tier_2: 1, boss_kills_tier_3: 1 } },
    sources,
  );
  assert.equal(wolf.COMBAT, 5);
  // Kills beyond the first add nothing: it is unique tiers, not a body count.
  assert.equal(wisdomFromSlayers({ zombie: { boss_kills_tier_0: 9999 } }, sources).COMBAT, 1);
  assert.deepEqual(wisdomFromSlayers({}, sources), {});
});

/* ------------------------------------------------------------- everything */

test("the four sources sum, and say which of them contributed", () => {
  const d = detectWisdom({
    gearLore: ["§7Combat Wisdom: §3+1", "§7Foraging Wisdom: §3+5"],
    accessoryLore: ["§7Combat Wisdom: §3+6.5"],
    attributeStacks: { veteran: 24, cavern_wisdom: 32 },
    slayerBosses: { zombie: { boss_kills_tier_0: 1 } },
    sources,
    perLevelByRarity: perLevel,
    apiKeyOf,
  });

  // 1 gear + 6.5 accessories + 10 veteran + 1 slayer tier.
  assert.equal(d.total.COMBAT, 18.5);
  assert.equal(d.total.FORAGING, 5);
  assert.equal(d.total.MINING, 5);
  assert.deepEqual(d.found, ["gear", "accessories", "attributes", "slayers"]);
  assert.equal(d.bySource.slayers.COMBAT, 1);
  assert.equal(d.bySource.attributes.COMBAT, 10);
});

test("a profile with nothing readable reports nothing rather than zeroes", () => {
  const d = detectWisdom({
    gearLore: [""],
    accessoryLore: [""],
    attributeStacks: {},
    slayerBosses: {},
    sources,
    perLevelByRarity: perLevel,
    apiKeyOf,
  });
  assert.deepEqual(d.total, {});
  assert.deepEqual(d.found, []);
});
