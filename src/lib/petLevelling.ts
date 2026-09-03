import { petKey, type AuctionRecord } from "./auctions";

/**
 * Buying a pet cheap, levelling it, and selling it dear.
 *
 * The trade is simple and the pricing is not. A pet's listing price is a function of two things
 * the auction endpoint puts in different places: the rarity, which arrives as `tier`, and the
 * level, which arrives inside the display name as "[Lvl 91] Golden Dragon" and nowhere else. The
 * existing BIN index throws the level away — reasonably, because the museum and accessory
 * questions it was built for do not have levels — and a pet at level 1 and the same pet at level
 * 100 are two completely different purchases at two completely different prices. Recovering the
 * level is the whole reason this file exists rather than reusing `absorbAuctionPage`.
 *
 * **The margin is not the answer; the margin per XP is.** A Golden Dragon gains tens of millions
 * levelling and needs 210 million Pet XP to do it; a Rabbit gains a fraction of that and needs
 * five and a half million. Ranked on margin the dragon wins every time and is the wrong answer for
 * anyone who has to actually generate the XP, which is everyone. Coins per Pet XP is the figure
 * that makes the two comparable, and it is what the minion half of this tab feeds: a minion
 * produces Pet XP an hour, and this says what an hour of it is worth in coins.
 *
 * **Both ends are lowest BIN and neither is a promise.** The buy side is a listing that exists, so
 * it is real. The sell side is *someone else's* listing, which is what you would have to undercut
 * rather than what you would receive — and if you list a hundred of them, the price you get is not
 * the price that is up now. Every figure here is before that reality and after the auction house's
 * 1% cut, which is the one deduction that is certain.
 */

/** What the auction house keeps on a sale. The same 1% the planner already prices trade-ins at. */
export const AUCTION_TAX = 0.01;
export const NET_OF_AUCTION_TAX = 1 - AUCTION_TAX;

/** "[Lvl 91] Golden Dragon" — the level, and the name with the bracket taken off. */
const PET_LEVEL = /^\[Lvl (\d+)\]\s*(.+)$/;
const DECORATION = /[^\x20-\x7E]/g;

export type PetListing = { level: number; price: number };

/**
 * The cheapest listing at each end of one pet's ladder, per rarity.
 *
 * Only the two ends are kept. A full price-by-level curve would be the better dataset and is a
 * hundred times the size, and the trade this ranks only ever touches the ends: you buy at the
 * bottom and sell at the top. `base` is the cheapest listing at the lowest level anyone is selling
 * — usually 1, occasionally not, which is why the level travels with the price instead of being
 * assumed.
 */
export type PetPrices = { base: PetListing | null; max: PetListing | null };
export type PetBinIndex = {
  /** PET:<NAME> to rarity to the two ends. */
  prices: Record<string, Record<string, PetPrices>>;
  scannedAt: number;
  pages: number;
  listings: number;
};

export function createPetBinIndex(): PetBinIndex {
  return { prices: {}, scannedAt: Date.now(), pages: 0, listings: 0 };
}

/**
 * Which level counts as "maxed" for a pet.
 *
 * A hundred for almost everything, two hundred for the dragons that hatch at a hundred. Taking the
 * overrides from the same curated table the pet-score code already reads means the two cannot
 * drift apart, and means a Golden Dragon is not quietly treated as finished at level 100 — the
 * level at which it has not started.
 */
export type PetLevelTable = {
  defaultMaxLevel: number;
  maxLevelXp: Record<string, number>;
  overrides?: Record<string, { maxLevel: number; maxLevelXp: number }>;
};

/**
 * The index keys pets as `PET:GOLDEN_DRAGON` — the same key the auction matcher and the planner
 * already use — and the curated level table keys them bare. Stripping the prefix here rather than
 * asking every caller to remember is not tidiness: a missed strip silently falls through to the
 * default of 100, which treats a Golden Dragon as finished at the level it hatches at and prices
 * the whole trade against the wrong end of its ladder.
 */
function bare(key: string): string {
  return key.startsWith("PET:") ? key.slice(4) : key;
}

export function maxLevelOf(key: string, levels: PetLevelTable): number {
  return levels.overrides?.[bare(key)]?.maxLevel ?? levels.defaultMaxLevel;
}

export function maxLevelXpOf(key: string, rarity: string, levels: PetLevelTable): number | null {
  const override = levels.overrides?.[bare(key)];
  if (override) return override.maxLevelXp;
  return levels.maxLevelXp[rarity] ?? null;
}

/**
 * Fold one page of auctions into the pet index.
 *
 * Non-pets fall out on the level bracket, which is a stronger filter than the category field: only
 * pets carry one, and every pet does. Bids are skipped along with everything else that is not a
 * BIN — an auction still running is not a price you can pay.
 */
export function absorbPetPage(index: PetBinIndex, auctions: AuctionRecord[], levels: PetLevelTable): void {
  for (const auction of auctions) {
    if (!auction.bin || !auction.item_name || !auction.tier) continue;
    const price = auction.starting_bid ?? 0;
    if (price <= 0) continue;

    const clean = auction.item_name.replace(DECORATION, "").replace(/\s+/g, " ").trim();
    const match = PET_LEVEL.exec(clean);
    if (!match) continue;

    const level = Number(match[1]);
    const key = petKey(match[2]);
    index.listings++;

    const byRarity = (index.prices[key] ??= {});
    const ends = (byRarity[auction.tier] ??= { base: null, max: null });

    if (level >= maxLevelOf(key, levels)) {
      if (!ends.max || price < ends.max.price) ends.max = { level, price };
    }
    // The base end takes the lowest level first and the lowest price second: a level 1 at 12M is
    // a better starting point than a level 4 at 11M, because the four levels are XP you did not
    // have to make and the comparison downstream is per XP.
    if (!ends.base || level < ends.base.level || (level === ends.base.level && price < ends.base.price)) {
      ends.base = { level, price };
    }
  }
  index.pages++;
}

/* -------------------------------------------------------------------- rows */

export type PetProfitRow = {
  key: string;
  name: string;
  rarity: string;
  buy: PetListing;
  sell: PetListing;
  /** Sale less the auction house's cut, less what the pet cost. */
  profit: number;
  /** Pet XP between the two ends. */
  xpNeeded: number;
  /** Coins of profit per Pet XP. The figure that makes a Rabbit comparable to a Dragon. */
  coinsPerXp: number;
  /** True when the cheap end is not level 1 and the XP figure is therefore an overstatement. */
  approximate: boolean;
  caveats: string[];
};

export type PetProfitOptions = {
  index: PetBinIndex;
  levels: PetLevelTable;
  /** Display names by pet key, so a row can say "Golden Dragon" rather than GOLDEN_DRAGON. */
  names?: Record<string, string>;
  /** Hide rows whose two ends are the same listing, which is not a trade. */
  minProfit?: number;
};

/**
 * Every pet worth levelling, best coins per Pet XP first.
 *
 * A row needs both ends to exist: a pet nobody is selling at level 1 cannot be bought, and one
 * nobody is selling at level 100 has no price to sell into. Both are common — the auction house is
 * a snapshot, not a catalogue — and a row invented from a reference price would be a trade you
 * cannot make.
 */
export function planPetProfit(o: PetProfitOptions): PetProfitRow[] {
  const out: PetProfitRow[] = [];
  const floor = o.minProfit ?? 0;

  for (const [key, byRarity] of Object.entries(o.index.prices)) {
    for (const [rarity, ends] of Object.entries(byRarity)) {
      if (!ends.base || !ends.max) continue;
      // One listing cannot be both ends of a trade.
      if (ends.base.level >= ends.max.level) continue;

      const total = maxLevelXpOf(key, rarity, o.levels);
      if (total === null || total <= 0) continue;

      const profit = ends.max.price * NET_OF_AUCTION_TAX - ends.base.price;
      if (profit <= floor) continue;

      const caveats: string[] = [];
      const approximate = ends.base.level > 1;
      if (approximate) {
        caveats.push(
          `the cheapest copy is level ${ends.base.level}, not 1, so some of this XP is already on it — ` +
            `the per-XP figure is a floor and the real one is better`,
        );
      }
      if (o.levels.overrides?.[bare(key)]) {
        caveats.push(`this pet levels past 100, to ${maxLevelOf(key, o.levels)}`);
      }

      out.push({
        key,
        name: o.names?.[key] ?? key.replace(/^PET:/, "").replace(/_/g, " "),
        rarity,
        buy: ends.base,
        sell: ends.max,
        profit,
        xpNeeded: total,
        coinsPerXp: profit / total,
        approximate,
        caveats,
      });
    }
  }

  return out.sort((a, b) => b.coinsPerXp - a.coinsPerXp || b.profit - a.profit);
}

/**
 * What a stream of Pet XP is worth in coins, at a given pet's rate.
 *
 * This is the join between the two halves of the tab: the minion section produces Pet XP an hour
 * and this turns it into coins an hour by naming which pet is absorbing it. Levelling a pet is not
 * a coin faucet on its own — you have to sell the pet at the end and buy another one — so the
 * figure is the trade's margin spread over the XP it took, which is exactly `coinsPerXp`.
 */
export function coinsPerHourFrom(petXpPerHour: number, row: PetProfitRow): number {
  return petXpPerHour * row.coinsPerXp;
}

/** How long one pet takes to level at a given Pet XP rate, in hours. */
export function hoursToLevel(petXpPerHour: number, row: PetProfitRow): number {
  return petXpPerHour > 0 ? row.xpNeeded / petXpPerHour : Infinity;
}
