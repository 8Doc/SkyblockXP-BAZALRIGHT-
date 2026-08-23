import { NET_OF_TAX, hourlyBought, hourlySold } from "./bazaar";
import type { ProductSnapshot } from "./bazaarTypes";
import type { NpcPrice, Recipe } from "./bazaarViews";
import { findCraftChains, type AnvilRules, type Chain } from "./bazaarChains";

/**
 * A flip somebody says works, priced the same way as one we found ourselves.
 *
 * The submitted numbers are never used. A submission is a *claim about a route* — buy these,
 * craft that, combine it up, sell the result — and the route is the only part worth keeping,
 * because it is the part that stays true when the price moves. Everything else is re-derived
 * from the live market on every read, exactly as the algorithmic rows are.
 *
 * That is not a slight against whoever submitted it. Someone's 40M-an-hour Enchanted Cactus route
 * was true when they wrote it down and is not true this afternoon, and a table that repeats their
 * figure is worse than one that never had it: it looks checked. So a submission that has stopped
 * working says so in the same column that would have said it works.
 */

/** What a person writes down: what they buy, what they do to it, and what they sell. */
export type Submission = {
  id: string;
  /** Free text, for a human to recognise it by. Never parsed. */
  label?: string;
  /** What the route ends in, and therefore what gets sold. */
  sells: string;
  /** Bazaar goods bought to start it, with quantities per finished item. */
  buys: { id: string; qty: number }[];
  /** The steps claimed, in order. Craft steps name their output; combines name the book. */
  steps: SubmittedStep[];
  submittedAt: number;
  /** What the submitter said it paid, kept only to show how far off it now is. */
  claimedCoinsPerHour?: number;
};

export type SubmittedStep = { kind: "craft"; output: string } | { kind: "combine"; to: string };

export type PricedSubmission = {
  submission: Submission;
  /** The live route, when one can be priced. Null when it cannot be. */
  chain: Chain | null;
  /**
   * Why this is not a trade right now, or null when it is one.
   *
   * A submission is never dropped for being unprofitable — it is shown with the reason, because
   * "we checked and it does not work" is the useful answer and a missing row is not.
   */
  problem: string | null;
  /** How far the live figure has drifted from the claim, as a percentage. Null without a claim. */
  driftPercent: number | null;
};

/**
 * Price a submission against the live market.
 *
 * The route is validated by being *found*, not by being trusted: the chain finder is asked for
 * the cheapest way to make the terminal, and the submission is priced on that. If the finder
 * cannot reach it at all — an ingredient nobody bids on, a step that is not a real recipe — the
 * submission is unpriceable and says which.
 */
export function priceSubmission(
  submission: Submission,
  market: Map<string, ProductSnapshot>,
  options: { recipes: Recipe[]; npcPrices?: Record<string, NpcPrice>; anvil?: AnvilRules; maxDepth?: number },
): PricedSubmission {
  const terminal = market.get(submission.sells);
  if (!terminal) {
    return { submission, chain: null, problem: `The bazaar does not trade ${submission.sells}.`, driftPercent: null };
  }
  if (terminal.instabuy <= 0) {
    // The same rule `flip()` and `craft()` keep: an empty side of the book is not a price of zero.
    return { submission, chain: null, problem: "Nobody is bidding on the finished item.", driftPercent: null };
  }

  const missing = submission.buys.filter((b) => !market.has(b.id) && !(options.npcPrices ?? {})[b.id]);
  if (missing.length > 0) {
    return {
      submission,
      chain: null,
      problem: `No price for ${missing.map((m) => m.id).join(", ")}.`,
      driftPercent: null,
    };
  }

  const chains = findCraftChains(market, {
    recipes: options.recipes,
    npcPrices: options.npcPrices,
    anvil: options.anvil,
    maxDepth: options.maxDepth ?? Math.max(4, submission.steps.length),
    // The route has to be costed as *made*. Left to itself the finder would answer "buying one is
    // cheaper" the moment the trade went underwater, which is true and is exactly the case this
    // row exists to report — so it would vanish at the moment it became worth reading.
    mustProduce: new Set([submission.sells]),
  });
  const chain = chains.find((c) => c.id === submission.sells) ?? null;

  if (!chain) {
    return {
      submission,
      chain: null,
      problem: "No route to this item can be priced from the live market.",
      driftPercent: null,
    };
  }

  const problem =
    chain.margin <= 0
      ? "Underwater: the ingredients cost more than the finished item sells for."
      : chain.bottleneck <= 0
        ? "Nothing is moving — no throughput on either the ingredients or the sale."
        : null;

  const driftPercent =
    submission.claimedCoinsPerHour && submission.claimedCoinsPerHour > 0
      ? (100 * chain.coinsPerHour) / submission.claimedCoinsPerHour - 100
      : null;

  return { submission, chain, problem, driftPercent };
}

/**
 * A one-hop route the chain finder will not return.
 *
 * `findCraftChains` only reports items it can *make*, so a submission that is really a plain
 * bazaar flip — buy it, sell it, no crafting — has no chain and would read as unpriceable. It is
 * a legitimate thing to submit, so it is priced directly here rather than rejected.
 */
export function priceDirectFlip(submission: Submission, market: Map<string, ProductSnapshot>): PricedSubmission | null {
  if (submission.steps.length > 0 || submission.buys.length !== 1) return null;
  const [only] = submission.buys;
  if (only.id !== submission.sells) return null;

  const p = market.get(submission.sells);
  if (!p || p.instabuy <= 0 || p.instasell <= 0) {
    return { submission, chain: null, problem: "One side of the book is empty.", driftPercent: null };
  }

  const margin = p.instabuy * NET_OF_TAX - p.instasell;
  const perHour = Math.min(hourlyBought(p), hourlySold(p));
  const chain: Chain = {
    id: p.id,
    hops: [],
    depth: 0,
    combines: false,
    craftCost: p.instasell,
    sellAt: p.instabuy,
    margin,
    inputLimit: hourlySold(p),
    outputLimit: hourlyBought(p),
    bottleneck: perHour,
    coinsPerHour: margin * perHour,
    unknownSupply: [],
  };

  const driftPercent =
    submission.claimedCoinsPerHour && submission.claimedCoinsPerHour > 0
      ? (100 * chain.coinsPerHour) / submission.claimedCoinsPerHour - 100
      : null;

  return {
    submission,
    chain,
    problem: margin <= 0 ? "Underwater: the spread has closed." : null,
    driftPercent,
  };
}

/** Price whichever way fits — a bare flip, or a route through the graph. */
export function price(
  submission: Submission,
  market: Map<string, ProductSnapshot>,
  options: { recipes: Recipe[]; npcPrices?: Record<string, NpcPrice>; anvil?: AnvilRules; maxDepth?: number },
): PricedSubmission {
  return priceDirectFlip(submission, market) ?? priceSubmission(submission, market, options);
}
