#!/usr/bin/env node
/**
 * Scrapes the bestiary's kill brackets and family list.
 *
 * The API reports raw kills per mob id and nothing else — no tiers, no thresholds, no family
 * list. Turning those kills into "you are tier 7, and tier 8 wants 42 more" needs two tables
 * Hypixel doesn't publish: the seven cumulative kill brackets, and which bracket and tier cap
 * each family carries. Both are on the wiki's Bestiary page.
 *
 * The two halves check each other. A family lists its bracket, its tier cap *and* its max
 * kills, and max kills is by definition the bracket's value at the tier cap — so every family
 * is an independent assertion about the bracket table, and the bracket column is derived from
 * the other two rather than trusted. Four rows on the page disagree with themselves; in each
 * the two numbers outvote the label, and the correction is printed rather than swallowed.
 *
 *   node scripts/fetch-bestiary.mjs
 */
import { writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "data", "generated", "bestiary.json");
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
    .replace(/<[^>]+>/g, " ")
    .replace(/&#160;|&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/\s+/g, " ")
    .trim();

const num = (s) => Number(String(s).replace(/,/g, "").replace(/[^0-9].*$/, ""));

const rows = (table) =>
  [...table.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map((r) =>
    [...r[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map((c) => text(c[1])),
  );

/** `Arachne's Brood` -> `arachne_brood`. Possessives drop rather than leaving a bare `s`. */
const familyId = (name) =>
  name
    .toLowerCase()
    .replace(/'s\b/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");

const html = await renderedHtml("Bestiary");

/* ------------------------------------------------------------------ brackets */

// "Cumulative Kill Brackets" runs one row per tier and one column per bracket, so it is
// transposed on the way in — a bracket is the useful unit to look a tier up in, a tier is not.
const bracketTable = [...html.matchAll(/<table[\s\S]*?<\/table>/g)]
  .map((t) => t[0])
  .find((t) => /Cumulative Kill Brackets/i.test(t));
if (!bracketTable) throw new Error("No 'Cumulative Kill Brackets' table on the page");

const brackets = {};
for (const row of rows(bracketTable)) {
  const tier = num(row[0]);
  if (!Number.isFinite(tier) || tier < 1) continue;
  const values = row.slice(1).map(num);
  if (values.length !== 7 || values.some((v) => !Number.isFinite(v))) continue;
  values.forEach((v, i) => ((brackets[i + 1] ??= [])[tier - 1] = v));
}

const bracketIds = Object.keys(brackets).map(Number);
if (bracketIds.length !== 7) throw new Error(`Expected 7 brackets, parsed ${bracketIds.length}`);
for (const b of bracketIds) {
  const ladder = brackets[b];
  if (ladder.length !== 25) throw new Error(`Bracket ${b} has ${ladder.length} tiers, expected 25`);
  for (let i = 1; i < ladder.length; i++)
    if (!(ladder[i] > ladder[i - 1])) throw new Error(`Bracket ${b} is not increasing at tier ${i + 1}`);
}

/* ------------------------------------------------------------------ families */

// Families sit one table per island inside a Fandom tabber, except Fishing, which runs six
// tables in one tab. So the island is the tab whose content pane is open when a table is
// reached, taken in document order — a zip of labels to tables would slip by five from there on.
const segment = html.slice(html.lastIndexOf('id="Families"'));
const islands = [...segment.matchAll(/<li class="wds-tabs__tab[^"]*" data-hash="([^"]+)"/g)].map((m) =>
  text(m[1]).replace(/_/g, " "),
);

const families = [];
const undocumented = [];
const corrected = [];
const unresolved = [];
let island = "Unknown";
let pane = 0;

for (const match of segment.matchAll(/<div class="wds-tab__content[^"]*"[^>]*>|<table[\s\S]*?<\/table>/g)) {
  if (match[0].startsWith("<div")) {
    island = islands[pane++] ?? "Unknown";
    continue;
  }
  const table = rows(match[0]);
  if (!table.length || !/Max Tier/.test(table[0].join("|"))) continue;

  for (const row of table.slice(1)) {
    const name = row.at(-5) ?? row[0];
    if (!name) continue;

    // A few families are on the page as placeholders nobody has filled in yet.
    if (row.slice(-3).some((c) => /More Info Needed/i.test(c))) {
      undocumented.push({ island, name, id: familyId(name) });
      continue;
    }

    const stated = num(row.at(-1));
    const maxKills = num(row.at(-2));
    const maxTier = num(row.at(-3));
    if (!Number.isFinite(maxTier) || !Number.isFinite(maxKills)) continue;

    const candidates = bracketIds.filter((b) => brackets[b][maxTier - 1] === maxKills);
    const bracket = candidates.includes(stated) ? stated : candidates.length === 1 ? candidates[0] : null;
    if (bracket === null) {
      unresolved.push({ island, name, maxTier, maxKills, stated, candidates });
      continue;
    }
    if (bracket !== stated) corrected.push({ island, name, maxTier, maxKills, stated, bracket });
    families.push({ island, name, id: familyId(name), maxTier, maxKills, bracket });
  }
}

if (unresolved.length) {
  for (const f of unresolved)
    console.error(`  ${f.island} / ${f.name}: ${f.maxKills} kills at tier ${f.maxTier} matches no bracket`);
  throw new Error(`${unresolved.length} families match no bracket at their tier cap`);
}

for (const f of corrected)
  console.log(
    `corrected: ${f.island} / ${f.name} is labelled bracket ${f.stated}, ` +
      `but ${f.maxKills} kills at tier ${f.maxTier} is bracket ${f.bracket}`,
  );
for (const f of undocumented) console.log(`undocumented: ${f.island} / ${f.name} — the wiki gives it no tier cap`);

const tiers = families.reduce((sum, f) => sum + f.maxTier, 0);
// Each tier pays 1 SkyBlock XP, and every tenth tier is a milestone paying another 10.
const xp = tiers + Math.floor(tiers / 10) * 10;

await mkdir(dirname(OUT), { recursive: true });
await writeFile(
  OUT,
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      source: "https://hypixel-skyblock.fandom.com/wiki/Bestiary",
      note:
        "brackets[bracket][maxTier-1] === maxKills for every family — the bracket is derived from " +
        "that identity, and the build fails on any family the identity can't place.",
      brackets,
      families,
      undocumented,
      corrected,
      totals: { families: families.length, islands: new Set(families.map((f) => f.island)).size, tiers, xp },
    },
    null,
    1,
  ) + "\n",
);

console.log(`${families.length} families across ${new Set(families.map((f) => f.island)).size} islands`);
console.log(`every one agrees with the 7x25 bracket table`);
console.log(`${tiers} tiers -> ${xp} SkyBlock XP available`);
console.log(`wrote ${OUT}`);
