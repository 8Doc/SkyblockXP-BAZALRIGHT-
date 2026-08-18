#!/usr/bin/env node
/**
 * Estimates how hard each grind is, by asking how many real players have already done it.
 *
 * Grind tasks have no coin price, so the solver can't rank them and the browser has been
 * listing them in arbitrary order. Ordering them needs a notion of effort, and effort is not
 * something the API publishes — a skill level, a collection tier, a slayer level and a trophy
 * fish are measured in four incompatible units.
 *
 * The one unit they *do* share is how common they are. Sample enough live profiles and the
 * fraction of players who have finished a task is a usable difficulty proxy: 95% of players
 * have Combat 10, 4% have Combat 50. It is observed rather than invented, it lands every
 * category on one 0-1 scale, and it needs no per-category fudge factors.
 *
 * === Sample bias, measured rather than asserted ===
 *
 * There is no Hypixel endpoint that lists "a random cross-section of players" — the only way to
 * *discover* a UUID through the public HTTP API is to already have one, so every sampling
 * strategy here starts from the auction house, and every one of them is biased toward players
 * engaged with the economy: online recently, with something to sell or buy. A brand-new player,
 * or one who only ever grinds and never trades, is under-represented by construction.
 *
 * The best correction available without a Minecraft client is a citable external benchmark. A
 * Hypixel Forums user (tla_, "Data #1: Distribution of SkyBlock Levels", 19 Jan 2024,
 * https://hypixel.net/threads/data-1-distribution-of-skyblock-levels.5579975/) AFK'd in the
 * SkyBlock login lobby for a few hours and logged ~9,800 player UUIDs as they passed through —
 * "basically every skyblock main will pass through the lobby while logging in", by their own
 * description. That is close to an unbiased cross-section of *active* players (it still misses
 * anyone who didn't log in that day), and it published level-distribution percentiles: mode 47,
 * Q1 53, median 105, Q3 178, 80th percentile 200.
 *
 * That method needs a bot sitting in a Minecraft lobby, which this script cannot do. What it
 * *can* do is pull a far bigger and more varied auction-house-seeded sample than before, then
 * report our own sample's level distribution next to tla_'s numbers — so the skew is a measured
 * delta in the output file, not a one-line disclaimer.
 *
 *   node scripts/harvest-difficulty.mjs [--players 600]
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "data", "generated", "difficulty.json");

const arg = (flag, fallback) => {
  const i = process.argv.indexOf(flag);
  return i > -1 ? Number(process.argv[i + 1]) : fallback;
};
const PLAYERS = arg("--players", 600);

const key = (await readFile(join(ROOT, ".env.local"), "utf8").catch(() => "")).match(/HYPIXEL_API_KEY=(.+)/)?.[1]?.trim();
if (!key) {
  console.error("No HYPIXEL_API_KEY in .env.local");
  process.exit(1);
}

const read = async (p) => JSON.parse(await readFile(join(ROOT, p), "utf8"));
const skills = await read("data/generated/skills.json");
const curves = await read("data/generated/curves.json");

async function api(path) {
  const res = await fetch(`https://api.hypixel.net/v2${path}`, { headers: { "API-Key": key } });
  if (res.status === 429) {
    await new Promise((r) => setTimeout(r, 15000));
    return api(path);
  }
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return res.json();
}

/**
 * Every task id this member has completed, using exactly the ids buildCatalog generates so the
 * two line up without a translation layer.
 */
function completedIds(member) {
  const ids = new Set();

  for (const id of member.leveling?.completed_tasks ?? []) ids.add(id);

  const experience = member.player_data?.experience ?? {};
  for (const skill of skills.skills) {
    const xp = experience[`SKILL_${skill.key}`] ?? 0;
    for (const level of skill.levels) {
      if (level.xp > 0 && xp >= level.totalExpRequired) ids.add(`skill_${skill.key}_${level.level}`);
    }
  }

  for (const tier of member.player_data?.unlocked_coll_tiers ?? []) {
    const match = /^(.*)_(\d+)$/.exec(tier);
    if (match) ids.add(`collection_${match[1]}_${match[2]}`);
  }

  for (const crafted of member.player_data?.crafted_generators ?? []) {
    const match = /^(.*)_(\d+)$/.exec(crafted);
    if (match) ids.add(`minion_${match[1]}_${match[2]}`);
  }

  const catacombsXp = member.dungeons?.dungeon_types?.catacombs?.experience ?? 0;
  for (const level of curves.dungeoneering.levels) {
    if (catacombsXp >= level.totalXp) ids.add(`catacombs_${level.level}`);
  }
  for (const [className, data] of Object.entries(member.dungeons?.player_classes ?? {})) {
    const classXp = data?.experience ?? 0;
    for (const level of curves.dungeoneering.levels) {
      if (classXp >= level.totalXp) ids.add(`class_${className}_${level.level}`);
    }
  }

  for (const [boss, thresholds] of Object.entries(curves.slayer.bosses)) {
    const bossXp = member.slayer?.slayer_bosses?.[boss]?.xp ?? 0;
    thresholds.forEach((threshold, index) => {
      if (bossXp >= threshold) ids.add(`slayer_${boss}_${index + 1}`);
    });
  }

  const souls = member.fairy_soul?.total_collected ?? 0;
  for (let chunk = 1; chunk <= 57; chunk++) {
    if (souls >= chunk * 5) ids.add(`fairy_souls_${chunk * 5}`);
  }

  return ids;
}

/* --------------------------------------------------------------- sampling */

/**
 * Two independent seed sources, unioned:
 *   - current listings (auctioneer)   -> players with something to sell right now
 *   - auctions_ended (seller + buyer) -> also catches the *buying* side of the economy, which
 *                                        the old version never sampled at all
 * Neither escapes the "engaged with the AH" bias, but a buyer skews differently from a lister
 * (a buyer just needs coins, not inventory), so the union is a broader cut than either alone.
 */
console.log("collecting player uuids from the auction house…");
const uuids = new Set();

for (let page = 0; page < 12 && uuids.size < PLAYERS * 3; page++) {
  const body = await api(`/skyblock/auctions?page=${page}`).catch(() => null);
  if (!body) break;
  for (const auction of body.auctions) if (auction.auctioneer) uuids.add(auction.auctioneer);
}
console.log(`  ${uuids.size} unique sellers from current listings`);

for (let poll = 0; poll < 3 && uuids.size < PLAYERS * 3; poll++) {
  const body = await api("/skyblock/auctions_ended").catch(() => null);
  if (!body) break;
  for (const auction of body.auctions ?? []) {
    if (auction.seller) uuids.add(auction.seller);
    if (auction.buyer) uuids.add(auction.buyer);
  }
  if (poll < 2) await new Promise((r) => setTimeout(r, 20000)); // let the ended list turn over
}
console.log(`  ${uuids.size} unique uuids after adding recent buyers and sellers`);

const sample = [...uuids].sort(() => Math.random() - 0.5).slice(0, PLAYERS);
console.log(`  sampling ${sample.length} of them`);

const counts = new Map();
const levels = []; // this sample's SkyBlock level per player, for the calibration check
let scanned = 0;

const CONCURRENCY = 5;
for (let i = 0; i < sample.length; i += CONCURRENCY) {
  const batch = await Promise.all(
    sample.slice(i, i + CONCURRENCY).map((uuid) =>
      api(`/skyblock/profiles?uuid=${uuid}`)
        .then((body) => ({ uuid, body }))
        .catch(() => null),
    ),
  );

  for (const entry of batch) {
    if (!entry?.body?.profiles) continue;
    // Take the player's best profile: a fresh alt profile would read as "hasn't done anything"
    // and drag every completion rate down without telling us anything about difficulty.
    let best = null;
    for (const profile of entry.body.profiles) {
      const member = profile.members?.[entry.uuid];
      if (!member) continue;
      const xp = member.leveling?.experience ?? 0;
      if (!best || xp > best.xp) best = { xp, member };
    }
    if (!best) continue;

    scanned++;
    levels.push(Math.floor(best.xp / 100));
    for (const id of completedIds(best.member)) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  process.stdout.write(`\r  scanned ${scanned}/${sample.length} players, ${counts.size} distinct completions`);
}
console.log();

/* --------------------------------------------------- calibration vs tla_'s sample */

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}
function mode(values) {
  const bins = new Map();
  for (const v of values) bins.set(v, (bins.get(v) ?? 0) + 1);
  let best = null;
  for (const [v, n] of bins) if (!best || n > best[1]) best = [v, n];
  return best?.[0] ?? null;
}

const sortedLevels = [...levels].sort((a, b) => a - b);
const ourDistribution = {
  n: levels.length,
  mode: mode(levels),
  q1: percentile(sortedLevels, 25),
  median: percentile(sortedLevels, 50),
  q3: percentile(sortedLevels, 75),
  p80: percentile(sortedLevels, 80),
};

// tla_'s published reference, from a login-lobby log — the closest thing to an unbiased sample
// of active players that exists for this game. See the module comment for the full citation.
const referenceDistribution = { n: 9800, mode: 47, q1: 53, median: 105, q3: 178, p80: 200 };

const skew = {
  medianDeltaLevels: ourDistribution.median !== null ? ourDistribution.median - referenceDistribution.median : null,
  interpretation:
    ourDistribution.median !== null && ourDistribution.median > referenceDistribution.median
      ? "our sample skews toward more advanced accounts than the login-lobby reference — expected, since the auction house selects for economically active players"
      : "our sample's median is at or below the reference — unexpected, worth rechecking the seed sources",
};

/* -------------------------------------------------------------- aggregate */

const rates = {};
for (const [id, count] of counts) rates[id] = Number((count / scanned).toFixed(4));

await mkdir(dirname(OUT), { recursive: true });
await writeFile(
  OUT,
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      playersScanned: scanned,
      note: "completionRate = fraction of sampled players who have finished this task. Lower means rarer, and rarer is treated as harder.",
      sampleBias:
        "Players are discovered through the auction house (current listings + recent trades), which is the only UUID-discovery path the public HTTP API offers. That selects for players active in the economy and skews the whole sample toward more advanced accounts. Rates are relative difficulty within that population, not an absolute rate across everyone who has ever played.",
      calibration: {
        method:
          "Our sampled players' SkyBlock level distribution, compared against a published external reference collected by a different method (see citation).",
        citation:
          "tla_, \"Data #1: Distribution of SkyBlock Levels\", Hypixel Forums, 19 Jan 2024 — https://hypixel.net/threads/data-1-distribution-of-skyblock-levels.5579975/ — ~9,800 UUIDs logged by AFKing in the SkyBlock login lobby, which the author describes as catching \"basically every skyblock main\" who logged in during that window.",
        ourSample: ourDistribution,
        reference: referenceDistribution,
        skew,
      },
      completionRate: rates,
    },
    null,
    1,
  ) + "\n",
);

/* ----------------------------------------------------------------- report */

const bands = { quick: 0, short: 0, long: 0, marathon: 0 };
for (const rate of Object.values(rates)) {
  if (rate >= 0.8) bands.quick++;
  else if (rate >= 0.5) bands.short++;
  else if (rate >= 0.2) bands.long++;
  else bands.marathon++;
}
console.log(`\n${Object.keys(rates).length} tasks rated from ${scanned} players`);
console.log(`bands: ${Object.entries(bands).map(([b, n]) => `${b} ${n}`).join(", ")}`);

console.log("\ncalibration against tla_'s login-lobby sample (n=9,800):");
console.log(
  `  level distribution   ours: mode ${ourDistribution.mode} · Q1 ${ourDistribution.q1} · median ${ourDistribution.median} · Q3 ${ourDistribution.q3} · P80 ${ourDistribution.p80}`,
);
console.log(
  `                       ref:  mode ${referenceDistribution.mode} · Q1 ${referenceDistribution.q1} · median ${referenceDistribution.median} · Q3 ${referenceDistribution.q3} · P80 ${referenceDistribution.p80}`,
);
console.log(`  median skew: ${skew.medianDeltaLevels > 0 ? "+" : ""}${skew.medianDeltaLevels} levels — ${skew.interpretation}`);

const show = (label, ids) => {
  const rated = ids.map((id) => [id, rates[id] ?? 0]).filter(([, r]) => r > 0);
  if (!rated.length) return;
  rated.sort((a, b) => b[1] - a[1]);
  console.log(`  ${label.padEnd(22)} easiest ${rated[0][0]} (${Math.round(rated[0][1] * 100)}%) … hardest ${rated.at(-1)[0]} (${Math.round(rated.at(-1)[1] * 100)}%)`);
};
show("combat levels", skills.skills.find((s) => s.key === "COMBAT").levels.map((l) => `skill_COMBAT_${l.level}`));
show("catacombs levels", curves.dungeoneering.levels.map((l) => `catacombs_${l.level}`));
show("zombie slayer", curves.slayer.bosses.zombie?.map((_, i) => `slayer_zombie_${i + 1}`) ?? []);
show("fairy souls", Array.from({ length: 57 }, (_, i) => `fairy_souls_${(i + 1) * 5}`));
console.log(`\n-> ${OUT}`);
