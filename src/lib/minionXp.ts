import { itemsPerHour, type MinionData, type MinionProduction, type Setup } from "./minions";

/**
 * A minion as a pet-levelling machine.
 *
 * This is a real mechanic and not a workaround. Collecting a minion grants Skill XP — the Minions
 * page says so plainly, noting that a co-op member who was away "will receive the Skill XP from
 * them once they go to Private Island" — and then says what people do with it: "players can level
 * the same pet multiple times from collecting Minions once". A pet equipped while you collect
 * levels off that XP like any other. So the chain is short and entirely documented: items an hour,
 * times the published per-item minion rate, times Wisdom, times Taming, divided by whatever
 * penalty the pet's own skill imposes.
 *
 * Four things in that chain are easy to get wrong and each is worth naming.
 *
 * **Minion XP is its own column.** It is not a fraction of the XP you get for doing the thing
 * yourself and there is no constant that turns one into the other. Wheat pays 4 by hand and 0.3
 * from a minion; Ice pays 0.2 by hand and 0.5 from a minion, which is *more*; Nether Wart pays 4
 * by hand and nothing at all from a minion. Any of the three would fall out of a model that
 * scaled the player column.
 *
 * **Only two skills publish the column.** Farming and Mining have it. Foraging, Combat and Fishing
 * minions plainly grant something and nobody has written down what, so those rows say "not
 * published" instead of "zero". The two rank at opposite ends of a table and only one of them is
 * a claim the sources support.
 *
 * **Wisdom is additive and everything else is multiplicative, in that order.** The Pets page is
 * explicit that additive factors apply first, so Wisdom scales the Skill XP and Taming scales the
 * Pet XP the Skill XP became. Multiplying them in the other order is off by a fraction of a
 * percent; treating Wisdom as a Pet XP multiplier is off by nothing at all in the common case and
 * silently wrong the moment a mismatch divisor is involved.
 *
 * **The divisors are where the good-looking routes die.** A pet earning XP outside its own skill
 * takes a /3. A pet earning Alchemy or Enchanting XP that is not an Alchemy or Enchanting pet
 * takes a /12 — so one Enchanted Sugar Cane, worth a headline 15,000 Alchemy XP, reaches an
 * ordinary pet as 1,250. And Carpentry grants no Pet XP whatsoever, which retires the whole
 * crafting route from this question however much Carpentry XP it is worth.
 */

/* ------------------------------------------------------------------ tables */

export type SkillKey =
  | "FARMING"
  | "MINING"
  | "COMBAT"
  | "FORAGING"
  | "FISHING"
  | "ENCHANTING"
  | "ALCHEMY"
  | "TAMING"
  | "CARPENTRY"
  | "RUNECRAFTING";

/** One item, and what producing it is worth in Skill XP by hand and from a minion. */
export type ItemXp = {
  item: string;
  itemId: string | null;
  skill: SkillKey;
  /** XP for obtaining one yourself. Null where the wiki leaves the cell blank. */
  playerXp: number | null;
  /** XP for one a minion produced. Null means unpublished, which is not zero. */
  minionXp: number | null;
};

export type BrewIngredient = { item: string; itemId: string | null; xp: number };

export type SkillXpTables = {
  perItem: ItemXp[];
  brewing: BrewIngredient[];
  carpentryXpPerNpcCoin: number;
};

export type PetXpRules = {
  wisdom: { formula: string };
  taming: { maxLevel: number };
  skillMultipliers: Partial<Record<SkillKey, number>>;
  mismatch: { divisor: number };
  alchemyEnchantingPenalty: { divisor: number; appliesTo: SkillKey[] };
  noPetXp: SkillKey[];
};

/* ------------------------------------------------------------- the player */

export type Player = {
  /**
   * Wisdom per skill, because that is what Wisdom is.
   *
   * There is a separate Wisdom stat for every skill and they are nothing like each other — a player
   * deep in Slayers can be at 30 Combat Wisdom and 0 Alchemy. A single figure applied to all six
   * was a convenience that quietly scaled the wrong skills, and since Wisdom multiplies the Skill XP
   * before anything else touches it, being wrong here is wrong everywhere downstream.
   *
   * A skill absent from the map is zero, which is the correct default: no Wisdom is the state every
   * account starts in.
   */
  wisdom: Partial<Record<SkillKey, number>>;
  /** Taming level, 0–60. Each level is +1% Pet XP through Zoologist. */
  taming: number;
  /**
   * The skill the pet being levelled belongs to, or null for "whatever matches".
   *
   * Null is the optimistic reading and it is the useful default: it answers "what is the best
   * this minion can do for some pet", which is the question someone shopping for a setup is
   * asking. Naming a skill answers the harder and more common one — "what does this do for the
   * pet I already have" — and is where the divisors start biting.
   */
  petSkill: SkillKey | null;
};

/* ------------------------------------------------------------ the numbers */

/** Skill XP after Wisdom, which is the only additive factor and therefore applies first. */
export function withWisdom(skillXp: number, wisdom: number): number {
  return skillXp * (1 + Math.max(0, wisdom) / 100);
}

/** This player's Wisdom for one skill. Absent is zero, which is where every account starts. */
export function wisdomFor(player: Player, skill: SkillKey): number {
  return player.wisdom[skill] ?? 0;
}

/**
 * The multiplier from Skill XP to Pet XP, for one skill and one pet.
 *
 * Returns 0 for the skills that grant no Pet XP at all, which is a real answer and not a missing
 * one — Carpentry XP is worth having and is worth exactly nothing to a pet.
 */
export function petXpMultiplier(skill: SkillKey, player: Player, rules: PetXpRules): number {
  if (rules.noPetXp.includes(skill)) return 0;

  const matches = player.petSkill === null || player.petSkill === skill;
  let multiplier = rules.skillMultipliers[skill] ?? 1;

  // The two penalties are alternatives, not a stack: a non-Alchemy pet earning Alchemy XP takes
  // the /12 and not the /3 as well. Reading the table as cumulative would understate the brewing
  // route by another factor of three, which is enough to move it off the page entirely.
  if (!matches) {
    multiplier /= rules.alchemyEnchantingPenalty.appliesTo.includes(skill)
      ? rules.alchemyEnchantingPenalty.divisor
      : rules.mismatch.divisor;
  }

  return multiplier * (1 + Math.min(Math.max(0, player.taming), rules.taming.maxLevel) / 100);
}

/** Skill XP through the whole chain into Pet XP. */
export function petXpFrom(skillXp: number, skill: SkillKey, player: Player, rules: PetXpRules): number {
  return withWisdom(skillXp, wisdomFor(player, skill)) * petXpMultiplier(skill, player, rules);
}

/* --------------------------------------------------------------- the rows */

/**
 * How a minion reaches a skill.
 *
 * `direct` is the minion's own published per-item rate — the real route, and the only one that
 * needs nothing of the player but a visit to the island. `brewing` is the drop compacted into its
 * enchanted form and brewed, which pays far more per item and then loses most of it to the /12
 * unless the pet is an Alchemy pet.
 */
export type XpRoute = "direct" | "brewing";

/**
 * Brews a day the route chooser assumes you will do, when no caller says otherwise.
 *
 * Not an economic figure: standing at a brewing stand is a chore with a ceiling nobody argues
 * about. It matters here because the ceiling is what decides *which* brewing ingredient is worth
 * planning — without one, the answer is always the rawest form and eleven thousand brews a day.
 * Kept in step with the planner's own budget.
 */
export const DEFAULT_MAX_BREWS_PER_DAY = 200;

export type MinionXpRow = {
  generator: string;
  family: string;
  tier: number;
  skill: SkillKey;
  route: XpRoute;
  itemId: string | null;
  itemName: string;

  itemsPerHour: number;
  /** Skill XP an hour before Wisdom. The published figure, times the rate. */
  baseSkillXpPerHour: number;
  /** Skill XP an hour after Wisdom. What the skill actually gains. */
  skillXpPerHour: number;
  /** Pet XP an hour after every multiplier and divisor. The ranking figure. */
  petXpPerHour: number;
  /** What one drop is worth in Skill XP on this route. */
  xpPerItem: number;
  /** For a brewing row, how many raw drops one brew consumes. */
  itemsPerBrew?: number;

  /**
   * On a brewing row, the skill collecting the same drops pays — and what it pays an hour.
   *
   * The drops do two jobs and were only ever credited with one. You collect a Sugar Cane Minion and
   * that collection pays Farming XP; you then brew what you collected and *that* pays Alchemy XP.
   * Modelling the brewing route as Alchemy alone throws the Farming half away, which is not a small
   * correction — for most minions the direct rate is the larger of the two and it was being counted
   * as zero the moment a brewing route existed.
   *
   * Absent on a direct row, where the skill is simply `skill` and there is no second half.
   */
  baseSkill?: SkillKey;
  /** Skill XP an hour, before Wisdom, that collecting pays into `baseSkill`. */
  baseXpPerHour?: number;

  caveats: string[];
};

export type MinionXpOptions = {
  data: MinionData;
  tables: SkillXpTables;
  rules: PetXpRules;
  player: Player;
  setup: Setup;
  /** Item id per minion, resolved the same way the profit tab resolves it. */
  dropIdFor: (minion: MinionProduction) => string | null;
  names: Record<string, string>;
  /** Recipes, for working out how many drops one enchanted brewing ingredient costs. */
  recipes: { output: string; yield: number; ingredients: { id: string; qty: number }[] }[];
  /**
   * Brews a day the chooser may assume, which is what decides which brewing form is planned.
   *
   * Compacting trades XP away — an Enchanted Cactus is 25,600 cactus and pays 500 where the same
   * cactus brewed raw pay 256,000 — so without a ceiling the rawest form always wins and asks for
   * an absurd number of brews. With one, the question becomes "most XP a day inside the budget",
   * which is the question actually being asked.
   */
  maxBrewsPerDay?: number;
};

/**
 * Every route every minion has into every skill, ranked on Pet XP an hour.
 *
 * A minion can appear twice — once for the XP its drops grant on collection and once for what
 * those drops brew into — because they are genuinely different plans with different work
 * attached, and collapsing them to the better one hides the fact that the better one involves
 * standing at a brewing stand.
 */
export function planMinionXp(o: MinionXpOptions): MinionXpRow[] {
  const directBy = new Map<string, ItemXp>();
  for (const row of o.tables.perItem) {
    if (row.itemId && row.minionXp !== null && !directBy.has(row.itemId)) directBy.set(row.itemId, row);
  }
  const brewBy = new Map<string, BrewIngredient>();
  for (const row of o.tables.brewing) if (row.itemId) brewBy.set(row.itemId, row);

  const out: MinionXpRow[] = [];

  for (const minion of o.data.minions) {
    const tier = Math.min(o.setup.tier, minion.maxTier);
    const rate = itemsPerHour(minion, o.data, { ...o.setup, tier });
    if (rate === null || rate <= 0) continue;

    const itemId = o.dropIdFor(minion);
    if (!itemId) continue;
    const itemName = o.names[itemId] ?? itemId;

    const direct = directBy.get(itemId);
    if (direct && direct.minionXp !== null) {
      const caveats: string[] = [];
      if (direct.minionXp === 0) caveats.push("published as exactly zero — this minion grants no skill XP at all");
      out.push(
        row(minion, tier, direct.skill, "direct", itemId, itemName, rate, direct.minionXp, o, caveats),
      );
    } else {
      out.push({
        generator: minion.generator,
        family: minion.family,
        tier,
        skill: skillGuess(minion),
        route: "direct",
        itemId,
        itemName,
        itemsPerHour: rate,
        baseSkillXpPerHour: 0,
        skillXpPerHour: 0,
        petXpPerHour: 0,
        xpPerItem: 0,
        caveats: [
          "no minion XP rate is published for this drop — only the Farming and Mining pages carry the column, " +
            "so this is unknown rather than zero",
        ],
      });
    }

    // The brewing route runs on the enchanted form, so the raw drop has to be worth one first.
    //
    /**
     * One brewing route per minion: the one worth the most XP a day inside the brew budget.
     *
     * A minion's drops usually reach several entries in the alchemy table — a Cactus Minion reaches
     * cactus, Enchanted Cactus Green and Enchanted Cactus — and those are versions of one decision,
     * so only one belongs in the table. Which one is the whole question.
     *
     * Picking the *most compacted* is the obvious answer and it is wrong, badly, on the minions it
     * matters for. Compacting trades XP away: an Enchanted Cactus is 25,600 cactus and pays 500,
     * where the same 25,600 cactus brewed raw pay 256,000. Ranking on depth demoted a Cactus Minion
     * from the top of the Alchemy list to the bottom of it, cost the Sugar Cane Minion a factor of
     * three, and cost seven of the fourteen brewing minions something.
     *
     * Picking the best *XP per drop* is wrong the other way: it asks for eleven thousand brews a
     * day, which is not a plan anybody executes.
     *
     * Neither is the constraint, though, because the brew budget already is. Inside a ceiling of
     * `maxBrewsPerDay` the honest question is simply which ingredient pays the most XP a day — a
     * route the minion cannot supply gets capped, a route the minion floods gets capped, and the
     * winner is whichever is worth more once both are. That also happens to spend the *fewest*
     * drops for the XP, since a capped shallow route consumes a few hundred drops where the deep
     * one eats tens of thousands, so the drops it does not eat stay on the market.
     */
    const dropsPerDay = rate * 24;
    const cap = o.maxBrewsPerDay ?? DEFAULT_MAX_BREWS_PER_DAY;
    let best: { id: string; brew: BrewIngredient; perBrew: number; xpPerDay: number; brews: number } | null = null;
    for (const [ingredientId, brew] of brewBy) {
      const perBrew = dropsPerIngredient(ingredientId, itemId, o.recipes);
      if (perBrew === null || !(perBrew > 0)) continue;
      const brews = Math.min(dropsPerDay / perBrew, cap);
      const xpPerDay = brews * brew.xp;
      // Ties go to the deeper chain, which is the same XP for fewer trips to the stand.
      const better =
        !best || xpPerDay > best.xpPerDay + 1e-9 || (Math.abs(xpPerDay - best.xpPerDay) <= 1e-9 && brews < best.brews);
      if (better) best = { id: ingredientId, brew, perBrew, xpPerDay, brews };
    }
    const deepest = best;

    if (deepest) {
      const { id: ingredientId, brew, perBrew } = deepest;
      const name = o.names[ingredientId] ?? ingredientId;
      const caveats =
        perBrew > 1
          ? [`one brew consumes ${Math.round(perBrew).toLocaleString("en-US")} drops compacted into ${name}`]
          : [`brewed as the raw drop rather than compacted first, which is worth far more XP for the same drops`];
      // Why this form and not one of the others the drops can reach. Worth saying on the row,
      // because "compact it first" is the intuition and on these minions it is the wrong one.
      const others = [...brewBy].filter(
        ([id]) => id !== ingredientId && dropsPerIngredient(id, itemId, o.recipes) !== null,
      );
      if (others.length > 0) {
        caveats.push(
          `these drops also brew as ${others
            .map(([id]) => o.names[id] ?? id)
            .join(" or ")}, which pay less a day at ${Math.round(cap).toLocaleString("en-US")} brews`,
        );
      }
      // The collection half, carried so the planner can put a second pet on it. Only meaningful
      // where the drop has a published direct rate; without one this stays absent rather than zero,
      // for the same reason the direct row does.
      const collects =
        direct && direct.minionXp !== null && direct.minionXp > 0
          ? { baseSkill: direct.skill, baseXpPerHour: rate * direct.minionXp }
          : {};
      if ("baseSkill" in collects) {
        caveats.push(
          `collecting the same drops also pays ${String(collects.baseSkill).toLowerCase()} XP — the drops do two jobs`,
        );
      }
      out.push({
        ...row(minion, tier, "ALCHEMY", "brewing", ingredientId, name, rate, brew.xp / perBrew, o, caveats, perBrew),
        ...collects,
      });
    }
  }

  return out.sort((a, b) => b.petXpPerHour - a.petXpPerHour || b.skillXpPerHour - a.skillXpPerHour);
}

function row(
  minion: MinionProduction,
  tier: number,
  skill: SkillKey,
  route: XpRoute,
  itemId: string,
  itemName: string,
  rate: number,
  xpPerItem: number,
  o: MinionXpOptions,
  caveats: string[],
  itemsPerBrew?: number,
): MinionXpRow {
  const baseSkillXpPerHour = rate * xpPerItem;
  // The skill's own Wisdom, not a global one: a brewed route is Alchemy XP and takes Alchemy
  // Wisdom even when the minion that fed it is a Farming minion.
  const skillXpPerHour = withWisdom(baseSkillXpPerHour, wisdomFor(o.player, skill));
  const multiplier = petXpMultiplier(skill, o.player, o.rules);
  if (multiplier === 0) caveats.push(`${skill.toLowerCase()} grants no pet XP at all — this levels the skill and nothing else`);

  return {
    generator: minion.generator,
    family: minion.family,
    tier,
    skill,
    route,
    itemId,
    itemName,
    itemsPerHour: rate,
    baseSkillXpPerHour,
    skillXpPerHour,
    petXpPerHour: skillXpPerHour * multiplier,
    xpPerItem,
    ...(itemsPerBrew === undefined ? {} : { itemsPerBrew }),
    caveats,
  };
}

/**
 * How many raw drops one brewing ingredient costs, following single-ingredient recipes down.
 *
 * Enchanted Sugar Cane is 160 Enchanted Sugar, and Enchanted Sugar is 160 Sugar Cane, so one
 * ingredient is 25,600 drops and pays 15,000 Alchemy XP — about 0.59 XP a drop, which is the
 * figure that makes it comparable to a direct rate at all. Following the chain rather than
 * assuming one step is what keeps that honest; assuming one step values it at 94 XP a drop and
 * puts sugar cane at the top of every list in the app.
 *
 * Null when no chain of single-ingredient recipes connects the two, which is the common case and
 * simply means this minion does not feed this brew.
 */
export function dropsPerIngredient(
  ingredientId: string,
  dropId: string,
  recipes: { output: string; yield: number; ingredients: { id: string; qty: number }[] }[],
  depth = 0,
): number | null {
  if (ingredientId === dropId) return 1;
  if (depth > 4) return null;

  for (const recipe of recipes) {
    if (recipe.output !== ingredientId || recipe.ingredients.length !== 1 || !(recipe.yield > 0)) continue;
    const only = recipe.ingredients[0];
    const below = dropsPerIngredient(only.id, dropId, recipes, depth + 1);
    if (below !== null) return (only.qty / recipe.yield) * below;
  }
  return null;
}

/**
 * The skill a minion plainly belongs to, for the rows with no published rate.
 *
 * A guess, and labelled as one wherever it is used: it exists so an unrated Oak Minion files under
 * Foraging rather than under nothing, not so the app can pretend to know what the rate is.
 */
const SKILL_BY_GENERATOR: Record<string, SkillKey> = {
  OAK: "FORAGING",
  BIRCH: "FORAGING",
  SPRUCE: "FORAGING",
  DARK_OAK: "FORAGING",
  ACACIA: "FORAGING",
  JUNGLE: "FORAGING",
  FLOWER: "FORAGING",
  FISHING: "FISHING",
  CLAY: "FISHING",
  LILY_PAD: "FISHING",
  ZOMBIE: "COMBAT",
  REVENANT: "COMBAT",
  SKELETON: "COMBAT",
  CREEPER: "COMBAT",
  SPIDER: "COMBAT",
  TARANTULA: "COMBAT",
  CAVESPIDER: "COMBAT",
  BLAZE: "COMBAT",
  MAGMA_CUBE: "COMBAT",
  ENDERMAN: "COMBAT",
  GHAST: "COMBAT",
  SLIME: "COMBAT",
  VOIDLING: "COMBAT",
  INFERNO: "COMBAT",
  VAMPIRE: "COMBAT",
};

export function skillGuess(minion: MinionProduction): SkillKey {
  return SKILL_BY_GENERATOR[minion.generator] ?? "MINING";
}

/**
 * The best minion for each skill, which is the question the section is actually built around.
 *
 * One winner per skill rather than a ranked list of everything, because "what should I put down
 * to level a farming pet" has one answer and a table of sixty rows is a worse way to give it.
 * Skills with no published route come back with a null row and the reason.
 */
export function bestPerSkill(rows: MinionXpRow[]): Map<SkillKey, MinionXpRow | null> {
  const best = new Map<SkillKey, MinionXpRow | null>();
  for (const row of rows) {
    if (row.petXpPerHour <= 0 && row.skillXpPerHour <= 0) {
      if (!best.has(row.skill)) best.set(row.skill, null);
      continue;
    }
    const held = best.get(row.skill);
    if (!held || row.petXpPerHour > held.petXpPerHour) best.set(row.skill, row);
  }
  return best;
}
