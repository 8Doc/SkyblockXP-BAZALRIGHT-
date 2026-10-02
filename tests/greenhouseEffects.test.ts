import { test } from "node:test";
import assert from "node:assert/strict";

import {
  effectsAtTargets,
  effectsOf,
  inForce,
  rollsBounty,
  sharedEffects,
  xpModifier,
  yieldModifier,
  type CropEffect,
} from "../src/lib/greenhouseEffects";
import { packGreenhouse } from "../src/lib/greenhouseLayout";
import greenhouseJson from "../data/generated/greenhouse.json";
import type { GreenhouseData, Mutation } from "../src/lib/greenhouse";

const data = greenhouseJson as unknown as GreenhouseData;
const byId = new Map(data.mutations.map((m) => [m.id, m]));
const named = (name: string) => data.mutations.find((m) => m.name === name);

test("a plant grants every effect it has, not the first one found", () => {
  // The bug this replaces: the reader returned on the first match, so Shellfruit — which retains
  // water *and* grants immunity — was granting only the water, everywhere, silently.
  const shellfruit = effectsOf(named("Shellfruit"));
  assert.ok(shellfruit.has("water-retain"));
  assert.ok(shellfruit.has("immunity"), "and the immunity it was dropping");
  assert.equal(shellfruit.size, 2);
});

test("improved is told from plain, not matched inside it", () => {
  // "Improved Water Retain" contains "Water Retain", so a substring match reads one plant as
  // granting both and then treats the pair as the stronger of the two for free.
  const shadevine = effectsOf(named("Shadevine"));
  assert.ok(shadevine.has("improved-water-retain"));
  assert.equal(shadevine.has("water-retain"), false);
});

test("nothing, and nothing recognisable, come out empty", () => {
  assert.equal(effectsOf(undefined).size, 0);
  assert.equal(effectsOf({ effects: [] }).size, 0);
  // The scrape stores a literal "None" for the mutation with no effects.
  assert.equal(effectsOf({ effects: ["None"] }).size, 0);
  assert.equal(effectsOf({ effects: ["Something Invented"] }).size, 0);
});

test("yield moves with the ring, and only the improved one of a pair counts", () => {
  const buffs = { harvestBoost: 0.2, improvedHarvestBoost: 0.3, harvestLoss: -0.2 };
  const ring = (...e: CropEffect[]) => new Set<CropEffect>(e);
  assert.equal(yieldModifier(ring(), buffs), 1);
  assert.equal(yieldModifier(ring("harvest-boost"), buffs), 1.2);
  assert.equal(yieldModifier(ring("improved-harvest-boost"), buffs), 1.3);
  // Ticks, not a tally: two neighbours boosting is the same tick as one.
  assert.equal(yieldModifier(ring("harvest-boost", "harvest-boost"), buffs), 1.2);
  // Improved replaces plain rather than adding to it.
  assert.equal(yieldModifier(ring("harvest-boost", "improved-harvest-boost"), buffs), 1.3);
  // A loss applies alongside a boost, and an immunity cancels the loss alone.
  assert.ok(Math.abs(yieldModifier(ring("harvest-loss"), buffs) - 0.8) < 1e-9);
  assert.ok(Math.abs(yieldModifier(ring("improved-harvest-boost", "harvest-loss"), buffs) - 1.1) < 1e-9);
  assert.equal(yieldModifier(ring("improved-harvest-boost", "harvest-loss", "immunity"), buffs), 1.3);
  assert.equal(yieldModifier(ring("immunity"), buffs), 1, "immunity alone buys nothing");
});

test("immunity cancels the negatives and leaves the positives alone", () => {
  const ring = new Set<CropEffect>(["harvest-loss", "xp-loss", "water-drain", "harvest-boost", "immunity"]);
  assert.equal(inForce(ring, "harvest-loss"), false);
  assert.equal(inForce(ring, "xp-loss"), false);
  assert.equal(inForce(ring, "water-drain"), false);
  assert.equal(inForce(ring, "harvest-boost"), true);
  assert.equal(inForce(ring, "bonus-drops"), false, "not in the ring at all");
});

test("farming XP has its own pair, read the same way", () => {
  const buffs = { xpBoost: 0.2, improvedXpBoost: 0.3, xpLoss: -0.2 };
  assert.equal(xpModifier(new Set<CropEffect>(["improved-xp-boost"]), buffs), 1.3);
  assert.ok(Math.abs(xpModifier(new Set<CropEffect>(["xp-loss"]), buffs) - 0.8) < 1e-9);
  assert.equal(xpModifier(new Set<CropEffect>(["xp-loss", "immunity"]), buffs), 1);
});

test("the bounty is behind one effect, not free", () => {
  assert.equal(rollsBounty(new Set<CropEffect>()), false);
  assert.equal(rollsBounty(new Set<CropEffect>(["harvest-boost"])), false);
  assert.equal(rollsBounty(new Set<CropEffect>(["bonus-drops"])), true);
});

test("effects reach orthogonally and not across a corner", () => {
  // A ring that satisfies a condition does not necessarily reach the mutation: the condition counts
  // the corners and an effect does not.
  const m = named("Phantomleaf")!;
  const requires = m.spreading.requires.map((r) => ({ cells: r.cells, size: byId.get(r.id)?.size ?? 1 }));
  const packing = packGreenhouse({ width: 10, height: 10, requires, targetSize: m.size });
  const rings = effectsAtTargets(m.spreading.requires, (id) => byId.get(id), packing, m.size);
  assert.equal(rings.length, packing.targets, "one set per mutation");

  // Shellfruit is half of Phantomleaf's ring and grants Water Retain and Immunity; Chorus Fruit is
  // the other half and grants Improved XP Boost and Harvest Loss. Whatever lands orthogonally has
  // to be a subset of those two.
  const possible = new Set<CropEffect>([...effectsOf(named("Shellfruit")), ...effectsOf(named("Chorus Fruit"))]);
  for (const ring of rings) for (const effect of ring) assert.ok(possible.has(effect), `${effect} came from nowhere`);
});

test("the plot's figure is what every mutation sees, not what any of them does", () => {
  const a = new Set<CropEffect>(["harvest-boost", "immunity"]);
  const b = new Set<CropEffect>(["harvest-boost"]);
  assert.deepEqual([...sharedEffects([a, b])], ["harvest-boost"]);
  assert.deepEqual([...sharedEffects([a, a])].sort(), ["harvest-boost", "immunity"]);
  assert.deepEqual([...sharedEffects([])], []);
  // One mutation missing the boost is enough to keep it out of a figure quoted for the plot.
  assert.deepEqual([...sharedEffects([a, b, new Set<CropEffect>()])], []);
});

test("a real plot comes out with effects that are actually in it", () => {
  let lifted = 0;
  let cut = 0;
  for (const m of data.mutations) {
    if (!m.spreading.requires.length) continue;
    const requires = m.spreading.requires.map((r) => ({ cells: r.cells, size: byId.get(r.id)?.size ?? 1 }));
    const packing = packGreenhouse({ width: 10, height: 10, requires, targetSize: m.size });
    if (packing.targets === 0) continue;
    const shared = sharedEffects(effectsAtTargets(m.spreading.requires, (id) => byId.get(id), packing, m.size));
    const yielded = yieldModifier(shared, data.yieldBuffs ?? {});
    assert.ok(yielded >= 0.8 && yielded <= 1.3, `${m.name} yields ${yielded}`);
    if (yielded > 1) lifted++;
    if (yielded < 1) cut++;
  }
  // Both happen, which is the whole reason it is worth reading rather than assuming.
  assert.ok(lifted > 0, "some rings lift the harvest");
  assert.ok(cut > 0, "and some cut it");
});
