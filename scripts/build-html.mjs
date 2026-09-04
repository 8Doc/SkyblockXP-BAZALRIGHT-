#!/usr/bin/env node
/**
 * Bundles the app into one self-contained HTML file that runs from the filesystem —
 * no server, no install, no network except the calls to Hypixel itself.
 *
 * The task tables in data/ are inlined, and the TypeScript in src/browser + src/lib is bundled
 * by esbuild. The domain logic is the *same source* the Next app uses, so both front ends
 * necessarily agree.
 *
 * No key is baked in by default — the page has its own "Get an API key" link and an input,
 * so each person supplies their own and it never leaves their browser (stored in localStorage
 * only). Pass --key only for a private, self-hosted build where baking one in is a deliberate
 * choice; --from-env opts back into the old behaviour of reading .env.local for that same case.
 * Never commit a build made with either flag.
 *
 *   node scripts/build-html.mjs [--key YOUR_KEY | --from-env]
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "dist", "skyblock-xp-planner.html");

const keyFlag = process.argv.indexOf("--key");
const apiKey = keyFlag > -1 ? process.argv[keyFlag + 1] : process.argv.includes("--from-env") ? (await readEnvKey()) ?? "" : "";

async function readEnvKey() {
  try {
    const env = await readFile(join(ROOT, ".env.local"), "utf8");
    return /HYPIXEL_API_KEY=(.+)/.exec(env)?.[1]?.trim() ?? null;
  } catch {
    return null;
  }
}

async function loadJson(relative) {
  return JSON.parse(await readFile(join(ROOT, "data", relative), "utf8"));
}

const gameData = {
  skills: await loadJson("generated/skills.json"),
  collections: await loadJson("generated/collections.json"),
  minions: await loadJson("generated/minions.json"),
  accessories: await loadJson("generated/accessories.json"),
  magicalPower: await loadJson("curated/magical_power.json"),
  accessoryFamilies: await loadJson("curated/accessory_families.json"),
  accessoryUpgrades: await loadJson("generated/accessory_upgrades.json"),
  museum: await loadJson("generated/museum.json"),
  tasks: await loadJson("generated/tasks.json"),
  curves: await loadJson("generated/curves.json"),
  travelScrolls: await loadJson("generated/travel_scrolls.json"),
  costs: await loadJson("generated/costs.json"),
  factionReputation: await loadJson("curated/faction_reputation.json"),
  petScore: await loadJson("curated/pet_score.json"),
  petLevels: await loadJson("curated/pet_levels.json"),
  petApiKeys: await loadJson("curated/pet_api_keys.json"),
  pets: await loadJson("generated/pets.json"),
  difficulty: await loadJson("generated/difficulty.json"),
  attributeShards: await loadJson("generated/attributes.json"),
  bestiary: await loadJson("generated/bestiary.json"),
  bestiaryKnownMax: await loadJson("curated/bestiary_known_max.json"),
  bestiaryMobIds: await loadJson("generated/bestiary_mob_ids.json"),
  bestiaryMobs: await loadJson("curated/bestiary_mobs.json"),
  abiphone: await loadJson("generated/abiphone.json"),
  bagUpgrades: await loadJson("curated/accessory_bag_upgrades.json"),
  attributeLevels: await loadJson("curated/attribute_levels.json"),
  attributeApiKeys: await loadJson("curated/attribute_api_keys.json"),
  powerStones: await loadJson("generated/power_stones.json"),
  npcs: await loadJson("generated/npcs.json"),
  carnivalShop: await loadJson("curated/carnival_shop.json"),
};

/**
 * The bazaar tab's tables, inlined separately from the planner's. They answer a different
 * question off different data, and keeping them apart means neither can quietly grow a
 * dependency on the other.
 */
const recipeFile = await loadJson("generated/recipes.json");
const bazaarData = {
  // The craft table's recipes and the steps underneath them travel together: the chain finder
  // treats them as one graph, and an intermediate is only ever reached through a real recipe.
  recipes: recipeFile.recipes,
  intermediates: recipeFile.intermediates ?? [],
  npcPrices: (await loadJson("generated/npc-prices.json")).prices,
  anvil: await loadJson("curated/anvil_combines.json"),
  names: (await loadJson("generated/bazaar_items.json")).names,
};

/**
 * The greenhouse tab's tables, separate again. It shares only the shop prices with the bazaar —
 * everything else about it is a wiki scrape of a feature the API does not describe.
 */
const greenhouseData = {
  greenhouse: {
    ...(await loadJson("generated/greenhouse.json")),
    // Decay is not on the Mutations table and not on the Greenhouse page — Hypixel publishes it
    // per plant only through the in-game Diagnostics Tool. What is written down lives here, with
    // its sources, and the gaps stay gaps.
    decay: await loadJson("curated/greenhouse_decay.json"),
  },
  npcPrices: (await loadJson("generated/npc-prices.json")).prices,
};

/**
 * The minions tab. Hypixel's item resource knows every minion's tiers and nothing about what they
 * produce, so the rates are a wiki scrape and the slot contents are curated — see the notes in
 * both files for why each is the shape it is.
 */
const skillXpFile = await loadJson("generated/skill-xp.json");
const minionStorage = await loadJson("curated/minion_storage.json");

const minionData = {
  production: {
    ...(await loadJson("generated/minion-production.json")),
    // Minions behave differently with a player on the island; this models the offline case, which
    // is when they are doing the work anyone asks a minion calculator about. The deviations that
    // are actually documented live here with their sources.
    offline: await loadJson("curated/minion_offline.json"),
  },
  modifiers: await loadJson("curated/minion_modifiers.json"),
  collections: (await loadJson("generated/collections.json")).collections,

  // The profits tab. Storage decides how much of a rate you ever collect, the recipes decide how
  // much a compactor changes that, and the shop prices are the third market a minion's output can
  // go to — often the best one, for the cheap bulk several minions produce.
  storage: {
    slotItems: minionStorage.slotItems,
    chests: minionStorage.chests,
    hoppers: minionStorage.hoppers,
    compactors: minionStorage.compactors,
  },
  drops: { overrides: (await loadJson("curated/minion_drops.json")).overrides },
  // Upgrades that add a second item to the output. Without these the single best-known coin
  // setup in the game — a mob minion with Corrupt Soil selling into an Enchanted Hopper — is
  // invisible in a table that models every other slot.
  extras: { extras: (await loadJson("curated/minion_extras.json")).extras },
  recipes: recipeFile.recipes,
  npcPrices: (await loadJson("generated/npc-prices.json")).prices,
  names: (await loadJson("generated/bazaar_items.json")).names,

  // The pet tab. Only Farming and Mining publish a per-item minion XP rate, so most of this table
  // is the absence of one — which is the point: an unpublished rate and a zero rank at opposite
  // ends and only one of them is a claim the wiki makes.
  skillXp: {
    perItem: skillXpFile.perItem,
    brewing: skillXpFile.brewing,
    carpentryXpPerNpcCoin: skillXpFile.carpentryXpPerNpcCoin,
  },
  petXpRules: await loadJson("curated/pet_xp.json"),
  petLevels: await loadJson("curated/pet_levels.json"),
};

const bundle = await build({
  entryPoints: [join(ROOT, "src", "browser", "main.ts")],
  bundle: true,
  format: "iife",
  target: "es2022",
  minify: true,
  write: false,
  define: { DEFAULT_API_KEY: JSON.stringify(apiKey) },
  logLevel: "warning",
});

const script = bundle.outputFiles[0].text;
const css = await readFile(join(ROOT, "src", "browser", "app.css"), "utf8");

// </script> inside inlined JSON would close the tag early.
const dataJson = JSON.stringify(gameData).replace(/</g, "\\u003c");
const bazaarJson = JSON.stringify(bazaarData).replace(/</g, "\\u003c");
const greenhouseJson = JSON.stringify(greenhouseData).replace(/</g, "\\u003c");
const minionJson = JSON.stringify(minionData).replace(/</g, "\\u003c");

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>SkyBlock XP Planner</title>
<style>
${css}
</style>
</head>
<body>
<div id="app"></div>
<script>window.__GAME_DATA__ = ${dataJson};</script>
<script>window.__BAZAAR_DATA__ = ${bazaarJson};</script>
<script>window.__GREENHOUSE_DATA__ = ${greenhouseJson};</script>
<script>window.__MINION_DATA__ = ${minionJson};</script>
<script>
${script}
</script>
</body>
</html>
`;

await mkdir(dirname(OUT), { recursive: true });
await writeFile(OUT, html);

const kb = (n) => `${(n / 1024).toFixed(0)} KB`;
console.log(`  data    ${kb(dataJson.length)}`);
console.log(`  bazaar  ${kb(bazaarJson.length)}`);
console.log(`  greenhouse ${kb(greenhouseJson.length)}`);
console.log(`  minions ${kb(minionJson.length)}`);
console.log(`  script  ${kb(script.length)}`);
console.log(`  css     ${kb(css.length)}`);
console.log(`  -> dist/skyblock-xp-planner.html  ${kb(html.length)}`);
console.log(apiKey ? "  API key baked in (keep the file private)" : "  no API key baked in — paste one in the UI");
