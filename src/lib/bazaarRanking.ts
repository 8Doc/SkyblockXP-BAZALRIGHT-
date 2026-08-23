import { ORDER_WINDOW_HOURS } from "./bazaarViews";
import type { Craft, Flip, NpcFlip } from "./bazaarViews";
import type { Chain } from "./bazaarChains";

/**
 * One ranking over every kind of trade at once.
 *
 * The six views each answer their own question well and none of them answers the question a
 * reader actually arrives with, which is *what should I do with the coins I have*. Coins per hour
 * cannot answer it: a craft turning 400M into 40M an hour and a flip turning 4M into 12M an hour
 * are not comparable on that axis, and the craft wins it while being the worse trade for anyone
 * without 400M spare.
 *
 * Return on capital is the axis they *are* comparable on, and `flip()` already computes it that
 * way — `coinsPerHour / capital`, with capital sized to twenty minutes of the market's own flow.
 * The work here is defining capital the same way for the other three, so the ratio means one
 * thing across the table rather than four.
 */

/**
 * Coins tied up, on the same twenty-minute rule for every kind of trade.
 *
 * A flip's capital is the buy order the bazaar holds up front, which is where the rule comes
 * from: an order sized to twenty minutes of flow fills in twenty minutes, so it is big enough to
 * leave alone and small enough that no part of it is idling in a queue. A craft or a chain has no
 * order, but it has the same shape of commitment — coins spent on ingredients that are not coins
 * again until the output sells — so it is sized the same way: twenty minutes of what the trade
 * can actually produce, at what producing one costs.
 *
 * Sizing all four the same way is the point. Any other rule would make the ratio a comparison of
 * the rules rather than of the trades.
 */
export function capitalFor(coinsPerItem: number, itemsPerHour: number): number {
  const items = Math.max(1, itemsPerHour * ORDER_WINDOW_HOURS);
  return coinsPerItem * items;
}

export type OpportunitySource = "flip" | "craft" | "chain" | "npc";

export type Opportunity = {
  id: string;
  source: OpportunitySource;
  /** Coins in per hour, exactly as the source view computes it. Never recomputed here. */
  coinsPerHour: number;
  /** Coins committed to earn it. */
  capital: number;
  /** The ranking figure: coins per hour per coin tied up. */
  returnOnCapital: number;
  /** Per item, or per round trip for a flip. */
  margin: number;
  /** Items an hour, or round trips an hour for a flip. */
  perHour: number;
};

/**
 * A trade with no capital behind it is not an infinite return, it is a missing number.
 *
 * Dividing by zero would put it at the top of the ranking permanently, which is the one place a
 * reader is most likely to trust it.
 */
function opportunity(
  id: string,
  source: OpportunitySource,
  coinsPerHour: number,
  capital: number,
  margin: number,
  perHour: number,
): Opportunity | null {
  if (!(capital > 0) || !Number.isFinite(capital) || !Number.isFinite(coinsPerHour)) return null;
  return { id, source, coinsPerHour, capital, returnOnCapital: coinsPerHour / capital, margin, perHour };
}

export type Sources = {
  flips?: Flip[];
  crafts?: Craft[];
  chains?: Chain[];
  npcFlips?: NpcFlip[];
};

/**
 * Every opportunity on one axis, best return first.
 *
 * Unprofitable rows are dropped rather than ranked negatively: the question is what to do with
 * coins, and "lose them slightly less quickly than this other thing" is not an answer.
 */
export function rankOpportunities(sources: Sources): Opportunity[] {
  const out: (Opportunity | null)[] = [];

  for (const f of sources.flips ?? []) {
    // A flip already sizes its own capital, and that rule is where the other three get theirs.
    out.push(opportunity(f.id, "flip", f.coinsPerHour, f.capital, f.netMargin, f.hourlyFills));
  }

  for (const c of sources.crafts ?? []) {
    out.push(opportunity(c.id, "craft", c.coinsPerHour, capitalFor(c.craftCost, c.bottleneck), c.margin, c.bottleneck));
  }

  for (const c of sources.chains ?? []) {
    out.push(opportunity(c.id, "chain", c.coinsPerHour, capitalFor(c.craftCost, c.bottleneck), c.margin, c.bottleneck));
  }

  for (const n of sources.npcFlips ?? []) {
    // `npcFlip` reports coins per hour as margin times the rate people sell it to you, so the
    // rate falls back out of the two rather than being recomputed from a snapshot this module
    // does not have — and a zero margin has no rate to recover.
    const perHour = n.margin > 0 ? n.coinsPerHour / n.margin : 0;
    out.push(opportunity(n.id, "npc", n.coinsPerHour, capitalFor(n.buyAt, perHour), n.margin, perHour));
  }

  return out
    .filter((o): o is Opportunity => o !== null && o.coinsPerHour > 0)
    .sort((a, b) => b.returnOnCapital - a.returnOnCapital);
}
