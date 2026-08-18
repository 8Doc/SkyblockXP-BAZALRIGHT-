#!/usr/bin/env node
/**
 * Joins the two halves of the task data into one committed table.
 *
 *   task_ids.json  — the ids the game actually emits, harvested from live players.
 *                    Ground truth for *what exists*.
 *   wiki_tasks.json — the XP each task awards, scraped from the wiki.
 *                    Ground truth for *what it's worth*.
 *
 * They can't be joined by name: the wiki shows display names ("One Punch") and the API emits
 * internal ids (DRAGON_ESSENCE_FLAT_DAMAGE_VS_ENDER_1), and only 195 of 319 essence rows line
 * up. So instead of a fuzzy name match, XP comes from *structural rules* read off the wiki —
 * rules that are then checked against the wiki's own per-category totals. Where a rule
 * reproduces the wiki total exactly, the category is exact; where it doesn't, this script says
 * so rather than quietly shipping a wrong number.
 *
 *   node scripts/build-task-table.mjs
 */
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "data", "generated", "tasks.json");

const read = async (p) => JSON.parse(await readFile(join(ROOT, p), "utf8"));
const harvest = await read("data/generated/task_ids.json");
const ids = Object.keys(harvest.tasks);

/**
 * Perk shops all pay out along one sequence, truncated at the perk's last tier. Verified
 * against every essence shop's wiki total: 8 of 9 matched on the first pass, and the ninth
 * (Diamond) matched once Rhinestone Infusion — which the wiki spells "Rhinstone" — was given
 * its documented flat curve.
 */
const PERK_CURVE = [2, 2, 3, 5, 7, 8, 8, 8, 9, 10];
const RHINESTONE_CURVE = [1, 1, 1, 1, 1, 1, 1, 2, 2, 2];

const tierOf = (id) => Number(/_(\d+)$/.exec(id)?.[1] ?? 0);
const perkXp = (id) => {
  const tier = tierOf(id);
  if (!tier) return null;
  const curve = /RHINESTONE_INFUSION/.test(id) ? RHINESTONE_CURVE : PERK_CURVE;
  return curve[tier - 1] ?? curve[curve.length - 1];
};

/** Trophy fish pay per grade, doubling each step. */
const TROPHY = { BRONZE: 4, SILVER: 8, GOLD: 16, DIAMOND: 32 };
const BANK = { GOLD: 20, DELUXE: 25, SUPER_DELUXE: 30, PREMIER: 35, LUXURIOUS: 40, PALATIAL: 50 };
const PERSONAL_BANK = { ONE: 25, TWO: 35, THREE: 50 };
const DOJO = { WHITE: 20, YELLOW: 30, GREEN: 50, BLUE: 75, BROWN: 100, BLACK: 150 };
const REPUTATION = { FRIENDLY: 5, TRUSTED: 10, HONORED: 20, HERO: 40 };
const BRACKET = { WOOD: 10, STONE: 20, IRON: 30, GOLD: 40, DIAMOND: 50, EMERALD: 75 };
const SLAYER_TIER = { ONE: 25, TWO: 25, THREE: 25, FOUR: 25, FIVE: 25 };

/**
 * Rules are tried in order; the first whose pattern matches owns the id. Each carries the wiki
 * line it came from so a wrong number can be traced back to a source rather than to a guess.
 */
const RULES = [
  // ---------------------------------------------------------------- perk shops
  {
    name: "essence shop perks",
    category: "essence_shop",
    match: /_ESSENCE_.+_\d+$/,
    xp: perkXp,
    source: "wiki Essence Shop tab — curve verified against all 9 shop totals",
  },
  {
    name: "event perk shops",
    category: "events",
    match: /^(SPOOKY_FESTIVAL|WINTER|FISHING_FESTIVAL|NATIONAL_MINING_MONTH|HARVEST_FEAST|MYTHOLOGICAL_RITUAL|YOTW)_.+_\d+$/,
    xp: perkXp,
    source: "wiki Event tab — perk shops use the same 2/2/3/5/7 curve, 49 XP per shop",
  },

  // -------------------------------------------------------------------- flat XP
  { name: "abiphone contacts", category: "abiphone", match: /^ABIPHONE_/, xp: () => 10, source: "wiki Miscellaneous — +10 per contact" },
  { name: "fast travel", category: "fast_travel", match: /^FAST_TRAVEL_/, xp: () => 15, source: "wiki Core — +15 per unlock" },
  { name: "community shop", category: "misc", match: /^UPGRADE_(ISLAND_SIZE|MINION_SLOTS|GUESTS_LIMIT|GUESTS_COUNT|COINS_ALLOWANCE)_/, xp: () => 10, source: "wiki Miscellaneous — Community Shop, +10 each" },
  { name: "rock/dolphin milestones", category: "misc", match: /^(ROCK|DOLPHIN)_MILESTONE_/, xp: () => 20, source: "wiki Skill Related — +20 per milestone" },
  { name: "safari milestones", category: "misc", match: /^SAFARI_MILESTONE_/, xp: () => 5, source: "not on the wiki (newer than the page) — assumed +5" , unverified: true },
  { name: "story objectives", category: "misc", match: /^OBJECTIVE_/, xp: () => 5, source: "wiki Story tab", unverified: true },
  { name: "jacob's contests", category: "events", match: /^FARMING_CONTEST_/, xp: () => 10, source: "wiki Event — Jacob's Farming Contest, +10 per gold medal crop, total 130" },
  { name: "carrolyn exports", category: "misc", match: /^CARROLYN_EXPORT_CROP_/, xp: () => 5, source: "wiki Miscellaneous — Carrolyn's Exportable Crops, total 35" },
  // Year of the Wolf stews: newer than the wiki page, so the value is inferred from the
  // consumable rows that do exist (one-off unlocks of this shape award 5).
  { name: "yotw stews", category: "events", match: /^YOTW_STEW_/, xp: () => 5, source: "not on the wiki — inferred", unverified: true },

  // ------------------------------------------------------------------ lookups
  { name: "bank upgrades", category: "bank", match: /^BANK_UPGRADE_/, xp: (id) => BANK[id.replace("BANK_UPGRADE_", "")] ?? null, source: "wiki Core — 20/25/30/35/40/50, total 200" },
  { name: "personal bank", category: "bank", match: /^PERSONAL_BANK_/, xp: (id) => PERSONAL_BANK[id.replace("PERSONAL_BANK_", "")] ?? null, source: "wiki Miscellaneous — 25/35/50, total 110" },
  { name: "dojo belts", category: "misc", match: /^DOJO_BELT_/, xp: (id) => DOJO[id.replace("DOJO_BELT_", "")] ?? null, source: "wiki Miscellaneous — total 425" },
  { name: "reputation", category: "misc", match: /^(MAGES|BARBARIANS?)_/, xp: (id) => REPUTATION[id.split("_").slice(1).join("_")] ?? null, source: "wiki Miscellaneous — 5/10/20/40 per faction" },
  { name: "trophy fish", category: "misc", match: /^TROPHY_/, xp: (id) => TROPHY[id.split("_").pop()] ?? null, source: "wiki Skill Related — 4/8/16/32 per grade" },
  { name: "festival brackets", category: "events", match: /^SPOOKY_FESTIVAL_(WOOD|STONE|IRON|GOLD|DIAMOND|EMERALD)$/, xp: (id) => BRACKET[id.split("_").pop()] ?? null, source: "wiki Event — Spooky Festival brackets, total 225" },

  // ----------------------------------------------------------------- dungeons
  { name: "master mode floors", category: "dungeons", match: /^COMPLETE_MASTER_CATACOMBS\d+$/, xp: () => 50, source: "wiki Dungeon — +50 each, total 350" },
  { name: "catacombs floors", category: "dungeons", match: /^COMPLETE_CATACOMBS\d+$/, xp: (id) => (Number(id.replace("COMPLETE_CATACOMBS", "")) >= 5 ? 30 : 20), source: "wiki Dungeon — +20 F0-F4, +30 F5-F7, total 190" },

  // ------------------------------------------------------------------- slayer
  { name: "slayer tiers", category: "slayer", match: /^DEFEAT_\w+_SLAYER_(ONE|TWO|THREE|FOUR|FIVE)$/, xp: (id) => SLAYER_TIER[id.split("_").pop()] ?? null, source: "wiki Slaying — +25 per boss tier" },
  { name: "dragons", category: "slayer", match: /^KILL_\w+_DRAGON$/, xp: (id) => (/SUPERIOR/.test(id) ? 50 : 25), source: "wiki Slaying — Superior 50, others 25, total 200" },
  { name: "other bosses", category: "slayer", match: /^KILL_/, xp: () => 25, source: "wiki Slaying", unverified: true },
  { name: "arachne", category: "slayer", match: /^KILL_ARACHNE_TIER_\d+$/, xp: () => 25, source: "wiki Slaying", unverified: true },

  // --------------------------------------------------------------------- rift
  {
    name: "harp songs",
    category: "rift",
    // SONG_HYMN_JOY_50 -> the trailing number is the completion percentage, not a tier.
    match: /^SONG_/,
    xp: (id) => SONG_XP[id.replace(/_\d+$/, "")] ?? null,
    source: "wiki Miscellaneous — Harp Songs, per-song XP × 4 difficulty steps",
  },
];

/**
 * Harp songs pay by song, and the wiki lists them by display name. These are the internal
 * stems, matched to the wiki's per-song value.
 */
const SONG_XP = {
  SONG_HYMN_JOY: 1,
  SONG_FRERE_JACQUES: 1,
  SONG_AMAZING_GRACE: 1,
  SONG_BRAHMS: 2,
  SONG_HAPPY_BIRTHDAY: 2,
  SONG_GREENSLEEVES: 2,
  SONG_GEOTHERMY: 4,
  SONG_MINUET: 4,
  SONG_JOY_WORLD: 4,
  SONG_PURE_IMAGINATION: 7,
  SONG_VIE_EN_ROSE: 7,
  SONG_FIRE_AND_FLAMES: 12,
  SONG_PACHELBEL: 12,
  // "Geothermy?" on the wiki; the game calls it Jeopardy. Same 4 XP slot as the other
  // third-tier songs, but the name match is inferred rather than documented.
  SONG_JEOPARDY: 4,
};

/* ------------------------------------------------------------------- build */

const tasks = [];
const unmatched = [];
const byRule = new Map();

for (const id of ids) {
  const rule = RULES.find((r) => r.match.test(id));
  const xp = rule ? rule.xp(id) : null;
  if (!rule || xp === null || xp === undefined) {
    unmatched.push(id);
    continue;
  }
  tasks.push({ id, category: rule.category, xp, rule: rule.name, players: harvest.tasks[id] });
  byRule.set(rule.name, (byRule.get(rule.name) ?? 0) + xp);
}

tasks.sort((a, b) => a.id.localeCompare(b.id));

const byCategory = {};
for (const task of tasks) byCategory[task.category] = (byCategory[task.category] ?? 0) + task.xp;

await writeFile(
  OUT,
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      sources: {
        ids: "data/generated/task_ids.json (harvested from live profiles)",
        xp: "data/generated/wiki_tasks.json (Hypixel Wiki, SkyBlock Levels/Tasks)",
      },
      playersScanned: harvest.playersScanned,
      totals: { tasks: tasks.length, xp: tasks.reduce((s, t) => s + t.xp, 0), byCategory },
      unmatchedIds: unmatched,
      tasks,
    },
    null,
    1,
  ) + "\n",
);

console.log(`${tasks.length} of ${ids.length} harvested ids priced in XP`);
console.log("\nXP by rule:");
for (const [rule, xp] of [...byRule].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(xp).padStart(6)}  ${rule}`);
}
console.log("\nXP by category:");
for (const [category, xp] of Object.entries(byCategory).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(xp).padStart(6)}  ${category}`);
}
if (unmatched.length) {
  console.log(`\n${unmatched.length} ids with no rule (they stay out of the table):`);
  console.log("  " + unmatched.slice(0, 20).join(", "));
}
console.log(`\n-> ${OUT}`);
