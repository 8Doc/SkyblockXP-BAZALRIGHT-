import { num } from "./format";

/**
 * The volume floor: how slow a thing you are willing to look at.
 *
 * A flip list's worst failure is a huge spread on something that trades twice a week, and no
 * amount of cleverness in the ranking removes the reader's need to say "not that slow". This is
 * the control that lets them, and it is separate from the derivations because it is a preference
 * rather than a fact about the market.
 */

/**
 * The slider's stops.
 *
 * Bazaar volumes run from a couple of trades a week to two hundred thousand an hour, so a linear
 * slider spends nine tenths of its travel in a range nobody wants and still cannot reach the top.
 * These are the 1-2-3-5-7 preferred numbers, five to a decade, which puts the resolution where the
 * decisions are: the gap between three an hour and seven an hour is the gap between a flip that
 * works and one that does not, and the gap between 20,000 and 50,000 is not a gap at all.
 */
export const VOLUME_LADDER = [
  0, 1, 2, 3, 5, 7, 10, 20, 30, 50, 70, 100, 200, 300, 500, 700, 1_000, 2_000, 3_000, 5_000, 7_000,
  10_000, 20_000, 50_000, 100_000,
];

/** Nearest stop at or below a value, so a remembered setting lands back on its own notch. */
export function ladderIndex(value: number): number {
  const at = VOLUME_LADDER.findIndex((stop) => stop > value);
  return at === -1 ? VOLUME_LADDER.length - 1 : Math.max(0, at - 1);
}

/**
 * "20/hr · one every 3 min".
 *
 * A rate is abstract and a wait is not, and the wait is what the floor is really about — you are
 * deciding how long you are prepared to sit watching an order that has not moved.
 */
export function volumeNote(perHour: number): string {
  if (perHour <= 0) return "off";

  // Below about one and a half a minute the wait is the readable half of the pair; above it, the
  // rate is. Rounding "60 / perHour" all the way up would have a hundred an hour read as one a
  // minute, which is a third slower than the truth.
  const minutes = Math.round(60 / perHour);
  const gap =
    perHour < 1
      ? `one every ${(1 / perHour).toFixed(1)} hr`
      : perHour === 1
        ? "one an hour"
        : perHour < 90
          ? minutes > 1
            ? `one every ${minutes} min`
            : "one a minute"
          : `${num(Math.round(perHour / 60))} a minute`;

  return `${num(perHour)}/hr · ${gap}`;
}
