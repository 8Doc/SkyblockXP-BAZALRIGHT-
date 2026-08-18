#!/usr/bin/env node
/**
 * Discovers the real task-id namespace by sampling live players.
 *
 * `leveling.completed_tasks` holds Hypixel's internal ids for every discrete task a player has
 * finished — FAST_TRAVEL_CRYSTAL_HOLLOWS, BANK_UPGRADE_GOLD, DRAGON_ESSENCE_ONE_PUNCH_3 — but
 * there is no endpoint that lists the ids that *exist*. Unioning enough players approximates
 * that set, and more importantly it lets us check the ids we derive from wiki task names
 * against ids the game actually emits, instead of trusting a naming convention we guessed.
 *
 * Players come from the auction house, which is just a convenient list of active accounts.
 *
 *   node scripts/harvest-task-ids.mjs [--players 120]
 */
import { writeFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "data", "generated", "task_ids.json");

const arg = (flag, fallback) => {
  const i = process.argv.indexOf(flag);
  return i > -1 ? Number(process.argv[i + 1]) : fallback;
};
const PLAYERS = arg("--players", 120);

const key = (await readFile(join(ROOT, ".env.local"), "utf8").catch(() => "")).match(/HYPIXEL_API_KEY=(.+)/)?.[1]?.trim();
if (!key) {
  console.error("No HYPIXEL_API_KEY in .env.local");
  process.exit(1);
}

async function api(path) {
  const res = await fetch(`https://api.hypixel.net/v2${path}`, { headers: { "API-Key": key } });
  if (res.status === 429) {
    // Rate limited: wait out the window rather than hammering.
    await new Promise((r) => setTimeout(r, 15000));
    return api(path);
  }
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return res.json();
}

console.log("collecting player uuids from the auction house…");
const uuids = new Set();
for (let page = 0; page < 3 && uuids.size < PLAYERS * 2; page++) {
  const body = await api(`/skyblock/auctions?page=${page}`);
  for (const auction of body.auctions) if (auction.auctioneer) uuids.add(auction.auctioneer);
}
const sample = [...uuids].slice(0, PLAYERS);
console.log(`  ${uuids.size} unique sellers, sampling ${sample.length}`);

const counts = new Map(); // task id -> how many players have it
let scanned = 0;
let profilesSeen = 0;

const CONCURRENCY = 4;
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
    scanned++;
    // Union across every profile the account owns — different profiles finish different things.
    const seen = new Set();
    for (const profile of entry.body.profiles) {
      profilesSeen++;
      for (const id of profile.members?.[entry.uuid]?.leveling?.completed_tasks ?? []) seen.add(id);
    }
    for (const id of seen) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  process.stdout.write(`\r  scanned ${scanned}/${sample.length} players, ${counts.size} distinct task ids`);
}
console.log();

/** Group ids by their family prefix so the shape of each category is visible at a glance. */
const ids = [...counts.entries()].sort((a, b) => b[1] - a[1]);
const payload = {
  generatedAt: new Date().toISOString(),
  playersScanned: scanned,
  profilesScanned: profilesSeen,
  distinctTaskIds: counts.size,
  /** id -> number of sampled players who have completed it. Low counts are rare, not invalid. */
  tasks: Object.fromEntries(ids),
};

await mkdir(dirname(OUT), { recursive: true });
await writeFile(OUT, JSON.stringify(payload, null, 1) + "\n");

const prefixes = {};
for (const [id] of ids) {
  const head = id.split("_")[0];
  prefixes[head] = (prefixes[head] ?? 0) + 1;
}
console.log(`\n${counts.size} distinct ids from ${scanned} players / ${profilesSeen} profiles`);
console.log("top prefixes:");
for (const [prefix, n] of Object.entries(prefixes).sort((a, b) => b[1] - a[1]).slice(0, 25)) {
  console.log(`  ${String(n).padStart(4)}  ${prefix}`);
}
console.log(`-> ${OUT}`);
