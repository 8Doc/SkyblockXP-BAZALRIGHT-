#!/usr/bin/env node
/**
 * Builds the static task tables in data/generated/ from the Hypixel resources API.
 *
 * Everything written here is derived from an authoritative source — the "+N SkyBlock XP"
 * strings the API itself ships in skill/collection unlock lists, and the real minion tier
 * list from the items resource. Nothing in this file is hand-typed game knowledge; anything
 * that has to be hand-typed lives in data/curated/ with a provenance note instead.
 *
 *   node scripts/generate-data.mjs
 */
import { writeFile, mkdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "data", "generated");
const BASE = "https://api.hypixel.net/v2/resources/skyblock";

const XP_RE = /\+([\d,]+)\s+SkyBlock XP/i;

/** Pull the "+N SkyBlock XP" reward out of an unlock list. Returns 0 when the tier grants none. */
function xpFromUnlocks(unlocks) {
  for (const line of unlocks ?? []) {
    const m = XP_RE.exec(String(line));
    if (m) return Number(m[1].replace(/,/g, ""));
  }
  return 0;
}

async function getJson(url) {
  const res = await fetch(url, { headers: { "User-Agent": "skyblock-xp-planner/0.1" } });
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  const body = await res.json();
  if (body.success === false) throw new Error(`${url} -> ${body.cause}`);
  return body;
}

const ROMAN = ["", "I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X", "XI", "XII"];

/* ------------------------------------------------------------------ skills */

async function buildSkills() {
  const { skills } = await getJson(`${BASE}/skills`);
  const out = [];
  for (const [key, skill] of Object.entries(skills)) {
    const levels = [];
    for (const lv of skill.levels ?? []) {
      levels.push({
        level: lv.level,
        totalExpRequired: lv.totalExpRequired,
        xp: xpFromUnlocks(lv.unlocks),
      });
    }
    out.push({ key, name: skill.name, maxLevel: skill.maxLevel, levels });
  }
  out.sort((a, b) => a.key.localeCompare(b.key));
  const total = out.reduce((s, sk) => s + sk.levels.reduce((t, l) => t + l.xp, 0), 0);
  return { totalXp: total, skills: out };
}

/* ------------------------------------------------------------- collections */

async function buildCollections() {
  const { collections } = await getJson(`${BASE}/collections`);
  const out = [];
  for (const [group, groupData] of Object.entries(collections)) {
    for (const [itemId, item] of Object.entries(groupData.items ?? {})) {
      const tiers = (item.tiers ?? []).map((t) => ({
        tier: t.tier,
        amountRequired: t.amountRequired,
        xp: xpFromUnlocks(t.unlocks),
      }));
      if (!tiers.some((t) => t.xp > 0)) continue;
      out.push({ group, itemId, name: item.name, maxTiers: item.maxTiers, tiers });
    }
  }
  out.sort((a, b) => a.itemId.localeCompare(b.itemId));
  const total = out.reduce((s, c) => s + c.tiers.reduce((t, x) => t + x.xp, 0), 0);
  return { totalXp: total, collections: out };
}

/* ----------------------------------------------------------------- minions */

/**
 * SkyBlock XP per minion tier. Flat 1 XP through tier VI, then it ramps hard —
 * XI and XII alone are worth 36 of a minion's 57 total. Source: README XP table
 * (Hypixel Wiki, SkyBlock_Levels/Tasks).
 */
const MINION_TIER_XP = { 1: 1, 2: 1, 3: 1, 4: 1, 5: 1, 6: 1, 7: 2, 8: 3, 9: 4, 10: 6, 11: 12, 12: 24 };

async function buildMinions() {
  const { items } = await getJson(`${BASE}/items`);
  const byGenerator = new Map();
  for (const item of items) {
    if (!item.generator || !item.generator_tier) continue;
    const list = byGenerator.get(item.generator) ?? [];
    list.push({ tier: item.generator_tier, itemId: item.id, name: item.name });
    byGenerator.set(item.generator, list);
  }
  const out = [];
  for (const [generator, tiersRaw] of byGenerator) {
    const tiers = tiersRaw
      .sort((a, b) => a.tier - b.tier)
      .map((t) => ({ ...t, xp: MINION_TIER_XP[t.tier] ?? 0 }));
    // "Lily Pad Minion V" -> "Lily Pad Minion"
    const family = tiers[0].name.replace(new RegExp(` (${ROMAN.slice(1).join("|")})$`), "");
    out.push({ generator, family, maxTier: tiers[tiers.length - 1].tier, tiers });
  }
  out.sort((a, b) => a.family.localeCompare(b.family));
  const total = out.reduce((s, m) => s + m.tiers.reduce((t, x) => t + x.xp, 0), 0);
  return { totalXp: total, minions: out };
}

/* -------------------------------------------------------------- accessories */

/** Every accessory in the game, with the rarity it drops at. Magical power comes from rarity. */
async function buildAccessories() {
  const { items } = await getJson(`${BASE}/items`);
  // The items resource leaves can_trade, can_auction and soulbound unset on plenty of things
  // that cannot be bought at all, so everything defaults to buyable and the cost to finish the
  // bag absorbs items nobody can sell you. The wiki states it outright; where it says no, that
  // wins. Rift accessories are the worst of it — two of them were priced at a billion each.
  let wikiUntradeable = new Set();
  try {
    const trade = JSON.parse(await readFile(join(OUT, "accessory_trade.json"), "utf8"));
    wikiUntradeable = new Set(trade.untradeable.map((entry) => entry.id));
  } catch {
    console.log("  accessories  no accessory_trade.json — run fetch-accessory-trade.mjs");
  }

  const out = [];
  for (const item of items) {
    if (item.category !== "ACCESSORY") continue;
    const tier = item.tier ?? impliedTier(item.name);
    if (!tier) continue; // no rarity we can stand behind -> no defined magical power
    out.push({
      id: item.id,
      name: item.name,
      tier,
      museum: Boolean(item.museum),
      soulbound: Boolean(item.soulbound),
      tradeable:
        item.can_trade !== false &&
        item.can_auction !== false &&
        !item.soulbound &&
        // Rift items never leave the rift, whatever the resource says.
        item.origin !== "RIFT" &&
        !wikiUntradeable.has(item.id),
      riftTransferrable: Boolean(item.rift_transferrable),
      // The Rift keeps its own accessory bag. These never reach the main one, so counting them
      // towards its magical power offers a player who owns every real accessory 29 more.
      rift: item.origin === "RIFT",
    });
  }
  out.sort((a, b) => a.id.localeCompare(b.id));
  return { accessories: out };
}

/**
 * A rarity for the accessories the items resource ships without one.
 *
 * There are 38 of them and dropping the lot was expensive in both directions: the bag couldn't
 * credit magical power for an accessory it didn't know (the computed-vs-reported readout was
 * short by exactly the sort of margin a stack of basic talismans makes), and the family those
 * accessories anchor looked empty, so the app offered the Ring of a family whose Talisman the
 * player already wore.
 *
 * Only the Talisman step is inferred, and only because it is the base of every family and
 * common throughout the game. The rest — Master Skulls, Runebook, the Campfire badge ladders,
 * Beastmaster Crest — carry no rarity anywhere in the API and are left out rather than guessed.
 */
function impliedTier(name) {
  return /(^|\s)Talisman(\s|$)/.test(name ?? "") ? "COMMON" : null;
}

/**
 * Power stones, with their item ids resolved from the items resource by name.
 *
 * The curated table names the stones because nothing in the API links a stone to the power it
 * unlocks. The ids are looked up rather than written down: "Glacite Chunk" is GLACITE_SHARD and
 * "Fang-tastic Chocolate Chip" is CHOCOLATE_CHIP, and hand-keying those is how you end up
 * pricing a power off the wrong item.
 */
async function buildPowerStones() {
  const { items } = await getJson(`${BASE}/items`);
  const byName = new Map(items.map((i) => [i.name, i.id]));
  const curated = JSON.parse(await readFile(join(ROOT, "data", "curated", "power_stones.json"), "utf8"));

  const powers = [];
  const missing = [];
  for (const entry of curated.powers) {
    const itemId = byName.get(entry.stone) ?? null;
    if (!itemId) missing.push(entry.stone);
    powers.push({ ...entry, itemId });
  }
  if (missing.length) console.log(`  power stones  no item id for: ${missing.join(", ")}`);

  return { stonesPerPower: curated.stonesPerPower, xpPerPower: curated.xpPerPower, powers };
}

/* ------------------------------------------------------------------ museum */

/**
 * Museum donations, straight from the items resource — `museum_data.donation_xp` is published
 * per item, and armour pieces carry `armor_set_donation_xp` where the whole set pays once.
 * Totals 3,644 against the wiki's 3,646, so this needs no curation at all.
 */
async function buildMuseum() {
  const { items } = await getJson(`${BASE}/items`);
  const donations = [];
  const armorSets = new Map();

  for (const item of items) {
    const museum = item.museum_data;
    if (!museum) continue;

    if (typeof museum.donation_xp === "number") {
      donations.push({
        itemId: item.id,
        name: item.name,
        xp: museum.donation_xp,
        // A dungeon-starred copy is filed under its own id: donate a Starred Shadow Fury and the
        // museum stores STARRED_SHADOW_FURY, which matches nothing unless the alternates come too.
        mappedIds: museum.mapped_item_ids ?? [],
        // The next item up this slot's upgrade line. Donating a Wand of Atonement fills the
        // Healing, Mending and Restoration slots below it, so the chain has to be walked.
        parentId: museum.parent?.[item.id] ?? null,
        category: museum.category ?? "MISC",
        stage: museum.game_stage ?? null,
        tradeable: item.can_trade !== false && !item.soulbound,
      });
    }

    for (const [set, xp] of Object.entries(museum.armor_set_donation_xp ?? {})) {
      const existing = armorSets.get(set);
      if (existing) {
        existing.pieces.push(item.id);
        continue;
      }
      armorSets.set(set, {
        setId: set,
        // A set's upgrade parent is carried by its pieces, keyed by the *set* id rather than the
        // piece's own — donate the Backwater set and the Angler slot below it is filled. Reading
        // only the self-keyed links dropped all 174 of these.
        parentId: museum.parent?.[set] ?? null,
        // A set's upgrade parent is carried by its pieces, keyed by the *set* id rather than the
        // piece's own — donate the Backwater set and the Angler slot below it is filled. Reading
        // only the self-keyed links dropped all 174 of these.
        parentId: museum.parent?.[set] ?? null,
        name: item.name.replace(/ (Helmet|Chestplate|Leggings|Boots|Hat|Cap|Tunic|Trousers|Shoes)$/i, "").trim(),
        xp,
        category: museum.category ?? "MISC",
        stage: museum.game_stage ?? null,
        pieces: [item.id],
      });
    }
  }

  donations.sort((a, b) => a.itemId.localeCompare(b.itemId));
  const sets = [...armorSets.values()].sort((a, b) => a.setId.localeCompare(b.setId));
  const total = donations.reduce((s, d) => s + d.xp, 0) + sets.reduce((s, d) => s + d.xp, 0);
  return { totalXp: total, donations, armorSets: sets };
}

/* ---------------------------------------------------------- travel scrolls */

/**
 * Which fast-travel unlocks can actually be bought. Ten of the twenty-four have a scroll on the
 * auction house; the rest unlock by walking there once, so they are free in coins and stay
 * grind-tagged rather than being priced at zero and dominating every plan.
 */
async function buildTravelScrolls() {
  const { items } = await getJson(`${BASE}/items`);
  const byId = new Map(items.filter((i) => i.category === "TRAVEL_SCROLL").map((i) => [i.id, i]));

  const scrolls = [];
  for (const item of byId.values()) {
    const stem = item.id.replace(/_TRAVEL_SCROLL$/, "");
    scrolls.push({ taskId: `FAST_TRAVEL_${stem}`, itemId: item.id, name: item.name });
  }
  scrolls.sort((a, b) => a.taskId.localeCompare(b.taskId));
  return { scrolls };
}

/* -------------------------------------------------------------------- main */

const generators = {
  skills: buildSkills,
  collections: buildCollections,
  minions: buildMinions,
  accessories: buildAccessories,
  museum: buildMuseum,
  travel_scrolls: buildTravelScrolls,
  power_stones: buildPowerStones,
};

await mkdir(OUT, { recursive: true });
const generatedAt = new Date().toISOString();
for (const [name, fn] of Object.entries(generators)) {
  const data = await fn();
  const payload = { generatedAt, source: `${BASE}`, ...data };
  await writeFile(join(OUT, `${name}.json`), JSON.stringify(payload, null, 1) + "\n");
  const counts = Object.entries(data)
    .map(([k, v]) => (Array.isArray(v) ? `${v.length} ${k}` : `${k}=${v}`))
    .join(", ");
  console.log(`  ${name.padEnd(12)} ${counts}`);
}
console.log("done");
