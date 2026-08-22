import { test } from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error - a plain build script, imported for its pure helpers only.
import { gridsFrom, ingredientsFrom, nameFromId, parseSlot, stripColours, untar } from "../scripts/fetch-bazaar-data.mjs";
import { gunzipSync, gzipSync } from "node:zlib";

/**
 * The recipe scraper's parsing, which is where all its bugs were. Every case below is a real NEU
 * item file that the first version of the scraper got wrong, costing a third of the craft list.
 */

test("a colon is a quantity", () => {
  assert.deepEqual(parseSlot("ENCHANTED_CACTUS_GREEN:32"), { id: "ENCHANTED_CACTUS_GREEN", qty: 32 });
  assert.deepEqual(parseSlot("PAPER"), { id: "PAPER", qty: 1 }, "no colon is one item");
  assert.equal(parseSlot(""), null, "an empty slot is empty, not an item");
  assert.equal(parseSlot(undefined), null);
});

test("a hyphenated damage value becomes the bazaar's colon", () => {
  // NEU writes lapis as INK_SACK-4; the bazaar sells it as INK_SACK:4. Getting this wrong lost
  // every recipe built on a vanilla colour variant.
  assert.deepEqual(parseSlot("INK_SACK-4:32"), { id: "INK_SACK:4", qty: 32 });
  assert.deepEqual(parseSlot("INK_SACK-4"), { id: "INK_SACK:4", qty: 1 });
});

test("one ingredient across five slots is one line", () => {
  const grid = {
    A1: "",
    A2: "ENCHANTED_CACTUS_GREEN:32",
    A3: "",
    B1: "ENCHANTED_CACTUS_GREEN:32",
    B2: "ENCHANTED_CACTUS_GREEN:32",
    B3: "ENCHANTED_CACTUS_GREEN:32",
    C1: "",
    C2: "ENCHANTED_CACTUS_GREEN:32",
    C3: "",
  };
  assert.deepEqual(ingredientsFrom(grid), [{ id: "ENCHANTED_CACTUS_GREEN", qty: 160 }]);
});

test("mixed slots keep their own totals", () => {
  const hotPotato = { B2: "PAPER:1", B3: "PAPER:1", C2: "PAPER:1", C3: "ENCHANTED_BAKED_POTATO:1" };
  assert.deepEqual(ingredientsFrom(hotPotato), [
    { id: "PAPER", qty: 3 },
    { id: "ENCHANTED_BAKED_POTATO", qty: 1 },
  ]);
});

test("alternative recipes are all kept, and only the crafting ones", () => {
  // Enchanted Iron is 160 ingots or 160 blocks. Which is cheaper is a price question, so the
  // scraper keeps both and refuses to answer it.
  const item = {
    internalname: "ENCHANTED_IRON",
    recipes: [
      { type: "crafting", B2: "IRON_INGOT:32" },
      { type: "crafting", B2: "IRON_BLOCK:32" },
      { type: "forge", B2: "IRON_INGOT:32" },
      { B2: "IRON_INGOT:32" },
    ],
  };
  const grids = gridsFrom(item);
  assert.equal(grids.length, 3, "two crafting entries plus the untyped one; the forge is dropped");
});

test("a single recipe wins over the alternatives list", () => {
  const item = { recipe: { B2: "PAPER:1" }, recipes: [{ type: "crafting", B2: "STRING:1" }] };
  assert.deepEqual(gridsFrom(item), [{ B2: "PAPER:1" }]);
});

test("an item with no grid at all yields nothing", () => {
  assert.deepEqual(gridsFrom({ internalname: "DIAMOND" }), []);
});

test("the tar walker finds files by name and size", () => {
  const archive = tar([
    ["repo/items/A.json", '{"internalname":"A"}'],
    ["repo/items/B.json", '{"internalname":"B"}'],
  ]);
  const found = [...untar(gunzipped(archive))].map(([name, bytes]) => [name, bytes.toString("utf8")]);
  assert.deepEqual(found, [
    ["repo/items/A.json", '{"internalname":"A"}'],
    ["repo/items/B.json", '{"internalname":"B"}'],
  ]);
});

/** A minimal tar: a 512-byte header per file, then its bytes padded to the next block. */
function tar(files: [string, string][]): Buffer {
  const blocks: Buffer[] = [];
  for (const [name, body] of files) {
    const header = Buffer.alloc(512);
    header.write(name, 0, "utf8");
    header.write(Buffer.byteLength(body).toString(8).padStart(11, "0") + "\0", 124, "utf8");
    blocks.push(header);
    const content = Buffer.alloc(Math.ceil(Buffer.byteLength(body) / 512) * 512);
    content.write(body, 0, "utf8");
    blocks.push(content);
  }
  blocks.push(Buffer.alloc(1024)); // Two zeroed blocks end the archive.
  return Buffer.concat(blocks);
}

/** The scraper gunzips before walking, so the test round-trips the same way. */
function gunzipped(buffer: Buffer): Buffer {
  return gunzipSync(gzipSync(buffer));
}
