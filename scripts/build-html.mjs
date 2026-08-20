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
  accessoryChains: await loadJson("generated/accessory_trade.json"),
  museum: await loadJson("generated/museum.json"),
  tasks: await loadJson("generated/tasks.json"),
  curves: await loadJson("generated/curves.json"),
  travelScrolls: await loadJson("generated/travel_scrolls.json"),
  costs: await loadJson("generated/costs.json"),
  petScore: await loadJson("curated/pet_score.json"),
  pets: await loadJson("generated/pets.json"),
  difficulty: await loadJson("generated/difficulty.json"),
  attributeShards: await loadJson("generated/attributes.json"),
  bestiary: await loadJson("generated/bestiary.json"),
  bestiaryMobs: await loadJson("curated/bestiary_mobs.json"),
  abiphone: await loadJson("generated/abiphone.json"),
  bagUpgrades: await loadJson("curated/accessory_bag_upgrades.json"),
  attributeLevels: await loadJson("curated/attribute_levels.json"),
  attributeApiKeys: await loadJson("curated/attribute_api_keys.json"),
  powerStones: await loadJson("generated/power_stones.json"),
  npcs: await loadJson("generated/npcs.json"),
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
console.log(`  script  ${kb(script.length)}`);
console.log(`  css     ${kb(css.length)}`);
console.log(`  -> dist/skyblock-xp-planner.html  ${kb(html.length)}`);
console.log(apiKey ? "  API key baked in (keep the file private)" : "  no API key baked in — paste one in the UI");
