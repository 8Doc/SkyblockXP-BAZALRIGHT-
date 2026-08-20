#!/usr/bin/env node
/**
 * Scrapes what each Abiphone contact costs to add.
 *
 * 84 contacts at 10 XP each is 840 XP, and every one of them was priced at nothing — they fell
 * through `discreteCost` to `{ kind: "none" }` and were filed as grind, so the single cheapest
 * purchases in the game never appeared in any ranking. They are not grind: most contacts are
 * added by handing the NPC one item, and the wiki's contacts table states which.
 *
 * The requirement column is written to a pattern rather than freely, which is what makes it
 * parseable: "No requirement.", "Paying 32,000,000 coins.", "Giving 64x Silent Pearl.". What
 * doesn't fit that pattern is a quest or a grind — slaying a runic Enderman, reaching 12,000
 * Mage Reputation — and stays unpriced rather than being guessed at.
 *
 * Item names are joined to item ids through the items resource. A name that doesn't resolve
 * becomes `unknown` carrying the name it couldn't find, so the contact stays visible in the
 * browser and out of the solver.
 *
 *   node scripts/fetch-abiphone.mjs
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "data", "generated", "abiphone.json");
const WIKI = "https://hypixel-skyblock.fandom.com/api.php";
const AGENT = { "User-Agent": "skyblock-xp-planner/0.1 (data build script)" };

const text = (html) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#160;|&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/\s+/g, " ")
    .trim();

/** "Clerk Seraphine" -> `clerk_seraphine`, matching the ids harvested from live profiles. */
const slug = (name) =>
  name
    // Some rows carry a "File:Bulvar Head.png" image caption ahead of the name.
    .replace(/^File:.*?\.png\s*/i, "")
    .toLowerCase()
    .replace(/'/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");

/* ------------------------------------------------------------- the two feeds */

const parsed = await (
  await fetch(`${WIKI}?action=parse&page=Abiphones/ContactsTable&format=json&prop=text`, { headers: AGENT })
).json();
if (parsed.error) throw new Error(`contacts table -> ${parsed.error.info}`);
const table = /<table[\s\S]*?<\/table>/.exec(parsed.parse.text["*"]);
if (!table) throw new Error("no contacts table on Abiphones/ContactsTable");

const rows = [...table[0].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)]
  .map((r) => [...r[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map((c) => text(c[1])))
  .filter((cells) => cells.length >= 3);
const header = rows.shift();
if (!/NPC/i.test(header[0]) || !/Requirement/i.test(header[2]))
  throw new Error(`unexpected columns: ${header.join(" | ")}`);

const items = (await (await fetch("https://api.hypixel.net/v2/resources/skyblock/items")).json()).items;
const byName = new Map();
for (const item of items) {
  if (!item.name || !item.id) continue;
  // First id wins: the resource lists a few display names twice, and the earlier entry is the
  // plain item rather than a dungeon or reforged variant.
  const key = item.name.toLowerCase();
  if (!byName.has(key)) byName.set(key, item.id);
}

const bazaar = (await (await fetch("https://api.hypixel.net/v2/skyblock/bazaar")).json()).products ?? {};

/**
 * An item id for a wiki display name.
 *
 * Three transformations, all mechanical: the wiki pluralises a quantity ("2x Ultimate Carrot
 * Candies") where the item is singular; attribute shards are absent from the items resource
 * altogether but trade on the bazaar under `SHARD_<MOB>`, so that id is checked against live
 * products rather than assumed; anything else is left unresolved rather than fuzzily matched,
 * because a wrong id prices the wrong item and nothing downstream would notice.
 */
function itemId(name) {
  const clean = name.trim().replace(/\s*\.$/, "");
  const tries = [clean, clean.replace(/ies$/, "y"), clean.replace(/s$/, "")];
  for (const candidate of tries) {
    const hit = byName.get(candidate.toLowerCase());
    if (hit) return hit;
  }
  const shard = /^(.+) Shard$/i.exec(clean);
  if (shard) {
    const id = `SHARD_${shard[1].toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`;
    if (bazaar[id]) return id;
  }
  return null;
}

/* -------------------------------------------------------------- the parsing */

const number = (s) => Number(String(s).replace(/,/g, ""));

/**
 * One requirement string to a cost.
 *
 * Returns the cost plus a caveat for the part of the requirement that isn't a purchase —
 * Walter wants a Sulphur collection alongside the item, and quoting only the item without
 * saying so would read as though the contact were one click away.
 */
function costOf(requirement) {
  const req = requirement.replace(/\s*\.$/, "").trim();

  if (/^no requirement/i.test(req)) return { cost: { kind: "npc", coins: 0 } };

  // "Paying 10,000,000 coins or completing Target Practice IV in under 11s" — the coin half is
  // a real price, and quoting it while naming the alternative is better than pricing neither.
  const paying = /^paying ([\d,]+) coins(?:\s+or\s+(.+))?$/i.exec(req);
  if (paying)
    return { cost: { kind: "npc", coins: number(paying[1]) }, caveat: paying[2] ? `or ${paying[2]}` : null };

  if (!/^giving /i.test(req)) return { cost: { kind: "none" } };

  const body = req.replace(/^giving /i, "");

  // A list of pets, gemstones or phones to choose between is a requirement we can't reduce to
  // one purchase, and the wiki writes all three the same way — a colon and a run of names.
  if (/following/i.test(body) || /\bany\b/i.test(body))
    return { cost: { kind: "unknown", note: `Needs ${body.slice(0, 60)}` } };

  const parts = body.split(/\s+and(?:\s+subsequently)?\s+/i);
  const wanted = [];
  let caveat = null;

  for (const part of parts) {
    const match = /^([\d,]+)\s*x?\s+(.+)$/i.exec(part.trim());
    if (!match) {
      // "having Sulphur VII" — a condition, not a purchase.
      caveat = caveat ? `${caveat}; ${part.trim()}` : part.trim();
      continue;
    }
    const qty = number(match[1]);
    const name = match[2].trim();
    if (/^coins$/i.test(name)) return { cost: { kind: "unknown", note: `Needs ${body}` }, caveat };
    // Essence is bought by the unit rather than as an item, and has its own cost kind.
    const essence = parts.length === 1 && /^(\w+) Essence$/i.exec(name);
    if (essence) return { cost: { kind: "essence", type: essence[1].toUpperCase(), amount: qty }, caveat };
    const id = itemId(name);
    if (!id) return { cost: { kind: "unknown", note: `No item id for ${name}` }, caveat };
    wanted.push({ id, qty, name });
  }

  if (!wanted.length) return { cost: { kind: "none" }, caveat };
  return { cost: { kind: "bazaar", items: wanted.map(({ id, qty }) => ({ id, qty })) }, caveat, wanted };
}

/* ------------------------------------------------------------------ the join */

// The profile names a contact by the NPC's *role* where the wiki names the person: the id for
// Maddox the Slayer is `slayer`, Tia the Fairy is `fairy`, Trevor is `trevor_the_trapper`.
// Most of that is structural — one name's words are a subset of the other's — and the pairing
// is required to be unique, so an ambiguous one fails the build instead of being picked.
const harvested = new Set(
  JSON.parse(await readFile(join(ROOT, "data", "generated", "tasks.json"), "utf8")).tasks
    .filter((t) => t.category === "abiphone")
    .map((t) => t.id.replace(/^ABIPHONE_/, "")),
);

// Roles nobody could derive: the person and the job share no word at all. Each is here because
// the NPC is the only one doing that job, not because the names look alike.
const ROLES = {
  kat: "pet_sitter", // Kat is the NPC who levels pets for you
  maxwell: "thaumaturgist", // Maxwell runs Thaumaturgy, the accessory power menu
  elizabeth: "community_shop", // Elizabeth sells the community shop upgrades
  geo: "gemstone", // Geo is the gemstone trader in the Crystal Hollows
  fear_mongerer: "spooky", // the Fear Mongerer runs the Spooky Festival shop
};

function taskIdFor(npc) {
  const plain = slug(npc);
  if (harvested.has(plain)) return { id: `ABIPHONE_${plain}`, how: "name" };
  if (ROLES[plain] && harvested.has(ROLES[plain])) return { id: `ABIPHONE_${ROLES[plain]}`, how: "role" };

  const words = new Set(plain.split("_"));
  const subsets = [...harvested].filter((id) => {
    const other = new Set(id.split("_"));
    const smaller = words.size <= other.size ? words : other;
    const larger = smaller === words ? other : words;
    return [...smaller].every((w) => larger.has(w));
  });
  if (subsets.length === 1) return { id: `ABIPHONE_${subsets[0]}`, how: "subset" };
  if (subsets.length > 1) throw new Error(`${npc} matches ${subsets.length} task ids: ${subsets.join(", ")}`);
  return null;
}

const contacts = [];
const unmatched = [];
const tally = { free: 0, coins: 0, items: 0, essence: 0, unknown: 0, quest: 0 };

for (const cells of rows) {
  const npc = cells[0].replace(/^File:.*?\.png\s*/i, "").trim();
  if (!npc) continue;
  const requirement = cells[2] ?? "";
  const match = taskIdFor(npc);
  if (!match) {
    // No id means no task to attach a price to, so saying nothing is the only honest option.
    unmatched.push({ npc, requirement });
    continue;
  }
  const { cost, caveat, wanted } = costOf(requirement);

  if (cost.kind === "npc") tally[cost.coins === 0 ? "free" : "coins"]++;
  else if (cost.kind === "bazaar") tally.items++;
  else if (cost.kind === "essence") tally.essence++;
  else if (cost.kind === "unknown") tally.unknown++;
  else tally.quest++;

  contacts.push({
    taskId: match.id,
    matchedBy: match.how,
    npc,
    requirement,
    cost,
    ...(caveat ? { caveat } : {}),
    ...(wanted ? { needs: wanted.map((w) => `${w.qty}x ${w.name}`).join(" + ") } : {}),
  });
}

await mkdir(dirname(OUT), { recursive: true });
await writeFile(
  OUT,
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      source: "https://hypixel-skyblock.fandom.com/wiki/Abiphones/ContactsTable",
      note:
        "Costs are the requirement column, parsed. 'npc' with 0 coins is a contact you only have " +
        "to talk to; 'none' is a quest or a grind with no purchase in it; 'unknown' is a " +
        "requirement that is a purchase but not one we could reduce to a single item id.",
      contacts,
      unmatched,
      totals: { contacts: contacts.length, unmatched: unmatched.length, ...tally },
    },
    null,
    1,
  ) + "\n",
);

console.log(`${contacts.length} contacts joined to a task id, ${unmatched.length} wiki rows with no id`);
console.log(`  ${tally.free} free to add, ${tally.coins} paid in coins, ${tally.items + tally.essence} priced from items`);
console.log(`  ${tally.quest} are quests or grinds, ${tally.unknown} are purchases we can't reduce to one item`);
for (const c of contacts.filter((c) => c.cost.kind === "unknown")) console.log(`    unpriced: ${c.npc} — ${c.cost.note}`);
for (const u of unmatched) console.log(`    no task id: ${u.npc}`);
console.log(`wrote ${OUT}`);
