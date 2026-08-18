import { test } from "node:test";
import assert from "node:assert/strict";
import { coins } from "../src/lib/format";

test("coin shorthand rolls over cleanly at each unit", () => {
  assert.equal(coins(0), "0");
  assert.equal(coins(999), "999");
  assert.equal(coins(1_000), "1.0k");
  assert.equal(coins(9_999), "10.0k");
  assert.equal(coins(40_000), "40k");
  // The boundary that used to print "1000k".
  assert.equal(coins(999_999), "1.0M");
  assert.equal(coins(1_500_000), "1.5M");
  assert.equal(coins(999_999_999), "1.00B");
  assert.equal(coins(1_623_630_175), "1.62B");
  assert.equal(coins(null), "—");
});
