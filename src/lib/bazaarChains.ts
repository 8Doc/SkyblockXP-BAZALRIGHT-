import { NET_OF_TAX, hourlyBought, hourlySold } from "./bazaar";
import type { ProductSnapshot } from "./bazaarTypes";
import type { NpcPrice, Recipe } from "./bazaarViews";

/**
 * Crafts that take more than one step.
 *
 * `craft()` answers one question — buy these ingredients, make this thing, sell it — and it is
 * the right question for 375 of the 375 recipes it can see. What it cannot see is that the
 * output of one recipe is the ingredient of another, so a trade like *buy Sugar Cane, make
 * Paper, make a Hot Potato Book* has no row anywhere: Paper is not a bazaar good, so the Paper
 * step is not a craft, and the Book step reads as unpriceable because one of its ingredients has
 * no price.
 *
 * This module is the same arithmetic done over a graph instead of a single edge. Two kinds of
 * edge, which is the second thing a one-hop view cannot express:
 *
 *   craft    n ingredients in, `yield` out, throughput capped by the scarcest ingredient
 *   combine  two identical enchanted books in, one a level higher out, instantly and free
 *
 * **Everything is per terminal item.** `craft()` divides through by the yield so that a recipe
 * making thirty-two is comparable to one making one; a chain has to do that at *every* hop or a
 * high-yield step in the middle misprices everything above it. The recursion below divides at
 * each step rather than at the end, which is the same rule applied the same way.
 *
 * **Cheapest is decided here, not in the data.** NEU publishes alternative recipes — Enchanted
 * Iron is 160 ingots or 160 blocks — and which is cheaper is a price question that changes
 * through the day. Every path is kept and the cheapest is chosen against the live market on each
 * call, which is also why this takes a `market` rather than baking anything in.
 */

/* --------------------------------------------------------------- the edges */

/**
 * Two books of one level into one of the next.
 *
 * `anvilFeeCoins` is zero and is carried anyway rather than dropped, because "we checked and it
 * is free" and "we forgot to model a cost" look identical once the field is gone. The wiki says
 * so twice, on two pages: combining "costs no additional Experience levels", and "It costs
 * nothing to combine Enchanted Books in an Anvil."
 */
export type CombineStep = {
  inputId: string;
  inputTier: number;
  outputId: string;
  inputsRequired: number;
  anvilFeeCoins: number;
};

/** The rules, curated; the ladder they run on is read off the live market. */
export type AnvilRules = {
  feeCoins: number;
  inputsRequired: number;
  maxCombinableLevel: number;
};

/** `ENCHANTMENT_PROTECTION_3` -> `{ family: "PROTECTION", level: 3 }`. */
export function enchantTier(id: string): { family: string; level: number } | null {
  const m = /^ENCHANTMENT_(.+)_(\d+)$/.exec(id);
  return m ? { family: m[1], level: Number(m[2]) } : null;
}

/**
 * Every combine the live market can actually support.
 *
 * Derived from the bazaar's own ids rather than from a table, so it cannot go stale: a step
 * exists only where both the pair being consumed and the book being produced are things the
 * bazaar quotes. The cap is the curated half — the wiki states that levels past the fifth
 * generally come from Dungeons and Experiments rather than from an anvil, and gives the case
 * where combining two of the level above actually produces a *lower* book, so a sixth level is
 * not one step up from a fifth.
 */
export function combineSteps(market: Map<string, ProductSnapshot>, rules: AnvilRules): CombineStep[] {
  const steps: CombineStep[] = [];
  for (const id of market.keys()) {
    const tier = enchantTier(id);
    if (!tier) continue;
    const next = tier.level + 1;
    if (next > rules.maxCombinableLevel) continue;
    const outputId = `ENCHANTMENT_${tier.family}_${next}`;
    if (!market.has(outputId)) continue;
    steps.push({
      inputId: id,
      inputTier: tier.level,
      outputId,
      inputsRequired: rules.inputsRequired,
      anvilFeeCoins: rules.feeCoins,
    });
  }
  return steps;
}

/* ---------------------------------------------------------------- the walk */

export type ChainHop =
  | { kind: "craft"; output: string; yield: number; ingredients: { id: string; qty: number }[] }
  | { kind: "combine"; step: CombineStep };

/** Where one item's supply comes from, and what it costs by the time it is in your hands. */
type Source = {
  /** Coins per one of this item, every step divided through by its own yield. */
  cost: number;
  /** Items an hour this can be produced at, before the terminal sale is considered. */
  rate: number;
  /** The hops that made it, in production order — leaves first, terminal last. */
  hops: ChainHop[];
  depth: number;
  /** Which leaf is holding the rate down, for the "held up by" note. */
  limitedBy?: string;
  /** Shop-sourced leaves with no published stock, whose supply we are not modelling. */
  unknownSupply: string[];
};

export type Chain = {
  id: string;
  hops: ChainHop[];
  /** Hops in the chain. One is an ordinary craft; the interesting rows are two and up. */
  depth: number;
  /** True when any hop is an anvil combine. */
  combines: boolean;
  craftCost: number;
  sellAt: number;
  margin: number;
  /** Items an hour the chain can be fed. */
  inputLimit: number;
  /** Items an hour the terminal's own demand will absorb. */
  outputLimit: number;
  bottleneck: number;
  coinsPerHour: number;
  limitedBy?: string;
  /**
   * Leaves bought from a shopkeeper with no stock figure published.
   *
   * Their cost is known and their throughput is not, so the bottleneck below is an upper bound
   * on those rows rather than a measurement. Named rather than folded in, because a chain whose
   * rate rests on an unknown should say so instead of ranking as though it were measured.
   */
  unknownSupply: string[];
};

/**
 * How fast a shopkeeper can supply an ingredient.
 *
 * A stated daily stock spread over the day; nothing where no stock is published. The second case
 * is deliberately *not* treated as zero — a shop with no stated limit is not a shop that sells
 * nothing — but it is not treated as unlimited either, so the id is carried up to the row as an
 * unknown rather than quietly becoming an infinity that wins every ranking.
 */
const HOURS_PER_DAY = 24;

/**
 * The cheapest way to get one of each item, and how fast.
 *
 * Depth-first with a memo per item, and a `visiting` set because recipe graphs contain cycles —
 * an Enchanted Block is made of Enchanted Ingots and can be broken back into them, and without
 * the guard the first such pair recurses forever. A cycle is simply not a cheaper path, so
 * refusing to re-enter one costs nothing.
 */
function sourceOf(
  id: string,
  market: Map<string, ProductSnapshot>,
  byOutput: Map<string, Recipe[]>,
  combinesByOutput: Map<string, CombineStep[]>,
  npcPrices: Record<string, NpcPrice>,
  maxDepth: number,
  memo: Map<string, Source | null>,
  visiting: Set<string>,
  mustProduce?: Set<string>,
): Source | null {
  // Keyed by the depth still available as well as by the item: a path that is too long for one
  // caller's remaining budget may be the cheapest for another's, and a single key would hand the
  // second caller the first one's shallower answer.
  const key = `${id}@${maxDepth}@${mustProduce?.has(id) ? "make" : "any"}`;
  const cached = memo.get(key);
  if (cached !== undefined) return cached;
  if (visiting.has(id)) return null;
  visiting.add(id);

  let best: Source | null = null;
  const consider = (candidate: Source | null) => {
    if (!candidate) return;
    if (!best || candidate.cost < best.cost) best = candidate;
  };

  // A leaf: something you can simply buy. Buying an ingredient means placing a buy order, which
  // fills at what buyers bid — the same side `craft()` prices its inputs from.
  //
  // `mustProduce` turns that off for one id, which is what pricing somebody's submitted route
  // needs: the question there is "what does making this cost", and the answer "buying it is
  // cheaper" — true and useful on a craft table — leaves the submission with no route to check
  // and no way to be told it has stopped working.
  const product = market.get(id);
  if (product && product.instasell > 0 && !mustProduce?.has(id)) {
    consider({ cost: product.instasell, rate: hourlySold(product), hops: [], depth: 0, limitedBy: id, unknownSupply: [] });
  }

  const shop = npcPrices[id];
  if (shop?.buy !== undefined && shop.buy > 0) {
    consider({
      cost: shop.buy,
      rate: shop.stock !== undefined ? shop.stock / HOURS_PER_DAY : Infinity,
      hops: [],
      depth: 0,
      limitedBy: shop.stock !== undefined ? id : undefined,
      unknownSupply: shop.stock === undefined ? [id] : [],
    });
  }

  if (maxDepth > 0) {
    for (const recipe of byOutput.get(id) ?? []) {
      let cost = 0;
      let rate = Infinity;
      let limitedBy: string | undefined;
      let depth = 0;
      const hops: ChainHop[] = [];
      const unknownSupply: string[] = [];
      let ok = true;

      for (const ingredient of recipe.ingredients) {
        const from = sourceOf(ingredient.id, market, byOutput, combinesByOutput, npcPrices, maxDepth - 1, memo, visiting, mustProduce);
        // No price is not a low price. One unpriceable ingredient makes the whole path
        // unpriceable, exactly as it does for a single craft.
        if (!from) {
          ok = false;
          break;
        }
        cost += from.cost * ingredient.qty;
        const feeds = from.rate / ingredient.qty;
        if (feeds < rate) {
          rate = feeds;
          limitedBy = from.limitedBy ?? ingredient.id;
        }
        depth = Math.max(depth, from.depth);
        hops.push(...from.hops);
        unknownSupply.push(...from.unknownSupply);
      }
      if (!ok) continue;

      // One craft of the scarcest ingredient still makes `yield` items, so cost and rate divide
      // and multiply through by it together.
      hops.push({ kind: "craft", output: recipe.output, yield: recipe.yield, ingredients: recipe.ingredients });
      consider({
        cost: cost / recipe.yield,
        rate: rate * recipe.yield,
        hops,
        depth: depth + 1,
        limitedBy,
        unknownSupply,
      });
    }

    for (const step of combinesByOutput.get(id) ?? []) {
      const from = sourceOf(step.inputId, market, byOutput, combinesByOutput, npcPrices, maxDepth - 1, memo, visiting, mustProduce);
      if (!from) continue;
      consider({
        cost: from.cost * step.inputsRequired + step.anvilFeeCoins,
        // Combining is instant, so the only thing limiting it is how fast the pair arrives.
        rate: from.rate / step.inputsRequired,
        hops: [...from.hops, { kind: "combine", step }],
        depth: from.depth + 1,
        limitedBy: from.limitedBy,
        unknownSupply: from.unknownSupply,
      });
    }
  }

  visiting.delete(id);
  // A `null` is not necessarily "this cannot be made" — it is also what the cycle guard returns
  // to whoever re-entered an item already on the stack. Caching that would turn one arbitrary
  // traversal order into a permanent verdict, so only real answers are kept.
  if (best) memo.set(key, best);
  return best;
}

export type ChainOptions = {
  recipes: Recipe[];
  npcPrices?: Record<string, NpcPrice>;
  anvil?: AnvilRules;
  maxDepth?: number;
  /**
   * Ids that must be *made* rather than bought, even where buying is cheaper.
   *
   * Off by default, because on a craft table "buying it is cheaper" is the right answer and a
   * row that ignored it would be selling a loss. It is turned on for one id when pricing a
   * submitted route, where the question is what that route costs today rather than what the
   * cheapest route is — a submission that has gone underwater has to be priced to be told so.
   */
  mustProduce?: Set<string>;
};

/**
 * Every terminal item worth making, and the cheapest way to get there.
 *
 * The terminal has to be a bazaar good with a bid on it — that is where the chain is sold — and
 * the margin is quoted against the same after-tax sale `craft()` uses, so a one-hop chain here
 * and a row in the craft table are the same number.
 */
export function findCraftChains(market: Map<string, ProductSnapshot>, options: ChainOptions): Chain[] {
  const maxDepth = options.maxDepth ?? 4;
  const npcPrices = options.npcPrices ?? {};

  const byOutput = new Map<string, Recipe[]>();
  for (const recipe of options.recipes) {
    if (!byOutput.has(recipe.output)) byOutput.set(recipe.output, []);
    byOutput.get(recipe.output)!.push(recipe);
  }

  const combinesByOutput = new Map<string, CombineStep[]>();
  if (options.anvil) {
    for (const step of combineSteps(market, options.anvil)) {
      if (!combinesByOutput.has(step.outputId)) combinesByOutput.set(step.outputId, []);
      combinesByOutput.get(step.outputId)!.push(step);
    }
  }

  const memo = new Map<string, Source | null>();
  const chains: Chain[] = [];

  const terminals = new Set<string>([...byOutput.keys(), ...combinesByOutput.keys()]);
  for (const id of terminals) {
    const product = market.get(id);
    if (!product || product.instabuy <= 0) continue;

    const source = sourceOf(id, market, byOutput, combinesByOutput, npcPrices, maxDepth, memo, new Set(), options.mustProduce);
    if (!source || source.hops.length === 0) continue;

    const margin = product.instabuy * NET_OF_TAX - source.cost;
    const outputLimit = hourlyBought(product);
    const bottleneck = Math.min(outputLimit, source.rate);

    chains.push({
      id,
      hops: source.hops,
      depth: source.hops.length,
      combines: source.hops.some((h) => h.kind === "combine"),
      craftCost: source.cost,
      sellAt: product.instabuy,
      margin,
      inputLimit: source.rate,
      outputLimit,
      bottleneck,
      coinsPerHour: margin * bottleneck,
      limitedBy: source.rate < outputLimit ? source.limitedBy : undefined,
      unknownSupply: [...new Set(source.unknownSupply)],
    });
  }

  return chains;
}

/**
 * The chains a one-hop craft table cannot already show you.
 *
 * Anything a single `craft()` call finds is already a row on the Crafts tab, and repeating it
 * under a different heading would be padding rather than a second opinion.
 */
export function unorthodoxChains(chains: Chain[]): Chain[] {
  return chains.filter((c) => c.depth >= 2 || c.combines);
}
