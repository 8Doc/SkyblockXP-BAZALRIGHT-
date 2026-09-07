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
  /**
   * What one plant of each requirement costs, relative to the others. Defaults to all equal.
   *
   * The search reaches the same target count by many different arrangements, and the choice
   * between them was being made by whichever pattern the loop happened to reach first. That is not
   * a small thing: Devourer's ring is four cells of Puffercloud at 758k and four of Zombud at 3k,
   * and the two arrangements that both grow sixteen — fifty of one and twenty-five of the other,
   * either way round — are a 38M ring and a 19M ring. Identical output, identical plant count, so
   * nothing in the old tie-break could tell them apart.
   *
   * Relative rather than absolute because these are memoised against a bazaar that reprices every
   * twenty seconds; see `packFor` for how the weights are made stable enough to key a cache on.
   */
  weights?: number[];
};

export type CellKind = "target" | "empty" | "locked" | number;

export type Packing = {
  /** How many of the mutation grow at once. This is the multiplier on everything else. */
  targets: number;
  /** Plants to buy per requirement, in the order the requirements were given. */
  plants: number[];
  /** Cells each requirement's plants occupy. */
  cells: number[];
  /** Plants the arrangement placed and the pruning pass took back out. See `prune`. */
  pruned: number;
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

  const weights = requires.map((_, i) => Math.max(0, Number(o.weights?.[i] ?? 1) || 0));

  // `crop[i]` is the map for requirement i: 1 where one of its plants stands.
  const crop = requires.map(() => new Uint8Array(width * height));
  const occupied = new Uint8Array(width * height);
  const taken = new Uint8Array(width * height);
  // Where each requirement's plants were anchored. The bitmaps above cannot say: a 3x3 plant sets
  // nine cells and pruning has to take out the plant, not a corner of it.
  const anchors = requires.map((): number[] => []);

  let bestTargets = -1;
  let bestPlants: number[] = requires.map(() => 0);
  let bestMask = 0;
  let bestPeriod: [number, number] = [1, 1];

  if (k > 0) {
    for (const [pr, pc] of periods(k + 1, budget)) {
      const patterns = (k + 1) ** (pr * pc);
      for (let mask = 0; mask < patterns; mask++) {
        const plants = fill(crop, occupied, anchors, mask, pr, pc, width, height, locked, requires, k);
        const targets = placeTargets(crop, occupied, taken, requires, locked, m, width, height).length;
        if (targets > bestTargets || (targets === bestTargets && better(plants, bestPlants, weights))) {
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

  const placed = useBlocks
    ? (fillFrom(crop, occupied, anchors, blocked!.map, requires, width, height), blocked!.plants)
    : fill(crop, occupied, anchors, bestMask, bestPeriod[0], bestPeriod[1], width, height, locked, requires, k);
  if (useBlocks) bestPeriod = [m + 2, m + 2];

  // Placement is done once and then held. Pruning takes plants out, and re-deriving where the
  // mutations go from a thinner grid could land on a different set — so the set that was pruned
  // against is the set that gets drawn.
  const targets = placeTargets(crop, occupied, taken, requires, locked, m, width, height);
  const pruned = prune(crop, occupied, anchors, targets, requires, weights, m, width, height);

  const plants = anchors.map((list) => list.length);
  const cells = crop.map((map) => map.reduce((n, v) => n + v, 0));

  return {
    targets: targets.length,
    plants,
    cells,
    pruned: total(placed) - total(plants),
    grid: draw(crop, targets, locked, m, width, height),
    period: { rows: bestPeriod[0], cols: bestPeriod[1] },
    ceiling,
  };
}

const total = (plants: number[]) => plants.reduce((a, b) => a + b, 0);

/** What the ring costs, in whatever units the weights were given in. */
const bill = (plants: number[], weights: number[]) =>
  plants.reduce((sum, n, i) => sum + n * (weights[i] ?? 1), 0);

/**
 * Is this arrangement a better buy than the one held, given they grow the same number?
 *
 * Cost first, plant count second. The second still matters: with no weights supplied every
 * arrangement costs the same and this falls back to the old rule, and even with weights two
 * arrangements can price identically, in which case fewer things to plant is the tidier answer.
 */
function better(plants: number[], best: number[], weights: number[]): boolean {
  const a = bill(plants, weights);
  const b = bill(best, weights);
  return a !== b ? a < b : total(plants) < total(best);
}

/** Stamp a tile onto the plot, placing each requirement's plants where they fit. */
function fill(
  crop: Uint8Array[],
  occupied: Uint8Array,
  anchors: number[][],
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
  for (const list of anchors) list.length = 0;

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

      anchors[which].push(r * width + c);
      for (let rr = r; rr < r + s; rr++) {
        for (let cc = c; cc < c + s; cc++) {
          crop[which][rr * width + cc] = 1;
          occupied[rr * width + cc] = 1;
        }
      }
    }
  }
  return anchors.map((list) => list.length);
}

/**
 * Where the mutations actually appear, as top-left indices. Every clause has to hold at once, at
 * the same target.
 *
 * Returning the positions rather than a count is what lets one placement serve the whole pipeline —
 * scoring during the search, pruning afterwards, and drawing the plot at the end all read the same
 * answer instead of each walking the grid and hoping to agree.
 */
function placeTargets(
  crop: Uint8Array[],
  occupied: Uint8Array,
  taken: Uint8Array,
  requires: Requirement[],
  locked: Set<string>,
  m: number,
  width: number,
  height: number,
): number[] {
  taken.fill(0);
  const targets: number[] = [];
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

      targets.push(r * width + c);
      for (let rr = r; rr < r + m; rr++) for (let cc = c; cc < c + m; cc++) taken[rr * width + cc] = 1;
    }
  }
  return targets;
}

/**
 * Take back out every plant the arrangement does not need.
 *
 * A periodic tile is stamped across the whole plot, and the plot does not divide evenly by the
 * tile. What is left over is plants standing where no mutation ever appeared - 18% of everything
 * planted across the forty, and 71% of Stoplight Petal's ring. They were being bought, priced,
 * and doing nothing at all.
 *
 * The surplus is the subtler half. A ring that needs four Cindershade can end up holding six,
 * because the tile that fed *this* target generously was the one that fed its neighbour exactly.
 * Those two extra are as useless as the ones stranded in a corner, and much easier to miss.
 *
 * Both come out the same way: try every plant, drop it if every mutation is still fed without it,
 * and go in order of what a plant costs so the expensive ones are offered up first. Greedy, and
 * that is a real limitation - dropping a cheap plant early can block an expensive one later - but
 * a plant is only ever removed when nothing needs it, so what comes back is always buildable and
 * never worse than what went in.
 *
 * Targets are fixed before this runs and are not re-derived after. Removing plants can only shrink
 * the set of positions whose ring is fed, and re-running the placement on the thinner grid could
 * settle on a different set - one this pass never checked, and so one the remaining plants are not
 * guaranteed to feed.
 */
function prune(
  crop: Uint8Array[],
  occupied: Uint8Array,
  anchors: number[][],
  targets: number[],
  requires: Requirement[],
  weights: number[],
  m: number,
  width: number,
  height: number,
): number {
  if (targets.length === 0) {
    // Nothing grows here, so nothing planted is doing anything. An empty plot is both the true
    // answer and a kinder one than a bill for a ring that feeds no mutation.
    let dropped = 0;
    for (let i = 0; i < anchors.length; i++) {
      dropped += anchors[i].length;
      for (const at of anchors[i]) clear(crop[i], occupied, at, requires[i].size, width);
      anchors[i].length = 0;
    }
    return dropped;
  }

  // How much of each requirement each target currently sees. Recounting a ring per candidate would
  // be the same walk thousands of times over; a removal only ever subtracts from this.
  const fed = targets.map((at) => requires.map((_, i) => ringCount(crop[i], at, m, width, height)));

  // Most expensive first, so the greedy spends its freedom where it is worth something. Ties keep
  // the order the fill produced, which is scan order - stable, and so is the answer.
  const order: { req: number; at: number }[] = [];
  for (let i = 0; i < anchors.length; i++) for (const at of anchors[i]) order.push({ req: i, at });
  order.sort((a, b) => (weights[b.req] ?? 1) - (weights[a.req] ?? 1));

  let dropped = 0;
  for (const { req, at } of order) {
    const size = requires[req].size;
    // What each target would lose. A plant can sit in several rings at once - that sharing is the
    // whole point of a layout - so this is not one number.
    const loss = targets.map((t) => overlap(at, size, t, m, width, height));
    let spare = true;
    for (let t = 0; t < targets.length && spare; t++) {
      if (loss[t] === 0) continue;
      if (fed[t][req] - loss[t] < requires[req].cells) spare = false;
    }
    if (!spare) continue;

    for (let t = 0; t < targets.length; t++) fed[t][req] -= loss[t];
    clear(crop[req], occupied, at, size, width);
    anchors[req].splice(anchors[req].indexOf(at), 1);
    dropped++;
  }
  return dropped;
}

/** Lift one plant off the plot. */
function clear(map: Uint8Array, occupied: Uint8Array, at: number, size: number, width: number): void {
  const r0 = Math.floor(at / width);
  const c0 = at % width;
  for (let r = r0; r < r0 + size; r++) {
    for (let c = c0; c < c0 + size; c++) {
      map[r * width + c] = 0;
      occupied[r * width + c] = 0;
    }
  }
}

/** How many of one requirement's cells lie in the ring around a target. */
function ringCount(map: Uint8Array, at: number, m: number, width: number, height: number): number {
  const r0 = Math.floor(at / width);
  const c0 = at % width;
  let fed = 0;
  for (let r = r0 - 1; r <= r0 + m; r++) {
    if (r < 0 || r >= height) continue;
    for (let c = c0 - 1; c <= c0 + m; c++) {
      if (c < 0 || c >= width) continue;
      if (r >= r0 && r < r0 + m && c >= c0 && c < c0 + m) continue;
      fed += map[r * width + c];
    }
  }
  return fed;
}

/** Cells of one plant that fall inside one target's ring. */
function overlap(at: number, size: number, target: number, m: number, width: number, height: number): number {
  const pr = Math.floor(at / width);
  const pc = at % width;
  const tr = Math.floor(target / width);
  const tc = target % width;
  let hit = 0;
  for (let r = pr; r < pr + size; r++) {
    if (r < 0 || r >= height) continue;
    for (let c = pc; c < pc + size; c++) {
      if (c < 0 || c >= width) continue;
      const inRing = r >= tr - 1 && r <= tr + m && c >= tc - 1 && c <= tc + m;
      const inTarget = r >= tr && r < tr + m && c >= tc && c < tc + m;
      if (inRing && !inTarget) hit++;
    }
  }
  return hit;
}

/** The plot as a reader sees it, from the placement that was already settled on. */
function draw(
  crop: Uint8Array[],
  targets: number[],
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

  for (const at of targets) {
    const r0 = Math.floor(at / width);
    const c0 = at % width;
    for (let r = r0; r < r0 + m; r++) for (let c = c0; c < c0 + m; c++) grid[r][c] = "target";
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
  anchors: number[][],
  map: Int8Array,
  requires: Requirement[],
  width: number,
  height: number,
): number[] {
  for (const layer of crop) layer.fill(0);
  occupied.fill(0);
  for (const list of anchors) list.length = 0;
  // Every plant in a private-ring construction is a single cell - privateRings refuses the job
  // otherwise - so each occupied cell is its own anchor.
  for (let i = 0; i < width * height; i++) {
    const at = map[i];
    if (at >= 0 && at < requires.length) {
      crop[at][i] = 1;
      occupied[i] = 1;
      anchors[at].push(i);
    }
  }
  return anchors.map((list) => list.length);
}
