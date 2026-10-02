/**
 * Given where the mutations go, what should be planted in every other cell — answered exactly.
 *
 * This is the half of the layout problem that was never being searched. The packer decides two
 * things at once: *where the mutations sit*, which fixes how many you grow, and *which crop fills
 * each cell around them*, which fixes what it costs. The first is what every argument in
 * `greenhouseLayout` is about. The second was being settled by whichever repeating tile happened to
 * win, and on a mutation whose ring is completely full that is the only question left.
 *
 * Phantomleaf is where it showed. Sixteen is provably the most that can grow, so the layout search
 * was skipped outright — and the tile that wins puts twenty-five Chorus Fruit on the plot when
 * twenty-three will do. At a hundred thousand coins each that is a quarter of a million per
 * greenhouse, three quarters of a million across three. Twenty-two is impossible and twenty-three is
 * reachable; nothing in the old code could tell the difference, because nothing was looking.
 *
 * **Counts, not coins.** The obvious search — branch and bound on the total bill — does not work
 * here, and it is worth saying why rather than leaving the next person to rediscover it. The
 * optimum is only a few per cent cheaper than the layout you start from, so the bound has to be
 * accurate to within a few per cent to reject anything, and it never is: three million nodes on
 * Phantomleaf proved nothing at all. Capping the *number* of the dear crop prunes immediately
 * instead — a branch that has already placed twenty-four Chorus Fruit is dead the moment the cap is
 * twenty-three, whatever the rest of the plot does. So the crops are settled one at a time, dearest
 * first, each pushed down to the fewest that still admits a working plot.
 *
 * On a full ring that is exactly minimising the bill, because the cell count is fixed: one fewer of
 * the dear crop is one more of the cheap one. Where a ring has slack the two can come apart, so the
 * answer is priced at the end and the layout it started from is kept if it was somehow better.
 *
 * Single-cell supports only. A 2x2 or 3x3 plant covers several cells at once and is placed at an
 * offset rather than chosen per cell, which is a different problem; the caller checks and leaves
 * those to the general search.
 */

export type AssignProblem = {
  /** How many cells of each requirement every mutation needs around it. */
  requires: number[];
  /** Relative cost of one plant of each requirement. */
  weights: number[];
  /**
   * One entry per mutation: the cells of its ring, as indices into a cell list the caller keeps.
   * Cells shared between rings are what the whole thing turns on, so they appear in each.
   */
  rings: number[][];
  /** How many cells there are in all. Every index in `rings` must be below it. */
  cells: number;
  /**
   * A layout that already works, as a requirement index per cell or -1 for empty.
   *
   * Both the starting point and the floor: every crop is pushed down from the count this has, and
   * if nothing improves, this is what comes back.
   */
  seed: Int8Array;
  /** Nodes per probe before giving up on proving that one. Guards a browser, not correctness. */
  budget?: number;
};

export type Assignment = {
  /** Requirement index per cell, or -1 for an empty cell. */
  cell: Int8Array;
  /** Plants of each requirement. */
  plants: number[];
  cost: number;
  /** False where a probe ran out of budget, so some crop's count is a ceiling rather than proven. */
  proven: boolean;
  nodes: number;
};

const DEFAULT_BUDGET = 400_000;

export function assignRings(p: AssignProblem): Assignment | null {
  const k = p.requires.length;
  const n = p.cells;
  if (k === 0 || n === 0 || p.seed.length !== n) return null;

  const targets = p.rings.length;
  const cellRings: number[][] = Array.from({ length: n }, () => []);
  p.rings.forEach((ring, t) => {
    for (const cell of ring) if (cell >= 0 && cell < n) cellRings[cell].push(t);
  });
  const degree = cellRings.map((rings) => rings.length);

  // Hardest first: a cell feeding four rings decides far more than one feeding a single ring, and
  // settling it early is what lets a cap reject a branch while it is still shallow.
  const order = [...Array(n).keys()].sort((a, b) => degree[b] - degree[a]);
  // Running total of the ordered degrees. Because `order` is sorted by degree descending, the cells
  // left at any depth are the best available, so "how many more cells could cover this many
  // ring-slots" is a binary search over this.
  const supply = new Int32Array(n + 1);
  for (let i = 0; i < n; i++) supply[i + 1] = supply[i] + degree[order[i]];

  const costOf = (choices: Int8Array) => {
    let cost = 0;
    for (const choice of choices) if (choice >= 0) cost += p.weights[choice] ?? 0;
    return cost;
  };
  const countOf = (choices: Int8Array) => {
    const out = new Array(k).fill(0);
    for (const choice of choices) if (choice >= 0) out[choice]++;
    return out;
  };

  let nodes = 0;
  let proven = true;
  const budget = p.budget ?? DEFAULT_BUDGET;

  /** Is there a working plot that plants no more than `caps[i]` of each crop? */
  function probe(caps: number[]): Int8Array | null {
    const have: Int16Array[] = p.rings.map(() => new Int16Array(k));
    const undecided = Int16Array.from(p.rings.map((ring) => ring.length));
    const short = p.requires.map((cells) => cells * targets);
    const used = new Array(k).fill(0);
    const cell = new Int8Array(n).fill(-1);
    let spent = 0;
    let answer: Int8Array | null = null;

    // Cheapest first so a working plot turns up early; empty last, because it costs nothing and
    // would otherwise send the search down branches that look free and satisfy nothing.
    const choices = [...[...Array(k).keys()].sort((a, b) => p.weights[a] - p.weights[b]), -1];

    const walk = (at: number): boolean => {
      if (++spent > budget) {
        proven = false;
        return false;
      }
      if (at === n) {
        answer = cell.slice();
        return true;
      }
      // Every crop must still fit under its cap, using the best cells that are left.
      for (let i = 0; i < k; i++) {
        if (short[i] <= 0) continue;
        const want = supply[at] + short[i];
        let low = at;
        let high = n;
        while (low < high) {
          const mid = (low + high) >> 1;
          if (supply[mid] >= want) high = mid;
          else low = mid + 1;
        }
        if (supply[low] < want) return false;
        if (used[i] + (low - at) > caps[i]) return false;
      }

      const which = order[at];
      const mine = cellRings[which];
      for (const choice of choices) {
        if (choice >= 0 && used[choice] >= caps[choice]) continue;

        for (const t of mine) {
          undecided[t]--;
          if (choice >= 0) {
            if (have[t][choice] < p.requires[choice]) short[choice]--;
            have[t][choice]++;
          }
        }
        if (choice >= 0) used[choice]++;

        let fits = true;
        for (const t of mine) {
          // Every outstanding demand of this ring has to fit in the cells it has left — all of them
          // together, not one crop at a time. Checking them separately is what let the search spend
          // its whole budget on plots where each crop could still be satisfied but not both: a full
          // eight-cell ring wanting four and four has no room for an empty cell, and only the joint
          // count says so.
          let owed = 0;
          for (let i = 0; i < k; i++) owed += Math.max(0, p.requires[i] - have[t][i]);
          if (owed > undecided[t]) {
            fits = false;
            break;
          }
        }
        let done = false;
        if (fits) {
          cell[which] = choice;
          done = walk(at + 1);
          if (!done) cell[which] = -1;
        }

        if (choice >= 0) used[choice]--;
        for (const t of mine) {
          undecided[t]++;
          if (choice >= 0) {
            have[t][choice]--;
            if (have[t][choice] < p.requires[choice]) short[choice]++;
          }
        }
        if (done) return true;
        if (spent > budget) return false;
      }
      return false;
    };

    const ok = walk(0);
    nodes += spent;
    return ok ? answer : null;
  }

  // Start from what already works and settle each crop in turn, dearest first.
  //
  // Only the crop being settled and the ones already settled are capped. Everything else has to
  // stay free, because taking one plant of the dear crop out means putting one of a cheaper crop in
  // — capping those at whatever the starting layout happened to use makes every reduction look
  // impossible, which is the shape the first version of this had and the reason it proved nothing.
  //
  // Bisected rather than stepped down one at a time. Feasibility is monotone — if a plot works
  // with twenty-three it works with twenty-four — so the fewest is a binary search, and that is
  // the difference between five probes and seventeen when the starting layout is far out. Stepping
  // was enough to settle Chorus Fruit, which only had two to give up, and nowhere near enough for
  // the crop on the other side of the same plot, which had seventeen.
  let best: Int8Array = Int8Array.from(p.seed);
  const fixed: number[] = p.requires.map(() => Infinity);
  const byPrice = [...Array(k).keys()].sort((a, b) => p.weights[b] - p.weights[a]);

  for (const crop of byPrice) {
    let low = 0;
    let high = countOf(best)[crop];
    while (low < high && proven) {
      const mid = (low + high) >> 1;
      const trial = fixed.slice();
      trial[crop] = mid;
      const found = probe(trial);
      if (found) {
        high = mid;
        best = Int8Array.from(found);
      } else {
        low = mid + 1;
      }
    }
    // `high` is the fewest that admitted a working plot. Settled: later crops may not undo it.
    fixed[crop] = high;
    if (!proven) break;
  }

  // Priced at the end rather than assumed: where a ring has slack, fewer of the dear crop can cost
  // more overall, and the layout we were handed is then the better one.
  if (costOf(best) > costOf(p.seed)) best = Int8Array.from(p.seed);

  return { cell: best, plants: countOf(best), cost: costOf(best), proven, nodes };
}
