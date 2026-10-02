import type { CellKind, Packing } from "./greenhouseLayout";

/**
 * What the plants around a mutation do to it.
 *
 * Every crop in the greenhouse grants its effects to the crops in *orthogonally* adjacent slots —
 * the Greenhouse page is explicit that the diagonals are skipped, which matters because a
 * spreading condition counts the diagonals and an effect does not. So a ring can satisfy a
 * condition while reaching the mutation with nothing at all, and the two have to be read apart.
 *
 * **A plant grants several at once.** Shellfruit retains water *and* grants immunity; Nether Wart
 * boosts yield *and* costs farming XP. The first version of this read one effect per plant and
 * returned on the first match, so every Shellfruit in the game was silently not granting immunity.
 * Effects are a set, per plant and per ring.
 *
 * **Present or absent, never counted.** In game a crop shows the effects on it as a ticked list, so
 * two neighbours granting Harvest Boost is the same tick as one rather than twice the buff.
 *
 * **Improved replaces plain.** Stated on the page for exactly one pair — "Improved Harvest Boost
 * ... Overrides Harvest Boost" — and the buffs are built to one pattern, so the same is taken for
 * the water and XP pairs.
 *
 * **Immunity cancels the negatives.** It "provides Immunity to negative effects", so a ring holding
 * both a Harvest Loss and an Immunity comes out at neither.
 */

export type CropEffect =
  | "harvest-boost"
  | "improved-harvest-boost"
  | "harvest-loss"
  | "xp-boost"
  | "improved-xp-boost"
  | "xp-loss"
  | "water-retain"
  | "improved-water-retain"
  | "water-drain"
  | "immunity"
  | "bonus-drops"
  | "effect-spread";

/** The wiki's own wording, which is what the scrape stores. Matched whole, never as a substring. */
const BY_NAME: Record<string, CropEffect> = {
  "harvest boost": "harvest-boost",
  "improved harvest boost": "improved-harvest-boost",
  "harvest loss": "harvest-loss",
  "xp boost": "xp-boost",
  "improved xp boost": "improved-xp-boost",
  "xp loss": "xp-loss",
  "water retain": "water-retain",
  "improved water retain": "improved-water-retain",
  "water drain": "water-drain",
  immunity: "immunity",
  "bonus drops": "bonus-drops",
  "effect spread": "effect-spread",
};

/** Something with effects: a mutation, or a base crop that carries them. */
export type Effecting = { effects?: string[] } | undefined;

/**
 * Everything one plant grants its orthogonal neighbours.
 *
 * Matched on the whole string rather than by searching the joined text, because "Improved Water
 * Retain" contains "Water Retain" and a substring match would read one plant as granting both.
 */
export function effectsOf(plant: Effecting): Set<CropEffect> {
  const out = new Set<CropEffect>();
  for (const name of plant?.effects ?? []) {
    const effect = BY_NAME[String(name).trim().toLowerCase()];
    if (effect) out.add(effect);
  }
  return out;
}

/** The negatives, which an Immunity in the same ring cancels. */
const NEGATIVE: ReadonlySet<CropEffect> = new Set<CropEffect>(["harvest-loss", "xp-loss", "water-drain"]);

/** Whether an effect is in force, after Immunity has had its say. */
export function inForce(ring: ReadonlySet<CropEffect>, effect: CropEffect): boolean {
  if (!ring.has(effect)) return false;
  return !(NEGATIVE.has(effect) && ring.has("immunity"));
}

/**
 * What the ring does to how much a harvest yields, as a multiplier on the crop drops.
 *
 * Only the base crops move. The mutation itself is one item a harvest however well it is fed, and
 * the Ethereal Vine is a chance rather than a quantity — Yield is explicitly "the base crops given
 * when harvesting", and applying it to the mutation's own price would roughly double some rows for
 * nothing.
 */
export function yieldModifier(ring: ReadonlySet<CropEffect>, buffs: { harvestBoost?: number; improvedHarvestBoost?: number; harvestLoss?: number }): number {
  const boost = ring.has("improved-harvest-boost")
    ? (buffs.improvedHarvestBoost ?? 0.3)
    : ring.has("harvest-boost")
      ? (buffs.harvestBoost ?? 0.2)
      : 0;
  const loss = inForce(ring, "harvest-loss") ? (buffs.harvestLoss ?? -0.2) : 0;
  return 1 + boost + loss;
}

/** What the ring does to the farming XP a harvest grants. Not priced; reported. */
export function xpModifier(ring: ReadonlySet<CropEffect>, buffs: { xpBoost?: number; improvedXpBoost?: number; xpLoss?: number }): number {
  const boost = ring.has("improved-xp-boost")
    ? (buffs.improvedXpBoost ?? 0.3)
    : ring.has("xp-boost")
      ? (buffs.xpBoost ?? 0.2)
      : 0;
  const loss = inForce(ring, "xp-loss") ? (buffs.xpLoss ?? -0.2) : 0;
  return 1 + boost + loss;
}

/**
 * Whether this mutation's harvest also rolls the Harvest Bounty table.
 *
 * Not a free extra. The Greenhouse page puts it behind one effect: "Harvesting crops with the Bonus
 * Drops effect in the Greenhouse rolls for Harvest Bounty". So it is worth what the ring makes it
 * worth, and on a ring with nothing granting it, nothing.
 */
export function rollsBounty(ring: ReadonlySet<CropEffect>): boolean {
  return ring.has("bonus-drops");
}

/**
 * The effects reaching each mutation in a laid-out plot.
 *
 * One set per mutation rather than one for the plot, because they differ: a mutation against the
 * plot edge has fewer neighbours than one in the middle, and on some layouts that is the difference
 * between a row that waters itself and one that does not.
 */
export function effectsAtTargets(
  requires: { id: string }[],
  lookup: (id: string) => Effecting,
  packing: Packing,
  targetSize: number,
): Set<CropEffect>[] {
  const grid = packing.grid;
  const height = grid.length;
  const width = height > 0 ? grid[0].length : 0;
  const size = Math.max(1, targetSize || 1);
  const granted = requires.map((r) => effectsOf(lookup(r.id)));

  const claimed = new Uint8Array(width * height);
  const out: Set<CropEffect>[] = [];

  const add = (into: Set<CropEffect>, cell: CellKind) => {
    if (typeof cell !== "number") return;
    for (const effect of granted[cell] ?? []) into.add(effect);
  };

  for (let r = 0; r + size <= height; r++) {
    for (let c = 0; c + size <= width; c++) {
      let whole = true;
      for (let rr = r; rr < r + size && whole; rr++)
        for (let cc = c; cc < c + size && whole; cc++)
          if (grid[rr][cc] !== "target" || claimed[rr * width + cc]) whole = false;
      if (!whole) continue;
      for (let rr = r; rr < r + size; rr++) for (let cc = c; cc < c + size; cc++) claimed[rr * width + cc] = 1;

      // Orthogonal only: the cells sharing an edge with the block, never its four corners.
      const ring = new Set<CropEffect>();
      for (let rr = r; rr < r + size; rr++) {
        for (const cc of [c - 1, c + size]) {
          if (cc < 0 || cc >= width) continue;
          add(ring, grid[rr][cc]);
        }
      }
      for (let cc = c; cc < c + size; cc++) {
        for (const rr of [r - 1, r + size]) {
          if (rr < 0 || rr >= height) continue;
          add(ring, grid[rr][cc]);
        }
      }
      out.push(ring);
    }
  }
  return out;
}

/** The effects every mutation in the plot sees, for a figure that has to be one number. */
export function sharedEffects(rings: Set<CropEffect>[]): Set<CropEffect> {
  if (rings.length === 0) return new Set();
  const out = new Set(rings[0]);
  for (const ring of rings.slice(1)) for (const effect of [...out]) if (!ring.has(effect)) out.delete(effect);
  return out;
}
