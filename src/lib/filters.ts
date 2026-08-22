import { num } from "./format";

/**
 * The two floors a flip list needs, and the sliders that set them.
 *
 * Both are preferences rather than facts about the market, which is why they live here and not
 * in the derivations. They answer different questions and neither substitutes for the other:
 * *volume* asks how often the thing trades, and *depth* asks whether the price it trades at is
 * standing on anything.
 *
 * Both sliders run on a ladder rather than linearly, for the same reason: the quantities span
 * five or six orders of magnitude, and a linear control spends nine tenths of its travel in the
 * part nobody wants.
 */

/** Nearest stop at or below a value, so a remembered setting lands back on its own notch. */
function stopAtOrBelow(ladder: number[], value: number): number {
  const at = ladder.findIndex((stop) => stop > value);
  return at === -1 ? ladder.length - 1 : Math.max(0, at - 1);
}

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

export function ladderIndex(value: number): number {
  return stopAtOrBelow(VOLUME_LADDER, value);
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

/* -------------------------------------------------------------- depth floor */

/**
 * The depth floor's stops, in minutes of flow.
 *
 * A price is only a price if there is something behind it. Turtlellini's ask read 457k against a
 * 72k bid — an 84% margin, top of the list — because its entire sell side was down to a handful
 * of stragglers after the book was cleared out, while the 662-an-hour figure beside it was earned
 * a week ago at a fifth of the price. Every fictional row on the list has that shape: two items
 * of supply, or one buy order, holding up a number nobody will trade at.
 *
 * Measuring the book in *minutes of flow* rather than in items is what makes it comparable — a
 * hundred and twenty-seven Turtlellini is eleven minutes, nine thousand Quartz Blocks is twelve
 * hours — and an hour is the default because everything below it, measured across a live read,
 * was fiction and nothing above 1M an hour was lost.
 */
export const DEPTH_LADDER = [0, 5, 10, 15, 30, 45, 60, 90, 120, 180, 360, 720, 1440, 2880, 7200];

export function depthIndex(minutes: number): number {
  return stopAtOrBelow(DEPTH_LADDER, minutes);
}

/** "45 min", "2 hr", "5 days" — a duration, since that is what the number is. */
export function depthNote(minutes: number): string {
  if (minutes <= 0) return "off";
  if (minutes < 60) return `${Math.round(minutes)} min`;

  const hours = minutes / 60;
  if (hours < 24) return hours % 1 === 0 ? `${hours} hr` : `${hours.toFixed(1)} hr`;

  const days = hours / 24;
  return days === 1 ? "1 day" : `${days % 1 === 0 ? days : days.toFixed(1)} days`;
}
