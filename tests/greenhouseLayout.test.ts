import { test } from "node:test";
import assert from "node:assert/strict";
import { packGreenhouse, type CellKind, type Packing, type Requirement } from "../src/lib/greenhouseLayout";

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

/* ------------------------------------------------- what the ring costs, not just how big it is */

/** Plants of one requirement, rebuilt from the drawn grid: the top-left of each size x size block. */
function plantsOf(grid: CellKind[][], req: number, size: number): [number, number][] {
  const seen = new Set<string>();
  const out: [number, number][] = [];
  for (let r = 0; r < grid.length; r++) {
    for (let c = 0; c < grid[0].length; c++) {
      if (grid[r][c] !== req || seen.has(`${r},${c}`)) continue;
      let whole = true;
      for (let rr = r; rr < r + size && whole; rr++)
        for (let cc = c; cc < c + size && whole; cc++)
          if (rr >= grid.length || cc >= grid[0].length || grid[rr][cc] !== req || seen.has(`${rr},${cc}`)) whole = false;
      if (!whole) continue;
      for (let rr = r; rr < r + size; rr++) for (let cc = c; cc < c + size; cc++) seen.add(`${rr},${cc}`);
      out.push([r, c]);
    }
  }
  return out;
}

/** Every cell that is in some target's ring. */
function ringCells(grid: CellKind[][], m: number): Set<string> {
  const ring = new Set<string>();
  for (let r = 0; r < grid.length; r++) {
    for (let c = 0; c < grid[0].length; c++) {
      if (grid[r][c] !== "target") continue;
      for (let rr = r - 1; rr <= r + m; rr++)
        for (let cc = c - 1; cc <= c + m; cc++) {
          const inTarget = rr >= r && rr < r + m && cc >= c && cc < c + m;
          if (!inTarget) ring.add(`${rr},${cc}`);
        }
    }
  }
  return ring;
}

test("nothing is planted where no mutation can reach it", () => {
  // A periodic tile does not divide a 10x10 evenly, and what was left over used to be bought and
  // priced: 18% of everything planted across the forty, and 71% of Stoplight Petal's ring.
  const cases: [Requirement[], number][] = [
    [[{ cells: 4, size: 1 }, { cells: 4, size: 1 }], 1],
    [[{ cells: 5, size: 1 }, { cells: 3, size: 1 }], 1],
    [[{ cells: 6, size: 1 }, { cells: 6, size: 1 }], 2],
    [[{ cells: 4, size: 3 }, { cells: 4, size: 2 }], 1],
  ];
  for (const [requires, targetSize] of cases) {
    const p = packGreenhouse({ ...PLOT, requires, targetSize });
    const ring = ringCells(p.grid, targetSize);
    for (let i = 0; i < requires.length; i++) {
      for (const [r, c] of plantsOf(p.grid, i, requires[i].size)) {
        let useful = false;
        for (let rr = r; rr < r + requires[i].size && !useful; rr++)
          for (let cc = c; cc < c + requires[i].size && !useful; cc++)
            if (ring.has(`${rr},${cc}`)) useful = true;
        assert.ok(useful, `a plant at ${r},${c} feeds nothing`);
      }
    }
  }
});

test("no single plant can be taken out and still leave every mutation fed", () => {
  // The pruning is greedy, so it is not minimal in general — but it is minimal against removing
  // one plant at a time, which is the claim worth pinning. A plant it rejected can never become
  // removable later, because every later removal only lowers what the rings hold.
  const requires = [{ cells: 4, size: 1 }, { cells: 4, size: 1 }];
  const p = packGreenhouse({ ...PLOT, requires, targetSize: 1 });
  const targets: [number, number][] = [];
  for (let r = 0; r < 10; r++) for (let c = 0; c < 10; c++) if (p.grid[r][c] === "target") targets.push([r, c]);
  assert.ok(targets.length > 0);

  for (let i = 0; i < requires.length; i++) {
    for (const [pr, pc] of plantsOf(p.grid, i, 1)) {
      // Every target that would drop below its clause if this one plant went away.
      let stillFine = true;
      for (const [tr, tc] of targets) {
        let fed = 0;
        for (let dr = -1; dr <= 1; dr++)
          for (let dc = -1; dc <= 1; dc++) {
            if (!dr && !dc) continue;
            const rr = tr + dr, cc = tc + dc;
            if (rr < 0 || rr >= 10 || cc < 0 || cc >= 10) continue;
            if (p.grid[rr][cc] === i && !(rr === pr && cc === pc)) fed++;
          }
        const touches = Math.abs(pr - tr) <= 1 && Math.abs(pc - tc) <= 1;
        if (touches && fed < requires[i].cells) stillFine = false;
      }
      assert.equal(stillFine, false, `the plant at ${pr},${pc} is spare and was left in`);
    }
  }
});

test("pruning never costs a mutation", () => {
  // It only ever removes a plant no target needs, so the count it was measured against has to
  // survive it. The reported figure is what came out, not what went in.
  for (const requires of [
    [{ cells: 4, size: 1 }, { cells: 4, size: 1 }],
    [{ cells: 6, size: 1 }, { cells: 2, size: 1 }],
    [{ cells: 3, size: 1 }],
  ]) {
    const p = packGreenhouse({ ...PLOT, requires, targetSize: 1 });
    assert.ok(p.targets > 0);
    assert.ok(p.pruned >= 0);
    assert.equal(
      p.cells.reduce((a, b) => a + b, 0),
      p.plants.reduce((a, b, i) => a + b * requires[i].size ** 2, 0),
      "the cell counts match the plants that survived",
    );
  }
});

test("told what a plant costs, it buys fewer of the dear one", () => {
  // Devourer's shape: four ring cells of a 758k mutation and four of a 3k one. Both arrangements
  // grow sixteen and both plant seventy-five things, so nothing but the price can separate them —
  // and the difference between them is a 38M ring and a 19M one.
  const requires = [{ cells: 4, size: 1 }, { cells: 4, size: 1 }];
  const flat = packGreenhouse({ ...PLOT, requires, targetSize: 1 });
  const priced = packGreenhouse({ ...PLOT, requires, targetSize: 1, weights: [1, 0.004] });

  assert.equal(priced.targets, flat.targets, "the same number still grows");
  assert.ok(priced.plants[0] < flat.plants[0], "fewer of the expensive one");
  const bill = (p: Packing) => p.plants[0] * 758_000 + p.plants[1] * 3_000;
  assert.ok(bill(priced) < bill(flat) * 0.8, `${bill(priced)} against ${bill(flat)}`);
});

test("with the prices the other way round, so is the answer", () => {
  // The weights are read, not a coincidence of which clause came first.
  const requires = [{ cells: 4, size: 1 }, { cells: 4, size: 1 }];
  const dearFirst = packGreenhouse({ ...PLOT, requires, targetSize: 1, weights: [1, 0.05] });
  const dearSecond = packGreenhouse({ ...PLOT, requires, targetSize: 1, weights: [0.05, 1] });
  assert.ok(dearFirst.plants[0] < dearFirst.plants[1]);
  assert.ok(dearSecond.plants[1] < dearSecond.plants[0]);
});

test("weights change what is bought, never what grows", () => {
  // The point of the tie-break is that it is a tie-break: it chooses among arrangements that were
  // already equal on the only thing that pays, and must never trade a mutation away for a discount.
  for (const requires of [
    [{ cells: 4, size: 1 }, { cells: 4, size: 1 }],
    [{ cells: 5, size: 1 }, { cells: 3, size: 1 }],
    [{ cells: 3, size: 1 }, { cells: 3, size: 1 }, { cells: 2, size: 1 }],
  ]) {
    const flat = packGreenhouse({ ...PLOT, requires, targetSize: 1 });
    for (const weights of [[1, 0.05, 0.5], [0.05, 1, 0.1], [1, 1, 1]]) {
      const priced = packGreenhouse({ ...PLOT, requires, targetSize: 1, weights: weights.slice(0, requires.length) });
      assert.equal(priced.targets, flat.targets, `weights ${weights} changed the yield`);
    }
  }
});

test("no prices means the old answer", () => {
  // All weights equal is the same comparison the tie-break used to make, so a caller with nothing
  // to price gets what it always got rather than an arbitrary new preference.
  const requires = [{ cells: 4, size: 1 }, { cells: 4, size: 1 }];
  const bare = packGreenhouse({ ...PLOT, requires, targetSize: 1 });
  const flat = packGreenhouse({ ...PLOT, requires, targetSize: 1, weights: [1, 1] });
  assert.deepEqual(bare.plants, flat.plants);
  assert.equal(bare.targets, flat.targets);
});

/* ------------------------------- a condition counts corners, an effect does not */

/** Mutations with a plant of `req` sharing an edge with them, rather than only a corner. */
function seatedTargets(grid: CellKind[][], req: number, m: number): { seated: number; total: number } {
  const H = grid.length;
  const W = grid[0].length;
  const seen: boolean[][] = grid.map((line) => line.map(() => false));
  let seated = 0;
  let total = 0;
  for (let r = 0; r + m <= H; r++) {
    for (let c = 0; c + m <= W; c++) {
      let whole = true;
      for (let rr = r; rr < r + m && whole; rr++)
        for (let cc = c; cc < c + m && whole; cc++) if (grid[rr][cc] !== "target" || seen[rr][cc]) whole = false;
      if (!whole) continue;
      for (let rr = r; rr < r + m; rr++) for (let cc = c; cc < c + m; cc++) (seen[rr][cc] = true);
      total++;
      let touching = false;
      for (let rr = r; rr < r + m && !touching; rr++)
        for (const cc of [c - 1, c + m]) if (cc >= 0 && cc < W && grid[rr][cc] === req) touching = true;
      for (let cc = c; cc < c + m && !touching; cc++)
        for (const rr of [r - 1, r + m]) if (rr >= 0 && rr < H && grid[rr][cc] === req) touching = true;
      if (touching) seated++;
    }
  }
  return { seated, total };
}

test("the cheapest ring puts the scarce crop on the corners, where an effect cannot reach", () => {
  // Chocoberry's shape, and the reason this exists. Six cells of one crop and two of another; a
  // corner cell lies in four rings at once and an edge cell in one, so economising on the second
  // crop means seating it exactly where a crop effect does not reach.
  const requires = [{ cells: 6, size: 1 }, { cells: 2, size: 1 }];
  const dear = packGreenhouse({ ...PLOT, requires, targetSize: 1, weights: [0.75, 1] });
  const { seated, total } = seatedTargets(dear.grid, 1, 1);
  assert.ok(total > 0);
  assert.equal(seated, 0, "left alone it corners the expensive crop — this is the bug being fixed");
  assert.equal(dear.seated, 0, "and the packing says so");
});

test("asked to seat one, it puts that crop on the edges instead", () => {
  const requires = [{ cells: 6, size: 1 }, { cells: 2, size: 1 }];
  const seatedPack = packGreenhouse({ ...PLOT, requires, targetSize: 1, weights: [0.75, 1], seat: [false, true] });
  const { seated, total } = seatedTargets(seatedPack.grid, 1, 1);
  assert.equal(seated, total, "every mutation has one on an edge");
  assert.equal(seatedPack.seated, total);
  // And it does not buy that with yield: the tie-break sits under the target count, never over it.
  assert.equal(seatedPack.targets, packGreenhouse({ ...PLOT, requires, targetSize: 1, weights: [0.75, 1] }).targets);
});

test("seating is only ever paid for when it is asked for", () => {
  // Every other row on the page is still laid out on price alone. Asking for nothing has to leave
  // the old answer exactly as it was, or one mutation's watering quietly reprices the whole table.
  const requires = [{ cells: 4, size: 1 }, { cells: 4, size: 1 }];
  const plain = packGreenhouse({ ...PLOT, requires, targetSize: 1, weights: [1, 0.05] });
  const asked = packGreenhouse({ ...PLOT, requires, targetSize: 1, weights: [1, 0.05], seat: [false, false] });
  assert.deepEqual(asked.plants, plain.plants);
  assert.deepEqual(asked.grid, plain.grid);
  assert.equal(plain.seated, 0, "nothing asked for, nothing counted");
});

test("the pruning does not strip a plant that is seating an effect", () => {
  // It drops the dearest spare plant first, and a seated one is worth more than it costs — dropping
  // it saves a few coins and silently turns a plot that waters itself into one that does not.
  const requires = [{ cells: 6, size: 1 }, { cells: 2, size: 1 }];
  const p = packGreenhouse({ ...PLOT, requires, targetSize: 1, weights: [0.1, 1], seat: [false, true] });
  const { seated, total } = seatedTargets(p.grid, 1, 1);
  assert.equal(seated, total, "still seated after the prune, despite being the expensive crop");
});

test("seating never costs a mutation", () => {
  for (const requires of [
    [{ cells: 6, size: 1 }, { cells: 2, size: 1 }],
    [{ cells: 5, size: 1 }, { cells: 3, size: 1 }],
    [{ cells: 2, size: 1 }, { cells: 2, size: 1 }],
    [{ cells: 4, size: 1 }, { cells: 4, size: 1 }],
  ]) {
    const plain = packGreenhouse({ ...PLOT, requires, targetSize: 1 });
    const asked = packGreenhouse({ ...PLOT, requires, targetSize: 1, seat: [false, true] });
    assert.equal(asked.targets, plain.targets, JSON.stringify(requires));
  }
});
