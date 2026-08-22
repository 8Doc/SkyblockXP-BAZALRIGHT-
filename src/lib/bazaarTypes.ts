/**
 * The bazaar's shapes, at both ends of the relabelling.
 *
 * `Raw*` is Hypixel's wire format and appears in exactly one place — the argument to
 * `normalise`. Everything else in the app speaks `ProductSnapshot`, where the names mean what
 * they say. See the table at the top of `bazaar.ts` for the mapping.
 */

export type RawOrderLevel = { amount: number; pricePerUnit: number; orders: number };

export type RawBazaarProduct = {
  product_id?: string;
  /** Sell offers. You instabuy from these; ascending by price. */
  buy_summary?: RawOrderLevel[];
  /** Buy orders. You instasell into these; descending by price. */
  sell_summary?: RawOrderLevel[];
  quick_status?: {
    buyPrice: number;
    buyVolume: number;
    buyMovingWeek: number;
    buyOrders: number;
    sellPrice: number;
    sellVolume: number;
    sellMovingWeek: number;
    sellOrders: number;
  };
};

/** One level of one side of the book: `orders` separate offers totalling `amount` items. */
export type OrderLevel = { amount: number; orders: number; price: number };

export type ProductSnapshot = {
  id: string;
  /** When this was read, in epoch ms. Hypixel refreshes the bazaar about every 20 seconds. */
  at: number;

  /** Lowest sell order — one coin figure for buying one item right now. */
  instabuy: number;
  /** Highest buy order — what selling one right now fetches, before tax. */
  instasell: number;

  /** Items sitting in sell offers, waiting for a buyer. */
  supply: number;
  /** Items wanted by standing buy orders. */
  demand: number;

  /** Items instabought over the last seven days. */
  weeklyBought: number;
  /** Items instasold over the last seven days. */
  weeklySold: number;

  /** How many separate sell offers stand. */
  sellOrders: number;
  /** How many separate buy orders stand. */
  buyOrders: number;

  /** Sell offers, cheapest first — the side you buy from. Top 30 levels only. */
  sellBook: OrderLevel[];
  /** Buy orders, richest first — the side you sell into. Top 30 levels only. */
  buyBook: OrderLevel[];
};

/**
 * One row of history, as a delta from the row before it.
 *
 * Six series share one timestamp, and the whole thing is stored as differences because the
 * numbers barely move between reads: a day of 20-second samples is 4,320 rows, and as absolutes
 * that is megabytes of near-identical figures. skyblock.bz ships its charts this way and it is
 * the reason a six-year price history arrives in 200KB. The first row of a series is absolute;
 * every row after it adds on.
 *
 * `dt` is in units of 10 seconds for the day series and whole days for the historical one, which
 * is what keeps the timestamp column a single small integer rather than a 13-digit one.
 */
export type HistoryRow = [
  dt: number,
  instabuy: number,
  instasell: number,
  supply: number,
  demand: number,
  weeklyBought: number,
  weeklySold: number,
];

/** The six series a `HistoryRow` carries, in order, for anything that indexes them positionally. */
export const HISTORY_SERIES = [
  "instabuy",
  "instasell",
  "supply",
  "demand",
  "weeklyBought",
  "weeklySold",
] as const;

export type HistorySeries = (typeof HISTORY_SERIES)[number];
