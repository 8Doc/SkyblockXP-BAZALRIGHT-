/**
 * What a minion costs to build, as opposed to what it earns.
 *
 * Every other figure in this app is an income, and an income on its own does not answer the
 * question anybody is actually asking. A Tier XII Melon Minion pays well; the eleven upgrades
 * behind it are nine hundred enchanted melons and a wooden hoe, and until that number is on the
 * page beside the income the table is only telling half the story — most obviously for the slayer
 * minions, where the drops themselves are the expensive part.
 *
 * The materials come from `data/generated/minion-recipes.json`, which sums each minion's own
 * recipe ladder off the wiki. Two things about that ladder matter here:
 *
 * **It is cumulative, and a nested minion is already expanded.** A Revenant Minion XI is not
 * "a Revenant Minion X plus some viscera" as far as this is concerned — it is every material since
 * Tier I, including the eleven Zombie Minions consumed on the way, written out as rotten flesh.
 *
 * **Some ingredients have no price, and that is reported rather than treated as free.** A
 * Crystallized Heart and a Bat Person Helmet are real costs that no bazaar quotes. A cost figure
 * that silently drops them is wrong in the direction that flatters the minion, so the count comes
 * back on the result and the caller says so.
 */

export type CraftIngredient = { item: string; itemId: string | null; qty: number };

export type MinionTierRecipe = {
  tier: number;
  /** What this tier alone adds. */
  upgrade: CraftIngredient[];
  /** Every material the tier has cost since Tier I. */
  cumulative: CraftIngredient[];
};

export type MinionRecipeLadder = { generator: string; family: string; tiers: MinionTierRecipe[] };

export type MinionRecipes = {
  minions: MinionRecipeLadder[];
  /** Minions nobody crafts — the Snow Minion comes out of Gifts. */
  noRecipe: string[];
};

/** One line of the bill: how many, at what each, for how much. */
export type CraftLine = CraftIngredient & {
  /** Coins for one, or null where nothing prices it. */
  unit: number | null;
  /** `qty * unit`, or 0 for an unpriced line. */
  coins: number;
};

export type CraftCost = {
  tier: number;
  /** Coins to buy every priced material for one minion of this tier. */
  coins: number;
  /** Biggest line first, because the answer to "why is this expensive" is almost always the first row. */
  lines: CraftLine[];
  /** Ingredients nothing prices. The figure above is a floor while this is non-empty. */
  unpriced: CraftIngredient[];
};

/**
 * What one minion of a tier costs in materials.
 *
 * `priceOf` is the caller's buy-side price for one of an item. Buy-side and not sell-side: this is
 * a purchase, so what matters is the ask, and quoting the bid would understate every line by the
 * spread — which on the bulk items a minion ladder is made of is not a small fraction.
 *
 * Null where the minion has no recipe at all, which is a different answer from zero and the reason
 * this does not simply return an empty bill.
 */
export function craftCostOf(
  generator: string,
  tier: number,
  recipes: MinionRecipes,
  priceOf: (itemId: string) => number | null,
): CraftCost | null {
  const ladder = recipes.minions.find((m) => m.generator === generator);
  if (!ladder) return null;

  // The highest tier at or below the one asked for, so a request for a tier this minion does not
  // have answers with the tier it stops at rather than with nothing.
  const found = ladder.tiers.filter((t) => t.tier <= tier).sort((a, b) => b.tier - a.tier)[0];
  if (!found) return null;

  const lines: CraftLine[] = [];
  const unpriced: CraftIngredient[] = [];
  let coins = 0;

  for (const ingredient of found.cumulative) {
    const unit = ingredient.itemId ? priceOf(ingredient.itemId) : null;
    if (unit === null || !(unit > 0)) {
      unpriced.push(ingredient);
      lines.push({ ...ingredient, unit: null, coins: 0 });
      continue;
    }
    const line = ingredient.qty * unit;
    coins += line;
    lines.push({ ...ingredient, unit, coins: line });
  }

  lines.sort((a, b) => b.coins - a.coins || b.qty - a.qty);
  return { tier: found.tier, coins, lines, unpriced };
}

/**
 * How long the minion takes to pay for itself, in days. Infinite where it never does.
 *
 * The one number that turns a cost and an income into a decision. Deliberately not netted against
 * anything else: this is the wall paying for the wall, at the rate the table beside it is quoting.
 */
export function paybackDays(coins: number, coinsPerDay: number): number {
  if (!(coins > 0)) return 0;
  if (!(coinsPerDay > 0)) return Infinity;
  return coins / coinsPerDay;
}

/**
 * Buy-side price for one of an item, from the bazaar first and a shopkeeper second.
 *
 * The ask, not the bid: building a minion means buying the materials, and pricing them at what
 * they fetch rather than at what they cost would understate every line by the spread. The shop is
 * the fallback rather than the other way round because it is usually the worse of the two and is
 * only reached for the vanilla items no bazaar carries — a wooden pickaxe, a flint and steel.
 */
export function buyPriceOf(
  market: Map<string, { instabuy: number } | null>,
  npcPrices: Record<string, { buy?: number; sell?: number }>,
): (itemId: string) => number | null {
  return (itemId) => {
    const quoted = market.get(itemId)?.instabuy;
    if (typeof quoted === "number" && quoted > 0) return quoted;
    const shop = npcPrices[itemId]?.buy;
    return typeof shop === "number" && shop > 0 ? shop : null;
  };
}
