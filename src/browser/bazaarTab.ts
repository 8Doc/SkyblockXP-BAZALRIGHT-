import { hourlyBought, hourlySold, normalise } from "../lib/bazaar";
import {
  affordableCoinsPerHour,
  crash,
  craft,
  flip,
  manipulation,
  npcFlip,
  reverseNpcFlip,
  type Craft,
  type CrashPlan,
  type Flip,
  type Manipulation,
  type NpcFlip,
  type NpcPrice,
  type Recipe,
  type ReverseNpcFlip,
} from "../lib/bazaarViews";
import { findCraftChains, unorthodoxChains, type AnvilRules, type Chain } from "../lib/bazaarChains";
import { observe, observedFor, relativeTo, type Baseline } from "../lib/bazaarHistory";
import { rankOpportunities, type Opportunity, type OpportunitySource } from "../lib/bazaarRanking";
import { price as priceSubmissionRow, type PricedSubmission, type Submission } from "../lib/bazaarSubmissions";
import type { ProductSnapshot, RawBazaarProduct } from "../lib/bazaarTypes";
import { coins, num, parseBudget } from "../lib/format";
import { DEPTH_LADDER, VOLUME_LADDER, depthIndex, depthNote, ladderIndex, volumeNote } from "../lib/filters";

/**
 * The bazaar tab: flips and crafts, off a live read of Hypixel.
 *
 * This is a separate branch of the app and it keeps its own state deliberately. It needs no API
 * key, no username and no profile — the bazaar endpoint is public — so entangling it with the
 * planner's load sequence would only mean asking for three things it does not use.
 *
 * The whole tab is two ranked tables over one payload. Everything that makes them worth reading
 * lives in `lib/bazaarViews.ts`; this file fetches, polls, sorts and draws.
 */

const BAZAAR = "https://api.hypixel.net/v2/skyblock/bazaar";

/**
 * Item art, from Coflnet's public icon service.
 *
 * The only thing on this page that comes from anywhere other than Hypixel, and the only reason
 * it is worth the exception is that a table of two thousand SkyBlock ids is genuinely hard to
 * read without it. Everything degrades if the service is gone or the file is opened offline: the
 * images fail, the space they were in stays reserved, and every number is exactly as it was.
 *
 * Note the missing `/vanilla` on the end. skyblock.bz asks for that variant and it is a much
 * poorer set — a sample of 120 products came back 43% blank, Enchanted Obsidian and every
 * enchanted book among them. The plain path answered all 150 we tried.
 *
 * The ten ids carrying a vanilla damage suffix — `INK_SACK:4`, `LOG:2` and the like — have no
 * icon under any spelling we could find, so they show nothing. That is the better failure: the
 * un-suffixed id does resolve, but it would put an oak log against Birch Log and a black ink sack
 * against Lapis Lazuli, which is worse than an empty square.
 */
function iconUrl(id: string): string {
  return `https://sky.coflnet.com/static/icon/${encodeURIComponent(id)}`;
}

/**
 * Hypixel refreshes the bazaar every 20.017 seconds, dead regular, and stamps each payload with
 * `lastUpdated`. Polling on a blind 20-second timer therefore lands, on average, ten seconds into
 * a stale window; waking just after the stamp says the next one is due halves that for free.
 *
 * Measured against the alternatives, this is as fresh as the data gets anywhere: skyblock.bz's
 * own snapshot runs four seconds behind the origin and Coflnet's runs two minutes behind, because
 * both of them are polling this same endpoint.
 */
const REFRESH_MS = 20_017;
const GRACE_MS = 500;

type BazaarData = {
  recipes: Recipe[];
  intermediates: Recipe[];
  npcPrices: Record<string, NpcPrice>;
  anvil: AnvilRules;
  names: Record<string, string>;
};

type Sort = { column: string; descending: boolean };

/**
 * Every view's row, for the machinery they share.
 *
 * The four differ in shape — a flip is flat, a manipulation nests two buyouts — so the table
 * takes the accessors it needs (`volumeOf`, `tooThin`) rather than reaching into fields that
 * only some of them have.
 */
type BazaarRow = Flip | Craft | Manipulation | CrashPlan | NpcFlip | ReverseNpcFlip | Chain | Opportunity | PricedRow;

/** A submission and its live verdict, flattened enough to sit in the shared table. */
type PricedRow = { id: string; priced: PricedSubmission; margin: number; coinsPerHour: number };

type ViewId = "best" | "flips" | "crafts" | "chains" | "npc" | "reversenpc" | "manipulate" | "crash" | "mine";

type BazaarState = {
  view: ViewId;
  search: string;
  /** Hide rows whose round-trip rate makes the coins-per-hour meaningless. */
  minFills: number;
  /** Coins on hand, as typed. Empty means "don't ask what I can afford". */
  budget: string;
  /** Minutes of flow a book must hold before its price is treated as a price. Flips only. */
  minDepth: number;
  market: Map<string, ProductSnapshot>;
  lastUpdated: number | null;
  fetchedAt: number | null;
  status: string;
  error: string | null;
  sorts: Record<ViewId, Sort>;
};

const state: BazaarState = {
  view: "flips",
  search: "",
  budget: localStorage.getItem("sbxp:bzbudget") ?? "",
  minFills: Number(localStorage.getItem("sbxp:bzminfills") ?? 1),
  minDepth: Number(localStorage.getItem("sbxp:bzmindepth") ?? 60),
  market: new Map(),
  lastUpdated: null,
  fetchedAt: null,
  status: "",
  error: null,
  sorts: {
    best: { column: "returnOnCapital", descending: true },
    mine: { column: "coinsPerHour", descending: true },
    flips: { column: "coinsPerHour", descending: true },
    crafts: { column: "coinsPerHour", descending: true },
    chains: { column: "coinsPerHour", descending: true },
    npc: { column: "coinsPerHour", descending: true },
    reversenpc: { column: "orderProfit", descending: true },
    // Risk ascending, because the interesting end of a buyout list is the negative one: a book
    // whose recovery exceeds its cost is one you are paid to corner.
    manipulate: { column: "partialRisk", descending: false },
    crash: { column: "estimatedProfit", descending: true },
  },
};

/**
 * What each item's margin has averaged while this browser has been watching.
 *
 * Kept per item and persisted, so the comparison survives a reload and keeps getting better the
 * longer the tab is used. Four numbers an item rather than a series — see `Baseline` — which is
 * what makes it small enough to store for two thousand products at all.
 */
const BASELINE_KEY = "sbxp:bzbaselines";
let baselines: Record<string, Baseline> = readBaselines();

function readBaselines(): Record<string, Baseline> {
  try {
    return JSON.parse(localStorage.getItem(BASELINE_KEY) ?? "{}") as Record<string, Baseline>;
  } catch {
    // A corrupt or truncated store is not worth a broken tab; starting over costs only the
    // history this browser had accumulated, and it starts accumulating again immediately.
    return {};
  }
}

/**
 * Fold the newest read into every item's average.
 *
 * The margin, not the price: a price that doubles because the whole market moved is not the
 * thing worth flagging, and a spread that doubles is. Only items with both sides quoted take
 * part, for the same reason `flip()` refuses them — an empty book is not a margin of zero.
 */
function observeMargins(): void {
  for (const p of state.market.values()) {
    if (p.instabuy <= 0 || p.instasell <= 0) continue;
    baselines[p.id] = observe(baselines[p.id], p.instabuy - p.instasell, p.at);
  }
  try {
    localStorage.setItem(BASELINE_KEY, JSON.stringify(baselines));
  } catch {
    // Storage full or blocked. The averages stay live in memory for this session; losing them on
    // reload is a smaller failure than dropping the read that filled the quota.
  }
}

/**
 * A margin against its own average, and how long "average" has been watching.
 *
 * The window is on the row rather than in a footnote because it is the thing that decides whether
 * the number means anything: +180% after four minutes is noise, and after four days it is a
 * spike worth understanding before buying into it.
 */
function baselineCell(id: string, current: number): string {
  const baseline = baselines[id];
  const relative = relativeTo(current, baseline);
  if (relative === null) {
    return `<span class="dim" title="Not enough reads yet. This browser builds the average as it polls — it needs a second read of this item before there is anything to compare against.">—</span>`;
  }
  const window = depthNote(observedFor(baseline) / 60_000);
  const sign = relative >= 0 ? "+" : "";
  const loud = Math.abs(relative) >= 50 ? " gold" : "";
  return `<span class="${loud.trim()}" title="Against the mean margin over the ${window} this browser has been watching this item, across ${num(
    baseline.samples,
  )} reads. Not a thirty-day figure: skyblock.bz's history endpoint now refuses outside callers, so this is measured here rather than fetched.">${sign}${relative.toFixed(0)}% <span class="dim">${window}</span></span>`;
}

/** The column, shared by every view whose row has a margin to compare. */
function baselineColumn<T extends { id: string; margin: number }>(): Column<T> {
  return {
    id: "vsBaseline",
    label: "vs usual",
    value: (r) => relativeTo(r.margin, baselines[r.id]) ?? -Infinity,
    render: (r) => baselineCell(r.id, r.margin),
    title:
      "How this margin compares with what the same item has averaged while this browser has been " +
      "watching it. A margin that is wildly above its own usual is more often a manipulation tail " +
      "or a stale book than an opportunity — the spread widens because one side emptied, not " +
      "because the trade got better.",
  };
}

let data: BazaarData = {
  recipes: [],
  intermediates: [],
  npcPrices: {},
  // Replaced at mount; the zeroes only matter if a table is drawn before the data arrives, and a
  // cap of zero offers no combines rather than offering them for free.
  anvil: { feeCoins: 0, inputsRequired: 2, maxCombinableLevel: 0 },
  names: {},
};
let host: HTMLElement | null = null;
let timer: number | undefined;
/** Listeners are delegated on the container and bind once; only the polling starts and stops. */
let bound = false;

/* ------------------------------------------------------------------ columns */

type Column<T> = {
  id: string;
  label: string;
  /** What to sort on, and what to draw. Kept apart so a formatted "3.4M" still sorts as a number. */
  value: (row: T) => number;
  render: (row: T) => string;
  title?: string;
};

const BASE_FLIP_COLUMNS: Column<Flip>[] = [
  { id: "buyAt", label: "Buy order", value: (r) => r.buyAt, render: (r) => coins(r.buyAt), title: "What buyers are already bidding — put your buy order here." },
  { id: "sellAt", label: "Sell order", value: (r) => r.sellAt, render: (r) => coins(r.sellAt), title: "What sellers are already asking — put your sell order here." },
  { id: "margin", label: "Margin", value: (r) => r.margin, render: (r) => coins(r.margin), title: "The gross spread between the two order books." },
  { id: "marginPercent", label: "Margin %", value: (r) => r.marginPercent, render: (r) => `${(r.marginPercent * 100).toFixed(1)}%` },
  { id: "hourlyBought", label: "Buys/hr", value: (r) => r.hourlyBought, render: (r) => num(Math.round(r.hourlyBought)), title: "Instabuys per hour, averaged over the moving week. This is how fast your sell order fills." },
  { id: "hourlySold", label: "Sells/hr", value: (r) => r.hourlySold, render: (r) => num(Math.round(r.hourlySold)), title: "Instasells per hour. This is how fast your buy order fills." },
  { id: "hourlyFills", label: "Trips/hr", value: (r) => r.hourlyFills, render: (r) => num(Math.round(r.hourlyFills)), title: "Round trips per hour — the slower of the two sides, since both legs have to fill for the flip to close." },
  {
    id: "capital",
    label: "Allocate",
    value: (r) => r.capital,
    render: (r) => `${coins(r.capital)} <span class="dim">· ${num(r.orderSize)}</span>`,
    title:
      "What to put in, and how many to order. Twenty minutes of the market's flow — the order " +
      "fills in twenty minutes, so it is big enough to leave alone and small enough that no part " +
      "of it is idling in a queue. The bazaar holds the whole order up front, so this is real " +
      "money committed, not a notional position. Never below one item: on something this thin " +
      "the smallest order allowed is already more than twenty minutes of flow.",
  },
  {
    id: "bookHours",
    label: "Depth",
    value: (r) => r.bookHours,
    render: (r) => {
      const side = r.supplyHours <= r.demandHours ? "supply" : "demand";
      return `${depthNote(r.bookHours * 60)} <span class="dim">${side}</span>`;
    },
    title:
      "How long the thinner side of the book would last against the traffic going through it. A " +
      "quote is set by whoever is at the front, and a nearly empty book behind them is one " +
      "straggler rather than a market — which is how a 457k ask stands against a 72k bid on an " +
      "item nobody is trading at either price.",
  },
  { id: "coinsPerHour", label: "Coins/hr", value: (r) => r.coinsPerHour, render: (r) => coins(r.coinsPerHour), title: "After-tax margin times the round-trip rate. This is the ranking figure." },
];

/**
 * The budget column only exists once there is a budget, because a column of em-dashes is noise.
 * It goes last, where the eye already is, and the default sort is left alone — this is a second
 * opinion on the ranking rather than a replacement for it.
 */
function flipColumns(): Column<Flip>[] {
  const budget = parseBudget(state.budget);
  if (budget === null) return [...BASE_FLIP_COLUMNS, baselineColumn<Flip>()];

  return [
    ...BASE_FLIP_COLUMNS,
    baselineColumn<Flip>(),
    {
      id: "affordable",
      label: `With ${coins(budget)}`,
      value: (r) => affordableCoinsPerHour(r, budget),
      render: (r) => coins(affordableCoinsPerHour(r, budget)),
      title:
        "What your coins can actually take out of this, per hour. The market only turns over so " +
        "fast and your coins only turn over so fast; the lower ceiling binds.",
    },
  ];
}

const CRAFT_COLUMNS: Column<Craft>[] = [
  { id: "craftCost", label: "Craft cost", value: (r) => r.craftCost, render: (r) => coins(r.craftCost), title: "What one costs to make, every ingredient bought through a buy order. Per item, not per craft — some recipes make thirty-two." },
  { id: "sellAt", label: "Sell order", value: (r) => r.sellAt, render: (r) => coins(r.sellAt) },
  { id: "margin", label: "Margin", value: (r) => r.margin, render: (r) => coins(r.margin), title: "Revenue after the 2.25% tax, less what one costs to make." },
  { id: "outputLimit", label: "Demand/hr", value: (r) => r.outputLimit, render: (r) => num(Math.round(r.outputLimit)), title: "Items per hour the output's own demand will absorb." },
  { id: "inputLimit", label: "Supply/hr", value: (r) => r.inputLimit, render: (r) => num(Math.round(r.inputLimit)), title: "Items per hour the scarcest ingredient will supply." },
  { id: "bottleneck", label: "Items/hr", value: (r) => r.bottleneck, render: (r) => num(Math.round(r.bottleneck)), title: "The binding one of the two. Production is a queue question, not a price question." },
  { id: "coinsPerHour", label: "Coins/hr", value: (r) => r.coinsPerHour, render: (r) => coins(r.coinsPerHour), title: "Margin times the bottleneck. This is the ranking figure." },
  { id: "instaCoinsPerHour", label: "Impatient", value: (r) => r.instaCoinsPerHour, render: (r) => coins(r.instaCoinsPerHour), title: "The same trade with no waiting: instabuy the ingredients, instasell the output. The gap is what patience is worth." },
];

/** Which tab a combined row came from, and where clicking it goes. */
const SOURCE_VIEW: Record<OpportunitySource, ViewId> = {
  flip: "flips",
  craft: "crafts",
  chain: "chains",
  npc: "npc",
};

const SOURCE_LABEL: Record<OpportunitySource, string> = {
  flip: "Flip",
  craft: "Craft",
  chain: "Chain",
  npc: "NPC",
};

/**
 * Return on capital, which is the only figure the four kinds of trade share a meaning on.
 *
 * Coins per hour is still here and still worth reading, but it is the second column rather than
 * the ranking one: it makes a big slow trade beat a small fast one, and the small fast one is the
 * better answer for anyone whose coins are the binding constraint.
 */
const BEST_COLUMNS: Column<Opportunity>[] = [
  {
    id: "returnOnCapital",
    label: "Return/hr",
    value: (r) => r.returnOnCapital,
    render: (r) => `${(r.returnOnCapital * 100).toFixed(0)}%`,
    title:
      "Coins per hour for every coin tied up. This is the ranking figure, and the only one the " +
      "four kinds of row mean the same thing by — a craft turning 400M into 40M an hour and a " +
      "flip turning 4M into 12M an hour are not comparable on coins per hour, and the craft wins " +
      "that comparison while being the worse trade for anyone without 400M spare.",
  },
  {
    id: "capital",
    label: "Capital",
    value: (r) => r.capital,
    render: (r) => coins(r.capital),
    title:
      "Coins committed, sized the same way for every kind of row: twenty minutes of what the " +
      "trade can actually move. For a flip that is the buy order the bazaar holds up front; for " +
      "a craft or a chain it is twenty minutes of production at what producing one costs.",
  },
  { id: "coinsPerHour", label: "Coins/hr", value: (r) => r.coinsPerHour, render: (r) => coins(r.coinsPerHour), title: "What it pays per hour with enough coins behind it. Read against the capital beside it." },
  { id: "margin", label: "Margin", value: (r) => r.margin, render: (r) => coins(r.margin), title: "Per item, or per round trip on a flip. After tax." },
  { id: "perHour", label: "Per hour", value: (r) => r.perHour, render: (r) => num(Math.round(r.perHour)), title: "Items an hour, or round trips an hour on a flip." },
];

/**
 * A submission's row leads with whether it still works.
 *
 * The verdict is the column a reader came for: the whole point of keeping somebody's route is to
 * find out that it has stopped paying, and a row that only showed coins per hour would answer
 * that with a small number rather than a reason.
 */
const MINE_COLUMNS: Column<PricedRow>[] = [
  {
    id: "coinsPerHour",
    label: "Coins/hr now",
    value: (r) => r.coinsPerHour,
    render: (r) => (r.priced.problem ? `<span class="gold">—</span>` : coins(r.coinsPerHour)),
    title: "Priced against the live market this second, never from the figure that was submitted.",
  },
  { id: "margin", label: "Margin", value: (r) => r.margin, render: (r) => coins(r.margin), title: "What one finished item makes after tax, less what the whole route costs today." },
  {
    id: "bottleneck",
    label: "Items/hr",
    value: (r) => r.priced.chain?.bottleneck ?? 0,
    render: (r) => (r.priced.chain ? num(Math.round(r.priced.chain.bottleneck)) : `<span class="dim">—</span>`),
    title: "The tightest step in the submitted route, or the sale — whichever runs out first.",
  },
  {
    id: "drift",
    label: "vs claimed",
    value: (r) => r.priced.driftPercent ?? -Infinity,
    render: (r) =>
      r.priced.driftPercent === null
        ? `<span class="dim" title="No figure was submitted to compare against.">—</span>`
        : `<span class="${Math.abs(r.priced.driftPercent) >= 50 ? "gold" : ""}">${r.priced.driftPercent >= 0 ? "+" : ""}${r.priced.driftPercent.toFixed(0)}%</span>`,
    title:
      "How far the live figure has drifted from what the submission claimed. A route that was " +
      "true when it was written down is not automatically true now, and this is the column that " +
      "says so rather than quietly repeating the old number.",
  },
];

const NPC_COLUMNS: Column<NpcFlip>[] = [
  { id: "buyAt", label: "Buy order", value: (r) => r.buyAt, render: (r) => coins(r.buyAt), title: "What buyers are already bidding — put your buy order here." },
  { id: "npcPrice", label: "Shop pays", value: (r) => r.npcPrice, render: (r) => coins(r.npcPrice), title: "What a shopkeeper gives you for one. From Hypixel's own item resource, and untaxed — which is most of why this beats a bazaar flip on cheap high-volume goods." },
  { id: "margin", label: "Margin", value: (r) => r.margin, render: (r) => coins(r.margin) },
  { id: "coinsPerHour", label: "Coins/hr", value: (r) => r.coinsPerHour, render: (r) => coins(r.coinsPerHour), title: "Margin times how fast people sell you the item. This is the ranking figure." },
  {
    id: "maxProfit",
    label: "Daily cap",
    value: (r) => r.maxProfit,
    render: (r) => coins(r.maxProfit),
    title: "Shopkeepers stop paying after 500M coins a day, so this is all the coins this row can make you before it closes for the night, however fast the bazaar supplies it.",
  },
  {
    id: "hoursBeforeLimited",
    label: "Hits cap in",
    value: (r) => r.hoursBeforeLimited,
    render: (r) => (Number.isFinite(r.hoursBeforeLimited) ? depthNote(r.hoursBeforeLimited * 60) : `<span class="dim">never</span>`),
    title: "How long the bazaar takes to supply the daily cap. Under a day means the shopkeeper stops before the market does.",
  },
];

const REVERSE_NPC_COLUMNS: Column<ReverseNpcFlip>[] = [
  { id: "npcPrice", label: "Shop asks", value: (r) => r.npcPrice, render: (r) => coins(r.npcPrice), title: "What the shopkeeper charges for one, off the wiki's shop pages, divided through by the bundle size." },
  { id: "stock", label: "Stock", value: (r) => r.stock, render: (r) => num(r.stock), title: "How many the shop will sell before it runs dry. Only rows where a shop states one appear here — a shop with no published limit is not the same as one with no limit, so it is left out rather than guessed at." },
  { id: "orderProfit", label: "Patient", value: (r) => r.orderProfit, render: (r) => coins(r.orderProfit), title: "Buying the whole stock and selling it at the top of the sell book, after tax." },
  { id: "instaProfit", label: "Impatient", value: (r) => r.instaProfit, render: (r) => coins(r.instaProfit), title: "The same stock dumped straight into the buy book. The gap is what patience is worth." },
];

/**
 * A chain is a path rather than a row, so the path itself is the first column and the numbers
 * come after it. Everything is per terminal item, the same as the craft table beside it.
 */
const CHAIN_COLUMNS: Column<Chain>[] = [
  { id: "depth", label: "Hops", value: (r) => r.depth, render: (r) => `${r.depth}${r.combines ? ` <span class="dim">+anvil</span>` : ""}`, title: "Steps between the bazaar goods you buy and the thing you sell. One-hop crafts are on the Crafts tab; everything here needs at least two, or an anvil." },
  { id: "craftCost", label: "Chain cost", value: (r) => r.craftCost, render: (r) => coins(r.craftCost), title: "What one finished item costs to make, every step's ingredients bought through buy orders and every step divided through by its own yield." },
  { id: "sellAt", label: "Sell order", value: (r) => r.sellAt, render: (r) => coins(r.sellAt) },
  { id: "margin", label: "Margin", value: (r) => r.margin, render: (r) => coins(r.margin), title: "Revenue after the 2.25% tax, less what the whole chain costs." },
  { id: "bottleneck", label: "Items/hr", value: (r) => r.bottleneck, render: (r) => num(Math.round(r.bottleneck)), title: "The tightest hop in the chain, or the terminal's own demand — whichever runs out first. A long chain is usually limited by one leaf a long way down it." },
  { id: "coinsPerHour", label: "Coins/hr", value: (r) => r.coinsPerHour, render: (r) => coins(r.coinsPerHour), title: "Margin times the bottleneck. This is the ranking figure." },
];

/**
 * Two buyouts a row, so each figure says which one it belongs to.
 *
 * Partial stops in front of the first price jump and full takes the visible book; on a thin
 * book they are often the same number, and where they are not, the gap between them is the
 * whole decision. Risk leads because it is the only column that can be negative, and negative
 * is the case worth finding.
 */
const MANIPULATION_COLUMNS: Column<Manipulation>[] = [
  {
    id: "partialRisk",
    label: "Risk",
    value: (r) => r.partial.risk,
    render: (r) => coins(r.partial.risk),
    title:
      "The most cornering the cheap part of the book can lose you: what you pay for it, less " +
      "what you would get back dumping the lot — the better of instaselling it (taxed) or " +
      "selling it to a shopkeeper (not). Negative means the books are crossed and the buyout " +
      "pays for itself, which is why this sorts ascending.",
  },
  { id: "partialItems", label: "Items", value: (r) => r.partial.items, render: (r) => num(r.partial.items), title: "Items on the sell book below the first price jump." },
  { id: "partialCost", label: "Cost", value: (r) => r.partial.cost, render: (r) => coins(r.partial.cost), title: "Coins to take them all off the book." },
  { id: "partialAverage", label: "Avg paid", value: (r) => r.partial.average, render: (r) => coins(r.partial.average) },
  {
    id: "partialAfter",
    label: "Price after",
    value: (r) => r.partial.priceAfter,
    render: (r) => (r.partial.priceAfter > 0 ? coins(r.partial.priceAfter) : `<span class="dim">book emptied</span>`),
    title: "What one costs to buy once the buyout is done. Zero means the visible book ran out — which at 30 published levels is the end of what we can see, not the end of the market.",
  },
  { id: "fullItems", label: "Whole book", value: (r) => r.full.items, render: (r) => num(r.full.items), title: "Every item on the visible sell book." },
  { id: "fullCost", label: "Whole cost", value: (r) => r.full.cost, render: (r) => coins(r.full.cost) },
  { id: "fullRisk", label: "Whole risk", value: (r) => r.full.risk, render: (r) => coins(r.full.risk), title: "The same exposure for taking the entire visible book rather than stopping at the jump." },
];

/**
 * `full` is nullable here and nowhere else: a crash we could not price — because the sell book
 * ran out before we had the items to dump — is reported as unknown rather than as a number with
 * a guessed tail on it. Those columns read "—" rather than sorting as zero.
 */
const CRASH_COLUMNS: Column<CrashPlan>[] = [
  {
    id: "estimatedProfit",
    label: "Est. profit",
    value: (r) => r.partial.estimatedProfit,
    render: (r) => coins(r.partial.estimatedProfit),
    title:
      "What clearing the top buy order makes if the bet comes off: sit under the hole, catch a " +
      "third of half an hour of instasells at the depressed price, sell them into the recovered " +
      "one. The third and the half hour are guesses — skyblock.bz's, kept because at least they " +
      "are stated — so read this as a shape rather than a forecast.",
  },
  { id: "items", label: "Items", value: (r) => r.partial.items, render: (r) => num(r.partial.items), title: "Items in the top buy order — what you have to buy and dump to clear it." },
  { id: "cost", label: "Cost to crash", value: (r) => r.partial.cost, render: (r) => coins(r.partial.cost), title: "Buy them, dump them, eat the difference. This is what executing the crash costs before anything comes back." },
  { id: "priceBefore", label: "Bid before", value: (r) => r.partial.priceBefore, render: (r) => coins(r.partial.priceBefore) },
  { id: "priceAfter", label: "Bid after", value: (r) => r.partial.priceAfter, render: (r) => coins(r.partial.priceAfter), title: "Where the buy book's best price lands once the top order is gone. The gap is what you are trying to catch people falling through." },
  {
    id: "fullCost",
    label: "Whole book",
    value: (r) => r.full?.cost ?? Infinity,
    render: (r) => (r.full ? coins(r.full.cost) : `<span class="dim" title="The sell book ran out before we had the items, so this cannot be priced from the visible book.">—</span>`),
    title: "What crashing the entire visible buy book would cost, where we can see far enough to say.",
  },
];

/* --------------------------------------------------------------- fetching */

async function refresh(): Promise<void> {
  state.status = state.market.size ? "refreshing" : "loading the bazaar…";
  state.error = null;
  renderMeta();

  try {
    const response = await fetch(BAZAAR);
    if (!response.ok) throw new Error(`Hypixel returned ${response.status}`);
    const body = (await response.json()) as { lastUpdated: number; products: Record<string, RawBazaarProduct> };

    const market = new Map<string, ProductSnapshot>();
    for (const [id, raw] of Object.entries(body.products)) {
      const snapshot = normalise(id, raw, body.lastUpdated);
      if (snapshot) market.set(id, snapshot);
    }

    state.market = market;
    state.lastUpdated = body.lastUpdated;
    state.fetchedAt = Date.now();
    state.status = "";
    observeMargins();
  } catch (error) {
    // A failed refresh leaves the last good read on screen rather than blanking the table; stale
    // prices with a visible age on them beat an empty page.
    state.error = error instanceof Error ? error.message : "Could not reach the Hypixel API.";
    state.status = "";
  }

  // Only the meta line and the table, never the controls: this runs every twenty seconds, and a
  // full repaint would take the cursor out of the search box mid-word.
  renderMeta();
  renderTable();
  schedule();
}

/** Wake just after the next payload is due, not on a blind interval. */
function schedule(): void {
  clearTimeout(timer);
  const due = state.lastUpdated ? state.lastUpdated + REFRESH_MS + GRACE_MS - Date.now() : REFRESH_MS;
  timer = window.setTimeout(refresh, Math.max(due, 2_000));
}

/* ----------------------------------------------------------------- rows */

function flipRows(): Flip[] {
  const rows: Flip[] = [];
  for (const product of state.market.values()) {
    const f = flip(product);
    if (f) rows.push(f);
  }
  return rows;
}

function craftRows(): Craft[] {
  // A recipe with alternatives appears once per alternative, and only the cheapest is a real
  // answer — nobody crafts Enchanted Iron out of blocks when ingots are cheaper today.
  const best = new Map<string, Craft>();
  for (const recipe of data.recipes) {
    const c = craft(recipe, state.market);
    if (!c || c.margin <= 0) continue;
    const prior = best.get(c.id);
    if (!prior || c.craftCost < prior.craftCost) best.set(c.id, c);
  }
  return [...best.values()];
}

/**
 * Every kind of row on one axis.
 *
 * Built from the same functions the individual tabs use rather than from a second implementation,
 * so a number here and the number on its own tab cannot drift apart.
 */
function bestRows(): { rows: Opportunity[]; hidden: { volume: number; depth: number } } {
  // Each source is filtered *before* it is ranked, not after.
  //
  // An Opportunity carries a return and not a book, so the depth floor cannot see it — and
  // dividing by capital is exactly where a fictional spread does its worst damage. A 69k ask
  // standing against a 2-coin bid is a 3-million-percent return on two coins, and it lands at the
  // top of the one table a reader is most likely to trust. Filtering here means the combined view
  // shows the rows the individual tabs would show, re-ranked, rather than a different set.
  const flips = flipRows();
  const crafts = craftRows();
  const chains = chainRows();
  const npcFlips = npcRows();
  return {
    rows: rankOpportunities({
      flips: filtered(flips),
      crafts: filtered(crafts),
      chains: filtered(chains),
      npcFlips: filtered(npcFlips),
    }),
    // Counted across the sources rather than the ranking, since that is where the floors bit.
    hidden: [flips, crafts, chains, npcFlips]
      .map((rows) => hiddenCounts(rows))
      .reduce((a, b) => ({ volume: a.volume + b.volume, depth: a.depth + b.depth }), { volume: 0, depth: 0 }),
  };
}

/* -------------------------------------------------------------- submissions */

const SUBMISSIONS_KEY = "sbxp:bzsubmissions";

function readSubmissions(): Submission[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(SUBMISSIONS_KEY) ?? "[]");
    return Array.isArray(parsed) ? (parsed as Submission[]) : [];
  } catch {
    return [];
  }
}

let submissions: Submission[] = readSubmissions();

function saveSubmissions(): void {
  try {
    localStorage.setItem(SUBMISSIONS_KEY, JSON.stringify(submissions));
  } catch {
    // Nothing to do but keep them for this session; the table is still correct either way.
  }
}

/** Priced from scratch on every read, which is the whole point — see `bazaarSubmissions.ts`. */
function submissionRows(): PricedRow[] {
  const options = {
    recipes: [...data.recipes, ...data.intermediates],
    npcPrices: data.npcPrices,
    anvil: data.anvil,
  };
  return submissions.map((submission) => {
    const priced = priceSubmissionRow(submission, state.market, options);
    return {
      id: submission.sells,
      priced,
      margin: priced.chain?.margin ?? 0,
      coinsPerHour: priced.problem ? 0 : (priced.chain?.coinsPerHour ?? 0),
    };
  });
}

function npcRows(): NpcFlip[] {
  const rows: NpcFlip[] = [];
  for (const product of state.market.values()) {
    const price = data.npcPrices[product.id];
    if (!price) continue;
    const f = npcFlip(product, price);
    if (f) rows.push(f);
  }
  return rows;
}

function reverseNpcRows(): ReverseNpcFlip[] {
  const rows: ReverseNpcFlip[] = [];
  for (const product of state.market.values()) {
    const price = data.npcPrices[product.id];
    if (!price) continue;
    const f = reverseNpcFlip(product, price);
    if (f) rows.push(f);
  }
  return rows;
}

/**
 * Recomputed per read rather than cached.
 *
 * The whole point of the finder is that "cheapest path" is a price question, and prices move
 * every twenty seconds — a cached graph would be answering yesterday's question. It costs about
 * twelve milliseconds over four hundred recipes, which is nothing against the fetch it follows.
 */
function chainRows(): Chain[] {
  const chains = findCraftChains(state.market, {
    recipes: [...data.recipes, ...data.intermediates],
    npcPrices: data.npcPrices,
    anvil: data.anvil,
    maxDepth: 4,
  });
  return unorthodoxChains(chains).filter((c) => c.margin > 0);
}

function manipulationRows(): Manipulation[] {
  const rows: Manipulation[] = [];
  for (const product of state.market.values()) {
    const m = manipulation(product);
    if (m && m.partial.items > 0) rows.push(m);
  }
  return rows;
}

function crashRows(): CrashPlan[] {
  const rows: CrashPlan[] = [];
  for (const product of state.market.values()) {
    const c = crash(product);
    if (c && c.partial.items > 0) rows.push(c);
  }
  return rows;
}

/**
 * What each floor is holding back, counted on its own.
 *
 * Separately, and not as "everything the search left out", or typing a word would look like the
 * floors had suddenly swallowed a thousand rows.
 */
function hiddenCounts(rows: BazaarRow[]): { volume: number; depth: number } {
  return {
    volume: rows.reduce((n, row) => n + (volumeOf(row) < state.minFills ? 1 : 0), 0),
    depth: rows.reduce((n, row) => n + (tooThin(row) ? 1 : 0), 0),
  };
}

/**
 * How much of this row moves in an hour.
 *
 * Round trips for a flip, items for a craft, and for the two book plays the side of the flow
 * the play actually depends on: cornering a book is only worth doing if people come along to
 * buy it off you, and a crash pays out of the instasells you catch on the way down. Both of
 * those live on the snapshot rather than on the row, so they are looked back up.
 */
function volumeOf(row: BazaarRow): number {
  // A submission is never hidden by a floor: it was kept on purpose, and "your route is too thin
  // to bother with" is a thing the row should say rather than a reason to make it disappear.
  if ("priced" in row) return Infinity;
  if ("perHour" in row) return row.perHour;
  if ("hourlyFills" in row) return row.hourlyFills;
  if ("bottleneck" in row) return row.bottleneck;
  const product = state.market.get(row.id);
  if (!product) return 0;
  // An NPC flip is fed by how fast people sell you the item; a reverse one is bounded by the
  // shop's stock rather than by the bazaar, so it is the sale side that has to keep up.
  if ("npcPrice" in row) return "stock" in row ? hourlyBought(product) : hourlySold(product);
  return isCrash(row as Manipulation | CrashPlan) ? hourlySold(product) : hourlyBought(product);
}

/** `CrashPlan.full` is nullable and `Manipulation.full` is not, which is what tells them apart. */
function isCrash(row: Manipulation | CrashPlan): row is CrashPlan {
  return "estimatedProfit" in row.partial;
}

function nameOf(id: string): string {
  return data.names[id] ?? id;
}

function filtered<T extends BazaarRow>(rows: T[]): T[] {
  const needle = state.search.trim().toLowerCase();
  return rows.filter((row) => {
    if (volumeOf(row) < state.minFills) return false;
    if (tooThin(row)) return false;
    if (!needle) return true;
    return nameOf(row.id).toLowerCase().includes(needle) || row.id.toLowerCase().includes(needle);
  });
}

/**
 * A row whose price is not standing on anything.
 *
 * Flips only. A craft's price comes from a recipe rather than from whoever is left at the front
 * of a book, so the same failure does not arise, and the bottleneck already says how fast it can
 * really go.
 */
function tooThin(row: BazaarRow): boolean {
  return "bookHours" in row && row.bookHours * 60 < state.minDepth;
}

function sorted<T extends BazaarRow>(rows: T[], columns: Column<T>[], sort: Sort): T[] {
  const column = columns.find((c) => c.id === sort.column);
  if (!column) return rows;
  const direction = sort.descending ? -1 : 1;
  return rows.slice().sort((a, b) => direction * (column.value(a) - column.value(b)));
}

/* --------------------------------------------------------------- rendering */

const ROW_LIMIT = 250;

export function mountBazaar(container: HTMLElement, tables: BazaarData): void {
  host = container;
  data = tables;

  if (bound) {
    render();
    void refresh();
    return;
  }
  bound = true;

  container.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;

    const view = target.closest<HTMLElement>("[data-bzview]");
    if (view) {
      state.view = view.dataset.bzview as BazaarState["view"];
      render();
      return;
    }

    const column = target.closest<HTMLElement>("[data-bzsort]");
    if (column) {
      const id = column.dataset.bzsort!;
      const sort = state.sorts[state.view];
      // Clicking the column you are already on flips it; a new column starts descending, because
      // every column here is a "more is better" figure.
      if (sort.column === id) sort.descending = !sort.descending;
      else state.sorts[state.view] = { column: id, descending: true };
      renderTable();
      return;
    }

    // A combined row knows which view it came from, so opening it lands on the tab that has the
    // detail — the book depth for a flip, the full path for a chain — rather than flattening
    // everything into one shape that has neither.
    const open = target.closest<HTMLElement>("[data-bzopen]");
    if (open) {
      state.view = SOURCE_VIEW[open.dataset.bzopen as OpportunitySource];
      state.search = open.dataset.bzid ?? "";
      render();
      return;
    }

    const forget = target.closest<HTMLElement>("[data-bzforget]");
    if (forget) {
      submissions = submissions.filter((s) => s.id !== forget.dataset.bzforget);
      saveSubmissions();
      renderTable();
      return;
    }

    if (target.closest("#bzsubadd")) {
      addSubmission();
      return;
    }

    if (target.closest("#bzrefresh")) void refresh();
  });

  // Error events do not bubble, so this listens on the way down. A missing icon is hidden rather
  // than removed, which keeps the names in a column instead of letting them jog left and right.
  container.addEventListener(
    "error",
    (event) => {
      const target = event.target;
      if (target instanceof HTMLImageElement && target.classList.contains("bz-icon")) {
        target.style.visibility = "hidden";
      }
    },
    true,
  );

  container.addEventListener("input", (event) => {
    const el = event.target as HTMLInputElement;
    if (el.id === "bzsearch") {
      state.search = el.value;
      renderTable();
      return;
    }
    if (el.id === "bzbudget") {
      state.budget = el.value;
      localStorage.setItem("sbxp:bzbudget", el.value);
      // The column set changes with it, so this is a header repaint rather than a body one.
      renderTable();
      return;
    }
    if (el.id === "bzmindepth") {
      state.minDepth = DEPTH_LADDER[Number(el.value)] ?? 0;
      localStorage.setItem("sbxp:bzmindepth", String(state.minDepth));
      const label = document.getElementById("bzmindepthvalue");
      if (label) label.textContent = depthNote(state.minDepth);
      renderTable();
      return;
    }
    if (el.id === "bzminfills") {
      state.minFills = VOLUME_LADDER[Number(el.value)] ?? 0;
      localStorage.setItem("sbxp:bzminfills", String(state.minFills));
      // The handle should track the finger even if the table takes a moment behind it.
      const label = document.getElementById("bzminfillsvalue");
      if (label) label.textContent = volumeNote(state.minFills);
      renderTable();
    }
  });

  render();
  void refresh();
}

/**
 * Read the form and keep the route.
 *
 * Validation is deliberately thin: the id has to be something the bazaar trades, because a route
 * ending in an item nobody sells cannot be priced at all and saving it would only produce a row
 * that says so forever. Everything past that is left to the pricer, which will report an
 * unreachable route in the table rather than refusing it at the door — a route that is broken
 * *today* is exactly the thing worth keeping and watching.
 */
function addSubmission(): void {
  const value = (id: string) => (document.getElementById(id) as HTMLInputElement | null)?.value.trim() ?? "";
  const error = document.getElementById("bzsuberror");
  const fail = (message: string) => {
    if (error) error.textContent = message;
  };

  const sells = value("bzsubsells").toUpperCase();
  if (!sells) return fail("Name the item the route ends in.");
  if (!state.market.has(sells)) return fail(`The bazaar does not trade ${sells}. Ids look like ENCHANTED_CACTUS.`);

  const buys = value("bzsubbuys")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const m = /^(\S+)(?:\s*[x*]\s*(\d+))?$/i.exec(part);
      return m ? { id: m[1].toUpperCase(), qty: Number(m[2] ?? 1) } : null;
    })
    .filter((b): b is { id: string; qty: number } => b !== null);

  const steps = value("bzsubsteps")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const [kind, ...rest] = part.split(/\s+/);
      const id = rest.join("_").toUpperCase();
      return /anvil|combine/i.test(kind) ? ({ kind: "combine", to: id } as const) : ({ kind: "craft", output: id } as const);
    });

  const claimed = Number(value("bzsubclaim").replace(/[^0-9.]/g, ""));

  submissions.push({
    id: `${sells}-${Date.now()}`,
    sells,
    buys: buys.length ? buys : [{ id: sells, qty: 1 }],
    steps,
    submittedAt: Date.now(),
    claimedCoinsPerHour: Number.isFinite(claimed) && claimed > 0 ? claimed : undefined,
  });
  saveSubmissions();
  fail("");
  renderTable();
}

export function unmountBazaar(): void {
  clearTimeout(timer);
  timer = undefined;
  host = null;
}

function render(): void {
  if (!host) return;

  host.innerHTML = `
    <div class="meta" id="bzmeta">${metaHtml()}</div>

    <div class="tabs">
      ${VIEW_TABS.map(
        ([id, label]) => `<button class="chip${state.view === id ? " on" : ""}" data-bzview="${id}">${label}</button>`,
      ).join("")}
    </div>

    <div class="panel pad controls">
      <div class="row">
        <label>Search
          <input id="bzsearch" value="${escapeHtml(state.search)}" placeholder="e.g. enchanted cactus" autocomplete="off">
        </label>
        <label title="What you have to flip with. Adds a column for what each row can actually pay you, rather than what it would pay someone with unlimited coins.">Coins on hand
          <input id="bzbudget" value="${escapeHtml(state.budget)}" placeholder="optional · 500M" autocomplete="off">
        </label>
        <label class="wide" title="A huge spread on something that trades twice a week is not an opportunity. This hides anything moving slower than the floor — round trips an hour on flips, items an hour on crafts.">
          Minimum volume <span class="dim" id="bzminfillsvalue">${volumeNote(state.minFills)}</span>
          <input type="range" id="bzminfills" min="0" max="${VOLUME_LADDER.length - 1}" step="1" value="${ladderIndex(state.minFills)}">
        </label>
        ${
          state.view === "flips"
            ? `<label class="wide" title="A price is only a price if something is standing behind it. This hides rows where the thinner side of the book would be gone in less than this much of its own traffic — the state a 457k ask against a 72k bid is always in.">
          Minimum book depth <span class="dim" id="bzmindepthvalue">${depthNote(state.minDepth)}</span>
          <input type="range" id="bzmindepth" min="0" max="${DEPTH_LADDER.length - 1}" step="1" value="${depthIndex(state.minDepth)}">
        </label>`
            : ""
        }
      </div>
    </div>

    <div id="bztable"></div>
  `;

  renderTable();
}

function metaHtml(): string {
  return `
    <strong>${num(state.market.size)} products</strong>
    <span class="dim">${ageNote()}</span>
    ${state.status ? `<span class="dim">${escapeHtml(state.status)}</span>` : ""}
    ${state.error ? `<span class="gold">${escapeHtml(state.error)}</span>` : ""}
    <button type="button" class="chip" id="bzrefresh" title="Hypixel republishes every 20 seconds; this tab already wakes for it.">Refresh now</button>
  `;
}

function renderMeta(): void {
  const meta = document.getElementById("bzmeta");
  if (meta) meta.innerHTML = metaHtml();
}

const VIEW_TABS: [ViewId, string][] = [
  ["best", "Best returns"],
  ["flips", "Flips"],
  ["crafts", "Crafts"],
  ["chains", "Unorthodox crafts"],
  ["npc", "NPC"],
  ["reversenpc", "Reverse NPC"],
  ["manipulate", "Manipulate"],
  ["crash", "Crash"],
  ["mine", "My flips"],
];

function renderTable(): void {
  const target = document.getElementById("bztable");
  if (!target) return;

  if (state.view === "best") {
    // Already filtered at source — see `bestRows` — so it is not filtered again here.
    const { rows, hidden } = bestRows();
    target.innerHTML = table(rows, hidden, BEST_COLUMNS, state.sorts.best, BEST_NOTE);
  } else if (state.view === "mine") {
    const all = submissionRows();
    target.innerHTML = submissionForm() + table(filtered(all), hiddenCounts(all), MINE_COLUMNS, state.sorts.mine, MINE_NOTE);
  } else if (state.view === "flips") {
    const all = flipRows();
    target.innerHTML = table(filtered(all), hiddenCounts(all), flipColumns(), state.sorts.flips, FLIPS_NOTE);
  } else if (state.view === "crafts") {
    const all = craftRows();
    target.innerHTML = table(filtered(all), hiddenCounts(all), [...CRAFT_COLUMNS, baselineColumn<Craft>()], state.sorts.crafts, CRAFTS_NOTE);
  } else if (state.view === "chains") {
    const all = chainRows();
    target.innerHTML = table(filtered(all), hiddenCounts(all), [...CHAIN_COLUMNS, baselineColumn<Chain>()], state.sorts.chains, CHAINS_NOTE);
  } else if (state.view === "npc") {
    const all = npcRows();
    target.innerHTML = table(filtered(all), hiddenCounts(all), NPC_COLUMNS, state.sorts.npc, NPC_NOTE);
  } else if (state.view === "reversenpc") {
    const all = reverseNpcRows();
    target.innerHTML = table(filtered(all), hiddenCounts(all), REVERSE_NPC_COLUMNS, state.sorts.reversenpc, REVERSE_NPC_NOTE);
  } else if (state.view === "manipulate") {
    const all = manipulationRows();
    target.innerHTML = table(filtered(all), hiddenCounts(all), MANIPULATION_COLUMNS, state.sorts.manipulate, MANIPULATE_NOTE);
  } else {
    const all = crashRows();
    target.innerHTML = table(filtered(all), hiddenCounts(all), CRASH_COLUMNS, state.sorts.crash, CRASH_NOTE);
  }
}

const FLIPS_NOTE =
  "Buy at the top of the buy book, sell at the top of the sell book. Ranked on coins per hour " +
  "rather than on the spread, because both legs have to fill and the slower side sets the pace. " +
  "Read that figure against the two beside it: a bad hour says what the mean is hiding on a thin " +
  "item, and capital says how much you need on hand before the rate is even available to you.";

const CRAFTS_NOTE =
  "Ingredients bought through buy orders, the output sold through a sell order. Ranked on coins " +
  "per hour, which is the margin times whichever runs out first — the output's demand or the " +
  "scarcest ingredient's supply.";

const BEST_NOTE =
  "Every flip, craft, chain and NPC trade on one axis: coins per hour for each coin tied up. " +
  "Coins per hour alone cannot rank them against each other — it makes a big slow trade beat a " +
  "small fast one, and the small fast one is the better answer for anyone whose coins are the " +
  "binding constraint. Capital is sized the same way for all four, twenty minutes of what the " +
  "trade can actually move, so the ratio compares the trades rather than the rules. Click a row " +
  "to open it on its own tab, where the book depth or the full path is. " +
  "Read the return against the capital beside it rather than on its own: a return in the millions " +
  "of percent is real arithmetic on a book whose top bid is a fraction of a coin — some enchanted " +
  "books are bid at 0.2 against a 71,000 ask — and the honest reading of it is not that the trade " +
  "is enormous but that it takes almost no coins, so almost no coins are what it will pay out on. " +
  "Put a figure in Coins on hand to see what each row can actually give you rather than what it " +
  "would give someone able to deploy an unlimited amount into a two-coin order.";

const MINE_NOTE =
  "Routes you have written down, priced against the live market every twenty seconds. The figure " +
  "you submitted is never used for anything except the drift column — a route that was true when " +
  "you wrote it down is not automatically true now, and a table that repeated your number would " +
  "look checked without being. A route that has stopped working stays on the list and says why.";

const CHAINS_NOTE =
  "Crafts that take more than one step, and book ladders combined up at an anvil. Only paths a " +
  "single craft cannot already find are here — two hops or more, or one containing a combine — " +
  "because anything shorter is already a row on the Crafts tab. Every step is costed the same " +
  "way a craft is, ingredients through buy orders and each hop divided through by its own yield, " +
  "and the items-per-hour is the tightest hop in the whole path rather than the last one. " +
  "Combining two enchanted books is free and instant: the wiki says so twice, so a combine never " +
  "adds a fee and never binds the rate beyond how fast its own input can be bought.";

const NPC_NOTE =
  "Buy through a buy order, sell to a shopkeeper. The shop's price comes from Hypixel's own item " +
  "resource and carries no tax, which is most of why this beats a bazaar flip on cheap goods that " +
  "move fast. Shopkeepers stop paying after 500M coins a day, so read coins per hour against the " +
  "daily cap beside it — a row that hits the cap in two hours is a two-hour job, not an hourly wage.";

const REVERSE_NPC_NOTE =
  "Buy from a shopkeeper at a fixed price, sell it on the bazaar. Only shops that publish a stock " +
  "limit appear: the profit is the whole stock sold at once, so without a stock figure there is no " +
  "row to quote — and a shop with no published limit is not the same thing as one with no limit, " +
  "so it is left out rather than guessed at.";

const MANIPULATE_NOTE =
  "Items thin enough that one player can own the whole sell side — fewer than 30 sell orders, " +
  "which is also the point past which Hypixel stops publishing the book and you would be buying " +
  "blind. Ranked on risk ascending: risk is what the buyout costs less the most you could get " +
  "back for it, so a negative one is a book you are paid to corner. Partial stops in front of " +
  "the first price jump, since a thin book is usually cheap all the way up and then triples.";

const CRASH_NOTE =
  "Buy the top buy order out and dump it straight back, and the bid drops to whatever was " +
  "standing behind it. The bet is that people instasell without looking at where the price went. " +
  "Cost is what executing it loses you; estimated profit assumes you catch a third of half an " +
  "hour of instasells in the hole before it fills back in — a stated guess, not a forecast.";

function table<T extends BazaarRow>(
  rows: T[],
  hidden: { volume: number; depth: number },
  columns: Column<T>[],
  sort: Sort,
  note: string,
): string {
  if (state.market.size === 0) return `<p class="dim pad">Waiting for the first read of the bazaar…</p>`;
  if (rows.length === 0) {
    const because = state.minFills > 0 ? ` Nothing moves ${num(state.minFills)} times an hour that also matches.` : "";
    return `<p class="dim pad">Nothing matches.${because}</p>`;
  }

  const ordered = sorted(rows, columns, sort);
  const shown = ordered.slice(0, ROW_LIMIT);

  const head = columns
    .map((c) => {
      const on = sort.column === c.id;
      const arrow = on ? (sort.descending ? " ▾" : " ▴") : "";
      return `<th class="num${on ? " on" : ""}" data-bzsort="${c.id}"${
        c.title ? ` title="${escapeHtml(c.title)}"` : ""
      }>${escapeHtml(c.label)}${arrow}</th>`;
    })
    .join("");

  const body = shown
    .map((row) => {
      const cells = columns.map((c) => `<td class="num">${c.render(row)}</td>`).join("");
      const name = escapeHtml(nameOf(row.id));
      // Decorative: the name is right beside it, so an empty alt keeps it out of a screen reader
      // rather than having every row read twice.
      // Lazy because only a screenful is ever on show, async-decoded because the table is rebuilt
      // every twenty seconds and a decode should never hold up the repaint. The service caches for
      // a year, so the rebuild costs nothing on the wire either.
      const icon = `<img class="bz-icon" src="${iconUrl(row.id)}" alt="" width="20" height="20" loading="lazy" decoding="async">`;
      const detail = rowDetail(row);
      // A combined row carries where it came from, so clicking it can open that view rather than
      // leaving the reader to find the same item again by hand.
      const open = "source" in row ? ` class="bz-open" data-bzopen="${(row as Opportunity).source}" data-bzid="${escapeHtml(row.id)}"` : "";
      return `<tr${open}><td>${icon}${name}${detail}</td>${cells}</tr>`;
    })
    .join("");

  const more = ordered.length > shown.length ? ` · showing the top ${num(shown.length)}` : "";
  const floor =
    (hidden.volume > 0 ? ` · ${num(hidden.volume)} below the volume floor` : "") +
    (hidden.depth > 0 ? ` · ${num(hidden.depth)} on too thin a book` : "");

  return `
    <p class="dim pad">${escapeHtml(note)}</p>
    <div class="panel scroll">
      <table class="bz">
        <thead><tr><th>Item</th>${head}</tr></thead>
        <tbody>${body}</tbody>
      </table>
    </div>
    <p class="dim pad">${num(ordered.length)} rows${more}${floor}</p>
  `;
}

/** Which ingredient is holding a craft back, when one is. Silent on flips. */
function limitNote(row: { id: string } & Partial<Craft>): string {
  if (!row.limitedBy) return "";
  return ` <span class="dim" title="This craft is capped by how fast people sell you this ingredient, not by what it sells for.">· held up by ${escapeHtml(
    nameOf(row.limitedBy),
  )}</span>`;
}

/** What goes under the name: a chain's path, a submission's verdict, a craft's binding input. */
function rowDetail(row: BazaarRow): string {
  if ("priced" in row) return submissionDetail(row as PricedRow);
  if ("source" in row) {
    const source = (row as Opportunity).source;
    return ` <span class="dim" title="Which kind of trade this is. Click the row to open it on that tab, where the depth or the full path lives.">· ${SOURCE_LABEL[source]}</span>`;
  }
  if ("hops" in row) return pathNote(row as Chain);
  return limitNote(row as { id: string } & Partial<Craft>);
}

/**
 * A submission's own line: the route as written, and the verdict on it.
 *
 * The problem, where there is one, is the point of the row — so it is stated in words rather than
 * left to be inferred from a zero in a column.
 */
function submissionDetail(row: PricedRow): string {
  const { submission, chain, problem } = row.priced;
  const label = submission.label ? ` <span class="dim">· ${escapeHtml(submission.label)}</span>` : "";
  const route = chain && chain.hops.length > 0 ? pathNote(chain) : "";
  const verdict = problem
    ? `<div class="gold" title="Priced against the live market, not against the figure submitted.">${escapeHtml(problem)}</div>`
    : "";
  return `${label}${route}${verdict}<button type="button" class="chip bz-forget" data-bzforget="${escapeHtml(submission.id)}" title="Remove this route from the list.">forget</button>`;
}

/**
 * The form, deliberately plain.
 *
 * Item ids rather than names, because an id is what every other table here is keyed by and a
 * name-matcher that silently picks the wrong Enchanted Book is worse than one that asks for the
 * id. The steps are optional: the route is re-derived from the live market anyway, so what is
 * really being stored is "watch this item, made rather than bought".
 */
function submissionForm(): string {
  return `
    <div class="panel pad">
      <div class="row">
        <label>Item sold <input id="bzsubsells" placeholder="ENCHANTED_CACTUS" autocomplete="off"></label>
        <label>Bought <input id="bzsubbuys" placeholder="ENCHANTED_CACTUS_GREEN x32" autocomplete="off"
          title="What you buy to start, as ID x QUANTITY, separated by commas. Quantities are per finished item."></label>
        <label>Steps <input id="bzsubsteps" placeholder="craft PAPER, anvil ENCHANTMENT_X_3" autocomplete="off"
          title="Optional, and only for your own reference — the route is re-derived from the live market either way. 'craft ID' or 'anvil ID'."></label>
        <label title="What you think it pays. Never used to price anything; it only feeds the drift column, so you can see how far it has moved since.">Claimed coins/hr
          <input id="bzsubclaim" placeholder="optional" autocomplete="off"></label>
        <button type="button" class="chip" id="bzsubadd">Add route</button>
      </div>
      <p class="dim" id="bzsuberror"></p>
    </div>
  `;
}

/**
 * The whole path, written out.
 *
 * A chain's identity is the route rather than the destination — two rows can both end at an
 * Enchanted Eye of Ender and be entirely different trades — so the path is the row's name, not a
 * detail hidden behind it. Leaves are quantified because "640 Fine Topaz" is the part that tells
 * you whether the trade is affordable, and each craft hop shows the yield when it makes more than
 * one, since that is where a per-item figure stops being obvious.
 */
function pathNote(chain: Chain): string {
  const parts: string[] = [];
  const first = chain.hops[0];
  if (first?.kind === "craft") {
    parts.push(first.ingredients.map((i) => `${num(i.qty)} ${nameOf(i.id)}`).join(" + "));
  } else if (first?.kind === "combine") {
    parts.push(`${first.step.inputsRequired} ${nameOf(first.step.inputId)}`);
  }

  // Consecutive combines up one ladder read as one rung at a time otherwise, which is noise on a
  // four-step climb: "Book·1 →(anvil x4)→ Book·5" is the same fact in one clause.
  let i = 0;
  while (i < chain.hops.length) {
    const hop = chain.hops[i];
    if (hop.kind === "craft") {
      parts.push(`${nameOf(hop.output)}${hop.yield > 1 ? ` <span class="dim">×${hop.yield}</span>` : ""}`);
      i++;
      continue;
    }
    let runs = 0;
    let last = hop.step.outputId;
    while (i < chain.hops.length && chain.hops[i].kind === "combine") {
      last = (chain.hops[i] as { kind: "combine"; step: { outputId: string } }).step.outputId;
      runs++;
      i++;
    }
    parts.push(`<span class="dim">(anvil${runs > 1 ? ` ×${runs}` : ""})</span> ${nameOf(last)}`);
  }

  const held = chain.limitedBy
    ? ` <span class="dim" title="The tightest step in the chain. Every hop above it is waiting on this one, not on what the finished item sells for.">· held up by ${escapeHtml(nameOf(chain.limitedBy))}</span>`
    : "";
  const unknown = chain.unknownSupply.length
    ? ` <span class="gold" title="Bought from a shopkeeper that publishes no stock limit, so how fast this chain can really be fed is not something we can measure. The items-per-hour beside it is an upper bound rather than a reading.">· unmeasured supply: ${escapeHtml(
        chain.unknownSupply.map(nameOf).join(", "),
      )}</span>`
    : "";

  return `<div class="dim bz-path">${parts.join(" → ")}</div>${held}${unknown}`;
}

function ageNote(): string {
  if (!state.lastUpdated) return "";
  const age = Math.round((Date.now() - state.lastUpdated) / 1000);
  return `priced ${age}s ago · Hypixel republishes every 20s`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
