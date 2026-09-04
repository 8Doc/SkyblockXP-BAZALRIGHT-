import type { SkillKey } from "./minionXp";

/**
 * Reading a player's Wisdom off their profile, and being honest about the part that cannot be.
 *
 * Wisdom multiplies Skill XP before anything else touches it, so on the pet tab it is the input
 * most worth getting right — and asking for six numbers by hand is the sort of chore people skip,
 * leaving every figure on that page computed against zero. It is worth some effort to fill in.
 *
 * **Hypixel never publishes a total.** There is no `wisdom` field anywhere in a profile. What there
 * is, is the parts, in three different shapes:
 *
 *  - **Item lore.** Armour, equipment and accessories state it outright — a line reading
 *    `Combat Wisdom: §3+1`. This app already gunzips and walks that NBT for other reasons, so the
 *    only new work is a regular expression. This is the largest source for a geared account.
 *  - **Attributes.** Ten attributes grant Wisdom, each stating a range across its ten levels, and
 *    the profile carries the shard counts. `wisdom-sources.json` holds the table.
 *  - **Slayers.** Every unique boss tier ever slain grants Combat Wisdom, one for tiers I–III and
 *    two for IV–V. The profile carries the per-tier kill counts.
 *
 * **And what is left out, which the caller must say out loud.** A Booster Cookie and active potions
 * are transient and not in the profile in any usable form. The held item is whatever you happen to
 * be holding. The Ultimate Wisdom enchantment is a separate multiplier on Skill XP rather than a
 * contribution to the Wisdom stat, and folding it in here would double-count it against itself.
 *
 * So this returns a **floor**, not a total, and says which sources it managed to read. A figure
 * that claims to be complete and is short by a hundred is worse than an obviously partial one —
 * the whole reason the boxes stay editable.
 */

/* ------------------------------------------------------------------ tables */

export type WisdomAttribute = {
  attribute: string;
  rarity: string;
  skill: string;
  atLevel1: number;
  atLevel10: number;
};

export type WisdomSources = {
  attributes: WisdomAttribute[];
  slayer: { perTier: Record<string, number>; skill: string };
};

/** Where a figure came from, so the UI can say so rather than presenting a bare number. */
export type WisdomSource = "gear" | "accessories" | "attributes" | "slayers";

export type DetectedWisdom = {
  /** Per skill, summed across every source that could be read. */
  total: Partial<Record<SkillKey, number>>;
  /** The same, split by where it came from — for the breakdown under the boxes. */
  bySource: Record<WisdomSource, Partial<Record<SkillKey, number>>>;
  /** Sources that actually contributed something, for the "read from" line. */
  found: WisdomSource[];
};

/* -------------------------------------------------------------------- lore */

/**
 * Every `<Skill> Wisdom: +N` an item's lore states.
 *
 * The colour codes are the trap. SkyBlock lore is `Combat Wisdom: §3+1`, and a pattern that expects
 * the number to follow the colon directly matches nothing — silently, returning zero rather than
 * failing. The section sign and its one following character are stripped first.
 *
 * Decimals are real: an Abicase grants +1.5, and rounding it away would be a choice nobody made.
 */
const WISDOM_LINE = /([A-Za-z]+) Wisdom: \+([\d.]+)/g;

export function wisdomFromLore(text: string): Partial<Record<SkillKey, number>> {
  const clean = text.replace(/§./g, "");
  const out: Partial<Record<SkillKey, number>> = {};
  for (const m of clean.matchAll(WISDOM_LINE)) {
    const skill = m[1].toUpperCase() as SkillKey;
    const amount = Number(m[2]);
    if (!Number.isFinite(amount)) continue;
    out[skill] = (out[skill] ?? 0) + amount;
  }
  return out;
}

/* -------------------------------------------------------------- attributes */

/** Cumulative shards for levels 1-10, from the per-level steps this repo already carries. */
export function cumulativeShards(perLevel: number[]): number[] {
  let running = 0;
  return perLevel.map((step) => (running += step));
}

/**
 * What level an attribute sits at, from the shards syphoned into it.
 *
 * Zero where it has not reached level 1. The rarity matters and is easy to get wrong: a legendary
 * maxes at 24 shards where a common needs 96, so applying the common table to `Veteran` reads a
 * maxed attribute as level 5 and halves the Combat Wisdom it grants.
 */
export function attributeLevel(stacks: number, perLevel: number[]): number {
  const thresholds = cumulativeShards(perLevel);
  let level = 0;
  for (const need of thresholds) if (stacks >= need) level++;
  return level;
}

/**
 * Wisdom from attribute shards.
 *
 * The wiki states each attribute's value at level 1 and at level 10 and nothing in between, so the
 * levels are spaced evenly — which for every wisdom attribute is exact, because the two ends are
 * always a tenfold step (0.5 to 5, or 1 to 10). Interpolating is therefore reading the table
 * rather than guessing at it.
 */
export function wisdomFromAttributes(
  stacks: Record<string, number>,
  sources: WisdomSources,
  perLevelByRarity: Record<string, number[]>,
  apiKeyOf: (attribute: string) => string | null,
): Partial<Record<SkillKey, number>> {
  const out: Partial<Record<SkillKey, number>> = {};

  for (const attribute of sources.attributes) {
    const apiKey = apiKeyOf(attribute.attribute);
    if (!apiKey) continue;
    const held = stacks[apiKey];
    if (!(held > 0)) continue;

    const perLevel = perLevelByRarity[attribute.rarity] ?? perLevelByRarity.COMMON;
    const level = attributeLevel(held, perLevel);
    if (level <= 0) continue;

    const step = (attribute.atLevel10 - attribute.atLevel1) / 9;
    const value = attribute.atLevel1 + step * (level - 1);
    const skill = attribute.skill as SkillKey;
    out[skill] = (out[skill] ?? 0) + value;
  }
  return out;
}

/* ----------------------------------------------------------------- slayers */

export type SlayerBoss = Record<string, number | undefined>;

/**
 * Combat Wisdom from Slayer tiers.
 *
 * Counted on *unique tiers ever slain* rather than on kills, so one boss of each tier is the whole
 * of it and a thousand more add nothing. Hypixel's per-tier counters are zero-indexed —
 * `boss_kills_tier_0` is tier I — which is the sort of off-by-one that would quietly credit tier V
 * to someone who has only done IV.
 */
export function wisdomFromSlayers(
  bosses: Record<string, SlayerBoss | undefined>,
  sources: WisdomSources,
): Partial<Record<SkillKey, number>> {
  let total = 0;
  for (const boss of Object.values(bosses)) {
    if (!boss) continue;
    for (const [tier, grant] of Object.entries(sources.slayer.perTier)) {
      const kills = boss[`boss_kills_tier_${Number(tier) - 1}`];
      if (typeof kills === "number" && kills > 0) total += grant;
    }
  }
  return total > 0 ? { [sources.slayer.skill as SkillKey]: total } : {};
}

/* --------------------------------------------------------------- together */

function add(into: Partial<Record<SkillKey, number>>, from: Partial<Record<SkillKey, number>>): void {
  for (const [skill, value] of Object.entries(from)) {
    if (typeof value !== "number") continue;
    into[skill as SkillKey] = (into[skill as SkillKey] ?? 0) + value;
  }
}

export type DetectInput = {
  /** Lore text of equipped armour and equipment, already decompressed. */
  gearLore: string[];
  /** Lore text of the accessory bag. */
  accessoryLore: string[];
  attributeStacks: Record<string, number>;
  slayerBosses: Record<string, SlayerBoss | undefined>;
  sources: WisdomSources;
  perLevelByRarity: Record<string, number[]>;
  apiKeyOf: (attribute: string) => string | null;
};

/**
 * Everything that can be read, per skill, with its provenance.
 *
 * Deliberately does not round. A player with 17.24 Foraging Wisdom has 17.24, and the box shows it;
 * rounding to 17 would be a silent claim that the last digit does not matter, which for a
 * multiplier applied to every figure on the page is not obviously true.
 */
export function detectWisdom(input: DetectInput): DetectedWisdom {
  const bySource: DetectedWisdom["bySource"] = { gear: {}, accessories: {}, attributes: {}, slayers: {} };

  for (const lore of input.gearLore) add(bySource.gear, wisdomFromLore(lore));
  for (const lore of input.accessoryLore) add(bySource.accessories, wisdomFromLore(lore));
  add(bySource.attributes, wisdomFromAttributes(input.attributeStacks, input.sources, input.perLevelByRarity, input.apiKeyOf));
  add(bySource.slayers, wisdomFromSlayers(input.slayerBosses, input.sources));

  const total: Partial<Record<SkillKey, number>> = {};
  const found: WisdomSource[] = [];
  for (const source of ["gear", "accessories", "attributes", "slayers"] as WisdomSource[]) {
    const part = bySource[source];
    if (Object.values(part).some((v) => (v ?? 0) > 0)) found.push(source);
    add(total, part);
  }

  return { total, bySource, found };
}

export const NOT_COUNTED =
  "A Booster Cookie, active potions, whatever you are holding, and the Ultimate Wisdom enchantment are not " +
  "counted — the first two are not in the profile, the third depends on your hand, and the last is a separate " +
  "multiplier on Skill XP rather than part of the Wisdom stat. So this is a floor: your real figures are these " +
  "or higher.";
