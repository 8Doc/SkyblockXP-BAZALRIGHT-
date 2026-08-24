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
    const p = packGreenhouse({ ...PLOT, requires: [{ cells: Number(required), size: 1 }], targetSize: 1 });
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
  const packed = packGreenhouse({ ...PLOT, requires: [{ cells: 2, size: 1 }], targetSize: 1 });
  assert.ok(packed.targets > stamped * 5, `${packed.targets} against ${stamped} stamped`);
});

/** A harder condition costs more support and therefore feeds fewer mutations. Monotone, always. */
test("asking for more of the ring can never feed more mutations", () => {
  let previous = Infinity;
  for (const requiredCells of [1, 2, 3, 4, 5, 6, 7, 8]) {
    const p = packGreenhouse({ ...PLOT, requires: [{ cells: requiredCells, size: 1 }], targetSize: 1 });
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
      const p = packGreenhouse({ ...PLOT, requires: [{ cells: requiredCells, size: 1 }], targetSize });
      assert.ok(p.targets <= p.ceiling, `N=${requiredCells} m=${targetSize}: ${p.targets} > ceiling ${p.ceiling}`);
    }
  }
});

/** Every target the grid claims must really have its ring fed — the drawing has to match the count. */
test("every target drawn really has the support it needs", () => {
  for (const requiredCells of [1, 3, 6]) {
    const p = packGreenhouse({ ...PLOT, requires: [{ cells: requiredCells, size: 1 }], targetSize: 1 });
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
            if (rr >= 0 && rr < 10 && cc >= 0 && cc < 10 && typeof p.grid[rr][cc] === "number") fed++;
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
  const p = packGreenhouse({ ...PLOT, locked, requires: [{ cells: 2, size: 1 }], targetSize: 1 });
  for (const cell of locked) {
    const [r, c] = cell.split(",").map(Number);
    assert.equal(p.grid[r][c], "locked");
  }
  const full = packGreenhouse({ ...PLOT, requires: [{ cells: 2, size: 1 }], targetSize: 1 });
  assert.ok(p.targets < full.targets, "a smaller plot grows fewer");
});

/**
 * A 2x2 mutation needs 2x2 of room *and* has a twelve-cell ring rather than an eight-cell one, so
 * it is doubly expensive — which is why the big legendaries pack so much worse than their drops
 * suggest.
 */
test("a bigger mutation fits fewer times than a small one", () => {
  const small = packGreenhouse({ ...PLOT, requires: [{ cells: 4, size: 1 }], targetSize: 1 });
  const big = packGreenhouse({ ...PLOT, requires: [{ cells: 4, size: 1 }], targetSize: 2 });
  assert.ok(big.targets < small.targets, `${big.targets} against ${small.targets}`);
});

/** A missing size must not read as "nothing fits" — NaN does not throw, it just quietly zeroes. */
test("a missing plant size is treated as one rather than as NaN", () => {
  const p = packGreenhouse({
    ...PLOT,
    requires: [{ cells: 2, size: undefined as unknown as number }],
    targetSize: undefined as unknown as number,
  });
  assert.ok(p.targets > 0, "a missing field must not silently mean zero");
});

/**
 * A condition is a conjunction, and this is the test that would have caught reading it as a
 * choice. Needing four of one crop *and* four of another is strictly harder than needing four of
 * either, so it must never feed more targets — reading the slash as "or" made every such mutation
 * look twice as cheap and twice as dense as it is.
 */
test("needing two crops at once is harder than needing either alone", () => {
  const both = packGreenhouse({ ...PLOT, requires: [{ cells: 4, size: 1 }, { cells: 4, size: 1 }], targetSize: 1 });
  const one = packGreenhouse({ ...PLOT, requires: [{ cells: 4, size: 1 }], targetSize: 1 });
  assert.ok(both.targets <= one.targets, `${both.targets} with both against ${one.targets} with one`);
  assert.ok(both.plants.length === 2 && both.plants.every((n) => n > 0), "and both crops really get planted");
});

/** Every clause has to hold at the *same* target, not merely somewhere on the plot. */
test("every target satisfies every clause at once", () => {
  const requires = [{ cells: 3, size: 1 }, { cells: 2, size: 1 }];
  const p = packGreenhouse({ ...PLOT, requires, targetSize: 1 });
  assert.ok(p.targets > 0);
  for (let r = 0; r < 10; r++) {
    for (let c = 0; c < 10; c++) {
      if (p.grid[r][c] !== "target") continue;
      const fed = [0, 0];
      for (let dr = -1; dr <= 1; dr++)
        for (let dc = -1; dc <= 1; dc++) {
          if (!dr && !dc) continue;
          const rr = r + dr, cc = c + dc;
          if (rr < 0 || rr >= 10 || cc < 0 || cc >= 10) continue;
          const cell = p.grid[rr][cc];
          if (typeof cell === "number") fed[cell]++;
        }
      assert.ok(fed[0] >= 3 && fed[1] >= 2, `target ${r},${c} has ${fed} against [3,2]`);
    }
  }
});

/**
 * The hardest condition in the game: Snoozling is 3x3, so its ring is sixteen cells, and it wants
 * them split between five different crops. A tile search cannot express that within any sane
 * pattern budget and returned nothing at all; giving each mutation its own private ring and tiling
 * those 5x5 blocks is both valid and what a player would build.
 */
test("a condition too tight to tile still gets an answer", () => {
  const p = packGreenhouse({
    ...PLOT,
    requires: [4, 3, 3, 3, 3].map((cells) => ({ cells, size: 1 })),
    targetSize: 3,
  });
  assert.equal(p.targets, 4, "four 5x5 blocks tile a 10x10 exactly");
  assert.equal(p.plants.reduce((a, b) => a + b, 0), 64, "sixteen ring cells apiece");
});
