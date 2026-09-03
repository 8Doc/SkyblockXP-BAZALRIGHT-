import type { CoflnetPoint } from "./bazaarHistory";

/**
 * Whether a price is a price, or just today's accident.
 *
 * This module exists because of a specific failure mode in every minion profit calculator that
 * ranks on a live read: the winner is frequently not the best minion but the one whose item the
 * bazaar happens to be lying about this minute. A thin book empties, the top-of-book ask jumps
 * fortyfold, and a minion nobody would build climbs to the top of the table and stays there until
 * someone refills the orders. The number is real — you genuinely could sell one item at it — and
 * the ranking it produces is worthless, because you cannot sell nine thousand an hour at it.
 *
 * A mean alone does not fix this. A month's mean tells you where the price usually sits, and an
 * item that usually sits at 400 and is at 460 today is unremarkable; an item that usually sits at
 * 400 with a standard deviation of 4 and is at 460 today is a different claim entirely. So the
 * figure that matters is not the distance from the mean but the distance *in units of how much
 * this item normally moves* — which is the z-score, and which is the one number that separates
 * "gold went up" from "somebody bought the book out".
 *
 * **The window is thirty days and it is fetched, not measured.** Coflnet's bare history endpoint
 * returns a daily series going back to 2021, of which the last thirty entries are the month. That
 * is a real month on arrival, where averaging our own polls would need the tab left open for a
 * month before it said anything. `bazaarHistory.ts` already fetches a week for the greenhouse and
 * folds it into a running mean; this asks the same host a different question and keeps the spread
 * as well as the middle, because the spread is the entire point.
 */

/** The bare history endpoint. `/history/week` is two-hourly and too short to be a month. */
export const MONTH_HISTORY_URL = (id: string): string =>
  `https://sky.coflnet.com/api/bazaar/${encodeURIComponent(id)}/history`;

/** Days the window covers. Thirty, because that is what "a month" means to the person asking. */
export const WINDOW_DAYS = 30;
const WINDOW_MS = WINDOW_DAYS * 86_400_000;

/**
 * What a month of one item's prices looks like.
 *
 * `mean` and `deviation` are of the same series, so they are in coins and comparable to a live
 * quote. `spread` is the deviation as a fraction of the mean — the coefficient of variation — and
 * it is the only one of the three that compares across items: a deviation of 4 coins is nothing on
 * gold and everything on cobblestone.
 */
export type Variance = {
  mean: number;
  /** Population standard deviation, in coins. */
  deviation: number;
  /** deviation / mean. Unitless, so two different items can be ranked on it. */
  spread: number;
  /** The middle value, which a single manipulated day cannot move. */
  median: number;
  samples: number;
  firstAt: number;
  lastAt: number;
};

/**
 * Fold a fetched history into a month's statistics, or null if there is not enough of one.
 *
 * `field` is `buy` for what an item costs and `sell` for what it fetches, matching Coflnet's own
 * naming and this repo's `instabuy`/`instasell` the way `bazaarHistory.baselineFrom` already
 * establishes. Getting it backwards compares a seller's price against a buyer's month and reports
 * every item as half its usual.
 *
 * Two samples are not a spread and one is not a mean, so anything thinner than a week of daily
 * points comes back null and the caller falls back to saying so. A made-up baseline is worse than
 * none: it makes every anomaly look explicable.
 */
export const MIN_SAMPLES = 7;

export function varianceFrom(points: CoflnetPoint[], field: "buy" | "sell" = "sell", now = Date.now()): Variance | null {
  const cutoff = now - WINDOW_MS;
  const values: number[] = [];
  let firstAt = Infinity;
  let lastAt = -Infinity;

  for (const point of points) {
    const value = point[field];
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) continue;
    // Coflnet stamps these without a zone; they are UTC. Parsing as local time shifts the window
    // by hours, which is free to get right and quietly wrong to leave.
    const at = point.timestamp ? Date.parse(point.timestamp.endsWith("Z") ? point.timestamp : `${point.timestamp}Z`) : NaN;
    if (!Number.isFinite(at) || at < cutoff) continue;
    values.push(value);
    firstAt = Math.min(firstAt, at);
    lastAt = Math.max(lastAt, at);
  }

  if (values.length < MIN_SAMPLES) return null;

  const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
  if (mean <= 0) return null;

  // Population rather than sample deviation: this is the whole month, not a sample drawn from it.
  const deviation = Math.sqrt(values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length);

  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  const median = sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;

  return { mean, deviation, spread: deviation / mean, median, samples: values.length, firstAt, lastAt };
}

/**
 * How far today sits from the month, counted in months-worth of normal movement.
 *
 * Zero is exactly average, +1 is one standard deviation high, +4 is the kind of number that means
 * the book emptied rather than that the item got dearer. Null where the month never moved at all,
 * because dividing by a zero deviation produces an infinity that would sort to the top of every
 * table — an item with a perfectly flat price is the *least* suspicious thing on the bazaar.
 */
export function zScore(current: number, variance: Variance): number | null {
  if (!(variance.deviation > 0)) return null;
  return (current - variance.mean) / variance.deviation;
}

/**
 * How anomalous today's quote is, as a word.
 *
 * Thresholds rather than a continuous scale because the decision this drives is discrete: do I
 * believe this row or not. Two sigma is roughly the top 2% of a normal month and is where "dearer
 * than usual" stops being an adequate explanation; four is where nothing but a thin book explains
 * it. The series is not normal — bazaar prices have fat tails in exactly the direction that
 * matters — so these read as conservative rather than as statistics.
 */
export type Confidence = "normal" | "elevated" | "anomalous";

export const ELEVATED_SIGMA = 2;
export const ANOMALOUS_SIGMA = 4;

export function confidenceOf(z: number | null): Confidence {
  if (z === null) return "normal";
  const size = Math.abs(z);
  if (size >= ANOMALOUS_SIGMA) return "anomalous";
  if (size >= ELEVATED_SIGMA) return "elevated";
  return "normal";
}

/**
 * The price to actually rank on.
 *
 * The live quote is what you can trade at right now and the month's median is what you can trade
 * at repeatedly, and a minion is a repeated trade — nine thousand items an hour, every hour, for
 * as long as you leave it down. So the honest basis for a *rate* is the one you can sustain.
 *
 * `trust` decides how much of that argument to accept:
 *
 *  - `live` takes the quote as given. This is what every other calculator does, and it is right
 *    for "what is this stack in my inventory worth" and wrong for "what should I build".
 *  - `median` always takes the month's middle, ignoring today entirely. Steady, and blind to a
 *    genuine, lasting move — a price that has doubled and stayed doubled for a week reads as an
 *    anomaly for three more.
 *  - `guarded` is the default and takes the live price until it is more than two sigma out, then
 *    falls back to the median. Ordinary days pass through untouched; the fortyfold spike does not.
 *
 * Falling back to the median rather than clamping to two sigma is deliberate. A clamp still lets a
 * manipulated item outrank an honest one, just by less, and the whole complaint is about the
 * ordering rather than about the size of the number.
 */
export type Trust = "live" | "guarded" | "median";

export type BasisPrice = {
  price: number;
  /** True when the live quote was set aside for the month's median. */
  substituted: boolean;
  z: number | null;
  confidence: Confidence;
};

export function trustedPrice(live: number, variance: Variance | null, trust: Trust = "guarded"): BasisPrice {
  if (!variance) return { price: live, substituted: false, z: null, confidence: "normal" };

  const z = zScore(live, variance);
  const confidence = confidenceOf(z);

  if (trust === "live") return { price: live, substituted: false, z, confidence };
  if (trust === "median") return { price: variance.median, substituted: variance.median !== live, z, confidence };

  const suspect = confidence !== "normal";
  return { price: suspect ? variance.median : live, substituted: suspect, z, confidence };
}
