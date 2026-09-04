/**
 * Every pet in the game and the highest rarity it reaches.
 *
 * The pet list used to come from the auction house sweep, which means a pet nobody happens to be
 * selling does not exist at all: a full sweep saw 97 pets worth 495 pet score against a real
 * maximum of 521. A ceiling that drifts with the market is not a ceiling.
 *
 * The wiki's pet infoboxes state the rarities each pet can be, so the catalogue can be fixed and
 * the auction house left to do what it is good for — prices.
 *
 * Writes data/generated/pets.json.
 */
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WIKI = "https://hypixelskyblock.minecraft.wiki/api.php";
const UA = { "User-Agent": "skyblock-xp-planner/0.1 (data build script)" };

/** Infobox rarity codes, and what each is worth in pet score. */
const RARITY = { C: "COMMON", U: "UNCOMMON", R: "RARE", E: "EPIC", L: "LEGENDARY", M: "MYTHIC" };
const ORDER = ["C", "U", "R", "E", "L", "M"];

/** Template fields are one per line as "| name = value". */
function field(text, name) {
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("|")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    if (trimmed.slice(1, eq).trim().toLowerCase() !== name) continue;
    return trimmed.slice(eq + 1).trim() || null;
  }
  return null;
}

/**
 * Which skill a pet levels off, from its infobox `type` line.
 *
 * This is the field that decides whether a minion and a pet are worth putting together at all. A
 * pet gains the full Skill XP of its own skill and a *third* of anything else, so pairing a Mining
 * minion with a Combat pet throws two thirds of the XP away — and the difference between the best
 * pairing and a careless one is larger than the difference between the best minion and the second.
 *
 * The line is written three ways across the pages and all three mean the same thing:
 *
 *   |type = [[Combat]] [[Pets|Pet]]
 *   |type = {{skill|Combat}} [[Pets|Pet]]
 *   |type = [[Farming]] [[Pet]]
 *
 * so the skill is pulled out by name rather than by position. Null where the type names no skill —
 * the Wisp is a "Gabagool" pet fed items rather than levelled off a skill, and the Bingo Pet takes
 * every skill at once. Those are real answers and not gaps; a caller must not read null as Combat.
 */
const SKILLS = ["COMBAT", "FARMING", "MINING", "FISHING", "FORAGING", "ENCHANTING", "ALCHEMY", "TAMING", "HUNTING"];

export function petSkill(box) {
  const type = field(box, "type");
  if (!type) return null;
  // Flatten the three markups to bare words first, so the match is on the word and not on which
  // template happened to wrap it. "[[Combat]] [[Pets|Pet]]" and "{{skill|Combat}} [[Pets|Pet]]"
  // both become "COMBAT PETS PET", and the word "PET" is why this looks for skills by name rather
  // than taking the first word it finds.
  const words = new Set(
    type
      .replace(/\{\{\s*skill\s*\|/gi, " ")
      .replace(/[[\]{}|]/g, " ")
      .toUpperCase()
      .split(/[^A-Z]+/)
      .filter(Boolean),
  );
  return SKILLS.find((skill) => words.has(skill)) ?? null;
}

const members = await fetch(
  `${WIKI}?action=query&list=categorymembers&cmtitle=Category%3APets&cmlimit=500&format=json`,
  { headers: UA },
).then((r) => r.json());

// Pages in the category that are not pets — Autopet, Kat, the menu — do not end in " Pet".
// Pages in the category that are not pets — Autopet, Kat, the menu — do not end in " Pet".
// The Bingo Pet is dropped outright: it exists only on Bingo profiles, so on a normal one it is
// a row nobody can ever complete. The wiki counts the game's pets as 81, or 80 without it.
const BINGO_ONLY = new Set(["Bingo Pet"]);
const titles = (members.query?.categorymembers ?? [])
  .map((m) => m.title)
  .filter((t) => t.endsWith(" Pet") && !BINGO_ONLY.has(t));
console.log(`reading ${titles.length} pet pages…`);

const pets = [];
const unparsed = [];
for (let i = 0; i < titles.length; i += 50) {
  const batch = titles.slice(i, i + 50);
  const url = `${WIKI}?action=query&prop=revisions&rvprop=content&rvslots=main&format=json&titles=${batch
    .map(encodeURIComponent)
    .join("|")}`;
  const body = await fetch(url, { headers: UA }).then((r) => r.json());

  for (const page of Object.values(body.query?.pages ?? {})) {
    const text = page.revisions?.[0]?.slots?.main?.["*"];
    if (!text) continue;
    // Only the pet infobox; a page can carry an item infobox for the egg as well.
    const start = text.indexOf("{{Infobox/Pet");
    if (start < 0) continue;
    const box = text.slice(start);

    // Two formats in use: a range of rarity templates, "rarities = {{Common}}-{{Mythic}}", or a
    // single letter code, "rarity = L". Both name the same thing.
    let codes = [];
    const range = field(box, "rarities");
    if (range) {
      const named = ORDER.filter((code) => range.toUpperCase().includes(`{{${RARITY[code]}}}`));
      if (named.length) {
        const lo = ORDER.indexOf(named[0]);
        const hi = ORDER.indexOf(named[named.length - 1]);
        codes = ORDER.slice(lo, hi + 1);
      }
    }
    if (!codes.length) {
      const raw = field(box, "rarity");
      if (raw) codes = ORDER.filter((code) => raw.toUpperCase().split(/[^A-Z]+/).includes(code));
    }
    if (!codes.length) {
      unparsed.push(page.title);
      continue;
    }
    const best = codes[codes.length - 1];

    // A pet the auction house will never carry cannot be bought, and this category is a
    // shopping list. The Rift's pets are the case that matters: Montezuma is rift-bound, so a
    // player with every buyable pet was still being told to go and get it.
    const saysNo = (name) => {
      const value = (field(box, name) ?? "").toLowerCase();
      return value === "n" || value === "no" || value === "false";
    };
    const buyable = !(saysNo("auctionable") || saysNo("tradeable"));

    pets.push({
      buyable,
      name: page.title.replace(/ Pet$/, ""),
      key: page.title.replace(/ Pet$/, "").toUpperCase().replace(/[^A-Z0-9]+/g, "_"),
      rarities: codes.map((c) => RARITY[c]),
      maxRarity: RARITY[best],
      skill: petSkill(box),
    });
  }
  process.stdout.write(`\r  ${Math.min(i + 50, titles.length)}/${titles.length}`);
}
process.stdout.write("\n");

const SCORE = { COMMON: 1, UNCOMMON: 2, RARE: 3, EPIC: 4, LEGENDARY: 5, MYTHIC: 6 };
pets.sort((a, b) => a.key.localeCompare(b.key));
// A pet is worth its rarity points, plus one more for reaching its maximum level.
const maxScore = pets.reduce((total, pet) => total + SCORE[pet.maxRarity] + 1, 0);
const unbuyable = pets.filter((p) => !p.buyable);

await writeFile(
  join(ROOT, "data", "generated", "pets.json"),
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      source: `${WIKI} — Category:Pets, Infobox/Pet rarity`,
      note:
        "Every pet, the rarities it can be, and the skill it levels off. Pet score is the best copy's rarity " +
        "points plus one for reaching max level. A null skill is a pet that does not level off a skill at all — the " +
        "Wisp is fed Gabagool and the Bingo Pet takes every skill — and must not be read as Combat.",
      maxScore,
      pets,
    },
    null,
    1,
  ) + "\n",
);
if (unparsed.length) console.log(`  no rarity on: ${unparsed.slice(0, 8).join(", ")}${unparsed.length > 8 ? " …" : ""}`);
console.log(`wrote ${pets.length} pets · maximum pet score ${maxScore} (the game's is 521)`);
console.log(`  ${unbuyable.length} cannot be bought: ${unbuyable.map((p) => p.name).join(", ")}`);
const noSkill = pets.filter((p) => !p.skill);
console.log(`  ${pets.length - noSkill.length} have a skill; ${noSkill.length} do not: ${noSkill.map((p) => p.name).join(", ")}`);
