import { test } from "node:test";
import assert from "node:assert/strict";

import { assignRings, type AssignProblem } from "../src/lib/greenhouseAssign";

/**
 * Phantomleaf's plot, which is where this came from: sixteen mutations on a 10x10, each wanting
 * four Chorus Fruit and four Shellfruit in its eight-cell ring. The ring is full, so every one of
 * the sixty-five cells around them must hold something and the only question is which.
 */
function phantomleaf(): AssignProblem & { cellAt: Map<number, number> } {
  const W = 10;
  const targets: number[] = [];
  for (const r of [1, 3, 5, 7]) for (const c of [1, 3, 5, 7]) targets.push(r * W + c);

  const cellAt = new Map<number, number>();
  const rings = targets.map((t) => {
    const r0 = Math.floor(t / W);
    const c0 = t % W;
    const ring: number[] = [];
    for (let r = r0 - 1; r <= r0 + 1; r++) {
      for (let c = c0 - 1; c <= c0 + 1; c++) {
        if (r === r0 && c === c0) continue;
        const flat = r * W + c;
        if (!cellAt.has(flat)) cellAt.set(flat, cellAt.size);
        ring.push(cellAt.get(flat)!);
      }
    }
    return ring;
  });

  // The layout the repeating tile produces: Chorus on every (even, even) cell. Valid, and two
  // plants dearer than it needs to be.
  const seed = new Int8Array(cellAt.size);
  for (const [flat, at] of cellAt) {
    const r = Math.floor(flat / W);
    const c = flat % W;
    seed[at] = r % 2 === 0 && c % 2 === 0 ? 0 : 1;
  }
  return { requires: [4, 4], weights: [1, 0.35], rings, cells: cellAt.size, seed, cellAt };
}

/** Every mutation really does get what its condition asks for. */
function check(p: AssignProblem, cell: Int8Array): void {
  p.rings.forEach((ring, t) => {
    const have = p.requires.map(() => 0);
    for (const at of ring) if (cell[at] >= 0) have[cell[at]]++;
    p.requires.forEach((need, i) => assert.ok(have[i] >= need, `ring ${t} has ${have[i]} of crop ${i}, needs ${need}`));
  });
}

test("it finds the cheapest split, and proves it", () => {
  const p = phantomleaf();
  const seedChorus = [...p.seed].filter((c) => c === 0).length;
  assert.equal(seedChorus, 25, "the tile's own answer");

  const got = assignRings(p)!;
  assert.ok(got.proven, "proved rather than given up on");
  assert.equal(got.plants[0], 23, "and twenty-three is the floor");
  assert.equal(got.plants[0] + got.plants[1], 65, "the cell count was never in question");
  check(p, got.cell);
});

test("twenty-two really is impossible, so the floor is a floor", () => {
  // The counting argument: sixteen rings want four cells each, a cell lies in at most four rings,
  // and only nine cells of the plot lie in four. Nine fours is thirty-six of the sixty-four slots;
  // the rest come two at a time, so fourteen more cells at least.
  const p = phantomleaf();
  const got = assignRings(p)!;
  const degree = new Map<number, number>();
  for (const ring of p.rings) for (const at of ring) degree.set(at, (degree.get(at) ?? 0) + 1);
  const fours = [...degree.values()].filter((d) => d === 4).length;
  assert.equal(fours, 9);
  assert.equal(9 + Math.ceil((16 * 4 - 9 * 4) / 2), got.plants[0]);
});

test("it never hands back something dearer than it was given", () => {
  // The search is lexicographic — fewest of the dear crop first — and where a ring has slack that
  // can cost more overall than the layout it started from. It prices the answer before returning it.
  const p = phantomleaf();
  const seedCost = [...p.seed].reduce((sum, c) => sum + (c >= 0 ? p.weights[c] : 0), 0);
  const got = assignRings(p)!;
  assert.ok(got.cost <= seedCost, `${got.cost} against ${seedCost}`);
});

test("turn the prices round and so does the answer", () => {
  const p = phantomleaf();
  const flipped = assignRings({ ...p, weights: [0.35, 1] })!;
  assert.equal(flipped.plants[1], 23, "now it is Shellfruit that gets economised");
  check(p, flipped.cell);
});

test("a ring with slack may leave cells empty", () => {
  // Two of eight, so six cells of every ring are free. Nothing should be planted in them.
  const W = 10;
  const targets = [11, 13, 31, 33];
  const cellAt = new Map<number, number>();
  const rings = targets.map((t) => {
    const r0 = Math.floor(t / W), c0 = t % W, ring: number[] = [];
    for (let r = r0 - 1; r <= r0 + 1; r++)
      for (let c = c0 - 1; c <= c0 + 1; c++) {
        if (r === r0 && c === c0) continue;
        const flat = r * W + c;
        if (!cellAt.has(flat)) cellAt.set(flat, cellAt.size);
        ring.push(cellAt.get(flat)!);
      }
    return ring;
  });
  const seed = new Int8Array(cellAt.size).fill(0);
  const p: AssignProblem = { requires: [2], weights: [1], rings, cells: cellAt.size, seed };
  const got = assignRings(p)!;
  assert.ok(got.plants[0] < cellAt.size, "it did not plant every cell");
  check(p, got.cell);
  // Three, and three is the floor: the only cell all four share is the one in the middle, which
  // gives each of them one of the two they need. The second has to come from cells that serve two
  // mutations apiece, so two more.
  assert.equal(got.plants[0], 3);
  assert.ok(got.proven);
});

test("a budget too small gives an answer that works, and says it is unproven", () => {
  const p = phantomleaf();
  const got = assignRings({ ...p, budget: 50 })!;
  assert.equal(got.proven, false);
  check(p, got.cell);
  assert.ok(got.cost <= [...p.seed].reduce((s, c) => s + (c >= 0 ? p.weights[c] : 0), 0));
});

test("nothing to assign is not an answer", () => {
  assert.equal(assignRings({ requires: [], weights: [], rings: [], cells: 0, seed: new Int8Array() }), null);
  // A seed that does not describe this plot is a caller bug, not something to guess around.
  const p = phantomleaf();
  assert.equal(assignRings({ ...p, seed: new Int8Array(3) }), null);
});
