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
  "pure coal": "ENCHANTED_COAL_BLOCK",
  "pure gold": "ENCHANTED_GOLD_BLOCK",
  "pure diamond": "ENCHANTED_DIAMOND_BLOCK",
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
  // `{{ID|Block of Gold!Pure Gold|link=Gold Ingot}}` — the row is the Dwarven Mines block, whose
  // item is the enchanted one. The other two Pures resolve by name; this one names itself twice.
  "block of gold": "ENCHANTED_GOLD_BLOCK",
};

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
  const resolve = resolver(names, npcPrices);

  const [farmingText, miningText, brewingText] = await Promise.all([
    wiki("Farming"),
    wiki("Mining"),
    wiki("Potions/Alchemy Experience"),
  ]);

  // The Farming page opens with a stats table that is not the XP table; the crops heading is the
  // only reliable landmark for where the one we want starts.
  const crops = farmingText.indexOf("=== Crops ===");
  const farming = parseMinionXp(crops < 0 ? farmingText : farmingText.slice(crops), "FARMING");
  const mining = parseMinionXp(miningText, "MINING");
  const brewing = parseBrewing(brewingText);

  const withIds = (rows) => rows.map((r) => ({ ...r, itemId: resolve(r.item) }));
  const perItem = withIds([...farming, ...mining]);
  const brews = withIds(brewing);
  const unresolved = [...perItem, ...brews].filter((r) => !r.itemId).map((r) => r.item);

  await writeFile(
    OUT,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        source: {
          minionXp: "Hypixel Wiki, Farming and Mining — the 'Minion XP' column of each skill's XP table.",
          brewing: "Hypixel Wiki, Potions/Alchemy Experience — XP yield per brew, keyed by first ingredient.",
          carpentry:
            "Hypixel Wiki, Carpentry — 'The XP gained is 3% of the combined NPC sell price of the ingredients used to craft the item.'",
          petXp: "Hypixel Wiki, Minions — collecting a minion grants the Skill XP, and an active pet levels off it.",
        },
        note:
          "minionXp is per item a minion produces and is NOT a fixed fraction of the XP for doing it by hand: " +
          "Wheat is +4 by hand and +0.3 from a minion, Ice is +0.2 by hand and +0.5 from a minion, and Nether Wart " +
          "is +4 by hand and +0 from one. null means the wiki publishes no figure, which is not the same as zero — " +
          "only Farming and Mining carry the column at all.",
        carpentryXpPerNpcCoin: 0.03,
        perItem,
        brewing: brews,
        unresolved,
      },
      null,
      1,
    ) + "\n",
  );

  const rated = perItem.filter((r) => r.minionXp !== null).length;
  console.log(`-> ${perItem.length} item rows, ${rated} with a published minion rate`);
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
