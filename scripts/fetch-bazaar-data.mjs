/**
 * The two static tables the bazaar tab needs: crafting recipes, and a name for every product.
 *
 * Both come out of one 9MB download, which is the only reason they share a script.
 *
 * Hypixel publishes a 5MB item resource with 5,646 items in it and exactly one recipe, so the
 * recipes have to come from somewhere else. NotEnoughUpdates' repo is the community's mirror of
 * them: one JSON file per item, each carrying a 3×3 grid as `A1`–`C3` with values shaped
 * `INTERNALNAME:count`.
 *
 * The whole repo arrives as a single 9MB tarball, which is one request instead of the couple of
 * thousand it would take to ask for the bazaar's items one at a time — and a tar is simple
 * enough to walk in forty lines, so this stays dependency-free like the rest of the build.
 *
 * Three shapes have to be handled, and missing any one of them costs a third of the list:
 *
 *   - `recipe`, a single grid. The common case.
 *   - `recipes`, an array of alternatives — Enchanted Iron is 160 ingots *or* 160 blocks — of
 *     which only `type: "crafting"` entries are ours. Every alternative is kept, because which
 *     one is cheapest is a question for the price layer, not for the scraper.
 *   - `overrideOutputId` and `count`, for recipes that don't make one of what they're filed under.
 *
 * Ingredient ids need translating too: NEU writes vanilla damage values as `INK_SACK-4` where the
 * bazaar calls the same item `INK_SACK:4`.
 *
 * Recipes are kept whole even when an ingredient does not trade on the bazaar — Paper and Blaze
 * Powder are shop goods, not bazaar goods, and dropping their recipes would lose Hot Potato Books
 * and Enchanted Eyes of Ender, both of which are real crafts. They are listed in
 * `offBazaarIngredients` instead, which is the shopping list for the NPC price table.
 *
 * The names are a three-source merge, because no single source covers the bazaar. Hypixel's item
 * resource names 1,018 of the 2,124 products; NEU's `displayname` (minus its colour codes) covers
 * most of the rest; and the last 1,094 are enchantments and shards, which no catalogue lists but
 * whose ids spell out their own names. skyblock.bz falls back to a naive title-case there and
 * ends up with "Shard Wiki Tiki"; the game calls it a Wiki Tiki Shard, and so do we.
 *
 * Writes data/generated/recipes.json and data/generated/bazaar_items.json.
 */
import { writeFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const NEU = "https://codeload.github.com/NotEnoughUpdates/NotEnoughUpdates-REPO/tar.gz/refs/heads/master";
const BAZAAR = "https://api.hypixel.net/v2/skyblock/bazaar";
const ITEMS = "https://api.hypixel.net/v2/resources/skyblock/items";

/** The nine grid slots, in the order the game draws them. */
const SLOTS = ["A1", "A2", "A3", "B1", "B2", "B3", "C1", "C2", "C3"];

/**
 * Walk a tar archive, yielding `[path, bytes]`.
 *
 * Tar is 512-byte blocks: a header naming the next file and its size, then the file rounded up
 * to the next block boundary. Everything past the name and the size is metadata we don't need.
 */
export function* untar(buffer) {
  let offset = 0;
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512);
    const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
    if (!name) break; // Two zeroed blocks mark the end of the archive.

    // Size is octal, space- or null-padded, in bytes 124-135.
    const size = parseInt(header.subarray(124, 136).toString("utf8").replace(/\0.*$/, "").trim(), 8) || 0;
    const start = offset + 512;
    yield [name, buffer.subarray(start, start + size)];
    offset = start + Math.ceil(size / 512) * 512;
  }
}

/**
 * "ENCHANTED_CACTUS_GREEN:32" -> { id, qty }.
 *
 * The colon is a quantity. A damage value, when there is one, is attached to the id with a
 * hyphen — `INK_SACK-4:32` is thirty-two lapis — and the bazaar writes that same item with a
 * colon, so the hyphen becomes one on the way through.
 */
export function parseSlot(value) {
  if (!value) return null;
  const [name, count] = String(value).split(":");
  if (!name) return null;
  const qty = Number(count ?? 1);
  if (!Number.isFinite(qty) || qty <= 0) return null;
  return { id: name.replace(/-(\d+)$/, ":$1"), qty };
}

/** A grid into a summed ingredient list. The same item in five slots is one line of 160. */
export function ingredientsFrom(grid) {
  const totals = new Map();
  for (const slot of SLOTS) {
    const parsed = parseSlot(grid[slot]);
    if (!parsed) continue;
    totals.set(parsed.id, (totals.get(parsed.id) ?? 0) + parsed.qty);
  }
  return [...totals].map(([id, qty]) => ({ id, qty }));
}

/** Every crafting grid an item file offers, single or alternatives, in one list. */
export function gridsFrom(item) {
  if (item.recipe) return [item.recipe];
  if (!Array.isArray(item.recipes)) return [];
  // `type` is absent on older entries and means crafting; anything that names something else —
  // forge, fusion, trade — is a different machine and does not price like a craft.
  return item.recipes.filter((r) => !r.type || r.type === "crafting");
}


/** Minecraft colour codes, which are formatting rather than name. */
export function stripColours(name) {
  return name.replace(/§./g, "").trim();
}

/**
 * A readable name worked out from the id alone, for the enchantments and shards no catalogue
 * carries. `ENCHANTMENT_ULTIMATE_CROP_FEVER_5` is Ultimate Crop Fever 5; `SHARD_WIKI_TIKI` is a
 * Wiki Tiki Shard, not a "Shard Wiki Tiki".
 */
export function nameFromId(id) {
  const [base, damage] = id.split(":");
  const enchant = /^ENCHANTMENT_(.+)_(\d+)$/.exec(base);
  if (enchant) return `${titleCase(enchant[1])} ${enchant[2]}`;

  const suffixed = /^(SHARD|ESSENCE|RUNE)_(.+)$/.exec(base);
  if (suffixed) return `${titleCase(suffixed[2])} ${titleCase(suffixed[1])}`;

  const plain = titleCase(base);
  // A damage value is a different item — Ink Sack 4 is lapis — so it has to survive into the name.
  return damage ? `${plain} ${damage}` : plain;
}

function titleCase(slug) {
  return slug
    .split("_")
    .filter(Boolean)
    .map((word) => word.charAt(0) + word.slice(1).toLowerCase())
    .join(" ");
}

async function main() {
  process.stdout.write("Reading the bazaar's product list… ");
  const bazaar = await (await fetch(BAZAAR)).json();
  const tradeable = new Set(Object.keys(bazaar.products));
  console.log(`${tradeable.size} products`);

  process.stdout.write("Downloading the NEU repo… ");
  const tarball = Buffer.from(await (await fetch(NEU)).arrayBuffer());
  console.log(`${(tarball.length / 1e6).toFixed(1)}MB`);

  const recipes = [];
  const neuNames = new Map();
  const offBazaar = new Map();
  let files = 0;
  let noGrid = 0;
  let notTradeable = 0;

  for (const [path, bytes] of untar(gunzipSync(tarball))) {
    if (!/\/items\/[^/]+\.json$/.test(path)) continue;
    files++;

    let item;
    try {
      item = JSON.parse(bytes.toString("utf8"));
    } catch {
      continue; // One malformed file shouldn't cost the other eight thousand.
    }

    if (item.internalname && item.displayname) neuNames.set(item.internalname, stripColours(item.displayname));

    const grids = gridsFrom(item);
    if (grids.length === 0) {
      noGrid++;
      continue;
    }

    for (const grid of grids) {
      const output = grid.overrideOutputId ?? item.internalname;
      if (!tradeable.has(output)) {
        notTradeable++;
        continue;
      }

      const ingredients = ingredientsFrom(grid);
      if (ingredients.length === 0) continue;

      const missing = ingredients.filter((i) => !tradeable.has(i.id)).map((i) => i.id);
      for (const id of missing) offBazaar.set(id, (offBazaar.get(id) ?? 0) + 1);

      recipes.push({
        output,
        yield: Number(grid.count ?? 1) || 1,
        ingredients,
        // Named rather than implied, so the price layer fails loudly on a recipe it can't cost
        // rather than quietly pricing it at whatever the bazaar happens to know about.
        ...(missing.length ? { offBazaar: missing } : {}),
      });
    }
  }

  recipes.sort((a, b) => a.output.localeCompare(b.output) || a.ingredients[0].id.localeCompare(b.ingredients[0].id));

  const priceable = recipes.filter((r) => !r.offBazaar);
  const payload = {
    generatedAt: new Date().toISOString(),
    source: "https://github.com/NotEnoughUpdates/NotEnoughUpdates-REPO",
    note:
      "Crafting-grid recipes whose output trades on the bazaar. Alternatives are all kept; the " +
      "price layer picks the cheapest. `offBazaar` names ingredients the bazaar does not sell, " +
      "which need a shop price before that recipe can be costed. Forge and fusion are not carried.",
    /** Ingredients no bazaar price exists for, and how many recipes are waiting on each. */
    offBazaarIngredients: Object.fromEntries([...offBazaar].sort((a, b) => b[1] - a[1])),
    recipes,
  };

  await writeFile(join(ROOT, "data/generated/recipes.json"), JSON.stringify(payload, null, 2) + "\n");

  await writeNames([...tradeable], neuNames);

  console.log(`${files} item files -> ${recipes.length} recipes for ${new Set(recipes.map((r) => r.output)).size} items.`);
  console.log(`${priceable.length} price from the bazaar alone; ${recipes.length - priceable.length} need a shop price.`);
  console.log(`${noGrid} items have no crafting grid; ${notTradeable} grids make something the bazaar doesn't trade.`);
  console.log(`${offBazaar.size} distinct ingredients need shop prices.`);
}


/** Every bazaar product's display name, best source first. */
async function writeNames(ids, neuNames) {
  const resource = await (await fetch(ITEMS)).json();
  const hypixel = new Map(resource.items.map((i) => [i.id, i.name]));

  const names = {};
  const from = { hypixel: 0, neu: 0, id: 0 };
  for (const id of ids.sort()) {
    const official = hypixel.get(id);
    const neu = neuNames.get(id);
    if (official) from.hypixel++;
    else if (neu) from.neu++;
    else from.id++;
    names[id] = official ?? neu ?? nameFromId(id);
  }

  await writeFile(
    join(ROOT, "data/generated/bazaar_items.json"),
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        source: `${ITEMS} + NEU displaynames + the ids themselves`,
        names,
      },
      null,
      2,
    ) + "\n",
  );

  console.log(`${ids.length} names: ${from.hypixel} from Hypixel, ${from.neu} from NEU, ${from.id} read off the id.`);
}

// Run when invoked directly; the helpers above stay exported so the tests can reach them without
// downloading nine megabytes. Two details, both learned the hard way: `import.meta.url` and
// `argv[1]` disagree about Windows paths, and a top-level `await` here stops the test runner
// transpiling the file at all.
if (process.argv[1]?.endsWith("fetch-bazaar-data.mjs")) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
