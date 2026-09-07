import assert from "node:assert/strict";
import test from "node:test";

import { parseAmount, parseFilter, type FilterKind } from "../src/lib/columnFilter";

/** Shorthand: does this box let this row through? */
function passes(typed: string, kind: FilterKind, value: number, label = ""): boolean {
  const parsed = parseFilter(typed, kind);
  return parsed.state === "ok" ? parsed.test(value, label) : true;
}

test("a figure carries its own scale, however it is typed", () => {
  assert.equal(parseAmount("10m"), 10_000_000);
  assert.equal(parseAmount("10M"), 10_000_000);
  assert.equal(parseAmount("10,000,000"), 10_000_000);
  assert.equal(parseAmount("10000000"), 10_000_000);
  assert.equal(parseAmount("1.5k"), 1_500);
  assert.equal(parseAmount("2b"), 2_000_000_000);
  assert.equal(parseAmount("6.2"), 6.2);
  assert.equal(parseAmount("-5m"), -5_000_000);
  // The "vs usual" column is printed as a percentage, so a player types one back.
  assert.equal(parseAmount("12%"), 12);
});

test("nothing readable is null rather than NaN", () => {
  // NaN would compare false against every row and empty the column, which looks like an answer.
  for (const bad of ["", ">", "abc", "1x", "--", "1.2.3"]) assert.equal(parseAmount(bad), null, bad);
});

test("both comparisons, with or without the equals", () => {
  assert.equal(passes(">10m", "number", 12_000_000), true);
  assert.equal(passes(">10m", "number", 9_000_000), false);
  assert.equal(passes(">10m", "number", 10_000_000), false);
  assert.equal(passes(">=10m", "number", 10_000_000), true);
  assert.equal(passes("<10m", "number", 9_000_000), true);
  assert.equal(passes("<10m", "number", 11_000_000), false);
  assert.equal(passes("<=10m", "number", 10_000_000), true);
});

test("a bare figure asks for at least that much", () => {
  assert.equal(passes("10m", "number", 10_000_000), true);
  assert.equal(passes("10m", "number", 40_000_000), true);
  assert.equal(passes("10m", "number", 900_000), false);
});

test("a dash between two figures is a range, a dash in front is a minus", () => {
  assert.equal(passes("1m-5m", "number", 3_000_000), true);
  assert.equal(passes("1m-5m", "number", 6_000_000), false);
  // Backwards is still a range: nobody means an empty set by "5m-1m".
  assert.equal(passes("5m-1m", "number", 3_000_000), true);
  // Net/day goes negative, so the leading dash has to survive.
  const negative = parseFilter("-5m", "number");
  assert.equal(negative.state, "ok");
  assert.equal(passes("-5m", "number", -1_000_000), true);
  assert.equal(passes("-5m", "number", -9_000_000), false);
});

test("hours are hours, decimals and all", () => {
  const parsed = parseFilter("<6.2", "hours");
  assert.equal(parsed.state === "ok" && parsed.label, "under 6.2 hr");
  assert.equal(passes("<6.2", "hours", 5.9), true);
  assert.equal(passes("<6.2", "hours", 14.8), false);
});

test("yes and no, in whatever case and whatever word", () => {
  for (const yes of ["yes", "YES", "y", "true"]) assert.equal(passes(yes, "boolean", 0, "yes"), true, yes);
  for (const yes of ["yes", "Y"]) assert.equal(passes(yes, "boolean", 0, "no"), false, yes);
  assert.equal(passes("no", "boolean", 0, "no"), true);
  assert.equal(passes("N", "boolean", 0, "yes"), false);
});

test("the sentinels the table sorts on keep behaving as they sort", () => {
  // A ring that never rots has no per-setup total and sorts as the best case, not the worst.
  assert.equal(passes(">10m", "number", Infinity), true);
  // Nothing can price it, so it should not survive a floor.
  assert.equal(passes(">10m", "number", -Infinity), false);
  assert.equal(passes("<10m", "number", -Infinity), true);
});

test("a half-typed filter hides nothing", () => {
  // Mid-keystroke on the way to ">10m". Emptying the table here reads as "no mutation qualifies".
  for (const partial of [">", "<=", "1.", "maybe"]) {
    assert.equal(parseFilter(partial, "number").state, "bad", partial);
    assert.equal(passes(partial, "number", 1), true, partial);
  }
  assert.equal(parseFilter("perhaps", "boolean").state, "bad");
});

test("a name box is a substring, ignoring case", () => {
  assert.equal(passes("noct", "text", 0, "Noctilume"), true);
  assert.equal(passes("LUME", "text", 0, "Noctilume"), true);
  assert.equal(passes("soggy", "text", 0, "Noctilume"), false);
});

test("blank is not a filter", () => {
  assert.equal(parseFilter("", "number").state, "blank");
  assert.equal(parseFilter("   ", "boolean").state, "blank");
});

test("what it read is said back in the words a player used", () => {
  const over = parseFilter(">10000000", "number");
  assert.equal(over.state === "ok" && over.label, "over 10m");
  const under = parseFilter("<1500", "number");
  assert.equal(under.state === "ok" && under.label, "under 1.5k");
  const water = parseFilter("Y", "boolean");
  assert.equal(water.state === "ok" && water.label, "yes");
});
