import { coins, num } from "../lib/format";
import { buyPriceOf, craftCostOf, type CraftCost, type MinionRecipes } from "../lib/minionCraft";

/**
 * The craft-cost cell, shared by the two tabs that show it.
 *
 * It is the same question on both — what did this wall cost to build — so it is one answer, priced
 * the same way and worded the same way. Splitting it was how "Just selling" ended up meaning two
 * different things on two tabs, and there is no reason to repeat that here.
 */

export type CraftCellContext = {
  recipes: MinionRecipes;
  /** Every product the bazaar published this poll. The ask side is what buying costs. */
  market: Map<string, { instabuy: number } | null>;
  npcPrices: Record<string, { buy?: number; sell?: number }>;
  /** How many of the minion are down, so the cell can quote the wall and the bill can quote one. */
  placed: number;
};

/**
 * A per-render cache.
 *
 * The table sorts on this column, so without one a twelve-tier ladder is walked for sixty minions
 * on every comparison. Keyed by minion and tier, and thrown away whenever prices or the count move
 * — which is every repaint, so the cache never outlives the numbers it was built from.
 */
export function createCraftCache(): Map<string, CraftCost | null> {
  return new Map();
}

export function craftFor(
  cache: Map<string, CraftCost | null>,
  context: CraftCellContext,
  generator: string,
  tier: number,
): CraftCost | null {
  const key = `${generator}:${tier}`;
  if (!cache.has(key)) {
    cache.set(key, craftCostOf(generator, tier, context.recipes, buyPriceOf(context.market, context.npcPrices)));
  }
  return cache.get(key) ?? null;
}

/**
 * The cost of the wall, with the bill for one minion on the hover.
 *
 * The wall, because every other figure on both tables is the wall — an income for thirty minions
 * beside a cost for one is the mismatch that made the two tabs disagree in the first place. The
 * bill is per minion, since that is what "the materials for a Tier XII" means, and it carries both
 * totals so neither has to be worked out by hand.
 */
export function craftCellHtml(cost: CraftCost | null, family: string, placed: number): string {
  if (!cost) {
    return `<span class="dim" title="This minion is not crafted — it is obtained some other way, so there is no material cost to quote.">not crafted</span>`;
  }
  const bill = craftBill(cost, family, placed);
  const shown = coins(Math.round(cost.coins * placed));
  // The plus is the honest part of an incomplete bill: something real is missing from the total.
  return `<span title="${escapeAttr(bill)}"${cost.unpriced.length ? ' class="gold"' : ""}>${shown}${
    cost.unpriced.length ? " +" : ""
  }</span>`;
}

/** The hover: every material the tier has cost since Tier I, dearest first. */
export function craftBill(cost: CraftCost, family: string, placed: number): string {
  const lines = cost.lines.map(
    (line) =>
      `${num(line.qty)}x ${line.item} — ${line.unit === null ? "nothing prices this" : coins(Math.round(line.coins))}`,
  );
  const head = `Materials for one ${family} ${roman(cost.tier)}, cumulative from Tier I:`;
  const foot =
    placed > 1
      ? `Total ${coins(Math.round(cost.coins))} each, ${coins(Math.round(cost.coins * placed))} for ${num(placed)}.`
      : `Total ${coins(Math.round(cost.coins))}.`;
  const caveat =
    cost.unpriced.length > 0
      ? `\nThe total is a floor: ${cost.unpriced.map((u) => u.item).join(" and ")} ${
          cost.unpriced.length === 1 ? "is" : "are"
        } not priced anywhere here.`
      : "";
  return [head, ...lines, foot].join("\n") + caveat;
}

const ROMAN = ["", "I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X", "XI", "XII"];
export function roman(tier: number): string {
  return ROMAN[tier] ?? String(tier);
}

/** Newlines survive in a title attribute; the quotes and angle brackets must not. */
function escapeAttr(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
