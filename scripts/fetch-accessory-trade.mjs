/**
 * Which accessories can actually be bought.
 *
 * The items resource is unreliable here: it leaves can_trade, can_auction and soulbound unset on
 * plenty of things that cannot be traded at all, so everything defaults to buyable and the cost
 * to finish the bag absorbs items nobody can sell you. Rift accessories are the worst of it —
 * Crux Chronomicon and Celestial Starstone were being priced at two billion each.
 *
 * The wiki infobox states it outright as `auctionable`/`tradeable`, so that is what this reads.
 * Titles are batched fifty at a time, which is the API's limit for a multi-page fetch.
 */
import { writeFile, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WIKI = "https://hypixel-skyblock.fandom.com/api.php";
const NEWER_WIKI = "https://hypixelskyblock.minecraft.wiki/api.php";
const UA = { "User-Agent": "skyblock-xp-planner/0.1 (data build script)" };

// Every accessory the game has, not just the ones already in our table. The eighteen the items
// resource ships without a tier are dropped from that table for want of a rarity — and four of
// them sit in a top player's bag — so the list has to come from upstream or the scrape can never
// supply what the API omits.
const accessories = JSON.parse(await readFile(join(ROOT, "data/generated/accessories.json"), "utf8")).accessories;
const { items } = await fetch("https://api.hypixel.net/v2/resources/skyblock/items").then((r) => r.json());
const everyAccessory = items.filter((i) => i.category === "ACCESSORY" && i.name);
const titles = [...new Set(everyAccessory.map((i) => i.name))];

/** Infobox flags are y/n/yes/no; anything else is left undecided rather than guessed. */
function flagOf(wikitext, field) {
  // Split on the infobox's own separator rather than pattern-matching: the fields are one per
  // "| name = value" and a plain scan is easier to trust than an escaped regex.
  for (const part of (wikitext ?? "").split("|")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim().toLowerCase() !== field) continue;
    const value = part.slice(eq + 1).split("\n")[0].trim().toLowerCase();
    if (value === "y" || value === "yes" || value === "true") return true;
    if (value === "n" || value === "no" || value === "false") return false;
    return null;
  }
  return null;
}

/** Rarity codes the infobox uses, lowest first. */
const RARITY_ORDER = ["COMMON", "UNCOMMON", "RARE", "EPIC", "LEGENDARY", "MYTHIC", "SPECIAL", "VERY SPECIAL"];
const RARITY_LETTER = { c: "COMMON", u: "UNCOMMON", r: "RARE", e: "EPIC", l: "LEGENDARY", m: "MYTHIC" };

/**
 * The lowest rarity the infobox names. "{{R|c}}-{{R|l}}" is a range and the low end is the safe
 * read: an accessory quoted above its base invents magical power, and under-promising is the
 * rule everywhere else here.
 */
function rarityOf(text) {
  const raw = fieldOf(text, "rarity") ?? fieldOf(text, "rarities");
  if (!raw) return null;
  const value = raw.toUpperCase();
  for (const name of RARITY_ORDER) if (value.includes(name)) return name;
  const letters = [...raw.toLowerCase().matchAll(/\{\{r\|([curelm])\}\}/g)].map((m) => RARITY_LETTER[m[1]]);
  return letters.length ? letters[0] : null;
}

/** One infobox field's raw value. */
function fieldOf(text, name) {
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("|")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    if (trimmed.slice(1, eq).trim().toLowerCase() !== name) continue;
    return trimmed.slice(eq + 1).replace(/[\[\]]/g, "").trim() || null;
  }
  return null;
}

/** The raw_materials list, as plain lines — "*8 Soul Fragment", "*1 Lucky Hoof". */
function materialsOf(text) {
  const lines = text.split("\n");
  const at = lines.findIndex((l) => l.trim().toLowerCase().startsWith("|raw_materials"));
  if (at < 0) return [];
  const out = [];
  const first = lines[at].split("=").slice(1).join("=").trim();
  if (first) out.push(first);
  for (let i = at + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line.startsWith("*")) break;
    out.push(line.replace(/^\*+/, "").trim());
  }
  return out;
}

/**
 * Why no player can hold this, in the wiki's own words. Several of these read as ordinary
 * accessories in the items resource — Grizzly Paw and the Talisman and Artifact of Space sit in
 * a former admin's inventory and nowhere else — so nothing but the page says they are off limits.
 */
function unobtainableReason(text) {
  const head = text.slice(0, 400);
  if (/\{\{\s*Admin only/i.test(head)) return "admin only";
  if (/\{\{\s*Historical article/i.test(head)) return "removed from the game";
  if (/\{\{\s*Unobtainable/i.test(head)) return "unobtainable";
  return null;
}

/** Everything one page has to say, in the fields both wikis happen to share. */
function readPage(text) {
  return {
    auctionable: flagOf(text, "auctionable"),
    tradeable: flagOf(text, "tradeable"),
    sellable: flagOf(text, "sellable"),
    // The accessory this one is upgraded from. raw_materials is the wrong field for this: it
    // lists the recipe broken all the way down to bazaar goods, so Sunshine Crystal reads as
    // nether quartz and sunflowers rather than as a Day Crystal.
    upgradesFrom: fieldOf(text, "upgrades_from"),
    // Recorded on either end depending on which page an editor reached for.
    upgradesTo: fieldOf(text, "upgrades_to"),
    // The items resource leaves 18 accessories with no tier, and four of them sit in a top
    // player's bag. The wiki states the rarity, so it can supply what the API omits.
    rarity: rarityOf(text),
    materials: materialsOf(text),
    unobtainable: unobtainableReason(text),
  };
}

/** Every title read from one wiki, fifty at a time, which is the API's limit for a batch. */
async function readWiki(api, label) {
  const pages = new Map();
  const redirects = new Map();
  for (let i = 0; i < titles.length; i += 50) {
    const batch = titles.slice(i, i + 50);
    const url = `${api}?action=query&prop=revisions&rvprop=content&rvslots=main&format=json&redirects=1&titles=${batch
      .map(encodeURIComponent)
      .join("|")}`;
    const body = await fetch(url, { headers: UA }).then((r) => r.json());
    // A redirect answers under the target's title, so remember which titles asked for it. One of
    // our accessories redirects to the register of removed features, which is the whole answer
    // about that item, and another redirects to the page its own edition is a tab of.
    const aliases = new Map();
    for (const hop of body.query?.redirects ?? []) {
      redirects.set(hop.from, hop.to);
      if (!aliases.has(hop.to)) aliases.set(hop.to, []);
      aliases.get(hop.to).push(hop.from);
    }
    for (const page of Object.values(body.query?.pages ?? {})) {
      const text = page.revisions?.[0]?.slots?.main?.["*"];
      if (!text) continue;
      const flags = readPage(text);
      pages.set(page.title, flags);
      for (const alias of aliases.get(page.title) ?? []) pages.set(alias, flags);
    }
    process.stdout.write(`\r  ${label} ${Math.min(i + 50, titles.length)}/${titles.length}`);
  }
  process.stdout.write("\n");
  return { pages, redirects };
}

/**
 * Two wikis, because neither is complete. The Fandom wiki records the upgrade lines most fully,
 * while the newer community wiki is the only one carrying the pages Fandom never got — the
 * Applicant's Statement, whose page is the only place stating that it upgrades into Student's
 * Studies, and the Admin-only register, which is the only place naming the two accessories
 * that have no page of their own on either wiki.
 */
/**
 * Every item id the newer wiki lists on its Admin-only page, which is a plain table of the
 * things only staff have ever held. Two of them — the Old Boot and the Ring of Space — have no
 * page of their own on either wiki, so this table is the only place that says so, and without
 * it a maxed player is told to go and buy a former admin's curio.
 */
async function readAdminOnly() {
  const url = `${NEWER_WIKI}?action=query&prop=revisions&rvprop=content&rvslots=main&format=json&redirects=1&titles=Admin-only`;
  const body = await fetch(url, { headers: UA }).then((r) => r.json());
  const text = Object.values(body.query?.pages ?? {})[0]?.revisions?.[0]?.slots?.main?.["*"] ?? "";
  return new Set([...text.matchAll(/\{\{\s*Code\s*\|\s*([A-Z0-9_]+)\s*\}\}/g)].map((m) => m[1]));
}

const adminOnly = await readAdminOnly();
console.log(`  ${adminOnly.size} admin-only item ids listed by the community wiki`);

const fandom = await readWiki(WIKI, "fandom   ");
const community = await readWiki(NEWER_WIKI, "community");

const byName = new Map();
const redirectedTo = new Map([...community.redirects, ...fandom.redirects]);
for (const name of new Set([...fandom.pages.keys(), ...community.pages.keys()])) {
  const a = fandom.pages.get(name) ?? {};
  const b = community.pages.get(name) ?? {};
  // Field by field rather than page by page: a wiki silent on one field should not suppress the
  // other wiki's answer to it.
  const merged = {};
  for (const field of new Set([...Object.keys(a), ...Object.keys(b)])) merged[field] = a[field] ?? b[field];
  byName.set(name, merged);
}


// An accessory crafted from another accessory is the same progression: the ingredient is
// consumed, so it leaves the bag and reads as unowned for ever after. Matching materials
// against the accessory list finds those pairs without anyone naming them.
const accessoryNames = new Map(accessories.map((a) => [a.name.toLowerCase(), a]));
const craftedFrom = [];
for (const acc of accessories) {
  // Stated outright by the infobox, and the only reliable half: Day Crystal into Sunshine
  // Crystal, Bait Ring into Spiked Atrocity, Fermento Artifact into Helianthus Relic.
  const stated = byName.get(acc.name)?.upgradesFrom;
  const statedFrom = stated ? accessoryNames.get(stated.toLowerCase()) : undefined;
  if (statedFrom && statedFrom.id !== acc.id) {
    craftedFrom.push({ id: acc.id, name: acc.name, from: statedFrom.id, fromName: statedFrom.name });
  }

  // The same link seen from the other side. Pages disagree on which end records it, and reading
  // only one direction loses whole lines where the upper page does not exist at all.
  const onward = byName.get(acc.name)?.upgradesTo;
  const statedTo = onward ? accessoryNames.get(onward.toLowerCase()) : undefined;
  if (statedTo && statedTo.id !== acc.id) {
    craftedFrom.push({ id: statedTo.id, name: statedTo.name, from: acc.id, fromName: acc.name });
  }

  for (const material of byName.get(acc.name)?.materials ?? []) {
    // "1 Lucky Hoof" or "8 Soul Fragment" — drop the count and look the rest up.
    const named = material.replace(/^[0-9,]+ */, "").replace(/[\[\]]/g, "").trim().toLowerCase();
    const ingredient = accessoryNames.get(named);
    if (ingredient && ingredient.id !== acc.id) craftedFrom.push({ id: acc.id, name: acc.name, from: ingredient.id, fromName: ingredient.name });
  }
}

// An upgrade line is one family however long it runs: Cropie Talisman becomes a Squash Ring,
// which becomes a Fermento Artifact, which becomes a Helianthus Relic, and only the last one is
// in your bag. Union the links so a chain of four is a chain of four, not four separate rows.
const parent = new Map();
const find = (id) => {
  let root = id;
  while (parent.get(root) !== undefined && parent.get(root) !== root) root = parent.get(root);
  return root;
};
const union = (a, b) => {
  const [ra, rb] = [find(a), find(b)];
  if (ra !== rb) parent.set(rb, ra);
};
for (const link of craftedFrom) {
  if (!parent.has(link.id)) parent.set(link.id, link.id);
  if (!parent.has(link.from)) parent.set(link.from, link.from);
  union(link.from, link.id);
}
const grouped = new Map();
for (const id of parent.keys()) {
  const root = find(id);
  if (!grouped.has(root)) grouped.set(root, []);
  grouped.get(root).push(id);
}
const chains = [...grouped.entries()]
  .filter(([, members]) => members.length > 1)
  .map(([root, members]) => ({ family: root, members: members.sort() }));
console.log(`  ${chains.length} upgrade chains, longest ${Math.max(0, ...chains.map((c) => c.members.length))} deep`);

const out = [];
const unobtainable = [];
let untradeable = 0;
for (const acc of accessories) {
  const flags = byName.get(acc.name);
  // A page that only redirects to the register of removed features is that register's entry.
  const target = redirectedTo.get(acc.name) ?? "";
  // An items own page beats the register: the Compass Talisman appears on both, and the page
  // is the one that knows it was a Redstone collection reward before it was taken out.
  const reason =
    flags?.unobtainable ??
    (/Removed|Coming Soon/i.test(target) ? "removed from the game" : null) ??
    (adminOnly.has(acc.id) ? "admin only" : null);
  if (reason) unobtainable.push({ id: acc.id, name: acc.name, reason });
  if (!flags) continue;
  // Only a stated "no" overrides. A page that doesn't say is left to the items resource.
  const buyable = flags.auctionable ?? flags.tradeable;
  if (buyable === false) {
    untradeable++;
    out.push({ id: acc.id, name: acc.name, buyable: false });
  }
}

await writeFile(
  join(ROOT, "data/generated/accessory_trade.json"),
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      source: "Hypixel SkyBlock Fandom wiki infobox: auctionable / tradeable",
      note: "Accessories the wiki states cannot be bought. Only an explicit no is recorded; silence defers to the items resource.",
      pagesRead: byName.size,
      untradeable: out,
      unobtainable,
      craftedFrom,
      chains,
      rarities: everyAccessory
        .map((item) => ({ id: item.id, rarity: byName.get(item.name)?.rarity ?? null }))
        .filter((entry) => entry.rarity),
    },
    null,
    1,
  ) + "\n",
);
console.log(`  read ${byName.size} pages, ${untradeable} accessories the wiki says cannot be bought`);
console.log(`  ${unobtainable.length} accessories no player can obtain: ${unobtainable.map((u) => u.name).join(", ")}`);
console.log(`  ${craftedFrom.length} accessories crafted from another accessory`);
for (const link of craftedFrom.slice(0, 12)) console.log(`     ${link.name} <- ${link.fromName}`);
