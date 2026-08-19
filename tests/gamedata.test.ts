import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * The standalone build inlines its game data by hand, listing each file in build-html.mjs, while
 * the code consumes it through the GameData type. Nothing connects the two: add a field to the
 * type, load it everywhere it's used, forget the one line in the builder, and it type-checks
 * cleanly and then dies at runtime against every profile — which is exactly how the app once
 * shipped without attributeLevels and threw "Cannot read properties of undefined".
 *
 * So the type and the loader are compared field by field.
 */
function fieldsOf(file: string, open: string, close: string, pattern: RegExp): string[] {
  const source = readFileSync(file, "utf8");
  const start = source.indexOf(open);
  assert.ok(start >= 0, `${file}: could not find "${open}"`);
  const body = source.slice(start, source.indexOf(close, start));
  return [...body.matchAll(pattern)].map((m) => m[1]).sort();
}

test("the standalone loader carries every field GameData declares", () => {
  const declared = fieldsOf("src/lib/gameData.ts", "export type GameData = {", "\n};", /^ {2}(\w+):/gm);
  const loaded = fieldsOf("scripts/build-html.mjs", "const gameData = {", "\n};", /^ {2}(\w+):/gm);

  assert.ok(declared.length > 10, `only found ${declared.length} fields — the parser has drifted`);
  assert.deepEqual(
    declared.filter((f) => !loaded.includes(f)),
    [],
    "declared on GameData but never loaded — these read as undefined at runtime",
  );
  assert.deepEqual(
    loaded.filter((f) => !declared.includes(f)),
    [],
    "loaded into the bundle but not on GameData — dead weight in the HTML",
  );
});

test("every data file the loader names is actually present", () => {
  const source = readFileSync("scripts/build-html.mjs", "utf8");
  const paths = [...source.matchAll(/loadJson\("([^"]+)"\)/g)].map((m) => m[1]);
  assert.ok(paths.length > 10, `only found ${paths.length} data files`);
  for (const path of paths) {
    assert.doesNotThrow(() => readFileSync(`data/${path}`), `data/${path} is named by the builder but missing`);
  }
});
