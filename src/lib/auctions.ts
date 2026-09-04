import type { BinIndex } from "./profile";

/**
 * Building a lowest-BIN index out of raw auction pages.
 *
 * The auction endpoint doesn't carry SkyBlock item ids — they're inside gzipped NBT on every one
 * of ~48,000 listings. Decoding all of that in a browser is not on, so listings are matched by
 * display name instead, which works because a reforge only ever *prepends* a word and stars only
 * append symbols. Measured 138/138 on a full page of accessories.
 *
 * Pets are the exception and get their own path: they list as "[Lvl 91] Golden Dragon" with the
 * rarity in `tier`, so the level is stripped and the name keyed as PET:<NAME>. That also makes
 * the auction house the pet catalogue — there is no pet list in the API, and a pet nobody is
 * selling is a pet you can't buy anyway.
 */

export type AuctionRecord = {
  bin?: boolean;
  category?: string;
  tier?: string;
  item_name?: string;
  starting_bid?: number;
  /** When the listing went up, in epoch ms. How long a BIN has sat is a liquidity signal. */
  start?: number;
};

const DECORATION = /[^\x20-\x7E]/g;
const PET_LEVEL = /^\[Lvl \d+\]\s*/;

/** "PET:GOLDEN_DRAGON" — the key a pet task looks itself up by. */
export function petKey(name: string): string {
  return `PET:${name.trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`;
}

export function matchName(itemName: string, nameToId: Map<string, string>): string | null {
  const name = itemName.replace(DECORATION, "").replace(/\s+/g, " ").trim().toLowerCase();
  const exact = nameToId.get(name);
  if (exact) return exact;
  // "Bizarre Tarantula Ring" -> "Tarantula Ring". Longest suffix wins, so a reforge or a
  // "Shiny" prefix falls away without swallowing a genuinely shorter item name.
  const parts = name.split(" ");
  for (let i = 1; i < parts.length; i++) {
    const tail = nameToId.get(parts.slice(i).join(" "));
    if (tail) return tail;
  }
  return null;
}

/** Every pet currently listed, as (name, rarity) pairs the catalogue can turn into tasks. */
export function petsFrom(index: BinIndex): { name: string; rarity: string }[] {
  const pets: { name: string; rarity: string }[] = [];
  for (const [key, byTier] of Object.entries(index.prices)) {
    if (!key.startsWith("PET:")) continue;
    const name = key.slice(4).replace(/_/g, " ");
    for (const rarity of Object.keys(byTier)) pets.push({ name, rarity });
  }
  return pets;
}

/** Accumulator so pages can be folded in as they arrive, however they were fetched. */
export function createBinIndex(): BinIndex {
  return { prices: {}, scannedAt: Date.now(), pages: 0, listings: 0 };
}

export function absorbAuctionPage(index: BinIndex, auctions: AuctionRecord[], nameToId: Map<string, string>): void {
  for (const auction of auctions) {
    if (!auction.bin || !auction.item_name || !auction.tier) continue;
    const price = auction.starting_bid ?? 0;
    if (price <= 0) continue;

    const clean = auction.item_name.replace(DECORATION, "").replace(/\s+/g, " ").trim();
    const id = PET_LEVEL.test(clean) ? petKey(clean.replace(PET_LEVEL, "")) : matchName(clean, nameToId);
    if (!id) continue;

    index.listings++;
    const byTier = (index.prices[id] ??= {});
    // Lowest BIN per rarity, not per item: a recombobulated copy — or a higher-rarity pet — is
    // a different purchase with a different value.
    if (byTier[auction.tier] === undefined || price < byTier[auction.tier]) byTier[auction.tier] = price;
  }
  index.pages++;
}
