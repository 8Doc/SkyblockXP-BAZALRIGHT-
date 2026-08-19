import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * The game data is assembled twice: once by staticData.ts for the server, once by
 * build-html.mjs for the standalone file. Nothing links them, so a field added to one and
 * forgotten in the other type-checks cleanly and then dies at runtime in the build that missed
 * it — which is exactly how the standalone shipped without attributeLevels and threw
 * "Cannot read properties of undefined (reading 'perLevel')" against every profile.
 */
function keysOf(file: string, open: string): string[] {
  const source = readFileSync(file, "utf8");
  const start = source.indexOf(open);
  assert.ok(start >= 0, `${file}: could not find "${open}"`);
  const body = source.slice(start, source.indexOf("\n};", start));
  return [...body.matchAll(/^\s{2,4}(\w+):/gm)].map((m) => m[1]).sort();
}

test("both game-data loaders carry the same fields", () => {
  const server = keysOf("src/lib/staticData.ts", "cached = {");
  const standalone = keysOf("scripts/build-html.mjs", "const gameData = {");

  const missingFromStandalone = server.filter((k) => !standalone.includes(k));
  const missingFromServer = standalone.filter((k) => !server.includes(k));

  assert.deepEqual(missingFromStandalone, [], "the standalone build would load these as undefined");
  assert.deepEqual(missingFromServer, [], "the server would load these as undefined");
  assert.ok(server.length > 10, `only found ${server.length} fields — the parser has drifted`);
});
