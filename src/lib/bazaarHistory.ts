import { HISTORY_SERIES } from "./bazaarTypes";
import type { HistoryRow, HistorySeries, ProductSnapshot } from "./bazaarTypes";

/**
 * Keeping a price series small enough to carry around.
 *
 * A day of bazaar reads is 4,320 samples of six numbers. Stored plainly that is a megabyte per
 * item and nothing can hold more than a handful; stored as differences it is a few tens of
 * kilobytes, because between two reads twenty seconds apart most of the six numbers do not move
 * at all and the rest move in the third decimal. skyblock.bz ships a six-year daily history and
 * a full day of twenty-second samples in under 200KB this way, and it is the only reason a page
 * can plot every series for every item without a server behind it.
 *
 * The encoding is the whole trick and it is three lines: the first row is absolute, every row
 * after it is the difference from the one before, and the timestamp is expressed in units of
 * the sampling interval so it stays a small integer instead of a 13-digit one.
 *
 * This module owns both directions plus the two things a history is actually *for*: a rolling
 * window that forgets, and the question the window exists to answer — is this price high or low
 * for this item?
 */

/** The tick the day series counts in. Hypixel refreshes the bazaar about this often. */
export const TICK_MS = 10_000;
/** The tick the long series counts in. */
export const DAY_MS = 86_400_000;

export type Series = { at: number; values: Record<HistorySeries, number> };

/* -------------------------------------------------------------- decode */

/** Delta rows back into absolute samples. `tick` is the unit `dt` counts in. */
export function decode(rows: HistoryRow[], tick = TICK_MS): Series[] {
  const out: Series[] = [];
  let at = 0;
  const running: Record<string, number> = {};

  for (const row of rows) {
    // The first row's dt is fractional on purpose — it carries an absolute epoch time in units
    // of the tick — and multiplying that back out lands a fraction of a millisecond off. Round
    // at every step rather than at the end, or the error rides along the whole series.
    at = Math.round(at + row[0] * tick);
    const values = {} as Record<HistorySeries, number>;
    HISTORY_SERIES.forEach((name, i) => {
      running[name] = (running[name] ?? 0) + row[i + 1];
      // Sums of decimals drift — a thousand additions of 0.1 do not land on 100 — so each
      // sample is rounded back to the precision the bazaar actually quotes.
      values[name] = round(running[name], 2);
    });
    out.push({ at, values });
  }
  return out;
}

/** Absolute samples back into delta rows. Round-trips through `decode` unchanged. */
export function encode(series: Series[], tick = TICK_MS): HistoryRow[] {
  const rows: HistoryRow[] = [];
  let at = 0;
  const previous: Record<string, number> = {};

  for (const sample of series) {
    const row = [round((sample.at - at) / tick, 4)] as unknown as HistoryRow;
    at = Math.round(at + row[0] * tick);
    HISTORY_SERIES.forEach((name, i) => {
      row[i + 1] = round(sample.values[name] - (previous[name] ?? 0), 2);
      previous[name] = sample.values[name];
    });
    rows.push(row);
  }
  return rows;
}

function round(n: number, places: number): number {
  const scale = 10 ** places;
  return Math.round(n * scale) / scale;
}

/** The six tracked numbers, pulled off a live snapshot. */
export function sample(p: ProductSnapshot): Series {
  return {
    at: p.at,
    values: {
      instabuy: p.instabuy,
      instasell: p.instasell,
      supply: p.supply,
      demand: p.demand,
      weeklyBought: p.weeklyBought,
      weeklySold: p.weeklySold,
    },
  };
}

/* -------------------------------------------------------------- windows */

/** Drop everything older than `windowMs` before the newest sample. */
export function trim(series: Series[], windowMs: number): Series[] {
  const newest = series[series.length - 1]?.at;
  if (newest === undefined) return series;
  const cutoff = newest - windowMs;
  const first = series.findIndex((s) => s.at >= cutoff);
  return first <= 0 ? series : series.slice(first);
}

/**
 * Collapse a window down to one sample per day.
 *
 * The rolling window forgets by design, so anything that wants to say "cheap by this year's
 * standards" needs the day series to survive the trim. Prices take the last read of the day
 * rather than the mean, because a daily average of an order book is an average of quotes nobody
 * traded at; volumes are already weekly totals and take the last read for the same reason.
 */
export function daily(series: Series[]): Series[] {
  const days = new Map<number, Series>();
  for (const s of series) days.set(Math.floor(s.at / DAY_MS), s);
  return [...days.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([day, s]) => ({ at: day * DAY_MS, values: s.values }));
}

/* ------------------------------------------------------------ statistics */

/**
 * How far today's number sits from its own history, as a percentage.
 *
 * This is the one derived figure on skyblock.bz that is not about a trade at all, and it is the
 * most useful thing on the product page: −20% means the item is a fifth cheaper than it has
 * generally been, which is a reason to look, where the raw price is a reason to look nothing up.
 *
 * The baseline is the mean of the daily series, so it weights a quiet Tuesday the same as a
 * mayor-election spike. That is deliberate — a median would hide exactly the events you want the
 * comparison to be against — but it does mean one enormous historical spike drags the baseline
 * up for months afterwards, and the number reads low for no present reason.
 */
export function proximityToAverage(current: number, history: Series[], name: HistorySeries): number | null {
  if (history.length === 0) return null;
  let total = 0;
  for (const s of history) total += s.values[name];
  const mean = total / history.length;
  if (mean === 0) return null;
  return (100 * current) / mean - 100;
}

/* -------------------------------------------------------------- baselines */

/**
 * A running average of one number, kept without keeping the samples.
 *
 * The intended source for this was skyblock.bz's `/api/product/init/{id}`, a six-and-a-half-year
 * daily series that `decode` above exists to read. That endpoint now answers 403 to any caller
 * outside their own site, with or without a referer, so there is no thirty-day average to be had
 * from it and inventing one would be worse than having none: a made-up baseline makes every
 * margin look explicable.
 *
 * What is left is what we can measure ourselves. The tab already reads the whole bazaar every
 * twenty seconds, so folding each read into a running mean costs one addition an item and needs
 * no history kept at all — four numbers rather than a series. `firstAt` is carried so the figure
 * can say how long it has actually been watching, because "12% above average" means something
 * different after four minutes than after four days, and a reader who is not told cannot tell.
 */
export type Baseline = { mean: number; samples: number; firstAt: number; lastAt: number };

/** Fold one reading in. A sample at a time it has already seen is ignored rather than doubled. */
export function observe(prior: Baseline | undefined, value: number, at: number): Baseline {
  if (!Number.isFinite(value)) return prior ?? { mean: 0, samples: 0, firstAt: at, lastAt: at };
  if (!prior || prior.samples === 0) return { mean: value, samples: 1, firstAt: at, lastAt: at };
  if (at <= prior.lastAt) return prior;
  const samples = prior.samples + 1;
  return {
    // Incremental rather than a running total: a sum of a hundred thousand reads of a
    // hundred-million-coin margin loses precision where the mean does not.
    mean: prior.mean + (value - prior.mean) / samples,
    samples,
    firstAt: prior.firstAt,
    lastAt: at,
  };
}

/**
 * Where a number sits against its own average, as a percentage.
 *
 * Zero means ordinary, +100 means twice its usual, −50 means half. Null while there is nothing
 * to compare against — one sample is not an average, and a mean of zero has no percentage.
 */
export function relativeTo(current: number, baseline: Baseline | undefined, minSamples = 2): number | null {
  if (!baseline || baseline.samples < minSamples || baseline.mean === 0) return null;
  return (100 * current) / baseline.mean - 100;
}

/** How long this baseline has actually been watching, in ms. */
export function observedFor(baseline: Baseline): number {
  return Math.max(0, baseline.lastAt - baseline.firstAt);
}

/**
 * Flatten the spikes out of a daily price series before plotting it.
 *
 * A six-year daily history collects reads taken mid-manipulation, when one player had bought out
 * the book and the quoted price was a hundred times the real one. Left in, a single such day
 * flattens the entire rest of the chart against the axis. Any sample more than half again above
 * what its neighbours would suggest is pulled back to that, which costs nothing on a series that
 * moves smoothly and saves the chart on one that does not.
 *
 * skyblock.bz applies this to the historical price series only, not to the day series or the
 * volumes, and neither do we: an hour-scale spike is usually real, and a volume spike always is.
 */
export function despike(series: Series[], name: HistorySeries): Series[] {
  const out = series.map((s) => ({ at: s.at, values: { ...s.values } }));
  for (let i = 1; i < out.length - 1; i++) {
    const neighbours = (out[i - 1].values[name] + out[i + 1].values[name]) * 1.5;
    out[i].values[name] = round(Math.min(out[i].values[name], neighbours), 1);
  }
  return out;
}
