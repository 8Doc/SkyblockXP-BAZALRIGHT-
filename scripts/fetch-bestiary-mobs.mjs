/**
 * Joins the mob ids a profile reports to the bestiary families they feed.
 *
 * The API hands out `bestiary.kills` keyed by internal mob id — `unburried_zombie_30`, `bezal_80`
 * — and nothing else: no family grouping, no thresholds, no caps. The wiki names families by
 * display name and never prints an id. So the two halves of the bestiary are published in
 * different vocabularies, and the join between them is the one thing neither source carries.
 *
 * Guessing it from the names does not work, and the failures are not near-misses: `bezal` is a
 * Blaze, `scatha` is a Worm, `team_treasurite_wendy` is a Grunt, and six separate goblin ids —
 * weakling_melee, weakling_bow, battler, creepertamer, murderlover, creeper — are all one
 * Goblin Raiders family. Grouping is real information, not spelling.
 *
 * SkyCrypt publishes it, because rendering the bestiary page requires it. Only the `mobs[]`
 * arrays are taken. Its `cap` and `bracket` are deliberately ignored: they disagree with the
 * wiki's on 92 of the families both describe, and where the two disagree the wiki is the one
 * that matches the game. Checked in-game: Creeper caps at 50 kills, which is the wiki's figure,
 * against SkyCrypt's 200. Its family list stopping at 208 against the wikis' 319 says the same
 * thing — it predates the newer islands. A rebalance moves a cap; it does not stop a Bezal being
 * a Blaze, so the stale half is dropped and the durable half kept, joined to our list by name.
 *
 *   node scripts/fetch-bestiary-mobs.mjs
 */
import { writeFile, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "data", "generated", "bestiary_mob_ids.json");
const SOURCE =
  "https://raw.githubusercontent.com/SkyCryptWebsite/SkyCrypt/master/src/constants/bestiary.js";

/** `Arachne's Brood` -> `arachne_brood`, matching how fetch-bestiary.mjs slugs a family name. */
const slug = (name) =>
  name
    .toLowerCase()
    .replace(/'s\b/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");

/**
 * Families whose SkyCrypt name is not the name our wiki list uses, where the difference is not a
 * rename either wiki records. Each was checked against the island and the mob ids rather than
 * matched by string distance. The renames the wikis *do* record arrive with the family list
 * instead, under `renames`, so this stays to the cases nothing published settles.
 */
const RENAMED = {
  "Arachne's Brood": "arachne_s_brood",
  "Arachne's Keeper": "arachne_s_keeper",
  // The Dwarven Mines mob the wiki now lists as Glacite Walker; ids still say ice_walker.
  "Ice Walker": "glacite_walker",
  // SkyCrypt spells it with one 'n'.
  "Millenia-Aged Blaze": "millennia_aged_blaze",
};

const source = await fetch(SOURCE, {
  headers: { "User-Agent": "skyblock-xp-planner/0.1 (data build script)" },
}).then((r) => {
  if (!r.ok) throw new Error(`${SOURCE} -> ${r.status}`);
  return r.text();
});

// The file is `export const BESTIARY = { ... };` followed by further exports, so the literal is
// taken by matching its braces rather than running to end of file. Evaluated rather than parsed:
// it is a plain object literal, and a regex over nested arrays would be the fragile way to read
// it. Strings here hold names and texture paths, never a brace, so counting is enough.
const open = source.indexOf("{", source.indexOf("export const BESTIARY"));
let depth = 0;
let end = -1;
for (let i = open; i < source.length; i++) {
  if (source[i] === "{") depth++;
  else if (source[i] === "}" && --depth === 0) {
    end = i + 1;
    break;
  }
}
if (end < 0) throw new Error("BESTIARY object literal is not brace-balanced");
const BESTIARY = new Function(`return ${source.slice(open, end)}`)();

const ours = JSON.parse(await readFile(join(ROOT, "data", "generated", "bestiary.json"), "utf8"));
const ourIds = new Set(ours.families.map((f) => f.id));

const aliases = {};
const unmatched = [];
let families = 0;

for (const island of Object.values(BESTIARY)) {
  for (const family of island.mobs ?? []) {
    families++;
    // SkyCrypt predates the wikis' renames, so it still says Gravel Skeleton and Endstone
    // Protector; the family list carries what those became.
    const id = RENAMED[family.name] ?? ours.renames?.[family.name] ?? slug(family.name);
    if (!ourIds.has(id)) {
      unmatched.push({ name: family.name, island: island.name, ids: family.mobs ?? [] });
      continue;
    }
    for (const mob of family.mobs ?? []) {
      // The id carries the mob's level; the bestiary counts a family across every level.
      const stem = String(mob).replace(/_-?\d+$/, "");
      // A stem that already resolves to itself is what the structural rule handles anyway.
      if (stem !== id) aliases[stem] = id;
    }
  }
}

const sorted = Object.fromEntries(Object.entries(aliases).sort(([a], [b]) => a.localeCompare(b)));

await writeFile(
  OUT,
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      source: SOURCE,
      note: "Internal mob id (level suffix stripped) -> the family id in bestiary.json it feeds. Taken from SkyCrypt's bestiary constants, which publish the grouping because rendering the page needs it. Only the mobs[] arrays are used: SkyCrypt's own caps and brackets are older than the wiki's and disagree with them on 92 families, so the tier maths stays with fetch-bestiary.mjs. Curated entries in bestiary_mobs.json are applied first and override anything here.",
      totals: { skyCryptFamilies: families, mapped: Object.keys(sorted).length, unmatched: unmatched.length },
      /** SkyCrypt families with no counterpart in our list — mobs we cannot score even so. */
      unmatched,
      aliases: sorted,
    },
    null,
    2,
  ) + "\n",
  "utf8",
);

console.log(`-> ${Object.keys(sorted).length} mob ids mapped across ${families} SkyCrypt families`);
if (unmatched.length) {
  console.log(`   ${unmatched.length} SkyCrypt families have no family of ours to attach to:`);
  for (const u of unmatched) console.log(`     ${u.name} (${u.island})`);
}
