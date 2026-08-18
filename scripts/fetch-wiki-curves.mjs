#!/usr/bin/env node
/**
 * Scrapes the level curves the API doesn't publish.
 *
 * Catacombs level, class levels and slayer levels are all "you are level N because you have X
 * XP" — so modelling them needs the XP thresholds, and Hypixel exposes only the raw XP. The
 * wiki has the tables, but builds them with templates, so the wikitext is empty of numbers;
 * asking MediaWiki for rendered HTML (prop=text) expands them first.
 *
 * Typing ~50 thresholds from memory is exactly what this project refuses to do, hence scraping.
 *
 *   node scripts/fetch-wiki-curves.mjs
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "data", "generated", "curves.json");
const WIKI = "https://hypixel-skyblock.fandom.com/api.php";

async function renderedHtml(page) {
  const url = `${WIKI}?action=parse&page=${encodeURIComponent(page)}&format=json&prop=text`;
  const res = await fetch(url, { headers: { "User-Agent": "skyblock-xp-planner/0.1 (data build script)" } });
  if (!res.ok) throw new Error(`${page} -> ${res.status}`);
  const body = await res.json();
  if (body.error) throw new Error(`${page} -> ${body.error.info}`);
  return body.parse.text["*"];
}

const text = (html) =>
  html
    .replace(/<[^>]+>/g, "")
    .replace(/&#160;|&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

/** Rows with spans collapsed, so a value shared across bosses lands in every column it covers. */
function rowsWithSpans(html) {
  const out = [];
  const carry = [];
  for (const [, rowHtml] of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
    const cells = [...rowHtml.matchAll(/<t[dh]([^>]*)>([\s\S]*?)<\/t[dh]>/g)].map((m) => ({
      value: text(m[2]),
      rowspan: Number(/rowspan="?(\d+)/i.exec(m[1])?.[1] ?? 1),
      colspan: Number(/colspan="?(\d+)/i.exec(m[1])?.[1] ?? 1),
    }));

    const line = [];
    let column = 0;
    const queue = [...cells];
    while (queue.length || carry.some((c, i) => c?.remaining > 0 && i >= column)) {
      if (carry[column]?.remaining > 0) {
        line[column] = carry[column].value;
        carry[column].remaining--;
        column++;
        continue;
      }
      if (!queue.length) break;
      const cell = queue.shift();
      for (let w = 0; w < Math.max(cell.colspan, 1); w++) {
        line[column + w] = cell.value;
        if (cell.rowspan > 1) carry[column + w] = { value: cell.value, remaining: cell.rowspan - 1 };
      }
      column += Math.max(cell.colspan, 1);
    }
    out.push(line.map((c) => c ?? ""));
  }
  return out;
}

async function renderedRows(page) {
  return rowsWithSpans(await renderedHtml(page)).map((r) => r.filter((c) => c !== ""));
}

const number = (text) => {
  const clean = String(text).replace(/,/g, "").trim();
  return /^\d+$/.test(clean) ? Number(clean) : null;
};

/**
 * Pull "level | xp for this level | cumulative" rows out of a page. Level rows are recognised
 * by shape — a row whose first cell counts up from 1 and whose other cells are numbers — so a
 * layout change shows up as a short table rather than as silently wrong thresholds.
 */
function levelCurve(rows) {
  const curve = [];
  for (const row of rows) {
    const level = number(row[0]);
    if (level === null || level !== curve.length + 1) continue;
    const numbers = row.slice(1).map(number).filter((n) => n !== null);
    if (numbers.length < 2) continue;
    curve.push({ level, xpForLevel: numbers[0], totalXp: numbers[1] });
  }
  return curve;
}

const out = { generatedAt: new Date().toISOString(), source: WIKI };

/* ------------------------------------------------------------ dungeoneering */

const dungeoneering = levelCurve(await renderedRows("Dungeoneering"));
out.dungeoneering = {
  page: "Dungeoneering",
  note: "Drives both Catacombs level (+20 XP per level 1-39, +40 for 40-50) and each class level (+4 per level).",
  levels: dungeoneering,
};
console.log(`dungeoneering: ${dungeoneering.length} levels, max total ${dungeoneering.at(-1)?.totalXp?.toLocaleString()}`);

/* -------------------------------------------------------------------- slayer */

const slayerGrid = rowsWithSpans(await renderedHtml("Slayer"));
const headerIndex = slayerGrid.findIndex((row) => row[1] === "LVL 1" || row[0] === "LVL 1");
const slayerBosses = {};
if (headerIndex >= 0) {
  const header = slayerGrid[headerIndex];
  const offset = header[0] === "LVL 1" ? 0 : 1;
  for (const row of slayerGrid.slice(headerIndex + 1)) {
    const boss = row[0];
    if (!/^(Zombie|Spider|Wolf|Enderman|Blaze|Vampire)$/i.test(boss ?? "")) continue;
    const thresholds = row
      .slice(offset === 0 ? 1 : 1)
      .map((cell) => {
        // "20k XP", "1M XP", "5,000 XP"
        const m = /^([\d,.]+)\s*([km])?\s*XP$/i.exec(cell ?? "");
        if (!m) return null;
        const scale = { k: 1e3, m: 1e6 }[m[2]?.toLowerCase() ?? ""] ?? 1;
        return Math.round(Number(m[1].replace(/,/g, "")) * scale);
      })
      .filter((n) => n !== null);
    if (thresholds.length) slayerBosses[boss.toLowerCase()] = thresholds;
  }
}

/**
 * XP awarded for reaching each slayer level, read off the tasks page rather than typed in.
 * Requires fetch-wiki-tasks.mjs to have run first.
 */
const taskRows = JSON.parse(await readFile(join(ROOT, "data/generated/wiki_tasks.json"), "utf8")).rows;
const SLAYER_LEVEL_XP = taskRows
  .filter((row) => row.cells.some((cell) => /^Level \d+:$/.test(cell)) && /Slayer Level Up/.test(row.cells.join(" ")))
  .map((row) => row.xp[0]);
if (SLAYER_LEVEL_XP.length < 9) throw new Error(`only found ${SLAYER_LEVEL_XP.length} slayer level rows`);

out.slayer = {
  page: "Slayer",
  note: "Cumulative slayer XP needed per level, per boss. Reaching a level awards SLAYER_LEVEL_XP[level-1].",
  levelXp: SLAYER_LEVEL_XP,
  bosses: slayerBosses,
};
const bossCount = Object.keys(slayerBosses).length;
console.log(`slayer: ${bossCount} bosses`);
for (const [boss, thresholds] of Object.entries(slayerBosses)) {
  console.log(`  ${boss.padEnd(9)} ${thresholds.length} levels: ${thresholds.join(", ")}`);
}

await mkdir(dirname(OUT), { recursive: true });
await writeFile(OUT, JSON.stringify(out, null, 1) + "\n");
console.log(`-> ${OUT}`);
