import { test } from "node:test";
import assert from "node:assert/strict";

import { packGreenhouse, ringSize, type CellKind, type Requirement } from "../src/lib/greenhouseLayout";
import { fullRingMaximum, isCapped, optimise } from "../src/lib/greenhouseOptimise";

const PLOT = { width: 10, height: 10 };

/** Every clause really holds, at every mutation the layout claims to grow. */
function verify(grid: CellKind[][], requires: Requirement[], m: number): number {
  const H = grid.length;
  const W = grid[0].length;
  const seen: boolean[][] = grid.map((line) => line.map(() => false));
  let grown = 0;

  for (let r = 0; r + m <= H; r++) {
    for (let c = 0; c + m <= W; c++) {
      let whole = true;
      for (let rr = r; rr < r + m && whole; rr++)
        for (let cc = c; cc < c + m && whole; cc++) if (grid[rr][cc] !== "target" || seen[rr][cc]) whole = false;
      if (!whole) continue;
      for (let rr = r; rr < r + m; rr++) for (let cc = c; cc < c + m; cc++) (seen[rr][cc] = true);
      grown++;

      const fed = requires.map(() => 0);
      for (let rr = r - 1; rr <= r + m; rr++) {
        for (let cc = c - 1; cc <= c + m; cc++) {
          if (rr < 0 || cc < 0 || rr >= H || cc >= W) continue;
          if (rr >= r && rr < r + m && cc >= c && cc < c + m) continue;
          const cell = grid[rr][cc];
          if (typeof cell === "number") fed[cell]++;
        }
      }
      for (let i = 0; i < requires.length; i++) {
        assert.ok(fed[i] >= requires[i].cells, `a mutation at ${r},${c} has ${fed[i]} of clause ${i}, needs ${requires[i].cells}`);
      }
    }
  }
  return grown;
}

test("a full ring fixes how many fit, and the arithmetic is the answer", () => {
  // No two can touch and none can sit against the edge, so the corners form a grid of spacing m+1
  // inside the interior. Nothing to search, and nothing an optimiser could find.
  assert.equal(fullRingMaximum(1, 10, 10), 16);
  assert.equal(fullRingMaximum(2, 10, 10), 9);
  assert.equal(fullRingMaximum(3, 10, 10), 4);

  for (const m of [1, 2, 3]) {
    const cells = ringSize(m);
    const requires = [{ cells: cells - 2, size: 1 }, { cells: 2, size: 1 }];
    assert.equal(isCapped(requires, m), true);
    const tile = packGreenhouse({ ...PLOT, requires, targetSize: m });
    assert.equal(tile.targets, fullRingMaximum(m, 10, 10), `the tile search already reaches it at ${m}x${m}`);
  }
});

test("a partial ring or a big support is not capped, so it is worth searching", () => {
  assert.equal(isCapped([{ cells: 2, size: 1 }], 1), false, "two of eight leaves room to share");
  assert.equal(isCapped([{ cells: 4, size: 3 }, { cells: 4, size: 1 }], 1), false, "a 3x3 support");
  assert.equal(isCapped([{ cells: 4, size: 1 }, { cells: 4, size: 1 }], 1), true);
});

test("a capped condition is answered without searching at all", () => {
  const requires = [{ cells: 4, size: 1 }, { cells: 4, size: 1 }];
  const out = optimise({ ...PLOT, requires, targetSize: 1, weights: [1, 0.05] });
  assert.equal(out.capped, true);
  assert.equal(out.packing.targets, 16);
  assert.deepEqual(out.after, out.before, "nothing was searched, so nothing changed");
});

test("what it returns is a greenhouse that actually works", () => {
  // The whole risk of picking mutations first and planting round them afterwards is handing back
  // an arrangement that looks fuller than it is. Every clause is checked at every mutation.
  const cases: [Requirement[], number][] = [
    [[{ cells: 2, size: 1 }], 1],
    [[{ cells: 2, size: 1 }, { cells: 2, size: 1 }], 1],
    [[{ cells: 2, size: 1 }, { cells: 2, size: 1 }, { cells: 2, size: 1 }, { cells: 2, size: 1 }], 1],
    [[{ cells: 6, size: 3 }, { cells: 6, size: 1 }], 2],
    [[{ cells: 6, size: 1 }, { cells: 2, size: 2 }], 1],
  ];
  for (const [requires, targetSize] of cases) {
    const out = optimise({ ...PLOT, requires, targetSize, restarts: 30 });
    const grown = verify(out.packing.grid, requires, targetSize);
    assert.equal(grown, out.packing.targets, "the count matches what is drawn");
  }
});

test("it never hands back something worse than the tile search", () => {
  const cases: [Requirement[], number][] = [
    [[{ cells: 2, size: 1 }, { cells: 2, size: 1 }], 1],
    [[{ cells: 4, size: 1 }], 1],
    [[{ cells: 5, size: 1 }, { cells: 3, size: 1 }], 1],
    [[{ cells: 6, size: 3 }, { cells: 6, size: 1 }], 2],
  ];
  for (const [requires, targetSize] of cases) {
    const tile = packGreenhouse({ ...PLOT, requires, targetSize });
    const out = optimise({ ...PLOT, requires, targetSize, restarts: 30 });
    assert.ok(out.packing.targets >= tile.targets, `${out.packing.targets} against ${tile.targets}`);
  }
});

test("it grows the ones the tile search cannot", () => {
  // PlantBoy Advance: a 2x2 mutation whose twelve-cell ring wants six cells of a 3x3 Snoozling and
  // six of a 1x1 Thunderling. No tile within the pattern budget can say that, so the old search
  // returned nothing at all and the row read as unbuildable.
  const requires = [{ cells: 6, size: 3 }, { cells: 6, size: 1 }];
  assert.equal(packGreenhouse({ ...PLOT, requires, targetSize: 2 }).targets, 0);

  const out = optimise({ ...PLOT, requires, targetSize: 2 });
  assert.ok(out.packing.targets > 0, "the plot is buildable and now says so");
  verify(out.packing.grid, requires, 2);
});

test("four clauses beat the pattern budget, and picking mutations first does not", () => {
  // Duskbloom's shape: eight ring cells split four ways. Five states to a cell means the tile
  // budget affords a 2x3 pattern, too coarse to reach the lattice — 12 where 16 is provable.
  const requires = [1, 1, 3, 3].map((cells) => ({ cells, size: 1 }));
  const tile = packGreenhouse({ ...PLOT, requires, targetSize: 1 });
  const out = optimise({ ...PLOT, requires, targetSize: 1 });
  assert.ok(out.packing.targets > tile.targets, `${out.packing.targets} against the tile's ${tile.targets}`);
  assert.ok(out.packing.targets <= fullRingMaximum(1, 10, 10));
  verify(out.packing.grid, requires, 1);
});

test("locked cells stay empty and grow nothing", () => {
  const locked = new Set(["0,0", "0,1", "1,0", "1,1", "9,9"]);
  const requires = [{ cells: 2, size: 1 }, { cells: 2, size: 1 }];
  const out = optimise({ ...PLOT, locked, requires, targetSize: 1, restarts: 20 });
  for (const at of locked) {
    const [r, c] = at.split(",").map(Number);
    assert.equal(out.packing.grid[r][c], "locked", `${at} was built on`);
  }
  verify(out.packing.grid, requires, 1);
});

test("the same question twice gives the same layout", () => {
  // The search is randomised, and a cached answer that disagreed with a fresh one would show up as
  // a plot that rearranges itself when the page is reloaded.
  const requires = [{ cells: 2, size: 1 }, { cells: 3, size: 1 }];
  const a = optimise({ ...PLOT, requires, targetSize: 1, restarts: 25 });
  const b = optimise({ ...PLOT, requires, targetSize: 1, restarts: 25 });
  assert.equal(a.packing.targets, b.packing.targets);
  assert.deepEqual(a.packing.plants, b.packing.plants);
  assert.deepEqual(a.packing.grid, b.packing.grid);
});

test("nothing is planted that no mutation is using", () => {
  const requires = [{ cells: 2, size: 1 }, { cells: 2, size: 1 }];
  const out = optimise({ ...PLOT, requires, targetSize: 1, restarts: 20 });
  const grid = out.packing.grid;
  const ring = new Set<string>();
  for (let r = 0; r < 10; r++)
    for (let c = 0; c < 10; c++) {
      if (grid[r][c] !== "target") continue;
      for (let rr = r - 1; rr <= r + 1; rr++)
        for (let cc = c - 1; cc <= c + 1; cc++) if (rr !== r || cc !== c) ring.add(`${rr},${cc}`);
    }
  for (let r = 0; r < 10; r++)
    for (let c = 0; c < 10; c++)
      if (typeof grid[r][c] === "number") assert.ok(ring.has(`${r},${c}`), `a plant at ${r},${c} feeds nothing`);
});

test("told what things cost, it plants fewer of the dear one", () => {
  const requires = [{ cells: 2, size: 1 }, { cells: 2, size: 1 }];
  const dearFirst = optimise({ ...PLOT, requires, targetSize: 1, weights: [1, 0.05], restarts: 40 });
  const dearSecond = optimise({ ...PLOT, requires, targetSize: 1, weights: [0.05, 1], restarts: 40 });
  assert.equal(dearFirst.packing.targets, dearSecond.packing.targets, "the same number still grows");
  const costly = (p: typeof dearFirst, i: number) => p.packing.plants[i];
  assert.ok(costly(dearFirst, 0) <= costly(dearFirst, 1));
  assert.ok(costly(dearSecond, 1) <= costly(dearSecond, 0));
});

test("the plants reported are the plants drawn", () => {
  // The bill is built from `plants` and the picture from `grid`, and a reader compares them.
  const requires = [{ cells: 2, size: 1 }, { cells: 4, size: 2 }];
  const out = optimise({ ...PLOT, requires, targetSize: 1, restarts: 20 });
  const drawn = requires.map(() => 0);
  for (const line of out.packing.grid) for (const cell of line) if (typeof cell === "number") drawn[cell]++;
  for (let i = 0; i < requires.length; i++) {
    assert.equal(drawn[i], out.packing.plants[i] * requires[i].size ** 2, `clause ${i}`);
    assert.equal(out.packing.cells[i], drawn[i]);
  }
});
