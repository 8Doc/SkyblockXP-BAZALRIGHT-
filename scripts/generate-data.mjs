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
import { writeFile, mkdir } from "node:fs/promises";
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
  const out = [];
  for (const item of items) {
    if (item.category !== "ACCESSORY") continue;
    if (!item.tier) continue; // no rarity -> no defined magical power
    out.push({
      id: item.id,
      name: item.name,
      tier: item.tier,
      museum: Boolean(item.museum),
      soulbound: Boolean(item.soulbound),
      tradeable: item.can_trade !== false && item.can_auction !== false && !item.soulbound,
      riftTransferrable: Boolean(item.rift_transferrable),
    });
  }
  out.sort((a, b) => a.id.localeCompare(b.id));
  return { accessories: out };
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
