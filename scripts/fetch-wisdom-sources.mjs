#!/usr/bin/env node
/**
 * Which attributes grant Wisdom, and how much.
 *
 * Wisdom multiplies Skill XP before anything else touches it, so on the pet tab it is the single
 * input most worth getting right — and typing six numbers by hand is the sort of chore people skip,
 * leaving every figure on the page computed against zero. Most of a player's Wisdom *is* readable
 * from their profile; it is just never published as a total, only as the parts.
 *
 * The parts live in three different shapes and this file covers the one that needs a table:
 *
 *  - **Item lore.** Armour, equipment and accessories state it outright — `Combat Wisdom: §3+1`.
 *    That needs no table at all, only the NBT this app already decodes.
 *  - **Slayers.** A flat published rule, carried in the JSON below rather than scraped: every
 *    unique boss tier slain grants Combat Wisdom, one each for tiers I–III and two for IV–V.
 *  - **Attributes.** Ten of them grant Wisdom and each states a range across its ten levels. That
 *    is what this scrapes, from `Attributes/List/<rarity>`, where every entry is an
 *    `{{Attribute Table Entry}}` carrying `attribute` and `effect`.
 *
 * The effect reads `Grants {{Stat|Mining Wisdom|+0.5–5}}` — the value at level 1 and at level 10,
 * with the levels in between spaced evenly. Both ends are kept rather than a per-level step,
 * because that is what the page states and a step is a derivation.
 *
 * `Echo of Wisdom` is the odd one and is carried separately: it does not grant Wisdom, it makes
 * every *other* Wisdom attribute stronger by a percentage. Folding it in as a flat grant would be
 * wrong in a way that scales with how many wisdom attributes a player has.
 */

import { writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WIKI = "https://hypixelskyblock.minecraft.wiki/api.php";
const OUT = join(ROOT, "data", "generated", "wisdom-sources.json");
const RARITIES = ["Common", "Uncommon", "Rare", "Epic", "Legendary"];

async function wiki(page) {
  const url = `${WIKI}?${new URLSearchParams({ format: "json", action: "parse", page, prop: "wikitext" })}`;
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(url);
    if (response.ok) {
      const body = await response.json();
      if (!body.parse) throw new Error(`no page: ${page}`);
      return body.parse.wikitext["*"];
    }
    if (response.status !== 429 || attempt >= 3) throw new Error(`${response.status} for ${page}`);
    await new Promise((done) => setTimeout(done, 2_000 * (attempt + 1)));
  }
}

/**
 * `|attribute = Cavern Wisdom` → the field, trimmed.
 *
 * Reads to the end of the line rather than to the next pipe, which is the whole trick here: the
 * value being read is `Grants {{Stat|Mining Wisdom|+0.5–5}}`, and stopping at a pipe truncates it
 * to "Grants {{Stat" — which finds nothing and reports zero wisdom attributes rather than wrong
 * ones. Template parameters on these pages are one per line, so the line is the right boundary.
 */
function field(entry, name) {
  const m = new RegExp(`\\|\\s*${name}\\s*=\\s*([^\\n]*)`).exec(entry);
  return m ? m[1].trim() : null;
}

/**
 * `Grants {{Stat|Mining Wisdom|+0.5–5}}` → the skill and both ends of the range.
 *
 * The dash is an en dash on every row, which is worth knowing before writing the pattern: a
 * hyphen finds nothing and the scrape comes back empty rather than wrong, which is the better
 * failure but still a silent one.
 */
export function parseWisdomEffect(effect) {
  const m = /\{\{Stat\|([A-Za-z ]+?)\s+Wisdom\|\+?([\d.]+)\s*[–-]\s*\+?([\d.]+)\}\}/.exec(effect);
  if (!m) return null;
  return { skill: m[1].trim().toUpperCase(), atLevel1: Number(m[2]), atLevel10: Number(m[3]) };
}

export function parseAttributeEntries(wikitext, rarity) {
  const out = [];
  for (const entry of wikitext.split("{{Attribute Table Entry").slice(1)) {
    const attribute = field(entry, "attribute");
    const effect = field(entry, "effect") ?? "";
    if (!attribute || !/Wisdom/i.test(effect)) continue;

    const parsed = parseWisdomEffect(effect);
    if (!parsed) {
      // Echo of Wisdom multiplies the others rather than granting any, so it has no Stat template
      // to read. Recorded by name so a caller can see it was found and deliberately not summed.
      out.push({ attribute, rarity: rarity.toUpperCase(), multiplier: true, effect: effect.replace(/\{\{[^}]*\}\}/g, "").trim() });
      continue;
    }
    out.push({ attribute, rarity: rarity.toUpperCase(), ...parsed });
  }
  return out;
}

async function main() {
  const attributes = [];
  for (const rarity of RARITIES) {
    attributes.push(...parseAttributeEntries(await wiki(`Attributes/List/${rarity}`), rarity));
  }

  const granting = attributes.filter((a) => !a.multiplier);
  const multipliers = attributes.filter((a) => a.multiplier);

  await writeFile(
    OUT,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        source: {
          attributes: "Hypixel Wiki, Attributes/List/<rarity> — the `effect` field of each {{Attribute Table Entry}}.",
          slayers: "Hypixel Wiki, Combat Wisdom — 'Each unique tier of Slayer bosses grants Combat Wisdom. Tiers I-III grant 1 each and tiers IV and V grant 2 each.'",
          lore: "The items themselves. Armour, equipment and accessories state their Wisdom in lore, which this app already decodes.",
        },
        note:
          "Wisdom is never published as a total, only as its parts. These are the parts that can be read from a " +
          "profile without guessing. What is NOT here, and cannot be: a Booster Cookie, active potions, the held " +
          "item (which depends on what you happen to be holding), and the Ultimate Wisdom enchantment, which is a " +
          "separate multiplier on Skill XP rather than a contribution to the Wisdom stat.",
        attributes: granting,
        multiplierAttributes: multipliers,
        slayer: {
          perTier: { 1: 1, 2: 1, 3: 1, 4: 2, 5: 2 },
          skill: "COMBAT",
          why: "Counted on unique tiers ever slain rather than on kills, so one boss of each tier is the whole of it.",
        },
      },
      null,
      1,
    ) + "\n",
  );

  console.log(`-> ${granting.length} wisdom attributes across ${new Set(granting.map((a) => a.skill)).size} skills`);
  for (const a of granting) console.log(`   ${a.attribute.padEnd(18)} ${a.rarity.padEnd(10)} ${a.skill} +${a.atLevel1}–${a.atLevel10}`);
  for (const a of multipliers) console.log(`   ${a.attribute.padEnd(18)} ${a.rarity.padEnd(10)} (multiplier, not summed)`);
}

if (process.argv[1]?.endsWith("fetch-wisdom-sources.mjs")) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
