/**
 * How many of one mutation fit in a greenhouse at once.
 *
 * This is the question that decides what the Greenhouse actually pays, and dividing the plot by
 * nine gets it badly wrong. A mutation spreads into an empty cell when the ring around it holds
 * enough of *every* crop its condition names — and **those ring cells are shared**. Put two empty
 * cells beside each other and one run of support feeds both.
 *
 * Two things make this harder than a stamp repeated in a grid:
 *
 * **A condition is a conjunction.** Stoplight Petal needs four Noctilume *and* four Snoozling, not
 * either one; Scourroot needs a Potato *and* a Carrot. So the layout has to satisfy several counts
 * of several different crops at the same target, which is why the search below assigns each cell a
 * crop rather than a yes/no.
 *
 * **The ring grows with the mutation.** A 1x1 has eight cells around it, a 2x2 has twelve and a 3x3
 * has sixteen — and the conditions fill them exactly: Stoplight Petal's 4 + 4 is eight, Noctilume's
 * 6 + 6 is twelve, Snoozling's 4 + 3 + 3 + 3 + 3 is sixteen. A big mutation therefore pays twice
 * for its size, in room and in ring.
 *
 * **Best found, not proven optimal.** The search is exhaustive over *periodic* patterns within a
 * pattern budget, evaluated exactly on the real grid including its edges, and it beats every
 * pattern worked out by hand. It could still miss an irregular arrangement, so `ceiling` — the most
 * any arrangement could manage, from a counting argument — is reported beside every answer.
 */

/** One clause of a spreading condition: this many ring cells of a plant this big. */
export type Requirement = { cells: number; size: number };

export type PackingOptions = {
  width: number;
  height: number;
  /** Cells the player has not unlocked. Keyed `"r,c"`; everything else is usable. */
  locked?: Set<string>;
  /** Every clause, all of which must hold at once. */
  requires: Requirement[];
  /** The side of the mutation being grown, which needs that much clear room to appear in. */
  targetSize: number;
  /** Patterns to try per tile before giving up on it. Guards the browser, not correctness. */
  budget?: number;
};

export type CellKind = "target" | "empty" | "locked" | number;

export type Packing = {
  /** How many of the mutation grow at once. This is the multiplier on everything else. */
  targets: number;
  /** Plants to buy per requirement, in the order the requirements were given. */
  plants: number[];
  /** Cells each requirement's plants occupy. */
  cells: number[];
  /** `target`, `empty`, `locked`, or the index of the requirement planted there. */
  grid: CellKind[][];
  period: { rows: number; cols: number };
  /** The most targets any arrangement could feed. See the note on the counting argument. */
  ceiling: number;
};

const key = (r: number, c: number) => `${r},${c}`;

/** The cells around an `m`x`m` block: eight for a single tile, twelve for a 2x2, sixteen for a 3x3. */
export function ringSize(m: number): number {
  return (m + 2) * (m + 2) - m * m;
}

/**
 * The counting bound.
 *
 * A support cell lies in at most `ringSize` rings, so every target needs `cells / ringSize` cells
 * of each requirement to itself, plus `m^2` for the mutation. The tightest clause binds.
 */
function ceilingFor(usable: number, o: PackingOptions, m: number): number {
  const ring = ringSize(m);
  const perTarget = o.requires.reduce((sum, r) => sum + r.cells / ring, 0);
  return Math.floor(usable / (m * m + perTarget));
}

const DEFAULT_BUDGET = 40_000;

/** Every periodic tile whose pattern count fits the budget, largest tiles last. */
function* periods(states: number, budget: number): Generator<[number, number]> {
  for (let rows = 1; rows <= 4; rows++) {
    for (let cols = 1; cols <= 4; cols++) {
      if (states ** (rows * cols) <= budget) yield [rows, cols];
    }
  }
}

/**
 * Lay out one mutation across a whole greenhouse.
 *
 * Each cell of the repeating tile is either empty or an anchor for one of the required plants.
 * Plants are placed greedily in scan order and a plant that would overlap one already down, run
 * off the edge, or cover a locked cell is simply not placed — which is what lets requirements of
 * different sizes share a grid without a lattice that suits none of them.
 */
export function packGreenhouse(o: PackingOptions): Packing {
  const { width, height } = o;
  const locked = o.locked ?? new Set<string>();
  const m = Math.max(1, Number(o.targetSize) || 1);
  const requires = o.requires.map((r) => ({ cells: Math.max(0, r.cells), size: Math.max(1, Number(r.size) || 1) }));
  const k = requires.length;

  const usable = width * height - locked.size;
  const ceiling = ceilingFor(usable, { ...o, requires }, m);
  const budget = o.budget ?? DEFAULT_BUDGET;

  // `crop[i]` is the map for requirement i: 1 where one of its plants stands.
  const crop = requires.map(() => new Uint8Array(width * height));
  const occupied = new Uint8Array(width * height);
  const taken = new Uint8Array(width * height);

  let bestTargets = -1;
  let bestPlants: number[] = requires.map(() => 0);
  let bestMask = 0;
  let bestPeriod: [number, number] = [1, 1];

  if (k > 0) {
    for (const [pr, pc] of periods(k + 1, budget)) {
      const patterns = (k + 1) ** (pr * pc);
      for (let mask = 0; mask < patterns; mask++) {
        const plants = fill(crop, occupied, mask, pr, pc, width, height, locked, requires, k);
        const targets = count(crop, occupied, taken, requires, locked, m, width, height);
        if (targets > bestTargets || (targets === bestTargets && total(plants) < total(bestPlants))) {
          bestTargets = targets;
          bestPlants = plants;
          bestMask = mask;
          bestPeriod = [pr, pc];
        }
      }
    }
  }

  // A tile search cannot reach the hardest conditions. Snoozling wants sixteen ring cells split
  // between five different crops around a 3x3, and with six states per cell the budget only
  // affords a tile of five — too small to express the arrangement at all, so the search returns
  // nothing. The answer there is not subtle, though: give every mutation its own private ring and
  // tile *those* blocks. That is always valid and it is what a player actually builds when the
  // condition is tight, so it runs as a candidate beside the search and the better one wins.
  const blocked = privateRings(requires, locked, m, width, height);
  const useBlocks = blocked !== null && blocked.targets > bestTargets;
  if (useBlocks && blocked) {
    bestTargets = blocked.targets;
    bestPlants = blocked.plants;
  }

  const plants = useBlocks
    ? (fillFrom(crop, occupied, blocked!.map, requires, width, height), blocked!.plants)
    : fill(crop, occupied, bestMask, bestPeriod[0], bestPeriod[1], width, height, locked, requires, k);
  if (useBlocks) bestPeriod = [m + 2, m + 2];
  const cells = crop.map((map) => map.reduce((n, v) => n + v, 0));

  return {
    targets: Math.max(0, bestTargets),
    plants,
    cells,
    grid: draw(crop, occupied, requires, locked, m, width, height),
    period: { rows: bestPeriod[0], cols: bestPeriod[1] },
    ceiling,
  };
}

const total = (plants: number[]) => plants.reduce((a, b) => a + b, 0);

/** Stamp a tile onto the plot, placing each requirement's plants where they fit. */
function fill(
  crop: Uint8Array[],
  occupied: Uint8Array,
  mask: number,
  pr: number,
  pc: number,
  width: number,
  height: number,
  locked: Set<string>,
  requires: Requirement[],
  k: number,
): number[] {
  for (const map of crop) map.fill(0);
  occupied.fill(0);
  const plants = requires.map(() => 0);

  for (let r = 0; r < height; r++) {
    for (let c = 0; c < width; c++) {
      // Base-(k+1) digit for this cell of the tile: 0 is empty, i+1 is requirement i.
      const digit = Math.floor(mask / (k + 1) ** ((r % pr) * pc + (c % pc))) % (k + 1);
      if (digit === 0) continue;
      const which = digit - 1;
      const s = requires[which].size;

      let fits = true;
      for (let rr = r; rr < r + s && fits; rr++) {
        for (let cc = c; cc < c + s && fits; cc++) {
          if (rr >= height || cc >= width || occupied[rr * width + cc] || locked.has(key(rr, cc))) fits = false;
        }
      }
      if (!fits) continue;

      plants[which]++;
      for (let rr = r; rr < r + s; rr++) {
        for (let cc = c; cc < c + s; cc++) {
          crop[which][rr * width + cc] = 1;
          occupied[rr * width + cc] = 1;
        }
      }
    }
  }
  return plants;
}

/** How many mutations this arrangement feeds. Every clause has to hold at the same target. */
function count(
  crop: Uint8Array[],
  occupied: Uint8Array,
  taken: Uint8Array,
  requires: Requirement[],
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
          if (occupied[rr * width + cc] || taken[rr * width + cc] || locked.has(key(rr, cc))) free = false;
      if (!free) continue;

      let ok = true;
      for (let i = 0; i < requires.length && ok; i++) {
        if (requires[i].cells === 0) continue;
        let fed = 0;
        for (let rr = r - 1; rr <= r + m && fed < requires[i].cells; rr++) {
          if (rr < 0 || rr >= height) continue;
          for (let cc = c - 1; cc <= c + m; cc++) {
            if (cc < 0 || cc >= width) continue;
            if (rr >= r && rr < r + m && cc >= c && cc < c + m) continue;
            fed += crop[i][rr * width + cc];
          }
        }
        if (fed < requires[i].cells) ok = false;
      }
      if (!ok) continue;

      targets++;
      for (let rr = r; rr < r + m; rr++) for (let cc = c; cc < c + m; cc++) taken[rr * width + cc] = 1;
    }
  }
  return targets;
}

/** The same walk once more, writing the labels a reader sees. */
function draw(
  crop: Uint8Array[],
  occupied: Uint8Array,
  requires: Requirement[],
  locked: Set<string>,
  m: number,
  width: number,
  height: number,
): CellKind[][] {
  const grid: CellKind[][] = Array.from({ length: height }, (_, r) =>
    Array.from({ length: width }, (_, c) => {
      if (locked.has(key(r, c))) return "locked" as CellKind;
      for (let i = 0; i < crop.length; i++) if (crop[i][r * width + c]) return i;
      return "empty" as CellKind;
    }),
  );

  const taken = new Uint8Array(width * height);
  for (let r = 0; r + m <= height; r++) {
    for (let c = 0; c + m <= width; c++) {
      let free = true;
      for (let rr = r; rr < r + m && free; rr++)
        for (let cc = c; cc < c + m && free; cc++)
          if (occupied[rr * width + cc] || taken[rr * width + cc] || locked.has(key(rr, cc))) free = false;
      if (!free) continue;

      let ok = true;
      for (let i = 0; i < requires.length && ok; i++) {
        if (requires[i].cells === 0) continue;
        let fed = 0;
        for (let rr = r - 1; rr <= r + m; rr++) {
          if (rr < 0 || rr >= height) continue;
          for (let cc = c - 1; cc <= c + m; cc++) {
            if (cc < 0 || cc >= width) continue;
            if (rr >= r && rr < r + m && cc >= c && cc < c + m) continue;
            fed += crop[i][rr * width + cc];
          }
        }
        if (fed < requires[i].cells) ok = false;
      }
      if (!ok) continue;

      for (let rr = r; rr < r + m; rr++)
        for (let cc = c; cc < c + m; cc++) {
          taken[rr * width + cc] = 1;
          grid[rr][cc] = "target";
        }
    }
  }
  return grid;
}

/**
 * Give every mutation its own ring and tile those blocks.
 *
 * A target of side `m` plus the border around it is an `(m+2)` square, and those squares tile
 * without touching — so every target's ring is private and every clause is satisfied by
 * construction. It wastes the sharing the search exists to find, which is why it is only ever a
 * fallback; but on a tight condition there is nothing to share, and it is then both the honest
 * answer and the one a player would build.
 *
 * Only attempted when every required plant is a single cell. A 2x2 support cannot sit inside a
 * one-cell-thick border without spilling into the neighbouring block, and working out where the
 * spill is harmless is exactly the search's job.
 */
function privateRings(
  requires: Requirement[],
  locked: Set<string>,
  m: number,
  width: number,
  height: number,
): { targets: number; plants: number[]; map: Int8Array } | null {
  if (requires.length === 0 || requires.some((r) => r.size !== 1)) return null;
  const needed = requires.reduce((sum, r) => sum + r.cells, 0);
  if (needed > ringSize(m)) return null;

  const pitch = m + 2;
  // `-1` is empty, `-2` a target, otherwise the requirement planted there.
  const map = new Int8Array(width * height).fill(-1);
  const plants = requires.map(() => 0);
  let targets = 0;

  for (let br = 0; br + pitch <= height + 1; br += pitch) {
    for (let bc = 0; bc + pitch <= width + 1; bc += pitch) {
      // The block is the target plus its border; the border may run off the plot, and a target
      // whose ring cannot be filled is simply not placed.
      const r0 = br + 1;
      const c0 = bc + 1;
      if (r0 + m > height || c0 + m > width) continue;

      const ring: number[] = [];
      let clear = true;
      for (let rr = r0 - 1; rr <= r0 + m && clear; rr++) {
        for (let cc = c0 - 1; cc <= c0 + m; cc++) {
          if (rr >= r0 && rr < r0 + m && cc >= c0 && cc < c0 + m) continue;
          if (rr < 0 || cc < 0 || rr >= height || cc >= width) continue;
          if (locked.has(key(rr, cc)) || map[rr * width + cc] !== -1) continue;
          ring.push(rr * width + cc);
        }
      }
      for (let rr = r0; rr < r0 + m && clear; rr++)
        for (let cc = c0; cc < c0 + m; cc++)
          if (locked.has(key(rr, cc)) || map[rr * width + cc] !== -1) clear = false;
      if (!clear || ring.length < needed) continue;

      let at = 0;
      for (let i = 0; i < requires.length; i++) {
        for (let n = 0; n < requires[i].cells; n++) {
          map[ring[at++]] = i;
          plants[i]++;
        }
      }
      for (let rr = r0; rr < r0 + m; rr++) for (let cc = c0; cc < c0 + m; cc++) map[rr * width + cc] = -2;
      targets++;
    }
  }

  return targets > 0 ? { targets, plants, map } : null;
}

/** Copy a constructed map back into the per-requirement grids the drawing and counting use. */
function fillFrom(
  crop: Uint8Array[],
  occupied: Uint8Array,
  map: Int8Array,
  requires: Requirement[],
  width: number,
  height: number,
): void {
  for (const layer of crop) layer.fill(0);
  occupied.fill(0);
  for (let i = 0; i < width * height; i++) {
    const at = map[i];
    if (at >= 0 && at < requires.length) {
      crop[at][i] = 1;
      occupied[i] = 1;
    }
  }
}
