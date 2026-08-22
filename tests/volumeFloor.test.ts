import { test } from "node:test";
import assert from "node:assert/strict";
import { VOLUME_LADDER, ladderIndex, volumeNote } from "../src/lib/volumeFloor";

/**
 * The volume floor's slider. It replaced a linear 0–200 control, which spent nine tenths of its
 * travel below ten an hour and could not express "a thousand" at all.
 */

test("the ladder climbs, and reaches both ends of the market", () => {
  for (let i = 1; i < VOLUME_LADDER.length; i++) {
    assert.ok(VOLUME_LADDER[i] > VOLUME_LADDER[i - 1], `stop ${i} should be above the one below it`);
  }
  assert.equal(VOLUME_LADDER[0], 0, "the first stop is off");
  assert.ok(VOLUME_LADDER.at(-1)! >= 100_000, "the last reaches the busiest items on the bazaar");
  // Five stops a decade, so the resolution is where the decisions are rather than spread evenly.
  assert.equal(VOLUME_LADDER.filter((v) => v >= 1 && v < 10).length, 5);
  assert.equal(VOLUME_LADDER.filter((v) => v >= 10 && v < 100).length, 5);
});

test("a remembered setting lands back on its own notch", () => {
  for (const [index, stop] of VOLUME_LADDER.entries()) {
    assert.equal(ladderIndex(stop), index, `${stop} should map back to stop ${index}`);
  }
  assert.equal(VOLUME_LADDER[ladderIndex(4)], 3, "a value between stops falls to the one below");
  assert.equal(VOLUME_LADDER[ladderIndex(999_999)], 100_000, "and past the end it stops at the end");
  assert.equal(ladderIndex(-1), 0, "nonsense lands on off rather than off the end");
});

test("the floor reads as a wait, because a wait is the thing you are choosing", () => {
  assert.equal(volumeNote(0), "off");
  assert.equal(volumeNote(1), "1/hr · one an hour");
  assert.equal(volumeNote(3), "3/hr · one every 20 min");
  assert.equal(volumeNote(50), "50/hr · one a minute");
  // Past about one and a half a minute the rate is the readable half of the pair. Rounding the
  // wait all the way up would have a hundred an hour reading as one a minute.
  assert.equal(volumeNote(100), "100/hr · 2 a minute");
  assert.equal(volumeNote(10_000), "10,000/hr · 167 a minute");
});
