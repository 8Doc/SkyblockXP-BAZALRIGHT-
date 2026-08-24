import { test } from "node:test";
import assert from "node:assert/strict";
import { packGreenhouse } from "../src/lib/greenhouseLayout";

/**
 * The packing is what decides what the Greenhouse pays, and the whole point of it is that rings
 * are *shared*: two empty cells side by side are fed by one run of support crop. Every figure
 * below was worked out by hand on a 10x10 first — a checkerboard, row stripes at every third row,
 * a spaced lattice — so the search has something to beat rather than only itself to agree with.
 */

const PLOT = { width: 10, height: 10 };

/** What the hand-built patterns manage, edges included. The search must not do worse. */
const HAND = { 1: 60, 2: 60, 3: 48, 4: 36, 6: 16, 8: 16 } as const;

test("the search beats every pattern worked out by hand", () => {
  for (const [required, hand] of Object.entries(HAND)) {
    const p = packGreenhouse({ ...PLOT, requiredCells: Number(required), supportSize: 1, targetSize: 1 });
    assert.ok(
      p.targets >= hand,
      `N=${required}: search found ${p.targets}, hand-built patterns reach ${hand}`,
    );
  }
});

/**
 * The number this whole feature exists to correct. A 3x3 stamp repeated across a hundred cells
 * gives eleven; sharing the ring between neighbours gives seventy for a two-crop condition.
 */
test("sharing the ring beats stamping a 3x3 across the plot", () => {
  const stamped = Math.floor((10 * 10) / 9);
  const packed = packGreenhouse({ ...PLOT, requiredCells: 2, supportSize: 1, targetSize: 1 });
  assert.ok(packed.targets > stamped * 5, `${packed.targets} against ${stamped} stamped`);
});

/** A harder condition costs more support and therefore feeds fewer mutations. Monotone, always. */
test("asking for more of the ring can never feed more mutations", () => {
  let previous = Infinity;
  for (const requiredCells of [1, 2, 3, 4, 5, 6, 7, 8]) {
    const p = packGreenhouse({ ...PLOT, requiredCells, supportSize: 1, targetSize: 1 });
    assert.ok(p.targets <= previous, `N=${requiredCells} fed ${p.targets}, more than N=${requiredCells - 1}`);
    previous = p.targets;
  }
});

/**
 * The counting bound: a support cell lies in at most eight rings, so N support-cells-per-target is
 * a floor on the space they take. A packing above its own ceiling would mean the arithmetic is
 * wrong somewhere, which is worth failing over.
 */
test("no packing exceeds the counting ceiling", () => {
  for (const requiredCells of [1, 2, 3, 4, 6, 8]) {
    for (const targetSize of [1, 2]) {
      const p = packGreenhouse({ ...PLOT, requiredCells, supportSize: 1, targetSize });
      assert.ok(p.targets <= p.ceiling, `N=${requiredCells} m=${targetSize}: ${p.targets} > ceiling ${p.ceiling}`);
    }
  }
});

/** Every target the grid claims must really have its ring fed — the drawing has to match the count. */
test("every target drawn really has the support it needs", () => {
  for (const requiredCells of [1, 3, 6]) {
    const p = packGreenhouse({ ...PLOT, requiredCells, supportSize: 1, targetSize: 1 });
    let drawn = 0;
    for (let r = 0; r < 10; r++) {
      for (let c = 0; c < 10; c++) {
        if (p.grid[r][c] !== "target") continue;
        drawn++;
        let fed = 0;
        for (let dr = -1; dr <= 1; dr++)
          for (let dc = -1; dc <= 1; dc++) {
            if (!dr && !dc) continue;
            const rr = r + dr, cc = c + dc;
            if (rr >= 0 && rr < 10 && cc >= 0 && cc < 10 && p.grid[rr][cc] === "support") fed++;
          }
        assert.ok(fed >= requiredCells, `target at ${r},${c} has ${fed} support, needs ${requiredCells}`);
      }
    }
    assert.equal(drawn, p.targets, "the grid and the count agree");
  }
});

/** Locked cells are the player's own plot rather than a full one, and nothing may be placed on them. */
test("locked cells are never planted and never counted", () => {
  const locked = new Set(["0,0", "0,1", "1,0", "1,1"]);
  const p = packGreenhouse({ ...PLOT, locked, requiredCells: 2, supportSize: 1, targetSize: 1 });
  for (const cell of locked) {
    const [r, c] = cell.split(",").map(Number);
    assert.equal(p.grid[r][c], "locked");
  }
  const full = packGreenhouse({ ...PLOT, requiredCells: 2, supportSize: 1, targetSize: 1 });
  assert.ok(p.targets < full.targets, "a smaller plot grows fewer");
});

/**
 * A 2x2 mutation needs 2x2 of room *and* has a twelve-cell ring rather than an eight-cell one, so
 * it is doubly expensive — which is why the big legendaries pack so much worse than their drops
 * suggest.
 */
test("a bigger mutation fits fewer times than a small one", () => {
  const small = packGreenhouse({ ...PLOT, requiredCells: 4, supportSize: 1, targetSize: 1 });
  const big = packGreenhouse({ ...PLOT, requiredCells: 4, supportSize: 1, targetSize: 2 });
  assert.ok(big.targets < small.targets, `${big.targets} against ${small.targets}`);
});

/** A missing size must not read as "nothing fits" — NaN does not throw, it just quietly zeroes. */
test("a missing plant size is treated as one rather than as NaN", () => {
  const p = packGreenhouse({
    ...PLOT,
    requiredCells: 2,
    supportSize: undefined as unknown as number,
    targetSize: undefined as unknown as number,
  });
  assert.ok(p.targets > 0, "a missing field must not silently mean zero");
});
