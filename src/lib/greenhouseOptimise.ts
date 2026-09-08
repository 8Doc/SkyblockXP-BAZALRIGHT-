import { packGreenhouse, ringSize, type CellKind, type Packing, type PackingOptions, type Requirement } from "./greenhouseLayout";

/**
 * The expensive way to lay out a greenhouse, for when the cheap way might be leaving something.
 *
 * `packGreenhouse` searches *periodic* patterns: a small tile stamped across the plot. That is the
 * right default — it is forty milliseconds, it is what a player can actually read off a picture,
 * and on most conditions it is provably unbeatable. It is not always unbeatable, and this is what
 * runs when you want to know.
 *
 * **Where the tile search cannot lose.** When a condition fills the ring completely — eight cells
 * around a 1x1, twelve around a 2x2 — every cell touching a mutation must hold a plant, so no two
 * mutations may touch, and none may sit against the plot edge with nowhere to put its ring. The
 * positions are then a lattice of spacing `m+1` inside the interior, and counting it is arithmetic
 * rather than search: sixteen for a 1x1 on a 10x10, nine for a 2x2, four for a 3x3. Twenty-one of
 * the forty mutations are that shape and the tile search already hits every one of them. No
 * optimiser can do better and this one is not asked to try.
 *
 * **Where it can.** Two kinds of condition escape that argument. A *partial* ring — Choconut wants
 * two cells out of eight — lets mutations sit close enough to share, and the arrangement stops
 * being a lattice. And a *multi-cell support* — Stoplight Petal's ring wants a 3x3 Snoozling and a
 * 2x2 Noctilume — cannot be said in a small tile at all: with six states to a cell the pattern
 * budget affords a tile of five squares, too small to hold the shape being described.
 *
 * **Why this is built the other way up.** The tile search decides where the *plants* go and finds
 * out afterwards what grew. Almost every arrangement of plants grows nothing, which is why an
 * annealer over plant positions gets nowhere: it never stumbles on a full ring by accident. So
 * this picks the *mutations* first — the thing being paid for — and only then asks what has to be
 * planted to feed them. Every candidate it considers is a legal greenhouse by construction, and
 * the question at each step is the useful one: what does one more mutation here cost me?
 */

export type OptimiseOptions = PackingOptions & {
  /** Attempts at the target set. More is slower and better; the default is a second or two. */
  restarts?: number;
  /** Deterministic across runs, so a cached answer and a fresh one agree. */
  seed?: number;
};

export type Optimised = {
  packing: Packing;
  /** What the tile search had, to say whether this was worth the wait. */
  before: { targets: number; cost: number };
  after: { targets: number; cost: number };
  /** True when the tile answer is provably unbeatable, in which case nothing was searched. */
  capped: boolean;
  elapsedMs: number;
};

const DEFAULT_RESTARTS = 120;

/** A tiny deterministic generator. `Math.random` would make a cached layout disagree with a fresh one. */
function generator(seed: number): () => number {
  let state = (seed || 1) >>> 0;
  return () => ((state = (state * 1664525 + 1013904223) >>> 0) / 4294967296);
}

/**
 * The exact maximum when every cell of the ring must hold a plant.
 *
 * No mutation may touch another, and none may sit where its ring would run off the plot, so the
 * top-left corners form a grid of spacing `m+1` inside `1..W-m-1`. There is nothing to search.
 */
export function fullRingMaximum(m: number, width: number, height: number): number {
  const across = Math.max(0, width - m - 1);
  const down = Math.max(0, height - m - 1);
  return Math.ceil(across / (m + 1)) * Math.ceil(down / (m + 1));
}

/** Whether the counting argument above applies: a full ring, and nothing bigger than one cell. */
export function isCapped(requires: Requirement[], m: number): boolean {
  const needed = requires.reduce((sum, r) => sum + r.cells, 0);
  return needed === ringSize(m) && requires.every((r) => r.size === 1);
}

const bill = (plants: number[], weights: number[]) =>
  plants.reduce((sum, n, i) => sum + n * (weights[i] ?? 1), 0);

export function optimise(o: OptimiseOptions): Optimised {
  const started = Date.now();
  const width = o.width;
  const height = o.height;
  const m = Math.max(1, Number(o.targetSize) || 1);
  const requires = o.requires.map((r) => ({ cells: Math.max(0, r.cells), size: Math.max(1, Number(r.size) || 1) }));
  const weights = requires.map((_, i) => Math.max(0, Number(o.weights?.[i] ?? 1) || 0));
  const locked = o.locked ?? new Set<string>();

  const tile = packGreenhouse(o);
  const before = { targets: tile.targets, cost: bill(tile.plants, weights) };

  // Nothing to search: the tile answer is already the most that can grow, and with every ring
  // exactly full there is no slack in what gets planted either.
  if (isCapped(requires, m) && tile.targets >= fullRingMaximum(m, width, height)) {
    return { packing: tile, before, after: before, capped: true, elapsedMs: Date.now() - started };
  }

  const board: Board = { width, height, m, requires, weights, seat: requires.map((_, i) => o.seat?.[i] === true), locked };
  const restarts = Math.max(1, o.restarts ?? DEFAULT_RESTARTS);
  const random = generator(o.seed ?? 20260907);

  let best: Solution | null = solutionFrom(board, targetsOfGrid(tile.grid, m, width, height));

  for (let attempt = 0; attempt < restarts; attempt++) {
    const candidate = grow(board, random, attempt);
    if (candidate && betterThan(candidate, best, weights)) best = candidate;
  }

  if (!best) return { packing: tile, before, after: before, capped: false, elapsedMs: Date.now() - started };

  const packing = render(board, best, tile.ceiling);
  const after = { targets: packing.targets, cost: bill(packing.plants, weights) };
  // Never hand back something worse than what was already on screen.
  if (after.targets < before.targets || (after.targets === before.targets && after.cost >= before.cost)) {
    return { packing: tile, before, after: before, capped: false, elapsedMs: Date.now() - started };
  }
  return { packing, before, after, capped: false, elapsedMs: Date.now() - started };
}

/* ------------------------------------------------------------------ the board */

type Board = {
  width: number;
  height: number;
  m: number;
  requires: Requirement[];
  weights: number[];
  /** Requirements worth putting on a mutation's edge rather than its corner. See `PackingOptions`. */
  seat: boolean[];
  locked: Set<string>;
};

/** A laid-out greenhouse: where the mutations are, and what is planted in every other cell. */
type Solution = {
  targets: number[];
  /** Cell -> requirement index, or -1. A multi-cell plant writes its index into all of its cells. */
  cell: Int8Array;
  /** Anchors per requirement, so a plant can be lifted whole. */
  anchors: number[][];
};

const at = (b: Board, r: number, c: number) => r * b.width + c;
const rowOf = (b: Board, i: number) => Math.floor(i / b.width);
const colOf = (b: Board, i: number) => i % b.width;

function inside(b: Board, r: number, c: number): boolean {
  return r >= 0 && c >= 0 && r < b.height && c < b.width;
}

/** Every cell of the ring around a target, on the plot. */
function ringOf(b: Board, target: number): number[] {
  const r0 = rowOf(b, target);
  const c0 = colOf(b, target);
  const out: number[] = [];
  for (let r = r0 - 1; r <= r0 + b.m; r++) {
    for (let c = c0 - 1; c <= c0 + b.m; c++) {
      if (!inside(b, r, c)) continue;
      if (r >= r0 && r < r0 + b.m && c >= c0 && c < c0 + b.m) continue;
      out.push(at(b, r, c));
    }
  }
  return out;
}

/** The cells a target itself covers. */
function bodyOf(b: Board, target: number): number[] {
  const r0 = rowOf(b, target);
  const c0 = colOf(b, target);
  const out: number[] = [];
  for (let r = r0; r < r0 + b.m; r++) for (let c = c0; c < c0 + b.m; c++) out.push(at(b, r, c));
  return out;
}

/** Where a target could stand: on the plot, off the locked cells. */
function positions(b: Board): number[] {
  const out: number[] = [];
  for (let r = 0; r + b.m <= b.height; r++) {
    for (let c = 0; c + b.m <= b.width; c++) {
      let clear = true;
      for (let rr = r; rr < r + b.m && clear; rr++)
        for (let cc = c; cc < c + b.m && clear; cc++) if (b.locked.has(`${rr},${cc}`)) clear = false;
      // A ring that runs short of what the condition asks for can never be filled, however the
      // rest of the plot is arranged — so a corner position is discarded here rather than tried.
      if (clear && ringOf(b, at(b, r, c)).length >= b.requires.reduce((s, x) => s + x.cells, 0)) {
        out.push(at(b, r, c));
      }
    }
  }
  return out;
}

/* --------------------------------------------------------------- construction */

/**
 * Build a greenhouse by adding one mutation at a time.
 *
 * Each pass takes the placeable positions in a shuffled order and tries them one by one, keeping
 * a mutation only when every mutation already down — and the new one — can still be fed. That
 * check is the whole trick: it means the search never walks through the enormous space of plant
 * arrangements that grow nothing, and never has to recognise an illegal greenhouse after the fact
 * because it cannot build one.
 */
function grow(b: Board, random: () => number, attempt: number): Solution | null {
  const spots = positions(b);
  if (spots.length === 0) return null;

  // The first attempts go in reading order, which is where the regular lattices live; later ones
  // are shuffled, which is where the irregular arrangements live.
  const order = spots.slice();
  if (attempt > 0) {
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
  }

  const chosen: number[] = [];
  for (const spot of order) {
    if (overlapsAny(b, chosen, spot)) continue;
    const trial = [...chosen, spot];
    if (feed(b, trial) === null) continue;
    chosen.push(spot);
  }
  return chosen.length === 0 ? null : solutionFrom(b, chosen);
}

function overlapsAny(b: Board, chosen: number[], spot: number): boolean {
  const body = new Set(bodyOf(b, spot));
  for (const other of chosen) for (const cell of bodyOf(b, other)) if (body.has(cell)) return true;
  return false;
}

/**
 * Can every one of these mutations be fed at once, and if so with what planted?
 *
 * Cells are handed out to the hungriest clause first — the one furthest from being satisfied — and
 * within that to the cell that feeds the most other mutations still wanting the same plant, with
 * the cheaper plant winning ties. Greedy, and it can fail on an arrangement a cleverer assignment
 * would have fed; a failure only ever costs one candidate mutation, never correctness.
 */
function feed(b: Board, targets: number[]): { cell: Int8Array; anchors: number[][] } | null {
  const size = b.width * b.height;
  const cell = new Int8Array(size).fill(-1);
  const anchors: number[][] = b.requires.map(() => []);

  // Cells the mutations themselves occupy, and locked cells, can hold nothing.
  const blocked = new Uint8Array(size);
  for (const t of targets) for (const c of bodyOf(b, t)) blocked[c] = 1;
  for (const k of b.locked) {
    const [r, c] = k.split(",").map(Number);
    if (inside(b, r, c)) blocked[at(b, r, c)] = 1;
  }

  const rings = targets.map((t) => ringOf(b, t));
  const need = targets.map(() => b.requires.map((r) => r.cells));

  for (;;) {
    // The clause in most trouble, measured as what is still missing.
    let worst = -1;
    let worstReq = -1;
    let missing = 0;
    for (let t = 0; t < targets.length; t++) {
      for (let i = 0; i < b.requires.length; i++) {
        if (need[t][i] > missing) {
          missing = need[t][i];
          worst = t;
          worstReq = i;
        }
      }
    }
    if (worst === -1) break; // everything is fed

    const wanted = b.requires[worstReq].size;
    let bestCell = -1;
    let bestScore = -Infinity;
    for (const candidate of rings[worst]) {
      if (!canPlant(b, cell, blocked, candidate, wanted)) continue;
      // How many hungry mutations this one plant would feed, counting each cell it covers.
      let serves = 0;
      for (let t = 0; t < targets.length; t++) {
        if (need[t][worstReq] === 0) continue;
        serves += Math.min(need[t][worstReq], covers(b, candidate, wanted, targets[t]));
      }
      // A plant whose effect only reaches orthogonally is worth putting on an edge even though the
      // condition would accept a corner — the corner satisfies the count and reaches nothing.
      const seats = b.seat[worstReq] && onEdge(b, candidate, wanted, targets);
      const score = serves * 1000 + (seats ? 500 : 0) - b.weights[worstReq] * 10 - candidate / (size * 10);
      if (score > bestScore) {
        bestScore = score;
        bestCell = candidate;
      }
    }
    if (bestCell === -1) return null; // this arrangement cannot be fed

    plant(b, cell, bestCell, worstReq, wanted);
    anchors[worstReq].push(bestCell);
    for (let t = 0; t < targets.length; t++) {
      need[t][worstReq] = Math.max(0, need[t][worstReq] - covers(b, bestCell, wanted, targets[t]));
    }
  }

  return { cell, anchors };
}

/** Whether a plant here would sit on some mutation's edge rather than only on its corners. */
function onEdge(b: Board, anchor: number, size: number, targets: number[]): boolean {
  const pr = rowOf(b, anchor);
  const pc = colOf(b, anchor);
  for (const target of targets) {
    const tr = rowOf(b, target);
    const tc = colOf(b, target);
    for (let r = pr; r < pr + size; r++) {
      for (let c = pc; c < pc + size; c++) {
        const vertical = c >= tc && c < tc + b.m && (r === tr - 1 || r === tr + b.m);
        const horizontal = r >= tr && r < tr + b.m && (c === tc - 1 || c === tc + b.m);
        if (vertical || horizontal) return true;
      }
    }
  }
  return false;
}

/** Room for a `size` x `size` plant anchored here, without covering a mutation or a locked cell. */
function canPlant(b: Board, cell: Int8Array, blocked: Uint8Array, anchor: number, size: number): boolean {
  const r0 = rowOf(b, anchor);
  const c0 = colOf(b, anchor);
  if (r0 + size > b.height || c0 + size > b.width) return false;
  for (let r = r0; r < r0 + size; r++) {
    for (let c = c0; c < c0 + size; c++) {
      const i = at(b, r, c);
      if (blocked[i] || cell[i] !== -1) return false;
    }
  }
  return true;
}

function plant(b: Board, cell: Int8Array, anchor: number, req: number, size: number): void {
  const r0 = rowOf(b, anchor);
  const c0 = colOf(b, anchor);
  for (let r = r0; r < r0 + size; r++) for (let c = c0; c < c0 + size; c++) cell[at(b, r, c)] = req;
}

function lift(b: Board, cell: Int8Array, anchor: number, size: number): void {
  const r0 = rowOf(b, anchor);
  const c0 = colOf(b, anchor);
  for (let r = r0; r < r0 + size; r++) for (let c = c0; c < c0 + size; c++) cell[at(b, r, c)] = -1;
}

/** Cells of one plant that land in one mutation's ring. */
function covers(b: Board, anchor: number, size: number, target: number): number {
  const pr = rowOf(b, anchor);
  const pc = colOf(b, anchor);
  const tr = rowOf(b, target);
  const tc = colOf(b, target);
  let hit = 0;
  for (let r = pr; r < pr + size; r++) {
    for (let c = pc; c < pc + size; c++) {
      if (!inside(b, r, c)) continue;
      const inRing = r >= tr - 1 && r <= tr + b.m && c >= tc - 1 && c <= tc + b.m;
      const inTarget = r >= tr && r < tr + b.m && c >= tc && c < tc + b.m;
      if (inRing && !inTarget) hit++;
    }
  }
  return hit;
}

/** Feed a target set, then take back out whatever it turns out not to need. */
function solutionFrom(b: Board, targets: number[]): Solution | null {
  if (targets.length === 0) return null;
  const fed = feed(b, targets);
  if (!fed) return null;
  const solution: Solution = { targets, cell: fed.cell, anchors: fed.anchors };
  trim(b, solution);
  return solution;
}

/**
 * Lift every plant nothing needs, dearest first.
 *
 * The same argument as the pruning in the tile packer: the assignment above hands out cells to
 * whoever is hungriest at the time, and a cell handed out early can be made redundant by one
 * handed out later.
 */
function trim(b: Board, s: Solution): void {
  const rings = s.targets.map((t) => ringOf(b, t));
  const held = s.targets.map((_, t) =>
    b.requires.map((_r, i) => rings[t].reduce((n, c) => n + (s.cell[c] === i ? 1 : 0), 0)),
  );

  const order: { req: number; anchor: number; seats: boolean }[] = [];
  for (let i = 0; i < s.anchors.length; i++) {
    for (const anchor of s.anchors[i]) {
      order.push({ req: i, anchor, seats: b.seat[i] && onEdge(b, anchor, b.requires[i].size, s.targets) });
    }
  }
  // Dearest first, but a plant that is seating an effect is offered up last whatever it costs.
  order.sort((a, z) => Number(a.seats) - Number(z.seats) || b.weights[z.req] - b.weights[a.req]);

  for (const { req, anchor } of order) {
    const size = b.requires[req].size;
    const loss = s.targets.map((t) => covers(b, anchor, size, t));
    let spare = true;
    for (let t = 0; t < s.targets.length && spare; t++) {
      if (loss[t] === 0) continue;
      if (held[t][req] - loss[t] < b.requires[req].cells) spare = false;
    }
    if (!spare) continue;
    for (let t = 0; t < s.targets.length; t++) held[t][req] -= loss[t];
    lift(b, s.cell, anchor, size);
    s.anchors[req].splice(s.anchors[req].indexOf(anchor), 1);
  }
}

function betterThan(candidate: Solution, best: Solution | null, weights: number[]): boolean {
  if (!best) return true;
  if (candidate.targets.length !== best.targets.length) return candidate.targets.length > best.targets.length;
  const a = bill(candidate.anchors.map((x) => x.length), weights);
  const z = bill(best.anchors.map((x) => x.length), weights);
  if (a !== z) return a < z;
  return candidate.anchors.reduce((n, x) => n + x.length, 0) < best.anchors.reduce((n, x) => n + x.length, 0);
}

/** Read a target set back off a drawn grid, so the tile answer can seed the search. */
function targetsOfGrid(grid: CellKind[][], m: number, width: number, height: number): number[] {
  const seen = new Uint8Array(width * height);
  const out: number[] = [];
  for (let r = 0; r + m <= height; r++) {
    for (let c = 0; c + m <= width; c++) {
      let whole = true;
      for (let rr = r; rr < r + m && whole; rr++)
        for (let cc = c; cc < c + m && whole; cc++)
          if (grid[rr][cc] !== "target" || seen[rr * width + cc]) whole = false;
      if (!whole) continue;
      for (let rr = r; rr < r + m; rr++) for (let cc = c; cc < c + m; cc++) seen[rr * width + cc] = 1;
      out.push(r * width + c);
    }
  }
  return out;
}

/** The solution in the shape the rest of the app already reads. */
function render(b: Board, s: Solution, ceiling: number): Packing {
  const grid: CellKind[][] = Array.from({ length: b.height }, (_, r) =>
    Array.from({ length: b.width }, (_, c) => {
      if (b.locked.has(`${r},${c}`)) return "locked" as CellKind;
      const value = s.cell[at(b, r, c)];
      return value >= 0 ? (value as CellKind) : ("empty" as CellKind);
    }),
  );
  for (const t of s.targets) for (const cell of bodyOf(b, t)) grid[rowOf(b, cell)][colOf(b, cell)] = "target";

  const plants = s.anchors.map((list) => list.length);
  const seated = s.targets.filter((t) =>
    s.anchors.some((list, i) => b.seat[i] && list.some((anchor) => onEdge(b, anchor, b.requires[i].size, [t]))),
  ).length;
  return {
    targets: s.targets.length,
    plants,
    cells: plants.map((n, i) => n * b.requires[i].size ** 2),
    pruned: 0,
    seated,
    grid,
    // Not a tiling, so there is no period to report. Saying 0x0 is how a reader tells an optimised
    // plot from a stamped one without being told.
    period: { rows: 0, cols: 0 },
    ceiling,
  };
}
