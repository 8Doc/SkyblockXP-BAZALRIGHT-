#!/usr/bin/env node
/**
 * Scrapes the task tables the API doesn't publish.
 *
 * The Hypixel API exposes XP for skills, collections, minions and museum donations, but nothing
 * at all for essence perks, fast travel, bank upgrades, abiphone contacts, slayers, events or
 * the rift. Those live only on the wiki — which is what the project spec assumed all along
 * ("scraped from the wiki, committed to the repo as JSON").
 *
 * Output is a flat row list; mapping rows onto Hypixel's internal task ids happens in
 * build-task-table.mjs, where it can be checked against ids harvested from real players.
 *
 *   node scripts/fetch-wiki-tasks.mjs
 */
import { writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "data", "generated", "wiki_tasks.json");

const WIKI = "https://hypixel-skyblock.fandom.com/api.php";
const PAGE = "SkyBlock Levels/Tasks";

async function wikitext(page) {
  const url = `${WIKI}?action=parse&page=${encodeURIComponent(page)}&format=json&prop=wikitext`;
  const res = await fetch(url, { headers: { "User-Agent": "skyblock-xp-planner/0.1 (data build script)" } });
  if (!res.ok) throw new Error(`${page} -> ${res.status}`);
  const body = await res.json();
  if (body.error) throw new Error(`${page} -> ${body.error.info}`);
  return body.parse.wikitext["*"];
}

/* ------------------------------------------------------- wikitext cleaning */

/** Pull the number out of {{SkyBlock XP|+5|short=y}} / {{SkyBlock XP|1,220|short=y}}. */
function xpValues(cell) {
  const out = [];
  for (const match of cell.matchAll(/\{\{\s*SkyBlock XP\s*\|\s*\+?([\d,]+)/gi)) {
    out.push(Number(match[1].replace(/,/g, "")));
  }
  return out;
}

/** Strip wiki markup down to readable text. */
function plain(cell) {
  return cell
    .replace(/\[\[File:[^\]]*\]\]/gi, "")
    .replace(/\{\{\s*SkyBlock XP[^}]*\}\}/gi, " ")
    .replace(/\{\{\s*(?:Gold|Aqua|DG|Green|Red|Blue|Yellow|Gray|White|Dark[a-z]*)\s*\|([^}|]*)\}\}/gi, "$1")
    .replace(/\{\{\s*(?:Skl|SBL|G|Stat)\s*\|([^}|]*)\}\}/gi, "$1")
    .replace(/\{\{[^}]*\}\}/g, " ")
    .replace(/\[\[([^\]|]*)\|([^\]]*)\]\]/g, "$2")
    .replace(/\[\[([^\]]*)\]\]/g, "$1")
    .replace(/<br\s*\/?>/gi, " · ")
    .replace(/<[^>]+>/g, "")
    .replace(/'''?/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/* ---------------------------------------------------------- table parsing */

/**
 * Wikitext tables here lean on rowspan to express hierarchy: an essence shop name spans 44
 * rows, a perk name spans its 5 tiers, and each row carries only the cells that change. To read
 * a row as a whole task we have to carry spanned cells downward, exactly as a browser would.
 */
function parseTable(table) {
  const lines = table.split("\n");
  const rawRows = [];
  let current = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("|-")) {
      if (current) rawRows.push(current);
      current = [];
      continue;
    }
    if (!current) continue; // header block before the first |-
    if (!trimmed.startsWith("|") || trimmed.startsWith("|}")) continue;

    // A row can be "| a || b || c" on one line, or one cell per line.
    for (const cell of trimmed.slice(1).split("||")) {
      const attrMatch = /^\s*([^|]*?)\s*\|(?!\|)([\s\S]*)$/.exec(cell);
      const attrs = attrMatch && /span=/i.test(attrMatch[1]) ? attrMatch[1] : "";
      const content = attrMatch && attrs ? attrMatch[2] : cell;
      current.push({
        content: content ?? "",
        rowspan: Number(/rowspan="?(\d+)/i.exec(attrs)?.[1] ?? 1),
        colspan: Number(/colspan="?(\d+)/i.exec(attrs)?.[1] ?? 1),
      });
    }
  }
  if (current) rawRows.push(current);

  // Expand rowspans into a dense grid.
  const grid = [];
  const carry = []; // column -> { cell, remaining }
  for (const row of rawRows) {
    const line = [];
    let column = 0;
    let queue = [...row];

    while (queue.length || carry.some((c, i) => c && c.remaining > 0 && i >= column)) {
      if (carry[column] && carry[column].remaining > 0) {
        line[column] = carry[column].cell;
        carry[column].remaining--;
        column++;
        continue;
      }
      if (!queue.length) break;
      const cell = queue.shift();
      const width = Math.max(cell.colspan, 1);
      for (let w = 0; w < width; w++) {
        line[column + w] = cell.content;
        if (cell.rowspan > 1) carry[column + w] = { cell: cell.content, remaining: cell.rowspan - 1 };
      }
      column += width;
    }
    if (line.length) grid.push(line);
  }
  return grid;
}

/* --------------------------------------------------------------------- run */

const text = await wikitext(PAGE);

// The page is a <tabber>; each tab is one category of task.
const tabNames = [...text.matchAll(/\|-\|\s*([^=\n]+?)\s*=/g)].map((m) => m[1].trim());
const chunks = text.split(/\|-\|\s*[^=\n]+?\s*=/).slice(1);

const rows = [];
tabNames.forEach((tab, index) => {
  const chunk = chunks[index] ?? "";
  for (const table of chunk.split(/\{\|/).slice(1)) {
    for (const line of parseTable(table)) {
      const cells = line.map((c) => c ?? "");
      const texts = cells.map(plain).filter((t) => t && !/^\d+px$/.test(t));
      const xp = cells.flatMap(xpValues);
      if (!texts.length || !xp.length) continue;
      rows.push({ tab, cells: texts, xp });
    }
  }
});

await mkdir(dirname(OUT), { recursive: true });
await writeFile(
  OUT,
  JSON.stringify({ generatedAt: new Date().toISOString(), source: `${WIKI} — ${PAGE}`, rows }, null, 1) + "\n",
);

const byTab = {};
for (const row of rows) byTab[row.tab] = (byTab[row.tab] ?? 0) + 1;
console.log(`${rows.length} rows parsed`);
for (const [tab, n] of Object.entries(byTab)) console.log(`  ${String(n).padStart(4)}  ${tab}`);
console.log(`-> ${OUT}`);
