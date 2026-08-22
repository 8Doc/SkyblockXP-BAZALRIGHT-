import { NET_OF_TAX, NPC_DAILY_COIN_LIMIT, costToBuy, hourlyBought, hourlySold, proceedsFromSelling } from "./bazaar";
import type { ProductSnapshot } from "./bazaarTypes";

/**
 * The six questions you can ask one bazaar snapshot.
 *
 * skyblock.bz publishes seven lists and they look like seven different products, but they are
 * six ways of reading the same two order books, plus one plain table. Written side by side the
 * family resemblance is the point:
 *
 *   flip         buy at the top of the buy book, sell at the top of the sell book
 *   craft        buy the ingredients that way, sell the output that way
 *   npc          buy that way, sell to a shopkeeper instead
 *   reverse npc  buy from a shopkeeper, sell that way
 *   manipulate   buy the *whole* sell book, and ask what dumping it back would cost
 *   crash        sell through the *whole* buy book, and ask who you can catch on the way down
 *
 * Everything below is a pure function of a snapshot plus, where the trade leaves the bazaar, a
 * static table. Nothing here fetches and nothing here caches.
 *
 * Two rules run through all of them:
 *
 * **Rate limits the return, not the margin.** A 200M spread on an item that trades four times a
 * week is not a 200M opportunity. Every view carries a coins-per-hour built from the moving
 * week and ranks on that rather than on the spread. It is the single thing separating a usable
 * flip list from a list of illiquid junk with enormous paper margins.
 *
 * **Depth limits the size.** Prices come off the book and quantities are walked through it, so a
 * quote for 5,000 items is a quote for 5,000 items and not the top order repeated 5,000 times.
 */

/* ------------------------------------------------------------------- flips */

export type Flip = {
  id: string;
  /** Place a buy order here; it is what other buyers are already bidding. */
  buyAt: number;
  /** Place a sell order here; it is what other sellers are already asking. */
  sellAt: number;
  /** Gross spread — the two order books quoted against each other. */
  margin: number;
  /** The spread once the bazaar has taken its cut of the sale. */
  netMargin: number;
  /** Spread as a share of the buy price, which is the figure that survives comparing items. */
  marginPercent: number;
  hourlyBought: number;
  hourlySold: number;
  /** Round trips per hour, which is the slower of the two sides. */
  hourlyFills: number;
  coinsPerHour: number;
};

export function flip(p: ProductSnapshot): Flip | null {
  // An empty side of the book is not a price of zero. Quoting one as if it were turns every
  // unlisted item into a 100%-margin flip and puts the whole dead half of the bazaar at the top
  // of the list.
  if (p.instabuy <= 0 || p.instasell <= 0) return null;

  const margin = p.instabuy - p.instasell;
  if (margin <= 0) return null;

  const netMargin = p.instabuy * NET_OF_TAX - p.instasell;
  const bought = hourlyBought(p);
  const sold = hourlySold(p);

  // Both legs have to fill for the flip to close, so the round-trip rate is the slower side.
  // Ranking on either alone rewards items that are heavily bought and never sold, where the buy
  // order simply never fills and the coins-per-hour is fiction.
  const hourlyFills = Math.min(bought, sold);

  return {
    id: p.id,
    buyAt: p.instasell,
    sellAt: p.instabuy,
    margin,
    netMargin,
    marginPercent: margin / p.instabuy,
    hourlyBought: bought,
    hourlySold: sold,
    hourlyFills,
    coinsPerHour: netMargin * hourlyFills,
  };
}

/* ------------------------------------------------------------------ crafts */

/** One ingredient of a recipe, in bazaar item ids. */
export type Ingredient = { id: string; qty: number };
export type Recipe = { output: string; yield: number; ingredients: Ingredient[] };

/**
 * Everything here is **per item produced**, not per craft.
 *
 * Hotspot Bait comes thirty-two to a craft, so a per-craft cost of 198k sits in the table beside
 * a sell price of 11k and reads as a catastrophe when the trade is fine. Dividing through by the
 * yield makes every column comparable to every other, and to the flip table beside it. Only 28
 * of 375 recipes make more than one, but those 28 are exactly the ones a reader would otherwise
 * be misled by.
 */
export type Craft = {
  id: string;
  /** What one costs to make, ingredients bought through buy orders. */
  craftCost: number;
  sellAt: number;
  /** Revenue after tax, less what one costs to make. */
  margin: number;
  /** Items per hour the output's own demand will absorb. */
  outputLimit: number;
  /** Items per hour the scarcest ingredient will supply. */
  inputLimit: number;
  /** The binding one of the two. Production is not a price question, it is a queue question. */
  bottleneck: number;
  coinsPerHour: number;
  /** The same trade done impatiently: instabuy the inputs, instasell the output. */
  instaCoinsPerHour: number;
  /** Which ingredient set the input limit, when one did. */
  limitedBy?: string;
};

export function craft(recipe: Recipe, market: Map<string, ProductSnapshot>): Craft | null {
  const output = market.get(recipe.output);
  if (!output || output.instabuy <= 0) return null;

  let orderCost = 0;
  let instaCost = 0;
  let inputLimit = Infinity;
  let limitedBy: string | undefined;

  for (const ingredient of recipe.ingredients) {
    const input = market.get(ingredient.id);
    // An ingredient nobody is bidding on has no buy-order price, and treating that as free is
    // how Wheat — nine of them out of one unbid Hay Block — ends up quoted as an infinite
    // margin. No price is not a low price.
    if (!input || input.instasell <= 0 || input.instabuy <= 0) return null;
    // Buying an ingredient means placing a buy order, which fills at what buyers bid; the
    // impatient version instabuys off the sell book instead.
    orderCost += input.instasell * ingredient.qty;
    instaCost += input.instabuy * ingredient.qty;

    // You cannot craft faster than people hand you the ingredient. One scarce input caps the
    // whole recipe, which is why a huge margin on a cheap craft is so often worth nothing.
    const crafts = hourlySold(input) / ingredient.qty;
    if (crafts < inputLimit) {
      inputLimit = crafts;
      limitedBy = ingredient.id;
    }
  }

  const per = recipe.yield;
  const margin = output.instabuy * NET_OF_TAX - orderCost / per;
  const instaMargin = output.instasell * NET_OF_TAX - instaCost / per;

  // One craft of the scarcest ingredient still makes `per` items, so the input limit converts
  // into items the same way the cost does.
  inputLimit *= per;
  const outputLimit = hourlyBought(output);
  const bottleneck = Math.min(outputLimit, inputLimit);

  return {
    id: recipe.output,
    craftCost: orderCost / per,
    sellAt: output.instabuy,
    margin,
    outputLimit,
    inputLimit,
    bottleneck,
    coinsPerHour: margin * bottleneck,
    instaCoinsPerHour: instaMargin * bottleneck,
    limitedBy: inputLimit < outputLimit ? limitedBy : undefined,
  };
}

/* --------------------------------------------------------------- npc flips */

/** What a shopkeeper pays for one, what it charges for one, and how many it stocks. Untaxed. */
export type NpcPrice = { sell?: number; buy?: number; stock?: number };

export type NpcFlip = {
  id: string;
  buyAt: number;
  npcPrice: number;
  margin: number;
  coinsPerHour: number;
  /** Coins the daily NPC limit allows you to make at all. */
  maxProfit: number;
  /** How long the bazaar takes to supply that much. Under a day means the cap binds first. */
  hoursBeforeLimited: number;
};

export function npcFlip(p: ProductSnapshot, npc: NpcPrice): NpcFlip | null {
  const npcPrice = npc.sell;
  if (!npcPrice) return null;

  // Buy through a buy order, sell to the shopkeeper. No tax on the NPC side, which is most of
  // why this beats a bazaar flip on cheap high-volume items.
  const margin = npcPrice - p.instasell;
  if (margin <= 0) return null;

  const coinsPerHour = margin * hourlySold(p);
  const maxProfit = (NPC_DAILY_COIN_LIMIT / npcPrice) * margin;

  return {
    id: p.id,
    buyAt: p.instasell,
    npcPrice,
    margin,
    coinsPerHour,
    maxProfit,
    hoursBeforeLimited: coinsPerHour > 0 ? maxProfit / coinsPerHour : Infinity,
  };
}

/* ------------------------------------------------------- npc to the bazaar */

export type ReverseNpcFlip = {
  id: string;
  npcPrice: number;
  stock: number;
  /** Selling the stock patiently, at the top of the sell book, after tax. */
  orderProfit: number;
  /** Selling it instantly into the buy book, after tax. */
  instaProfit: number;
};

export function reverseNpcFlip(p: ProductSnapshot, npc: NpcPrice): ReverseNpcFlip | null {
  const npcPrice = npc.buy;
  const stock = npc.stock ?? 0;
  if (!npcPrice || stock <= 0) return null;

  const orderProfit = (p.instabuy * NET_OF_TAX - npcPrice) * stock;
  const instaProfit = (p.instasell * NET_OF_TAX - npcPrice) * stock;
  if (orderProfit <= 0 && instaProfit <= 0) return null;

  return { id: p.id, npcPrice, stock, orderProfit, instaProfit: Math.max(0, instaProfit) };
}

/* -------------------------------------------------------------- buying out */

export type Buyout = {
  /** Items taken off the sell book. */
  items: number;
  /** Coins spent taking them. */
  cost: number;
  average: number;
  /** What one costs to buy afterwards. Zero means the visible book emptied. */
  priceAfter: number;
  /**
   * The most this can lose you: what you paid, less what you would get back dumping the lot.
   *
   * Negative means the books are crossed and buying out the sell side is free money — which is
   * why the list sorts ascending. The recovery takes the better of instaselling through the buy
   * book (taxed) and selling to a shopkeeper (not taxed), because the shopkeeper is a floor
   * under the price and ignoring it overstates the risk on every junk item.
   */
  risk: number;
};

export type Manipulation = { id: string; partial: Buyout; full: Buyout };

/**
 * Items thin enough that one player can own the entire sell side.
 *
 * skyblock.bz's cut is "fewer than 30 sell orders", which is the same as saying the whole book
 * fits in what Hypixel publishes — past 30 levels you would be buying blind.
 */
export const THIN_BOOK_ORDERS = 30;

/**
 * Where a partial buyout stops.
 *
 * A thin book is usually cheap all the way up and then jumps: five levels around 48k, one at
 * 100k, one at 200k, then a level at a million. Buying through the jump is most of the cost for
 * almost none of the supply, so partial stops in front of it. The threshold is ours — a level
 * that more than triples the one below it — chosen because it reproduces the cut skyblock.bz
 * makes on the cases we checked, not because they publish a rule.
 */
export const PRICE_JUMP = 3;

export function manipulation(p: ProductSnapshot, npc?: NpcPrice): Manipulation | null {
  if (p.sellOrders >= THIN_BOOK_ORDERS || p.sellBook.length === 0) return null;

  const fullItems = p.sellBook.reduce((sum, level) => sum + level.amount, 0);

  let partialItems = 0;
  for (let i = 0; i < p.sellBook.length; i++) {
    const previous = p.sellBook[i - 1];
    if (previous && p.sellBook[i].price > previous.price * PRICE_JUMP) break;
    partialItems += p.sellBook[i].amount;
  }

  return { id: p.id, partial: buyout(p, partialItems, npc), full: buyout(p, fullItems, npc) };
}

function buyout(p: ProductSnapshot, items: number, npc?: NpcPrice): Buyout {
  const bought = costToBuy(p, items);
  return {
    items: bought.filled,
    cost: bought.coins,
    average: bought.average,
    priceAfter: bought.priceAfter,
    risk: bought.coins - recovery(p, bought.filled, npc),
  };
}

/** The most you could get back for items you already hold: the book, taxed, or the NPC, not. */
function recovery(p: ProductSnapshot, items: number, npc?: NpcPrice): number {
  const book = proceedsFromSelling(p, items).coins * NET_OF_TAX;
  const shop = (npc?.sell ?? 0) * items;
  return Math.max(book, shop);
}

/* ------------------------------------------------------------- crashing it */

export type Crash = {
  items: number;
  /** Buy them, dump them, eat the difference. This is what the crash costs to execute. */
  cost: number;
  priceBefore: number;
  priceAfter: number;
  /**
   * What you make if it works.
   *
   * The bet is that people instasell without looking. Sit under the hole you just made, catch a
   * third of half an hour of instasells at the depressed price, sell them back into the
   * recovered one. The third and the half hour are both guesses — skyblock.bz's guesses, kept
   * because at least they are stated — so read this as a shape, not a forecast.
   */
  estimatedProfit: number;
};

/** Share of the flow you expect to catch, and for how long, before the price recovers. */
export const CRASH_CAPTURE = 1 / 3;
export const CRASH_WINDOW_HOURS = 0.5;

export type CrashPlan = { id: string; partial: Crash; full: Crash | null };

export function crash(p: ProductSnapshot): CrashPlan | null {
  if (p.buyBook.length < 2) return null;

  // Clearing the top level alone is the cheapest crash there is, and on a top-heavy book it is
  // the whole crash: one level often stands far above the rest.
  const partial = crashTo(p, p.buyBook[0].amount);

  const everything = p.buyBook.reduce((sum, level) => sum + level.amount, 0);
  // A full crash we cannot even price — the sell book ran out before we had the items — is
  // reported as unknown rather than as a number with a made-up tail on it.
  const full = costToBuy(p, everything).exhausted ? null : crashTo(p, everything);

  return { id: p.id, partial, full };
}

function crashTo(p: ProductSnapshot, items: number): Crash {
  const bought = costToBuy(p, items);
  const dumped = proceedsFromSelling(p, items);

  const priceBefore = p.instasell;
  const priceAfter = dumped.priceAfter;
  const caught = hourlySold(p) * CRASH_WINDOW_HOURS * CRASH_CAPTURE;
  const cost = bought.coins - dumped.coins * NET_OF_TAX;

  return {
    items: bought.filled,
    cost,
    priceBefore,
    priceAfter,
    estimatedProfit: caught * (priceBefore - priceAfter) - cost,
  };
}
