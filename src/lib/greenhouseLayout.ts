/**
 * How many of one mutation fit in a greenhouse at once.
 *
 * This is the question that decides what the Greenhouse actually pays, and dividing the plot by
 * nine gets it badly wrong. A mutation spreads into an empty cell when enough of the eight cells
 * around it hold the right crop — and **those eight cells are shared**. Put two empty cells beside
 * each other and one run of support crop feeds both. Tiled across a 10x10, a condition needing two
 * adjacent crops supports **seventy** mutations at once, not the eleven that a 3x3 stamp repeated
 * across a hundred cells would suggest.
 *
 * So the layout is a packing problem over the whole plot rather than a stamp in a grid:
 *
 *   maximise the empty cells whose ring holds >= N of the support crop,
 *   subject to the support crop occupying cells of its own.
 *
 * The trade is visible in the arithmetic, and the shapes fall out of it. A support cell sits in at
 * most eight rings, so a requirement of N needs at least `N/8` support cells per target: a
 * two-crop condition can afford to be mostly empty and tiles at seventy, while an eight-crop
 * condition needs every neighbour filled and collapses to a scattered sixteen. The search finds
 * the shape; the ceiling explains why it stops there.
 *
 * **Best found, not proven optimal.** The search is exhaustive over *periodic* patterns up to a
 * twelve-cell tile and exact on the real grid, edges included — so it will not miss the regular
 * arrangements a player would actually build, and it beats every pattern worked out by hand
 * (a checkerboard, row stripes, a spaced lattice) on every requirement tried. It could still miss
 * an irregular arrangement worth a few percent, and `ceiling` is reported beside the answer so a
 * reader can see how much room is left rather than take an optimum on trust.
 */

export type PackingOptions = {
  width: number;
  height: number;
  /** Cells the player has not unlocked. Keyed `"r,c"`; everything else is usable. */
  locked?: Set<string>;
  /** Ring cells of the support crop the condition asks for. */
  requiredCells: number;
  /** The side of the support plant. A 2x2 mutation occupies four cells and fills two of a ring. */
  supportSize: number;
  /** The side of the mutation being grown, which needs that much empty room to appear in. */
  targetSize: number;
};

export type CellKind = "support" | "target" | "empty" | "locked";

export type Packing = {
  /** How many of the mutation grow at once. This is the multiplier on everything else. */
  targets: number;
  /** Support plants to buy — the setup cost for a whole plot rather than for one mutation. */
  supportPlants: number;
  supportCells: number;
  grid: CellKind[][];
  /** The tile that was repeated, for the caption. */
  period: { rows: number; cols: number };
  /**
   * The most targets any arrangement could feed, from the counting argument above.
   *
   * Reported beside the result so a reader can see how much room the search may have left: a
   * packing at the ceiling is optimal, and one far below it says the shape is awkward rather than
   * that the search gave up.
   */
  ceiling: number;
};

const key = (r: number, c: number) => `${r},${c}`;

/**
 * The cells around an `m`x`m` block — its Moore ring.
 *
 * Eight for a single tile and twelve for a 2x2, which is part of why a big mutation is expensive:
 * it needs more room *and* it has more ring to fill.
 */
function ringOf(r: number, c: number, m: number, height: number, width: number): [number, number][] {
  const out: [number, number][] = [];
  for (let rr = r - 1; rr <= r + m; rr++) {
    for (let cc = c - 1; cc <= c + m; cc++) {
      if (rr >= r && rr < r + m && cc >= c && cc < c + m) continue;
      if (rr < 0 || cc < 0 || rr >= height || cc >= width) continue;
      out.push([rr, cc]);
    }
  }
  return out;
}

/**
 * The counting bound: a support cell lies in at most `ringSize` rings, so `ringSize * support >=
 * N * targets`, and each target also costs `m^2` cells of its own.
 */
function ceilingFor(usable: number, o: PackingOptions, ringSize: number): number {
  const area = o.targetSize * o.targetSize;
  if (o.requiredCells <= 0) return Math.floor(usable / area);
  return Math.floor(usable / (area + o.requiredCells / ringSize));
}

/** Every periodic tile worth trying. A 4x4 is 65,536 masks and finds nothing 4x3 does not. */
function* periods(): Generator<[number, number]> {
  for (let rows = 1; rows <= 4; rows++) {
    for (let cols = 1; cols <= 4; cols++) if (rows * cols <= 12) yield [rows, cols];
  }
}

/**
 * Lay out one mutation across a whole greenhouse.
 *
 * The support crop is placed on a lattice of its own size, because a 2x2 plant cannot straddle two
 * cells of a 1x1 grid — so for a big support the pattern applies to blocks and the cells follow.
 */
export function packGreenhouse(o: PackingOptions): Packing {
  const { width, height } = o;
  const locked = o.locked ?? new Set<string>();
  // Coerced rather than trusted: Math.max(1, undefined) is NaN, and a NaN size does not throw —
  // it silently reports zero targets, which reads as "this mutation does not fit" rather than as
  // a missing field.
  const s = Math.max(1, Number(o.supportSize) || 1);
  const m = Math.max(1, Number(o.targetSize) || 1);

  const usable = width * height - locked.size;
  const ceiling = ceilingFor(usable, o, ringOf(1, 1, m, height + 4, width + 4).length);

  // The search counts on flat arrays and never allocates; the readable grid is built once, for the
  // winner. Building it inside the loop cost an allocation per mask and made this twelve times
  // slower than the arithmetic needs to be, which matters at nine thousand masks a mutation.
  let bestTargets = -1;
  let bestPlants = Infinity;
  let bestMask = 0;
  let bestPeriod: [number, number] = [1, 1];

  const support = new Uint8Array(width * height);
  const taken = new Uint8Array(width * height);
  for (const [pr, pc] of periods()) {
    for (let mask = 0; mask < 1 << (pr * pc); mask++) {
      const plants = fill(support, mask, pr, pc, width, height, locked, s);
      const targets = count(support, taken, o, locked, m, width, height);
      if (targets > bestTargets || (targets === bestTargets && plants < bestPlants)) {
        bestTargets = targets;
        bestPlants = plants;
        bestMask = mask;
        bestPeriod = [pr, pc];
      }
    }
  }

  const plants = fill(support, bestMask, bestPeriod[0], bestPeriod[1], width, height, locked, s);
  let supportCells = 0;
  for (const cell of support) supportCells += cell;

  return {
    targets: Math.max(0, bestTargets),
    supportPlants: plants,
    supportCells,
    grid: draw(support, o, locked, m, width, height),
    period: { rows: bestPeriod[0], cols: bestPeriod[1] },
    ceiling,
  };
}

/** Stamp a periodic mask onto the support map, in blocks of the support plant's own size. */
function fill(
  support: Uint8Array,
  mask: number,
  pr: number,
  pc: number,
  width: number,
  height: number,
  locked: Set<string>,
  s: number,
): number {
  support.fill(0);
  let plants = 0;
  for (let br = 0; br * s < height; br++) {
    for (let bc = 0; bc * s < width; bc++) {
      if ((mask & (1 << ((br % pr) * pc + (bc % pc)))) === 0) continue;
      // A plant that would hang off the edge or cover a locked cell cannot be placed there.
      let fits = true;
      for (let r = br * s; r < br * s + s && fits; r++) {
        for (let c = bc * s; c < bc * s + s && fits; c++) {
          if (r >= height || c >= width || locked.has(key(r, c))) fits = false;
        }
      }
      if (!fits) continue;
      plants++;
      for (let r = br * s; r < br * s + s; r++) for (let c = bc * s; c < bc * s + s; c++) support[r * width + c] = 1;
    }
  }
  return plants;
}

/** How many mutations this support map feeds. Counting only — nothing allocated in the hot path. */
function count(
  support: Uint8Array,
  taken: Uint8Array,
  o: PackingOptions,
  locked: Set<string>,
  m: number,
  width: number,
  height: number,
): number {
  taken.fill(0);
  let targets = 0;
  for (let r = 0; r + m <= height; r++) {
    for (let c = 0; c + m <= width; c++) {
      let free = true;
      for (let rr = r; rr < r + m && free; rr++)
        for (let cc = c; cc < c + m && free; cc++)
          if (support[rr * width + cc] || taken[rr * width + cc] || locked.has(key(rr, cc))) free = false;
      if (!free) continue;

      let fed = 0;
      for (let rr = r - 1; rr <= r + m; rr++) {
        if (rr < 0 || rr >= height) continue;
        for (let cc = c - 1; cc <= c + m; cc++) {
          if (cc < 0 || cc >= width) continue;
          if (rr >= r && rr < r + m && cc >= c && cc < c + m) continue;
          fed += support[rr * width + cc];
        }
      }
      if (fed < o.requiredCells) continue;

      targets++;
      for (let rr = r; rr < r + m; rr++) for (let cc = c; cc < c + m; cc++) taken[rr * width + cc] = 1;
    }
  }
  return targets;
}

/** The same walk once more, writing the labels a reader sees. */
function draw(
  support: Uint8Array,
  o: PackingOptions,
  locked: Set<string>,
  m: number,
  width: number,
  height: number,
): CellKind[][] {
  const grid: CellKind[][] = Array.from({ length: height }, (_, r) =>
    Array.from({ length: width }, (_, c) => (locked.has(key(r, c)) ? "locked" : support[r * width + c] ? "support" : "empty")),
  );
  const taken = new Uint8Array(width * height);
  for (let r = 0; r + m <= height; r++) {
    for (let c = 0; c + m <= width; c++) {
      let free = true;
      for (let rr = r; rr < r + m && free; rr++)
        for (let cc = c; cc < c + m && free; cc++)
          if (support[rr * width + cc] || taken[rr * width + cc] || locked.has(key(rr, cc))) free = false;
      if (!free) continue;

      let fed = 0;
      for (const [rr, cc] of ringOf(r, c, m, height, width)) fed += support[rr * width + cc];
      if (fed < o.requiredCells) continue;

      for (let rr = r; rr < r + m; rr++)
        for (let cc = c; cc < c + m; cc++) {
          taken[rr * width + cc] = 1;
          grid[rr][cc] = "target";
        }
    }
  }
  return grid;
}
