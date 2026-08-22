import type { OrderLevel, ProductSnapshot, RawBazaarProduct, RawOrderLevel } from "./bazaarTypes";

/**
 * The bazaar, in the player's own words.
 *
 * Hypixel names its bazaar fields from the *order book's* point of view, which is the exact
 * opposite of the player's: `buy_summary` is the list of orders you can buy *from*, so it is
 * made of other people's sell offers, and `quick_status.buyPrice` is what buying costs. Read
 * quickly, every one of those names means its own opposite, and code written against them
 * inverts supply and demand about half the time.
 *
 * skyblock.bz fixes this by relabelling once, at the edge, and never touching Hypixel's names
 * again downstream. This module does the same. Past `normalise`, "sell orders" are orders to
 * sell — the ones you instabuy from — and nothing in the app has to remember the inversion.
 *
 * | Hypixel                  | here            | means                              |
 * |--------------------------|-----------------|------------------------------------|
 * | `buy_summary`            | `sellBook`      | sell offers; you instabuy from them |
 * | `sell_summary`           | `buyBook`       | buy orders; you instasell into them |
 * | `quick_status.buyPrice`  | `instabuy`      | what one costs right now            |
 * | `quick_status.sellPrice` | `instasell`     | what one fetches right now          |
 * | `quick_status.buyVolume` | `supply`        | items sitting in sell offers        |
 * | `quick_status.sellVolume`| `demand`        | items wanted by buy orders          |
 * | `buyMovingWeek`          | `weeklyBought`  | items instabought in 7 days         |
 * | `sellMovingWeek`         | `weeklySold`    | items instasold in 7 days           |
 */

/**
 * What the bazaar keeps when you sell.
 *
 * 2.25% — measured, not looked up. It falls out of three of skyblock.bz's derived figures
 * independently (craft margins, NPC-to-bazaar profit, and the cost of a price crash), and in the
 * crash case it reproduces their number to the coin. Hypixel's own tax varies with a booster
 * cookie and the Bazaar Flipper perk; this is the plain rate, which is the conservative one.
 */
export const SELL_TAX = 0.0225;
export const NET_OF_TAX = 1 - SELL_TAX;

/** Hours in the week the `weekly*` counters cover. Every "per hour" figure divides by this. */
export const WEEK_HOURS = 168;

/**
 * Coins an NPC will take off you per day before it stops buying.
 *
 * Also measured: skyblock.bz's "max profit" column for every NPC flip is exactly
 * `(500M / npcPrice) * margin`, which only works if the cap is on coins spent, not items bought.
 */
export const NPC_DAILY_COIN_LIMIT = 500_000_000;

/* --------------------------------------------------------------- normalise */

/** One Hypixel product, turned the right way round. */
export function normalise(id: string, raw: RawBazaarProduct, at = Date.now()): ProductSnapshot | null {
  const q = raw.quick_status;
  if (!q) return null;

  // Hypixel's quick_status prices are weighted averages over the top slice of the book, which
  // is a fine summary and a bad quote: you cannot buy at it. skyblock.bz quotes the best order
  // instead, and so does this — the book is right here, and the top of it is the real price.
  const sellBook = levelsFrom(raw.buy_summary);
  const buyBook = levelsFrom(raw.sell_summary);

  return {
    id,
    at,
    instabuy: sellBook[0]?.price ?? q.buyPrice,
    instasell: buyBook[0]?.price ?? q.sellPrice,
    supply: q.buyVolume,
    demand: q.sellVolume,
    weeklyBought: q.buyMovingWeek,
    weeklySold: q.sellMovingWeek,
    sellOrders: q.buyOrders,
    buyOrders: q.sellOrders,
    sellBook,
    buyBook,
  };
}

function levelsFrom(summary: RawBazaarProduct["buy_summary"]): OrderLevel[] {
  return (summary ?? []).map((level: RawOrderLevel) => ({
    amount: level.amount,
    orders: level.orders,
    price: level.pricePerUnit,
  }));
}

/** Items instabought per hour, averaged over the moving week. The rate you can sell into. */
export function hourlyBought(p: ProductSnapshot): number {
  return p.weeklyBought / WEEK_HOURS;
}

/** Items instasold per hour. The rate you can buy from. */
export function hourlySold(p: ProductSnapshot): number {
  return p.weeklySold / WEEK_HOURS;
}

/* ------------------------------------------------------------ book walking */

export type Walk = {
  /** How many were actually filled. Short of the ask when the book runs out. */
  filled: number;
  /** Coins moved across the whole fill. */
  coins: number;
  /** Volume-weighted price of the fill — the honest quote for a trade this size. */
  average: number;
  /** Where the book's best price sits once this fill has eaten through it. */
  priceAfter: number;
  /** True when the book emptied before the ask was met. */
  exhausted: boolean;
};

/**
 * Fill `qty` against a book, level by level.
 *
 * Every derived view below is really this function wearing a different hat. A flip's margin is
 * the top of two books; a crash is a walk down the buy book and back up the sell book; a
 * manipulation is a walk to the end of the sell book. Quoting any of them off the top price
 * alone is what makes flip sites promise coins that aren't there — the top level is often a
 * single item.
 *
 * Note the ceiling on honesty here: Hypixel publishes only the top 30 levels of each book, so a
 * walk that exhausts them has reached the end of what is *visible*, not the end of the market.
 * `exhausted` is the flag for that, and callers treat it as "unknown", not as "no more".
 */
export function walk(levels: OrderLevel[], qty: number): Walk {
  let filled = 0;
  let coins = 0;

  for (const level of levels) {
    if (filled >= qty) break;
    const take = Math.min(qty - filled, level.amount);
    filled += take;
    coins += take * level.price;
  }

  return {
    filled,
    coins,
    average: filled > 0 ? coins / filled : 0,
    priceAfter: bestRemaining(levels, filled),
    exhausted: filled < qty,
  };
}

/**
 * The best price still standing once `filled` items have been taken off the top.
 *
 * A level only disappears when the fill took all of it, so this is the first level the running
 * total has not swallowed whole. Zero means the visible book emptied — which, at 30 published
 * levels, means "we can't see any further", not "the market is empty".
 */
function bestRemaining(levels: OrderLevel[], filled: number): number {
  let seen = 0;
  for (const level of levels) {
    seen += level.amount;
    if (seen > filled) return level.price;
  }
  return 0;
}

/** What `qty` costs to buy off the sell book, and what the price becomes after. */
export function costToBuy(p: ProductSnapshot, qty: number): Walk {
  return walk(p.sellBook, qty);
}

/** What `qty` fetches dumped into the buy book, before tax. */
export function proceedsFromSelling(p: ProductSnapshot, qty: number): Walk {
  return walk(p.buyBook, qty);
}
