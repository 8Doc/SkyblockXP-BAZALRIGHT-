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

const members = await fetch(
  `${WIKI}?action=query&list=categorymembers&cmtitle=Category%3APets&cmlimit=500&format=json`,
  { headers: UA },
).then((r) => r.json());

// Pages in the category that are not pets — Autopet, Kat, the menu — do not end in " Pet".
const titles = (members.query?.categorymembers ?? []).map((m) => m.title).filter((t) => t.endsWith(" Pet"));
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

    pets.push({
      name: page.title.replace(/ Pet$/, ""),
      key: page.title.replace(/ Pet$/, "").toUpperCase().replace(/[^A-Z0-9]+/g, "_"),
      rarities: codes.map((c) => RARITY[c]),
      maxRarity: RARITY[best],
    });
  }
  process.stdout.write(`\r  ${Math.min(i + 50, titles.length)}/${titles.length}`);
}
process.stdout.write("\n");

const SCORE = { COMMON: 1, UNCOMMON: 2, RARE: 3, EPIC: 4, LEGENDARY: 5, MYTHIC: 6 };
pets.sort((a, b) => a.key.localeCompare(b.key));
// A pet is worth its rarity points, plus one more for reaching its maximum level.
const maxScore = pets.reduce((total, pet) => total + SCORE[pet.maxRarity] + 1, 0);

await writeFile(
  join(ROOT, "data", "generated", "pets.json"),
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      source: `${WIKI} — Category:Pets, Infobox/Pet rarity`,
      note: "Every pet and the rarities it can be. Pet score is the best copy's rarity points plus one for reaching max level.",
      maxScore,
      pets,
    },
    null,
    1,
  ) + "\n",
);
if (unparsed.length) console.log(`  no rarity on: ${unparsed.slice(0, 8).join(", ")}${unparsed.length > 8 ? " …" : ""}`);
console.log(`wrote ${pets.length} pets · maximum pet score ${maxScore} (the game's is 521)`);
