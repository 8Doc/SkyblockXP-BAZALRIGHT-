#!/usr/bin/env node
/**
 * The Greenhouse: its base crops, its forty Mutations, and what each one drops.
 *
 * All of it off the community wiki, which is where this lives — Hypixel publishes no greenhouse
 * resource, and the profile endpoint carries a player's own plots rather than the rules. Two of
 * the numbers that matter most are staff statements quoted on the wiki rather than wiki figures:
 * the mutation weight table and the Harvest Bounty pool both come from Hypixel developers posting
 * in Discord, cited inline on the page.
 *
 * **This data has a shelf life and the page says so.** On 2026 August 20 every base crop's drop
 * changed — Nether Wart went from 240 to 108, Carrot from 280 to 175, Sunflower from 160 to 232 —
 * so anything computed against the old figures is wrong by up to a factor of two in either
 * direction. `generatedAt` is the date to check against the page's own History section.
 *
 * Three shapes need care:
 *
 * **`{{bc}}` is a blank cell, not a zero.** Four mutations have no published weight because they
 * need a special condition rather than a roll — exploding a Turtlellini, growing a Jerryseed —
 * and reading that as "0% chance" would rank them as impossible rather than as unmeasured.
 *
 * **A mutation's size decides how many you have to buy.** Layouts are a 3x3 ring around the spot
 * the mutation spreads into, and the spreading condition counts *ring cells*, not plants. A 2x2
 * mutation covers two ring cells at once and a 3x3 covers three, so a requirement of three
 * Noctilume cells is met by two Noctilumes, not three. The wiki works this out in footnotes for
 * the six cases where it bites, and those are parsed rather than re-derived.
 *
 * **Growth stages are the clock.** Most commons are 0 — harvestable the moment they spread —
 * while Godseed is 40, and at roughly four hours a stage that is the whole difference between the
 * two ends of the list.
 *
 *   node scripts/fetch-greenhouse.mjs
 */
import { writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "data", "generated", "greenhouse.json");
const WIKI = "https://hypixelskyblock.minecraft.wiki/api.php";
const UA = { "User-Agent": "skyblock-xp-planner/0.1 (data build script)" };

async function wikitext(title) {
  const url = `${WIKI}?action=query&prop=revisions&rvprop=content|timestamp&rvslots=main&format=json&redirects=1&titles=${encodeURIComponent(title)}`;
  const body = await fetch(url, { headers: UA }).then((r) => r.json());
  const page = Object.values(body.query?.pages ?? {})[0];
  if (!page || page.missing !== undefined) return null;
  return { text: page.revisions?.[0]?.slots?.main?.["*"] ?? "", editedAt: page.revisions?.[0]?.timestamp };
}

/**
 * A display name reduced to a comparison key. Not an id — see `resolveIds`.
 *
 * Slugging a wiki name straight into an id looks right and is wrong for exactly the crops this
 * page is mostly about. The bazaar still carries Minecraft's 2013 names: Nether Wart trades as
 * `NETHER_STALK`, Cocoa Beans as `INK_SACK:3`, Potato as `POTATO_ITEM`, Melon Slice as `MELON`
 * and Sunflower as `DOUBLE_PLANT`. Guessed ids simply fail to price, and the failure is quiet —
 * six of the twelve base crops read as "nobody is bidding" when the bazaar is full of them.
 */
export const nameKey = (name) =>
  String(name)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");

/** The fallback id when the item resource has never heard of a name. */
export const slugId = (name) =>
  String(name)
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_|_$/g, "");

/**
 * Fire is lit with a flint and steel rather than bought, so it is a real requirement with no price
 * rather than an item to look up. It stays in the condition — Ashwreath's whole published chance
 * turns on its two Fire cells not counting as crops — and is marked so pricing does not hunt for it.
 *
 * Dead Plant used to be listed here too and should not have been: it trades on the bazaar as
 * `DEAD_PLANT` at several hundred coins, so Witherbloom's ring of four is a real bill and calling
 * it free understated the only cost that mutation has. It does still never *rot*, being what
 * rotting produces — but that belongs in the decay table, not here.
 */
const NOT_PURCHASABLE = /^Fire$/i;
/** Blocks a mutation grows *on*, which appear in the analysis cell and are not ingredients. */
const SURFACES = /^(Farmland|Dirt|Soul Sand)$/i;

/** `{{Item|Wheat|amount=100}}` and `{{Item|Pumpkin}}` alike. */
export function parseItemList(cell) {
  const out = [];
  for (const m of cell.matchAll(/\{\{Item\|([^|}]+)(?:\|amount=([\d,]+))?[^}]*\}\}/g)) {
    const name = m[1].trim();
    if (SURFACES.test(name)) continue;
    const entry = { id: slugId(name), name, amount: Number((m[2] ?? "1").replace(/,/g, "")) };
    if (NOT_PURCHASABLE.test(name)) entry.free = true;
    out.push(entry);
  }
  return out;
}

/**
 * `{{Item|Soggybud|amount=5}} / {{Item|Noctilume|amount=3}}` — everything a mutation needs beside
 * it, and how many ring cells each one has to fill.
 *
 * **The slash is "and", not "or".** It reads like a list of alternatives and it is a list of
 * requirements, which is worth being certain about because getting it wrong halves every setup
 * cost on the page. The layouts settle it: Thunderling's 3x3 holds three Noctilume *and* five
 * Soggybud, Scourroot's holds a Potato *and* a Carrot, Stoplight Petal's holds four Noctilume and
 * four Snoozling. Every slash-separated condition checked has all of its parts drawn at once.
 *
 * The counts sum to the ring, which is the other half of the proof: a 1x1 mutation has eight cells
 * around it and Stoplight Petal asks for 4 + 4; a 3x3 Snoozling has sixteen and asks for
 * 4 + 3 + 3 + 3 + 3.
 *
 * Where the condition is prose rather than items — "0 adjacent crops", "Explode a Turtlellini with
 * a Blastberry" — it is kept as prose and flagged, because a condition nobody has reduced to a
 * count is not one to guess a count for.
 */
export function parseSpreading(raw) {
  const text = raw.replace(/<ref[^>]*>[\s\S]*?<\/ref>/g, "").replace(/<ref[^/]*\/>/g, "").trim();
  const requires = [];
  for (const part of text.split("/")) {
    const items = parseItemList(part);
    // A bare `4x [[Witherbloom]]` appears once, where the editor wrote a link instead of a
    // template; it is the same statement and dropping it would lose a real requirement.
    const link = /(\d+)x\s*\[\[([^\]|]+)/.exec(part);
    if (items.length > 0) requires.push({ id: items[0].id, name: items[0].name, cells: items[0].amount, ...(items[0].free ? { free: true } : {}) });
    else if (link) requires.push({ id: slugId(link[2]), name: link[2].trim(), cells: Number(link[1]) });
  }
  return { raw: text, requires, prose: requires.length === 0 };
}

/** `{{Chance|15%|1|6.67}}` -> 0.15. */
export function parseChance(cell) {
  const m = /\{\{Chance\|([\d.]+)%/.exec(cell);
  return m ? Number(m[1]) / 100 : null;
}

/** A blank-cell template means the wiki has no figure, which is not the same as a figure of zero. */
const isBlank = (cell) => /\{\{bc\}\}/.test(cell) || cell.trim() === "";

const RARITIES = ["Common", "Uncommon", "Rare", "Epic", "Legendary", "Mythic", "Divine", "Special"];

/**
 * "This means 6 total blocks of Snoozlings. In practice, this can be achieved using 2 Snoozlings."
 *
 * The wiki doing the geometry so we do not have to. Both halves are taken — the ring cells the
 * condition asks for, and the number of plants that actually covers them — because the first is
 * what the game checks and the second is what you pay for.
 */
export function parsePlantNotes(row) {
  const notes = {};
  for (const m of row.matchAll(/group="note">This means (\d+) total blocks? of ([^.]+?)\. In practice, this can be achieved using \{\{Item\|([^|}]+)\|amount=(\d+)\}\}/g)) {
    notes[slugId(m[3])] = { cells: Number(m[1]), plants: Number(m[4]) };
  }
  return notes;
}

async function main() {
  console.log("reading the Mutations page…");
  const mutationsPage = await wikitext("Mutations");
  if (!mutationsPage) throw new Error("No Mutations page");
  console.log(`  last edited ${mutationsPage.editedAt}`);

  /* ------------------------------------------------- the staff weight table */

  // Quoted on the page from a Hypixel developer, and the only complete list of weights there is.
  // "weight of 0 means special conditions required", which is what makes a zero here meaningful
  // where a blank chance cell is not.
  const staffWeights = {};
  const weightBlock = /Mutation - Weight\s*\n-+\s*\n([\s\S]*?)<\/pre>/.exec(mutationsPage.text);
  if (weightBlock) {
    for (const line of weightBlock[1].split("\n")) {
      const m = /^([A-Z_0-9]+)\s*-\s*(\d+)\s*$/.exec(line.trim());
      if (m) staffWeights[m[1]] = Number(m[2]);
    }
  }
  console.log(`  ${Object.keys(staffWeights).length} weights from the staff table`);

  /* ------------------------------------------------------------- the rows */

  const mutations = [];
  const unresolved = [];
  for (const row of mutationsPage.text.split(/\n\|-\n/)) {
    const name = (/^\| \[\[([^\]|]+)\]\]\s*$/m.exec(row) ?? [])[1];
    if (!name) continue;

    const cells = row.split(/\n\| /);
    const analysis = /'''Size:'''\s*(\d+x\d+)/.exec(row);
    if (!analysis) {
      unresolved.push({ name, why: "no Size in the analysis cell" });
      continue;
    }

    const size = Number(analysis[1].split("x")[0]);
    const rarity = RARITIES.find((r) => new RegExp(`\\{\\{${r}[|}]`).test(row)) ?? null;
    const weightCell = cells.find((c) => /^class="ct" \| (\d+|\{\{bc\}\})/.test(c.trim())) ?? "";
    const staffWeight = staffWeights[slugId(name)];

    const stagesMatch = /\| class="ct" \| (\d+)\n\| [A-Z]/.exec(row);
    const spreadingRaw = (/'''Spreading Conditions:'''\s*(.+)/.exec(row) ?? [])[1] ?? "";
    const dropsCell = (/\| \{\{Item List\|([\s\S]*?)\}\}\s*$/m.exec(row) ?? [])[1] ?? "";
    const dropsRaw = (/\{\{Item List\|([\s\S]*?)(?:\n\||$)/.exec(row) ?? [])[1] ?? "";

    const drops = parseItemList(dropsRaw);
    const farmingXp = Number((/\{\{Skill XP\|([\d,]+) Farming\}\}/.exec(row) ?? [])[1]?.replace(/,/g, "") ?? 0) || null;

    mutations.push({
      id: slugId(name),
      name,
      rarity,
      size,
      /** Ring cells a plant of this size covers — see the header. */
      cellsPerPlant: size,
      surface: (/'''Growth Surface:'''\s*(.+)/.exec(row) ?? [])[1]?.replace(/\{\{Item\|([^|}]+)[^}]*\}\}/g, "$1").trim() ?? null,
      /** Null rather than zero where the wiki leaves the cell blank. */
      weight: staffWeight ?? (isBlank(weightCell) ? null : Number((/(\d+)/.exec(weightCell) ?? [])[1] ?? "") || null),
      chance: parseChance(row),
      growthStages: stagesMatch ? Number(stagesMatch[1]) : null,
      spreading: parseSpreading(spreadingRaw),
      plantNotes: parsePlantNotes(row),
      effects: ((/'''Effects:'''\s*(.+)/.exec(row) ?? [])[1] ?? "")
        .replace(/\{\{(?:Green|Red)\|([^}]+)\}\}/g, "$1")
        .split("/")
        .map((s) => s.trim())
        .filter(Boolean),
      drops,
      farmingXp,
      hasLayout: /\{\{\/Layout\//.test(row),
    });
  }
  console.log(`  ${mutations.length} mutations, ${mutations.filter((m) => m.weight === null).length} with no published weight`);

  /* ----------------------------------------------------------- the layouts */

  // The 3x3 ring each mutation spreads into the middle of, one page apiece.
  console.log("reading the layout subpages…");
  let layouts = 0;
  for (const mutation of mutations) {
    if (!mutation.hasLayout) continue;
    const page = await wikitext(`Mutations/Layout/${mutation.name}`);
    if (!page) continue;
    // The grid is not always 3x3. A 2x2 mutation is drawn on a 4x4 and a 3x3 one on a 5x5, because
    // the ring around a bigger block is bigger — twelve cells and sixteen rather than eight.
    // Reading a fixed 3x3 quietly took the wrong cells for exactly the mutations whose layout
    // matters most.
    const rows = Number(/\|rows=(\d+)/.exec(page.text)?.[1] ?? 3);
    const cols = Number(/\|cols=(\d+)/.exec(page.text)?.[1] ?? 3);
    const grid = [];
    const cellCounts = {};
    for (let r = 1; r <= rows; r++) {
      const line = [];
      for (let c = 1; c <= cols; c++) {
        const m = new RegExp(`\\|${r},${c}=([^,\\n]+)`).exec(page.text);
        const cell = (m?.[1] ?? "").trim();
        // Glass panes are the template's way of drawing "nothing here", not a crop to plant.
        const empty = /stained glass pane|^none$/i.test(cell) || cell === "";
        line.push(empty ? null : cell);
        if (!empty) cellCounts[cell] = (cellCounts[cell] ?? 0) + 1;
      }
      grid.push(line);
    }
    mutation.layout = grid;
    /** What the drawing actually contains, which cross-checks the parsed requirements. */
    mutation.layoutCounts = cellCounts;
    layouts++;
  }
  console.log(`  ${layouts} layouts`);

  /* ------------------------------------------------------- the greenhouse */

  console.log("reading the Greenhouse page…");
  const greenhousePage = await wikitext("Greenhouse");
  const gh = greenhousePage.text;

  // The base crop table: crop, base yield, growth cycles, buff.
  const baseCrops = [];
  const cropTable = gh.slice(gh.indexOf("! Crop"), gh.indexOf("Additionally, all base crops"));
  for (const chunk of cropTable.split(/\n\|-\n/)) {
    const name = (/\| \{\{Item\|([^|}]+)\}\}/.exec(chunk) ?? [])[1];
    if (!name) continue;
    const yieldMatch = /amount=(\d+)/.exec(chunk) ?? /\{\{RL\|(\d+)\s/.exec(chunk);
    const cycles = /\{\{Green\|(\d+)\}\}/.exec(chunk);
    if (!yieldMatch || !cycles) continue;
    baseCrops.push({
      id: slugId(name),
      name,
      baseYield: Number(yieldMatch[1]),
      growthCycles: Number(cycles[1]),
      unconfirmed: /\{\{Confirm\}\}/.test(chunk),
    });
  }

  // Harvest Bounty, from the same staff post as the weights.
  const bounty = [];
  const bountyBlock = /Item ID - Chance\s*\n-+\s*\n([\s\S]*?)<\/pre>/.exec(gh);
  if (bountyBlock) {
    for (const line of bountyBlock[1].split("\n")) {
      const m = /^([A-Z_0-9]+)\s*-\s*([\d.]+)\s*$/.exec(line.trim());
      if (m) bounty.push({ id: m[1], chance: Number(m[2]) });
    }
  }

  // Ethereal Vine, off the item's own page: the odds scale with the mutation's rarity, which is
  // a second revenue stream on every mutation and the only way to unlock more of the greenhouse.
  const vinePage = await wikitext("Ethereal Vine");
  const vineByRarity = {};
  if (vinePage) {
    const table = vinePage.text.slice(vinePage.text.indexOf("!Mutation Rarity"));
    for (const m of table.matchAll(/\|\{\{(\w+)\}\}\s*\n\|\{\{Green\|(\d+)%\}\}/g)) {
      vineByRarity[m[1].toLowerCase()] = Number(m[2]) / 100;
    }
  }

  /* -------------------------------------------------------- real item ids */

  // Every name the wiki wrote, resolved against Hypixel's own item resource. Mutations are not in
  // it — they are greenhouse-only and have no item id — so those keep their slug, which is what
  // the mutation list is keyed by anyway.
  console.log("resolving display names to item ids…");
  const items = (await (await fetch("https://api.hypixel.net/v2/resources/skyblock/items")).json()).items ?? [];
  const byName = new Map();
  for (const item of items) {
    if (!item.name || !item.id) continue;
    const key = nameKey(item.name);
    if (!byName.has(key)) byName.set(key, item.id);
  }
  const mutationSlugs = new Set(mutations.map((m) => m.id));
  const unresolvedNames = new Set();
  const resolve = (entry) => {
    if (mutationSlugs.has(entry.id)) return;
    const real = byName.get(nameKey(entry.name));
    if (real) entry.id = real;
    else unresolvedNames.add(entry.name);
  };
  for (const m of mutations) {
    m.drops.forEach(resolve);
    m.spreading.requires.forEach(resolve);
  }
  baseCrops.forEach(resolve);
  console.log(`  ${byName.size} names in the resource; ${unresolvedNames.size} wiki names had no match`);
  if (unresolvedNames.size) console.log(`    ${[...unresolvedNames].join(", ")}`);

  /* ------------------------------------------------------- crop fortune */

  // Thirteen separate stats, one per crop, and they are the reason fortune is not one number.
  // Farming Fortune lifts every crop; Wheat Fortune lifts wheat. A mutation dropping wheat and one
  // dropping cocoa beans are therefore affected differently by the same player's gear, which is
  // what makes crop fortune the only fortune that can change the *order* of this list.
  console.log("reading the Crop Fortune types…");
  const fortunePage = await wikitext("Crop Fortune");
  const cropFortunes = [];
  if (fortunePage) {
    const types = fortunePage.text.slice(fortunePage.text.indexOf("== Types =="), fortunePage.text.indexOf("== Increasing"));
    for (const m of types.matchAll(/\{\{stat\|([^|}]+) Fortune\}\}\s*\n\|(.+)/g)) {
      const crop = m[1].trim();
      // The affected-crop cell is an Item or an RL template; either way the first name is the crop.
      const affected = /\{\{(?:Item|RL)\|([^|}]+)/.exec(m[2])?.[1]?.trim() ?? crop;
      const id = byName.get(nameKey(affected));
      cropFortunes.push({ stat: `${crop} Fortune`, crop, ids: id ? [id] : [] });
    }
  }
  // "Mushroom Fortune" covers a crop the bazaar splits in two, and the only thing the item
  // resource offers for the bare name is `MUSHROOM_COLLECTION` — a collection key rather than
  // anything that drops. Overridden outright rather than only when the lookup fails, because the
  // lookup does not fail; it succeeds with the wrong kind of id, and a mushroom mutation would
  // silently miss the one crop fortune that applies to it.
  const mushroom = cropFortunes.find((f) => f.crop === "Mushroom");
  if (mushroom) mushroom.ids = ["RED_MUSHROOM", "BROWN_MUSHROOM"];
  console.log(`  ${cropFortunes.length} crop fortunes, ${cropFortunes.filter((f) => f.ids.length === 0).length} with no item id`);

  const payload = {
    generatedAt: new Date().toISOString(),
    /**
     * The thirteen crop-specific fortunes, and which item ids each one lifts.
     *
     * Kept as data rather than code because the list grows: Sunflower, Moonflower and Wild Rose
     * were added with the Greenhouse itself in December.
     */
    cropFortunes,
    cropFortuneNote:
      "Crop Fortune is added to Farming Fortune before the yield is worked out, per the Crop Fortune page: 'their farming fortune is first added to their Crop Fortune stat corresponding to the crop they are breaking'. Each point is a 1% chance of 100% more, and every whole 100 is a guaranteed 100% more — so the expected multiplier is 1 + (farming + crop) / 100. The wiki's own worked example is Cactus Fortune 233 giving 300% drops and a 33% chance of 400%. Sources include the farming tool held, Anita's shop, Carrolyn, and the Overdrive Chip, which grants up to +140 Crop Fortune for the active crop but only during a Jacob's Farming Contest.",
    /** Names the item resource has never heard of — priced as unknown rather than guessed at. */
    unresolvedNames: [...unresolvedNames],
    source: {
      mutations: "hypixelskyblock.minecraft.wiki/wiki/Mutations",
      greenhouse: "hypixelskyblock.minecraft.wiki/wiki/Greenhouse",
      weights: "Hypixel staff (mrkeith) posted in Discord, quoted on the Mutations page",
      bounty: "Hypixel staff (mrkeith) posted in Discord, quoted on the Greenhouse page",
    },
    editedAt: { mutations: mutationsPage.editedAt, greenhouse: greenhousePage.editedAt },
    note:
      "Base crop drops changed wholesale on 2026-08-20 — Nether Wart 240 to 108, Carrot 280 to 175, Sunflower 160 to 232 — so a figure computed before that date is wrong by up to a factor of two. A null weight or chance is a cell the wiki leaves blank, meaning the mutation needs a special condition rather than a roll; it is not a chance of zero. Layouts are the 3x3 ring the mutation spreads into the middle of, and a spreading condition counts ring cells rather than plants, which is why a 2x2 mutation satisfies two cells at once.",
    /** 4 hours a stage before any of the speed bonuses, per the Greenhouse page's own formula. */
    growth: {
      baseStageSeconds: 14_400,
      fastestStageSeconds: 6_063,
      formula: "T = 14400 / (1 + 0.025*uniqueCrops + 0.0025*cropGrowth + 0.005*speedAttribute + upgradeBonus)",
      upgradeBonus: "0.05 per tier for tiers 0-8; 0.50 at tier 9",
      source: "Greenhouse#Growth Stage",
    },
    /** Every crop's watering falls 2-3 a stage; the retain effects are what hold it up. */
    water: { lossPerStageMin: 2, lossPerStageMax: 3, retain: 0.5, improvedRetain: 1.0, drain: -0.3 },
    maxPlots: 3,
    yieldBuffs: {
      plantYieldUpgrade: [0.02, 0.2],
      evergreenChip: [0.02, 0.6],
      harvestBoost: 0.2,
      improvedHarvestBoost: 0.3,
      perUniqueCrop: 0.03,
      allTwelveUnique: 0.36,
    },
    etherealVineByRarity: vineByRarity,
    harvestBounty: bounty,
    baseCrops,
    mutations,
    unresolved,
  };

  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(payload, null, 2) + "\n", "utf8");

  console.log(`\n-> ${mutations.length} mutations, ${baseCrops.length} base crops, ${bounty.length} bounty drops`);
  console.log(`   ${mutations.filter((m) => m.layout).length} with a parsed layout`);
  console.log(`   ${mutations.filter((m) => m.spreading.prose).length} whose spreading condition is prose rather than a count:`);
  for (const m of mutations.filter((x) => x.spreading.prose)) console.log(`     ${m.name}: ${m.spreading.raw.slice(0, 70)}`);
  if (unresolved.length) console.log(`   ${unresolved.length} rows could not be read: ${unresolved.map((u) => u.name).join(", ")}`);
}

// Run when invoked directly; the parsers stay exported for the tests. No top-level await on the
// call — it stops the test runner transpiling the file at all.
if (process.argv[1]?.endsWith("fetch-greenhouse.mjs")) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
