/**
 * Which accessories are upgrades of which.
 *
 * Only the best member of an accessory family grants magical power, so the planner has to know
 * that owning a Fermento Artifact makes the Cropie Talisman worthless. The items resource does
 * not say: a sweep of all 423 accessories in `resources/skyblock/items` finds no `recipe`, no
 * `upgrade_costs` and no `upgrades_from` on any of them, so the link is genuinely unpublished.
 *
 * `familyOf` therefore infers families from names, which works whenever a line keeps its stem
 * (Bat Talisman -> Bat Ring -> Bat Artifact) and cannot possibly work when it doesn't. Fourteen
 * lines rename as they climb — Shady Ring becomes a Crooked Artifact, a Lynx Talisman is a
 * grown-up Cat Talisman — and for those the bag kept offering a tier the player had already
 * upgraded past.
 *
 * The wiki does state it, as `upgrades_from` in the accessory infobox, so that is what this
 * reads. Titles are batched fifty at a time, which is the API's limit for a multi-page fetch.
 *
 * Edges are written rather than finished families: the union that turns them into families
 * belongs next to the name rules in `familyOf`, so both sources merge in one place and either
 * one alone still produces a usable answer.
 */
import { writeFile, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WIKI = "https://hypixel-skyblock.fandom.com/api.php";
/** The community wiki, which carries pages Fandom never got. */
const COMMUNITY = "https://hypixelskyblock.minecraft.wiki/api.php";
const UA = { "User-Agent": "skyblock-xp-planner/0.1 (data build script)" };

const accessories = JSON.parse(await readFile(join(ROOT, "data/generated/accessories.json"), "utf8")).accessories;
const byName = new Map(accessories.map((a) => [a.name.toLowerCase(), a.id]));
const byId = new Map(accessories.map((a) => [a.id, a]));

/** One "| name = value" out of the infobox. Split on the template's own separator. */
function fieldOf(wikitext, field) {
  for (const part of (wikitext ?? "").split("|")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim().toLowerCase() !== field) continue;
    return part.slice(eq + 1).split("\n")[0].trim();
  }
  return null;
}

/**
 * An infobox value down to a bare item name. `upgrades_from` is written by hand across a decade
 * of edits, so it arrives as a plain name, a `[[link]]`, a `[[link|label]]` or a `{{ID|name}}`.
 */
function plainName(value) {
  if (!value) return null;
  const bare = value
    .replace(/\{\{\s*(?:ID|RD|R|IL)\s*\|\s*([^}|]+)[^}]*\}\}/gi, "$1")
    .replace(/\[\[([^\]|]+)\|[^\]]*\]\]/g, "$1")
    .replace(/\[\[|\]\]/g, "")
    .replace(/'''/g, "")
    .replace(/<[^>]+>/g, "")
    .trim();
  return bare || null;
}

/** Every accessory page one wiki has, with the three fields that matter. */
async function readPages(api, label) {
  const pages = [];
  const titles = accessories.map((a) => a.name);
  for (let i = 0; i < titles.length; i += 50) {
    const batch = titles.slice(i, i + 50);
    // redirects=1 because a line often shares one page: "Accretion Talisman" and "Accretion Ring"
    // both land on it, and without following the redirect they read as pages that don't exist.
    const url = `${api}?action=query&prop=revisions&rvprop=content&rvslots=main&redirects=1&format=json&titles=${batch
      .map(encodeURIComponent)
      .join("|")}`;
    const body = await fetch(url, { headers: UA })
      .then((r) => r.json())
      .catch(() => null);
    for (const page of Object.values(body?.query?.pages ?? {})) {
      const text = page.revisions?.[0]?.slots?.main?.["*"];
      if (!text) continue;
      pages.push({
        title: page.title,
        id: fieldOf(text, "id"),
        upgradesFrom: fieldOf(text, "upgrades_from"),
        // Editors record the link from whichever end they happened to be editing, so a line can
        // be stated only as an upgrades_to. The Applicant's Statement is the case that matters:
        // the only page saying it becomes a Student's Studies is on the community wiki.
        upgradesTo: fieldOf(text, "upgrades_to"),
      });
    }
    process.stdout.write(`\r  ${label} ${Math.min(i + 50, titles.length)}/${titles.length}`);
  }
  process.stdout.write("\n");
  return pages;
}

// Both wikis, because neither has every page. Fandom is the fuller one; the community wiki is
// the only one carrying the pages Fandom never got.
const pages = [...(await readPages(WIKI, "fandom   ")), ...(await readPages(COMMUNITY, "community"))];

const edges = [];
const unresolved = [];
const seen = new Set();
for (const page of pages) {
  if (!page.upgradesFrom && !page.upgradesTo) continue;
  // The infobox states the item id outright, which beats matching the page title: a redirect
  // means the title we asked for and the title we got need not be the same accessory. Upper-cased
  // first because fifteen pages don't — `Agarimoo_RING`, `lucky_hoof` — and item ids never vary.
  const stated = page.id ? page.id.toUpperCase() : null;
  const self = stated && byId.has(stated) ? stated : byName.get(page.title.toLowerCase());

  // upgrades_from names what this page is made of; upgrades_to names what it becomes. Both state
  // one edge, only from opposite ends, so they are read into the same shape.
  for (const [field, raw] of [
    ["upgrades_from", page.upgradesFrom],
    ["upgrades_to", page.upgradesTo],
  ]) {
    if (!raw) continue;
    const otherName = plainName(raw);
    const other = otherName ? byName.get(otherName.toLowerCase()) : undefined;
    const child = field === "upgrades_from" ? self : other;
    const parent = field === "upgrades_from" ? other : self;
    if (!child || !parent || child === parent) {
      unresolved.push({ page: page.title, field, states: raw });
      continue;
    }
    const key = `${child}<-${parent}`;
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push({ child, parent, childName: byId.get(child).name, parentName: byId.get(parent).name });
  }
}
edges.sort((a, b) => a.child.localeCompare(b.child));

await writeFile(
  join(ROOT, "data/generated/accessory_upgrades.json"),
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      source: "Hypixel SkyBlock Fandom wiki infobox: upgrades_from",
      note: "child upgrades from parent, so the two never count at once. Both ids are accessories we model; an upgrades_from naming something outside that set is left in `unresolved` rather than guessed at.",
      consequence:
        "A missing edge lets the bag offer a tier the player has already upgraded past, and inflates the category ceiling. A wrong edge hides real XP. Names that don't resolve are dropped, never approximated.",
      pagesRead: pages.length,
      edges,
      unresolved,
    },
    null,
    1,
  ) + "\n",
);
console.log(`  read ${pages.length} pages, ${edges.length} upgrade edges, ${unresolved.length} unresolved`);
