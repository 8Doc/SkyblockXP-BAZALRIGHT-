#!/usr/bin/env node
/**
 * What a minion is worth in Skill XP, and therefore in Pet XP.
 *
 * The premise most minion calculators start from is that minions pay in coins and nothing else.
 * They pay in Skill XP too, and the Minions page says so outright — a co-op member who was away
 * when the minions were collected "will receive the Skill XP from them once they go to Private
 * Island" — and then says what it is *for*: "players can level the same pet multiple times from
 * collecting Minions once". That sentence is this file's reason to exist. A minion is a pet
 * levelling machine, and the rate is published.
 *
 * **Minion XP is not the XP you get for doing it yourself, and it is not a fixed fraction of it
 * either.** The Farming and Mining pages carry two separate columns and the ratio between them
 * wanders: Wheat is +4 by hand and +0.3 from a minion, Ice is +0.2 by hand and +0.5 from a
 * minion — *more* from the minion — and Nether Wart is +4 by hand and flatly +0 from one.
 * Anything that derived one column from the other would get all three wrong, which is why both
 * are scraped and neither is inferred.
 *
 * Only Farming and Mining publish the column. Foraging, Combat and Fishing minions plainly grant
 * something, but nobody has written the rate down, so those come back with `minionXp: null` and
 * the app says "not published" rather than quoting a zero it invented. A zero and an unknown rank
 * very differently, and conflating them would put every log minion at the bottom of a list it may
 * well top.
 *
 * The brewing table is the second route and a different shape: Alchemy XP is per *brew*, not per
 * item, so a minion feeds it only once its drops are compacted into the enchanted form the table
 * pays for — 15,000 Alchemy XP for one Enchanted Sugar Cane against 5 for one Sugar.
 *
 * Carpentry needs no table at all. The skill page states it as a formula — "The XP gained is 3%
 * of the combined NPC sell price of the ingredients used to craft the item" — and this repo
 * already holds both halves of it, in recipes.json and npc-prices.json. The constant and its
 * citation are carried here; the arithmetic happens where it is used.
 */

import { writeFile, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WIKI = "https://hypixelskyblock.minecraft.wiki/api.php";
const OUT = join(ROOT, "data", "generated", "skill-xp.json");

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

/* ------------------------------------------------------------------ parsing */

/** `{{Item|Iron|alt=Iron Ore}}` to "Iron Ore"; `{{Item|Wheat}}` to "Wheat". The alt is the display. */
export function itemName(cell) {
  const alt = /\|\s*alt\s*=\s*([^}|]+)/.exec(cell);
  if (alt) return alt[1].trim();
  const item = /\{\{(?:Item|ID)\|([^}|!]+)/.exec(cell);
  if (item) return item[1].trim();
  return cell
    .replace(/\{\{[^}]*\}\}/g, "")
    .replace(/\[\[([^\]|]*)\|?([^\]]*)\]\]/g, (_, a, b) => b || a)
    .trim();
}

/**
 * `| class="ct" | +0.3` to 0.3, and `{{bc}}` to null.
 *
 * `{{bc}}` is the wiki's blank cell and it means *nobody has measured this*, not zero. Netherrack
 * grants Mining XP by hand and carries a blank in the minion column; reading that as a zero would
 * be a claim the page does not make.
 */
export function xpValue(cell) {
  // A cell can carry HTML attributes before its content, separated by a second pipe.
  const body = cell.includes('"') ? cell.slice(cell.lastIndexOf("|") + 1) : cell;
  const text = body.replace(/\{\{confirm\}\}/gi, "").trim();
  if (!text || /\{\{bc\}\}/i.test(text)) return null;
  const number = /(-?[\d.]+)/.exec(text);
  return number ? Number(number[1]) : null;
}

/**
 * A wikitable into rows of cells, carrying rowspans down.
 *
 * Red and Brown Mushroom share one `rowspan="2"` XP cell, so the second row's markup is a single
 * item cell and nothing else. Read row by row without carrying, Brown Mushroom silently inherits
 * whatever the *next* table row happens to hold. Carrying forward is not a nicety here; it is the
 * difference between a right number and a plausible one.
 */
export function parseXpTable(wikitext, columns) {
  const rows = [];
  let carried = new Array(columns).fill(null);

  for (const block of wikitext.split(/\n\|-/)) {
    const cells = block
      .split("\n")
      .filter((line) => /^\s*\|(?!-|\})/.test(line))
      .map((line) => line.replace(/^\s*\|/, ""));
    if (cells.length === 0) continue;

    const row = new Array(columns);
    for (let i = 0; i < columns; i++) row[i] = cells[i] !== undefined ? cells[i] : carried[i];
    // A full row replaces what is carried; a short one is a rowspan continuation and keeps it.
    if (cells.length >= columns) carried = row.slice();
    rows.push(row);
  }
  return rows;
}

/** The Farming and Mining tables share a shape: item, player XP, minion XP, and where. */
export function parseMinionXp(wikitext, skill) {
  const start = wikitext.search(/^\{\|[^\n]*wikitable/m);
  if (start < 0) return [];
  const end = wikitext.indexOf("\n|}", start);
  const table = wikitext.slice(start, end < 0 ? undefined : end);

  const out = [];
  const seen = new Set();
  for (const row of parseXpTable(table, 3)) {
    const name = itemName(row[0] ?? "");
    if (!name || /^!/.test(row[0] ?? "") || /^(Item|XP|Minion XP|XP Received)$/i.test(name)) continue;
    const playerXp = xpValue(row[1] ?? "");
    const minionXp = xpValue(row[2] ?? "");
    if (playerXp === null && minionXp === null) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    out.push({ item: name, skill, playerXp, minionXp });
  }
  return out;
}

/**
 * The brewing table: which ingredient, and what one brew of it pays in Alchemy XP.
 *
 * One ingredient appears against several potions at the same yield — Fermented Spider Eye is in
 * four rows and pays 10 every time — so the list is deduplicated by ingredient rather than kept
 * per potion. The potion is not what a minion produces; the ingredient is.
 */
export function parseBrewing(wikitext) {
  const found = new Map();
  for (const m of wikitext.matchAll(/\{\{Slot\|([^}|]+)[^}]*\}\}[\s\S]*?\{\{Skill XP\|([\d,]+) Alchemy\}\}/g)) {
    const name = m[1].trim();
    const xp = Number(m[2].replace(/,/g, ""));
    if (!found.has(name) || found.get(name) < xp) found.set(name, xp);
  }
  return [...found.entries()].map(([item, xp]) => ({ item, xp })).sort((a, b) => b.xp - a.xp);
}

/* ------------------------------------------------------- the item infoboxes */

/**
 * `|minion_xp = 0.1 Foraging` — the rate off the item's own page, rather than off a skill's table.
 *
 * This is the better of the two sources and it was found second. The Farming and Mining pages each
 * carry a Minion XP column and *no other skill page does*, which made Foraging, Combat and Fishing
 * look unpublished; they are published, one item page at a time, in an infobox field. Forty-two
 * items carry it, and between them they cover four skills the tables never mention.
 *
 * Three things come out of the infobox that the tables cannot give:
 *
 *  - **The item id, stated.** `|id = INK_SACK:4` is the real id, so nothing has to be resolved from
 *    a display name and the whole class of "Lapis Lazuli is not LAPIS_LAZULI" mistakes goes away.
 *  - **The skill, per item.** A table's skill is whichever page it was on; here it is written down,
 *    which is how Enchanted Sugar turns out to be an *Alchemy* rate on a Farming minion's output.
 *  - **The enchanted forms**, which is what a minion with a compactor actually produces.
 *
 * The value is written every way a wiki writes things: `0.1 Mining`, `+0.3 Mining`, `+7,680
 * [[Mining]]`. All three are the same fact.
 */
export function parseInfoboxXp(wikitext, page) {
  const field = (name) => {
    const m = new RegExp(`\\|\\s*${name}\\s*=\\s*([^\\n|}]+)`).exec(wikitext);
    return m ? m[1].trim() : null;
  };

  const raw = field("minion_xp");
  if (!raw) return null;

  const clean = raw.replace(/\[\[([^\]|]*)\|?([^\]]*)\]\]/g, (_, a, b) => b || a);
  const parsed = /^\+?\s*([\d,.]+)\s*([A-Za-z]+)?/.exec(clean);
  if (!parsed) return null;

  const skillXp = field("skill_xp_given");
  const player = skillXp ? /^\+?\s*([\d,.]+)/.exec(skillXp.replace(/\[\[([^\]|]*)\|?([^\]]*)\]\]/g, (_, a, b) => b || a)) : null;

  return {
    item: page,
    itemId: field("id"),
    skill: parsed[2] ? parsed[2].toUpperCase() : null,
    minionXp: Number(parsed[1].replace(/,/g, "")),
    playerXp: player ? Number(player[1].replace(/,/g, "")) : null,
    source: "infobox",
  };
}

/**
 * Every item page carrying the field, found by asking the wiki rather than by listing them.
 *
 * A hand-kept list would go stale the moment somebody fills the field in on the Oak Log page — and
 * that is exactly the page whose absence this scrape most wants to notice. `insource:` searches the
 * raw wikitext, so it finds the field wherever it is used.
 */
async function infoboxPages() {
  const url =
    `${WIKI}?` +
    new URLSearchParams({ format: "json", action: "query", list: "search", srsearch: "insource:/minion_xp/", srlimit: "500" });
  const body = await (await fetch(url)).json();
  return (body.query?.search ?? []).map((r) => r.title);
}

/**
 * Compaction does not create Skill XP, and this is where that gets checked rather than assumed.
 *
 * An Enchanted Cobblestone is 160 cobblestone and grants 16 Mining XP against cobblestone's 0.1 —
 * exactly 160 times, exactly the recipe quantity. That holds for sixteen of the seventeen pairs
 * where both ends are published, including Sponge, whose recipe is 40 rather than 160 and whose XP
 * ratio is 40 to match. So a Super Compactor changes what a minion drops and not what the drop is
 * worth in XP, which is worth knowing: it is the opposite of what people assume, and it means the
 * XP half of the app can ignore the compactor entirely.
 *
 * The seventeenth is Spider Eye, published at 0.3 with an Enchanted Spider Eye at 480 where the
 * rule says 48. Sixteen exact agreements make a typo the likeliest reading by some distance, but
 * this reports the disagreement rather than silently correcting the wiki — and the drop a minion
 * actually produces is the base item, so the base rate is what gets used either way.
 */
export function checkCompactionLinearity(rows, recipes) {
  const byId = new Map(rows.filter((r) => r.itemId).map((r) => [r.itemId, r]));
  const checks = [];

  for (const recipe of recipes) {
    if (recipe.ingredients.length !== 1 || !(recipe.yield > 0)) continue;
    const to = byId.get(recipe.output);
    const from = byId.get(recipe.ingredients[0].id);
    if (!to || !from || !(from.minionXp > 0)) continue;

    const perCraft = recipe.ingredients[0].qty / recipe.yield;
    const expected = from.minionXp * perCraft;
    checks.push({
      from: from.itemId,
      to: to.itemId,
      perCraft,
      expected,
      published: to.minionXp,
      linear: Math.abs(expected - to.minionXp) < Math.max(0.01, expected * 0.001),
    });
  }
  return checks;
}

/* ------------------------------------------------------------- resolution */

/**
 * Display name to item id, off the same name table the bazaar tab prices against.
 *
 * The wiki writes ore rows as `{{Item|Iron|alt=Iron Ore}}` because an ore is what you break, but
 * SkyBlock has no ore *item* — the Iron Minion's drop is an Iron Ingot and the collection is Iron
 * Ingot. The translations are listed rather than pattern-matched: each is its own reason, and a
 * rule broad enough to cover them all would over-reach onto rows that mean what they say.
 */
export const ALIASES = {
  "iron ore": "IRON_INGOT",
  "gold ore": "GOLD_INGOT",
  "lapis lazuli ore": "INK_SACK:4",
  "lapis lazuli": "INK_SACK:4",
  "redstone ore": "REDSTONE",
  "emerald ore": "EMERALD",
  "diamond ore": "DIAMOND",
  "coal ore": "COAL",
  redstone: "REDSTONE",
  glowstone: "GLOWSTONE_DUST",
  wool: "WOOL",
  slimeball: "SLIME_BALL",
  "cocoa beans": "INK_SACK:3",
  melon: "MELON",
  "melon slice": "MELON",
  "nether wart": "NETHER_STALK",
  "raw porkchop": "PORK",
  "raw rabbit": "RABBIT",
  "raw mutton": "MUTTON",
  snowball: "SNOW_BALL",
  "rabbit's foot": "RABBIT_FOOT",
};

/**
 * Rows that are deliberately left without an item id.
 *
 * Pure Coal, Pure Gold and Pure Diamond are *blocks in the Dwarven Mines*, not items anything can
 * hold — there is no `PURE_COAL` in the bazaar's names or at any shopkeeper. An earlier pass
 * aliased them onto Enchanted Coal Block and friends because the wiki links them there, which
 * quietly filed a Dwarven Mines block's rate under a completely different item: the table says
 * Pure Coal is 2.7 and the Enchanted Coal Block's own page says 7,680, and only one of those is
 * about the thing named. The compaction cross-check is what caught it.
 *
 * Nothing is lost by leaving them out. No minion drops a Pure anything, so no ranking in the app
 * ever reads these rows — they simply stop claiming to be an item they are not.
 */
export const NOT_ITEMS = new Set(["pure coal", "pure gold", "pure diamond", "block of gold", "gemstone", "titanium"]);

/**
 * Display name to item id, from the bazaar's name table first and the shopkeepers' second.
 *
 * The brewing ingredients are the reason for the second lookup. Sugar, Blaze Powder, Golden Carrot
 * and Fermented Spider Eye are vanilla items that no bazaar carries, so the bazaar's name table
 * has never heard of them — but every one of them is in npc-prices.json under exactly the id its
 * name shouts, and a brewing table missing its cheap half is a brewing table that recommends only
 * the expensive routes.
 */
export function resolver(names, npcPrices = {}) {
  const byName = new Map();
  for (const [id, name] of Object.entries(names)) {
    const key = name.toLowerCase();
    if (!byName.has(key)) byName.set(key, id);
  }
  const shouted = (display) => display.trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_");

  return (display) => {
    const key = display.trim().toLowerCase();
    // Checked before the aliases and before the name table, because the whole point is that these
    // names *do* resolve to something plausible and the something is the wrong item.
    if (NOT_ITEMS.has(key)) return null;
    if (ALIASES[key]) return ALIASES[key];
    const named = byName.get(key);
    if (named) return named;
    const guess = shouted(display);
    return npcPrices[guess] ? guess : null;
  };
}

/* --------------------------------------------------------------------- main */

async function main() {
  const names = JSON.parse(await readFile(join(ROOT, "data", "generated", "bazaar_items.json"), "utf8")).names;
  const npcPrices = JSON.parse(await readFile(join(ROOT, "data", "generated", "npc-prices.json"), "utf8")).prices;
  const recipes = JSON.parse(await readFile(join(ROOT, "data", "generated", "recipes.json"), "utf8")).recipes;
  const resolve = resolver(names, npcPrices);

  const [farmingText, miningText, brewingText, pages] = await Promise.all([
    wiki("Farming"),
    wiki("Mining"),
    wiki("Potions/Alchemy Experience"),
    infoboxPages(),
  ]);

  // The Farming page opens with a stats table that is not the XP table; the crops heading is the
  // only reliable landmark for where the one we want starts.
  const crops = farmingText.indexOf("=== Crops ===");
  const farming = parseMinionXp(crops < 0 ? farmingText : farmingText.slice(crops), "FARMING");
  const mining = parseMinionXp(miningText, "MINING");
  const brewing = parseBrewing(brewingText);

  // The item pages, four at a time. Forty-two requests against a volunteer host on a build step.
  const infoboxes = [];
  for (let i = 0; i < pages.length; i += 4) {
    const batch = await Promise.all(
      pages.slice(i, i + 4).map((page) => wiki(page).then((w) => parseInfoboxXp(w, page)).catch(() => null)),
    );
    for (const row of batch) if (row) infoboxes.push(row);
  }

  const withIds = (rows) => rows.map((r) => ({ ...r, itemId: r.itemId ?? resolve(r.item), source: r.source ?? "table" }));
  const tableRows = withIds([...farming, ...mining]);
  // An id the infobox states is only trusted if something else in the game has heard of it: the
  // Enchanted Lush Berberis page carries `id = ENCHANTED_SHARK_FIN`, which is a copy-paste and not
  // an item. Anything unrecognised falls back to resolving the name like a table row would.
  const known = (id) => Boolean(id && (names[id] || npcPrices[id]));
  const infoboxRows = infoboxes.map((r) => ({
    ...r,
    itemId: known(r.itemId) ? r.itemId : resolve(r.item),
    statedId: known(r.itemId) ? undefined : r.itemId,
  }));

  const linearity = checkCompactionLinearity(infoboxRows, recipes);
  const nonLinear = linearity.filter((c) => !c.linear);

  // Where both sources cover an item they must agree, and where they do not the table wins: it is
  // the one a human maintains as a set, so a lone infobox drifting is the likelier error.
  const byId = new Map(tableRows.filter((r) => r.itemId).map((r) => [r.itemId, r]));
  const disagreements = [];
  const added = [];
  for (const row of infoboxRows) {
    if (!row.itemId) continue;
    const table = byId.get(row.itemId);
    if (!table) {
      added.push(row);
      continue;
    }
    if (table.minionXp !== null && Math.abs(table.minionXp - row.minionXp) > 1e-9) {
      disagreements.push({ itemId: row.itemId, table: table.minionXp, infobox: row.minionXp });
    } else if (table.minionXp === null) {
      // The table left the cell blank and the item page filled it in. That is the gap closing.
      table.minionXp = row.minionXp;
      table.filledFrom = "infobox";
    }
  }

  const perItem = [...tableRows, ...added];
  const brews = withIds(brewing);
  const unresolved = [...perItem, ...brews].filter((r) => !r.itemId).map((r) => r.item);
  const skills = [...new Set(perItem.filter((r) => r.minionXp !== null).map((r) => r.skill))].sort();

  await writeFile(
    OUT,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        source: {
          minionXpTables: "Hypixel Wiki, Farming and Mining — the 'Minion XP' column of each skill's XP table.",
          minionXpInfoboxes:
            "Hypixel Wiki, every item page carrying a |minion_xp= infobox field, found with insource:/minion_xp/. " +
            "The only place Foraging, Fishing, Combat and Alchemy minion rates are published at all.",
          brewing: "Hypixel Wiki, Potions/Alchemy Experience — XP yield per brew, keyed by first ingredient.",
          carpentry:
            "Hypixel Wiki, Carpentry — 'The XP gained is 3% of the combined NPC sell price of the ingredients used to craft the item.'",
          petXp: "Hypixel Wiki, Minions — collecting a minion grants the Skill XP, and an active pet levels off it.",
        },
        note:
          "minionXp is per item a minion produces and is NOT a fixed fraction of the XP for doing it by hand: " +
          "Wheat is +4 by hand and +0.3 from a minion, Ice is +0.2 by hand and +0.5 from a minion, and Nether Wart " +
          "is +4 by hand and +0 from one. null still means unpublished rather than zero.",
        compaction:
          "Compaction is XP-neutral. An enchanted item's minion XP is its recipe quantity times the base item's, " +
          "checked against every pair where both are published — including Sponge, whose recipe is 40 rather than " +
          "160 and whose XP ratio is 40 to match. So a Super Compactor changes what a minion drops and not what " +
          "the drop is worth in XP, and the XP model can ignore it.",
        carpentryXpPerNpcCoin: 0.03,
        skillsCovered: skills,
        perItem,
        brewing: brews,
        linearityChecks: linearity.length,
        nonLinear,
        disagreements,
        unresolved,
      },
      null,
      1,
    ) + "\n",
  );

  const rated = perItem.filter((r) => r.minionXp !== null).length;
  const filled = perItem.filter((r) => r.filledFrom).length;
  console.log(`-> ${perItem.length} item rows, ${rated} with a published minion rate, across ${skills.join(", ")}`);
  console.log(`   ${infoboxRows.length} item infoboxes: ${added.length} rows the tables never had, ${filled} blanks filled`);
  console.log(`   ${linearity.length} compaction pairs checked, ${nonLinear.length} not linear`);
  for (const c of nonLinear) console.log(`     ${c.from} x${c.perCraft} -> ${c.to}: expected ${c.expected}, published ${c.published}`);
  if (disagreements.length) console.log(`   ${disagreements.length} table/infobox disagreements: ${JSON.stringify(disagreements)}`);
  console.log(`   ${brews.length} brewing ingredients`);
  if (unresolved.length) console.log(`   ${unresolved.length} names with no item id: ${unresolved.join(", ")}`);
}

// Called rather than awaited at the top level: the tests import the parsers above out of this
// same file, and a top-level await makes it untransformable for that.
if (process.argv[1]?.endsWith("fetch-skill-xp.mjs")) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
