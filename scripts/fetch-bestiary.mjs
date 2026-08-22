#!/usr/bin/env node
/**
 * Scrapes the bestiary's kill brackets and family list.
 *
 * The API reports raw kills per mob id and nothing else — no tiers, no thresholds, no family
 * list. Turning those kills into "you are tier 7, and tier 8 wants 42 more" needs tables Hypixel
 * doesn't publish: the cumulative kill brackets, and which bracket and tier cap each family
 * carries.
 *
 * Two sources, because neither is complete. The community wiki the editors moved to carries the
 * newer islands — Moonglade Marsh, Torrhus Canyon, the Lotus Atoll — and 74 families the Fandom
 * wiki never got; the Fandom wiki still carries the fishing sections the community one has no
 * page for. Between them, 323 families against the 249 this used to read.
 *
 * Two bracket tables as well. The main one runs eight brackets over 25 tiers; critters and
 * hunting mobs use their own five, keyed to shard rarity, which cap at 125 kills rather than a
 * million. Which table a family belongs to is derived, not asserted: a family states its tier
 * cap and its max kills, and max kills is by definition its ladder's value at the cap, so every
 * family is placed on whichever column of whichever table makes its own two numbers agree.
 *
 *   node scripts/fetch-bestiary.mjs
 */
import { writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "data", "generated", "bestiary.json");
const COMMUNITY = "https://hypixelskyblock.minecraft.wiki/api.php";
const FANDOM = "https://hypixel-skyblock.fandom.com/api.php";
const UA = { "User-Agent": "skyblock-xp-planner/0.1 (data build script)" };

async function wikitext(api, page) {
  const url = `${api}?action=query&prop=revisions&rvprop=content&rvslots=main&format=json&redirects=1&titles=${encodeURIComponent(page)}`;
  const body = await fetch(url, { headers: UA }).then((r) => r.json());
  const found = Object.values(body.query?.pages ?? {})[0];
  const text = found?.revisions?.[0]?.slots?.main?.["*"];
  if (!text) throw new Error(`${page} has no content`);
  return text;
}

const slug = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");

/** One "Cumulative Kill Brackets" table: a tier per row, a bracket per column. */
function bracketTable(table, columns) {
  const out = {};
  for (let c = 1; c <= columns; c++) out[c] = [];
  let tier = null;
  let column = 0;
  for (const line of table.split("\n")) {
    const heading = line.match(/^!(\d+)$/);
    if (heading) {
      tier = Number(heading[1]);
      column = 0;
      continue;
    }
    if (tier === null) continue;
    const value = line.match(/^\|([\d,]+)$/);
    if (!value) continue;
    column++;
    if (column <= columns) out[column][tier - 1] = Number(value[1].replace(/,/g, ""));
  }
  return out;
}

console.log("reading the bracket tables…");
const bestiaryPage = await wikitext(COMMUNITY, "Bestiary");
const tables = [...bestiaryPage.matchAll(/\{\|[^]*?\|\}/g)]
  .map((m) => m[0])
  .filter((t) => /Cumulative Kill Brackets/.test(t));
if (tables.length < 2) throw new Error(`expected two bracket tables, found ${tables.length}`);
const brackets = bracketTable(tables[0], 8);
const huntingBrackets = bracketTable(tables[1], 5);
console.log(`  ${Object.keys(brackets).length} main brackets, ${Object.keys(huntingBrackets).length} for critters and hunting mobs`);

/** The community wiki's per-island tables: image, name, types, lore, max tier, max kills, bracket. */
function communityFamilies(text) {
  const families = [];
  let island = "?";
  let cells = [];
  const flush = () => {
    if (cells.length >= 7) {
      const name = (cells[1].match(/\[\[([^\]|]+)/) ?? [])[1] ?? cells[1];
      const maxTier = Number(cells[4].replace(/[^0-9]/g, ""));
      const maxKills = Number(cells[5].replace(/[^0-9]/g, ""));
      if (name && maxTier && maxKills) families.push({ island, name: name.trim(), maxTier, maxKills });
    }
    cells = [];
  };
  for (const line of text.split("\n")) {
    const tab = line.match(/^\|-\|(.+)=$/);
    if (tab) {
      flush();
      island = tab[1].trim();
      continue;
    }
    if (line.startsWith("|-") || line.startsWith("|}")) {
      flush();
      continue;
    }
    if (line.startsWith("!")) {
      cells = [];
      continue;
    }
    if (line.startsWith("|+")) continue;
    if (line.startsWith("|")) cells.push(line.slice(1));
  }
  flush();
  return families;
}

console.log("reading the family lists…");
const community = communityFamilies(await wikitext(COMMUNITY, "Bestiary/List"));
console.log(`  community wiki: ${community.length} families`);

/**
 * The Fandom wiki's rendered table, for the sections the community wiki has no page for — the
 * fishing bestiary among them. Its rows carry the same facts in a different shape.
 */
const rendered = await fetch(`${FANDOM}?action=parse&page=Bestiary&format=json&prop=text`, { headers: UA })
  .then((r) => r.json())
  .then((body) => body.parse?.text?.["*"] ?? "");
const fandom = [];
{
  let island = "?";
  for (const chunk of rendered.split(/<h[23]/).slice(1)) {
    const heading = (chunk.match(/id="([^"]+)"/) ?? [])[1];
    if (heading) island = heading.replace(/_/g, " ");
    for (const row of chunk.match(/<tr>[^]*?<\/tr>/g) ?? []) {
      const cells = [...row.matchAll(/<t[dh][^>]*>([^]*?)<\/t[dh]>/g)].map((m) =>
        m[1].replace(/<[^>]+>/g, " ").replace(/&#?\w+;/g, " ").replace(/\s+/g, " ").trim(),
      );
      if (cells.length < 4) continue;
      const name = cells.find((c) => /^[A-Za-z][A-Za-z' -]{2,}$/.test(c));
      const numbers = cells.map((c) => Number(c.replace(/[^0-9]/g, ""))).filter((n) => n > 0);
      if (!name || numbers.length < 2) continue;
      const [maxTier, maxKills] = numbers;
      if (maxTier <= 25 && maxKills > 0) fandom.push({ island, name, maxTier, maxKills });
    }
  }
}
console.log(`  fandom wiki:    ${fandom.length} rows`);

/**
 * Whichever column of whichever table makes a family's own two numbers agree.
 *
 * The bracket a page states is a label; the tier cap and the max kills are the measurement, and
 * the identity between them is what places a family. Reading the label instead put fifty of them
 * on ladders a thousand times too long — a critter capping at 125 kills read against a bracket
 * that wants three thousand.
 */
function placeOnLadder(family) {
  for (const [table, columns] of [
    ["main", brackets],
    ["hunting", huntingBrackets],
  ]) {
    for (const [column, ladder] of Object.entries(columns)) {
      if (ladder[family.maxTier - 1] === family.maxKills) return { table, bracket: Number(column) };
    }
  }
  return null;
}

const merged = new Map();
for (const f of community) merged.set(slug(f.name), { ...f, id: slug(f.name) });

/**
 * The two wikis spell some families differently. Fandom writes "Endstone Protector" and "Angry
 * Archeologist" where the community wiki writes "End Stone Protector" and "Angry Archaeologist",
 * and slugging both gives four ids for two families — which then read as two families nobody has
 * ever killed, and inflate the family count and the category total with them.
 *
 * Both wikis carry a redirect from one spelling to the other, so the wikis themselves state that
 * the pages are the same thing. That is used instead of a spelling rule of our own: collapsing
 * "archeologist" onto "archaeologist" by hand would be guessing at which differences are
 * cosmetic, and the next pair would not look like this one.
 *
 * Both wikis have to agree, because a redirect is about articles rather than about families. The
 * community wiki points "Worm" at "Stoneworm" — its Stoneworm article covers the shard creature,
 * and it has no separate page for the Crystal Hollows worms — while Fandom keeps a real Worm
 * family that Scatha feeds. Folding on one wiki's say-so would have merged two different families
 * and stranded the Scatha kills. Fandom has no such redirect, and that disagreement is the signal.
 */
async function redirectsFrom(api, names) {
  const map = new Map();
  for (let i = 0; i < names.length; i += 50) {
    const batch = names.slice(i, i + 50);
    const url = `${api}?action=query&format=json&redirects=1&titles=${batch.map(encodeURIComponent).join("|")}`;
    const body = await fetch(url, { headers: UA }).then((r) => r.json());
    for (const step of [...(body.query?.normalized ?? []), ...(body.query?.redirects ?? [])])
      map.set(step.from, step.to);
  }
  return map;
}

/** A redirect can point at another redirect, and a cycle would otherwise spin here. */
function follow(map, name) {
  const seen = new Set();
  let at = name;
  while (map.has(at) && !seen.has(at)) {
    seen.add(at);
    at = map.get(at);
  }
  return at;
}

const unresolved = [...new Set(fandom.map((f) => f.name))].filter((n) => !merged.has(slug(n)));
const [onCommunity, onFandom] = await Promise.all([
  redirectsFrom(COMMUNITY, unresolved),
  redirectsFrom(FANDOM, unresolved),
]);
const canonical = new Map();
for (const name of unresolved) {
  const community = follow(onCommunity, name);
  const fandomSide = follow(onFandom, name);
  if (community === fandomSide && community !== name) canonical.set(name, community);
}

const resolveName = (name) => canonical.get(name) ?? name;

let added = 0;
const folded = [];
for (const f of fandom) {
  const name = resolveName(f.name);
  const id = slug(name);
  if (merged.has(id)) {
    if (id !== slug(f.name)) folded.push(`${f.name} -> ${name}`);
    continue;
  }
  merged.set(id, { ...f, name, id });
  added++;
}
console.log(`  ${merged.size} families after the merge, ${added} of them only on Fandom`);
for (const fold of [...new Set(folded)]) console.log(`    folded by the wikis' own redirect: ${fold}`);

const families = [];
const undocumented = [];
for (const family of merged.values()) {
  const placed = placeOnLadder(family);
  if (!placed) {
    undocumented.push({ island: family.island, name: family.name, id: family.id });
    continue;
  }
  families.push({
    island: family.island,
    name: family.name,
    id: family.id,
    maxTier: family.maxTier,
    maxKills: family.maxKills,
    bracket: placed.bracket,
    table: placed.table,
  });
}
families.sort((a, b) => a.island.localeCompare(b.island) || a.name.localeCompare(b.name));

const tiers = families.reduce((sum, f) => sum + f.maxTier, 0);
// Every tier pays 1 XP. A milestone is ten tiers, and every ten milestones pay 10 XP — so the
// milestone half is not a separate grind, it is a tenth of the tier count, awarded in lumps.
const milestoneXp = Math.floor(tiers / 100) * 10;

await mkdir(dirname(OUT), { recursive: true });
await writeFile(
  OUT,
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      source: "hypixelskyblock.minecraft.wiki Bestiary and Bestiary/List, plus the sections only hypixel-skyblock.fandom.com still carries",
      note: "A family is placed on a ladder by the identity ladder[maxTier-1] === maxKills rather than by the bracket its page states. Critters and hunting mobs have their own five brackets, keyed to shard rarity.",
      brackets,
      huntingBrackets,
      families,
      /**
       * Names that are this family under an older spelling, as both wikis' redirects agree. Kept
       * so anything joining on a family name — SkyCrypt's mob ids among them — can follow the
       * rename instead of failing to match and dropping the mobs on the floor.
       */
      renames: Object.fromEntries(
        [...canonical].map(([from, to]) => [from, slug(to)]).sort(([a], [b]) => a.localeCompare(b)),
      ),
      undocumented,
      totals: {
        families: families.length,
        islands: new Set(families.map((f) => f.island)).size,
        tiers,
        xp: tiers,
        milestoneXp,
        statedTotal: tiers + milestoneXp,
        statedTotalSource: "1 XP a tier, plus 10 XP per ten milestones where a milestone is ten tiers — wiki Bestiary, Leveling and Milestone Rewards",
      },
    },
    null,
    1,
  ) + "\n",
);
console.log(`\n-> ${families.length} families, ${tiers} tiers + ${milestoneXp} milestone XP = ${tiers + milestoneXp}`);
if (undocumented.length) console.log(`   ${undocumented.length} could not be placed on any ladder`);
