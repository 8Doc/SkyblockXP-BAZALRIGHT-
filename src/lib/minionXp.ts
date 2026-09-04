import { itemsPerHour, offlineAmount, type MinionData, type MinionProduction, type Setup } from "./minions";

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

/**
 * The Alchemy XP a brewing ingredient must pay before it is worth a brewing stand at all.
 *
 * The alchemy table has forty-five ingredient rows and its values are not a spread — they are two
 * clusters with nothing between them. Five ingredients pay 15,000 or 23,000; the sixth-best pays
 * **600**. That gap is the whole shape of the decision, and a threshold anywhere inside it picks
 * out the same five:
 *
 *   23,000  Enchanted Blaze Rod             (Strength)
 *   15,000  Enchanted Sugar Cane            (Speed)
 *   15,000  Enchanted Fermented Spider Eye  (Weakness)
 *   15,000  Enchanted Gold Block            (Absorption)
 *   15,000  Enchanted Cooked Mutton         (Mana)
 *
 * Below the gap, brewing is not a plan. Compacting trades XP away — the same 25,600 cactus are
 * worth 256,000 Alchemy XP brewed raw and 500 brewed as one Enchanted Cactus — so an ingredient
 * whose top form pays 500 is asking you to throw away most of the XP *and* stand at a stand for it.
 * Above the gap the same compaction is worth doing: an Enchanted Sugar Cane costs the same 25,600
 * drops and pays 15,000, which is thirty times the Enchanted Cactus for the same work.
 *
 * So this is not a tuning knob dressed as a constant. It is the cliff, and it is where the routes
 * people actually brew sit.
 */
export const MIN_BREW_XP = 10_000;

/**
 * One of a minion's drops, and what that drop alone is worth in XP.
 *
 * A minion is not one drop. A Voidling Minion makes obsidian at two and a half a harvest beside its
 * quartz at four tenths, a Tarantula Minion makes a spider eye and an iron ingot alongside its
 * string, a Revenant Minion's diamonds are a fifth of its harvests. Every one of those was being
 * thrown away by a model that read `collects` and stopped, which is why the four slayer minions —
 * the ones whose secondary drop *is* the point — came back as zero XP an hour.
 *
 * They are kept apart rather than summed into one figure because they are not all the same skill.
 * A Tarantula Minion pays Combat XP for its spider eyes and Mining XP for its iron, and a single
 * pet standing there takes the two at different multipliers: full rate on the one that matches it
 * and a third of the other. Summing first and applying one multiplier after is wrong in both
 * directions depending on which pet is out.
 */
export type XpContribution = {
  skill: SkillKey;
  itemId: string;
  itemName: string;
  /** Drops of this item an hour, after its own chance. */
  itemsPerHour: number;
  /** Published minion XP for one of them. */
  xpPerItem: number;
  /** Skill XP an hour from this drop alone, before Wisdom. */
  baseXpPerHour: number;
  /** After that skill's own Wisdom. */
  skillXpPerHour: number;
  /** After the pet multiplier for this drop's skill. */
  petXpPerHour: number;
};

export type MinionXpRow = {
  generator: string;
  family: string;
  tier: number;
  skill: SkillKey;
  route: XpRoute;
  itemId: string | null;
  itemName: string;

  itemsPerHour: number;
  /**
   * Skill XP an hour before Wisdom, summed over every drop of the minion and every skill they pay.
   *
   * Across skills, not within one: a Tarantula Minion's number is its spider eyes' Combat XP plus
   * its iron's Mining XP, because both arrive in the same collection and one pet is standing there
   * for both. `contributions` is where the split lives.
   */
  baseSkillXpPerHour: number;
  /** Skill XP an hour after Wisdom. What the skill actually gains. */
  skillXpPerHour: number;
  /** Pet XP an hour after every multiplier and divisor. The ranking figure. */
  petXpPerHour: number;
  /** What one drop is worth in Skill XP on this route, for the drop the row is named after. */
  xpPerItem: number;
  /**
   * Every drop that pays XP, one entry each, largest first.
   *
   * The row's headline figures are these summed; this is what they were summed from, and it is the
   * only honest place to answer "which of this minion's drops is actually doing the work" or to
   * re-rank the minion for one skill in particular.
   */
  contributions: XpContribution[];
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
  /** Skill XP an hour, before Wisdom, that collecting pays — every skill of it, not just `baseSkill`. */
  baseXpPerHour?: number;
  /** The collection half's drops, split by skill, the same way `contributions` splits the route's own. */
  baseContributions?: XpContribution[];

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
  for (const row of o.tables.brewing) if (row.itemId && row.xp >= MIN_BREW_XP) brewBy.set(row.itemId, row);

  // Names to ids, for the secondary drops. The wiki states those by display name only — there is no
  // `collectionId` behind an `alsoCollects` entry — so without this a Revenant Minion's diamonds
  // cannot be looked up in the XP table at all.
  const byName = new Map<string, string>();
  for (const [id, name] of Object.entries(o.names)) {
    const key = name.trim().toLowerCase();
    if (!byName.has(key)) byName.set(key, id);
  }

  const out: MinionXpRow[] = [];

  for (const minion of o.data.minions) {
    const tier = Math.min(o.setup.tier, minion.maxTier);
    const rate = itemsPerHour(minion, o.data, { ...o.setup, tier });
    if (rate === null || rate <= 0) continue;

    const itemId = o.dropIdFor(minion);
    if (!itemId) continue;
    const itemName = o.names[itemId] ?? itemId;

    /**
     * Everything the minion drops, in drops an hour, not just the one on the tin.
     *
     * The rate is the *primary* drop's rate, so dividing its per-harvest stack back out recovers
     * the harvest count, which is the unit the secondary drops are quoted in. A conditional drop
     * needs an upgrade fitted and is not something the minion makes on its own, so it is left out
     * here the same way the profit side leaves it out.
     */
    const perHarvest = Math.max(1e-9, offlineAmount(minion, o.data));
    const harvests = rate / perHarvest;
    const drops: { id: string; name: string; perHour: number }[] = [
      { id: itemId, name: itemName, perHour: rate * (minion.collects.chance ?? 1) },
    ];
    const unnamed: string[] = [];
    for (const also of minion.alsoCollects ?? []) {
      if (also.condition) continue;
      const alsoId = byName.get(also.item.trim().toLowerCase());
      if (!alsoId) {
        unnamed.push(also.item);
        continue;
      }
      drops.push({
        id: alsoId,
        name: o.names[alsoId] ?? also.item,
        perHour: harvests * also.amount * (also.chance ?? 1),
      });
    }

    const contributions = contributionsFor(drops, directBy, o);
    const unpublished = drops.filter((d) => {
      const known = directBy.get(d.id);
      return !known || known.minionXp === null;
    });

    if (contributions.length > 0) {
      const lead = contributions[0];
      const caveats: string[] = [];
      if (contributions.every((c) => c.xpPerItem === 0)) {
        caveats.push("published as exactly zero — this minion grants no skill XP at all");
      }
      if (contributions.length > 1) {
        caveats.push(
          `counts every drop: ${contributions
            .map((c) => `${c.itemName} at ${round(c.baseXpPerHour)} ${c.skill.toLowerCase()} xp/hr`)
            .join(", ")}`,
        );
      }
      if (unpublished.length > 0) {
        caveats.push(
          `no minion XP rate is published for ${unpublished
            .map((d) => d.name)
            .join(" or ")}, so that part of the output counts as unknown rather than zero`,
        );
      }
      out.push(directRow(minion, tier, "direct", lead, rate, contributions, caveats));
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
        contributions: [],
        caveats: [
          "no minion XP rate is published for this drop — only the Farming and Mining pages carry the column, " +
            "so this is unknown rather than zero",
        ],
      });
    }
    if (unnamed.length > 0) {
      // Said once, on the row that exists, rather than dropped silently: an unresolvable drop is a
      // gap in the item table and not a drop the minion does not make.
      out[out.length - 1].caveats.push(`also drops ${unnamed.join(" and ")}, which nothing here can price or rate`);
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
    const cap = o.maxBrewsPerDay ?? DEFAULT_MAX_BREWS_PER_DAY;
    let best:
      | {
          id: string;
          brew: BrewIngredient;
          perBrew: number;
          xpPerDay: number;
          brews: number;
          from: { id: string; name: string; perHour: number };
          alongside: { id: string; qty: number }[];
        }
      | null = null;

    // Every drop the minion makes, not only the one on the tin. A Spider Minion's brewing route
    // runs on the spider eyes it drops beside its string, and a Tarantula Minion's on the same —
    // reading the primary drop alone is why neither had an Alchemy route.
    for (const drop of drops) {
      const dropsPerDay = drop.perHour * 24;
      if (!(dropsPerDay > 0)) continue;

      for (const [ingredientId, brew] of brewBy) {
        const chain = brewChain(ingredientId, drop.id, o.recipes);
        if (chain === null || !(chain.drops > 0)) continue;
        const brews = Math.min(dropsPerDay / chain.drops, cap);
        const xpPerDay = brews * brew.xp;
        // Ties go to the deeper chain, which is the same XP for fewer trips to the stand.
        const better =
          !best || xpPerDay > best.xpPerDay + 1e-9 || (Math.abs(xpPerDay - best.xpPerDay) <= 1e-9 && brews < best.brews);
        if (better) {
          best = { id: ingredientId, brew, perBrew: chain.drops, xpPerDay, brews, from: drop, alongside: chain.alongside };
        }
      }
    }
    const deepest = best;

    if (deepest) {
      const { id: ingredientId, brew, perBrew, from, alongside } = deepest;
      const name = o.names[ingredientId] ?? ingredientId;
      const caveats = [
        `one brew consumes ${Math.round(perBrew).toLocaleString("en-US")} ${from.name} compacted into ${name}, worth ${brew.xp.toLocaleString("en-US")} alchemy XP`,
      ];
      // A recipe with more than one ingredient wants things this minion does not make. They are a
      // real cost and the row says so rather than quoting a brew as though the drops were all of it.
      if (alongside.length > 0) {
        const merged = new Map<string, number>();
        for (const side of alongside) merged.set(side.id, (merged.get(side.id) ?? 0) + side.qty);
        caveats.push(
          `each one also needs ${[...merged]
            .map(([id, qty]) => `${Math.round(qty).toLocaleString("en-US")} ${o.names[id] ?? readableId(id)}`)
            .join(" and ")}, which this minion does not make`,
        );
      }
      // The collection half, carried so the planner can put a second pet on it. Only meaningful
      // where a drop has a published direct rate; without one this stays absent rather than zero,
      // for the same reason the direct row does.
      const paid = contributions.filter((c) => c.baseXpPerHour > 0);
      const collects =
        paid.length > 0
          ? {
              baseSkill: paid[0].skill,
              baseXpPerHour: paid.reduce((sum, c) => sum + c.baseXpPerHour, 0),
              baseContributions: paid,
            }
          : {};
      if ("baseSkill" in collects) {
        const skills = [...new Set(paid.map((c) => String(c.skill).toLowerCase()))];
        caveats.push(`collecting the same drops also pays ${skills.join(" and ")} XP — the drops do two jobs`);
      }
      out.push({
        // `from.perHour`, not the minion's headline rate: the chain may run on a secondary drop —
        // a Spider Minion brews its eyes, not its string — and those arrive at their own rate.
        ...row(minion, tier, "ALCHEMY", "brewing", ingredientId, name, from.perHour, brew.xp / perBrew, o, caveats, perBrew),
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
    // A brewing route reaches exactly one skill, so its split is the row itself. Kept populated
    // rather than empty so every consumer can read `contributions` without a special case.
    contributions: [
      {
        skill,
        itemId,
        itemName,
        itemsPerHour: rate,
        xpPerItem,
        baseXpPerHour: baseSkillXpPerHour,
        skillXpPerHour,
        petXpPerHour: skillXpPerHour * multiplier,
      },
    ],
    ...(itemsPerBrew === undefined ? {} : { itemsPerBrew }),
    caveats,
  };
}

/** One entry per drop that has a published rate, biggest earner first. */
function contributionsFor(
  drops: { id: string; name: string; perHour: number }[],
  directBy: Map<string, ItemXp>,
  o: MinionXpOptions,
): XpContribution[] {
  const out: XpContribution[] = [];
  for (const drop of drops) {
    const known = directBy.get(drop.id);
    if (!known || known.minionXp === null) continue;
    const baseXpPerHour = drop.perHour * known.minionXp;
    const skillXpPerHour = withWisdom(baseXpPerHour, wisdomFor(o.player, known.skill));
    out.push({
      skill: known.skill,
      itemId: drop.id,
      itemName: drop.name,
      itemsPerHour: drop.perHour,
      xpPerItem: known.minionXp,
      baseXpPerHour,
      skillXpPerHour,
      petXpPerHour: skillXpPerHour * petXpMultiplier(known.skill, o.player, o.rules),
    });
  }
  return out.sort((a, b) => b.baseXpPerHour - a.baseXpPerHour);
}

/** A direct row is the sum of its drops, named after whichever of them earns the most. */
function directRow(
  minion: MinionProduction,
  tier: number,
  route: XpRoute,
  lead: XpContribution,
  rate: number,
  contributions: XpContribution[],
  caveats: string[],
): MinionXpRow {
  const sum = (pick: (c: XpContribution) => number) => contributions.reduce((total, c) => total + pick(c), 0);
  return {
    generator: minion.generator,
    family: minion.family,
    tier,
    skill: lead.skill,
    route,
    itemId: lead.itemId,
    itemName: lead.itemName,
    itemsPerHour: rate,
    baseSkillXpPerHour: sum((c) => c.baseXpPerHour),
    skillXpPerHour: sum((c) => c.skillXpPerHour),
    petXpPerHour: sum((c) => c.petXpPerHour),
    xpPerItem: lead.xpPerItem,
    contributions,
    caveats,
  };
}

const round = (n: number) => Math.round(n).toLocaleString("en-US");

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
  return brewChain(ingredientId, dropId, recipes, depth)?.drops ?? null;
}

/**
 * The drop cost of one brewing ingredient, and what else the recipe wants alongside.
 *
 * Following only single-ingredient recipes was enough for four of the five routes and silently
 * lost the fifth. Enchanted Fermented Spider Eye — the Weakness potion, 15,000 XP — is
 * `64 Brown Mushroom + 64 Sugar + 64 Enchanted Spider Eye`, and a chain that gives up the moment a
 * recipe has more than one ingredient never reaches it. So every spider minion in the game came
 * back with no Alchemy route at all, which is not a judgement about spider minions: it is a
 * traversal that could not see round a corner.
 *
 * The walk now follows whichever ingredient leads to the drop and keeps the rest as `alongside` —
 * they are a real cost and the caller says so rather than pretending a brew is free. Where several
 * branches reach the drop the cheapest is taken, since that is the recipe somebody would follow.
 *
 * Depth stays capped at four. The point is to see round one corner, not to search the crafting
 * tree: an unbounded walk finds a path from almost anything to almost anything and every one of
 * them costs more than it is worth.
 */
/**
 * How many base items one of this id decomposes to, following single-ingredient recipes down.
 *
 * The measure of "how much of a recipe is this ingredient". An Enchanted Spider Eye is 160 spider
 * eyes; a brown mushroom is one mushroom. Counting the compaction is the only way to see that 64
 * of the first is a hundred and sixty times the 64 of the second, which is what makes one the
 * substance of the brew and the other the garnish.
 */
function baseUnits(
  id: string,
  recipes: { output: string; yield: number; ingredients: { id: string; qty: number }[] }[],
  depth = 0,
): number {
  if (depth > 4) return 1;
  for (const recipe of recipes) {
    if (recipe.output !== id || recipe.ingredients.length !== 1 || !(recipe.yield > 0)) continue;
    const only = recipe.ingredients[0];
    return (only.qty / recipe.yield) * baseUnits(only.id, recipes, depth + 1);
  }
  return 1;
}

/**
 * "SUGAR" to "Sugar", for the handful of brewing ingredients no bazaar carries.
 *
 * The name table is the bazaar's, and vanilla items like sugar and brown mushroom are not traded
 * on it — so an id falls through with nothing to show. Printing the id raw in a sentence about
 * shopping is worse than a plain title case of it.
 */
function readableId(id: string): string {
  return id
    .toLowerCase()
    .split(/[_:]/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/** The ingredient a recipe is mostly made of, by base items rather than by count. */
function dominantIngredient(
  recipe: { yield: number; ingredients: { id: string; qty: number }[] },
  recipes: { output: string; yield: number; ingredients: { id: string; qty: number }[] }[],
): { id: string; qty: number } | undefined {
  let best: { id: string; qty: number } | undefined;
  let bestWeight = -Infinity;
  for (const ingredient of recipe.ingredients) {
    const weight = ingredient.qty * baseUnits(ingredient.id, recipes);
    if (weight > bestWeight) {
      bestWeight = weight;
      best = ingredient;
    }
  }
  return best;
}

export function brewChain(
  ingredientId: string,
  dropId: string,
  recipes: { output: string; yield: number; ingredients: { id: string; qty: number }[] }[],
  depth = 0,
): { drops: number; alongside: { id: string; qty: number }[] } | null {
  if (ingredientId === dropId) return { drops: 1, alongside: [] };
  if (depth > 4) return null;

  let best: { drops: number; alongside: { id: string; qty: number }[] } | null = null;

  for (const recipe of recipes) {
    if (recipe.output !== ingredientId || !(recipe.yield > 0)) continue;

    // Only the ingredient the recipe is mostly *made of* may be followed.
    //
    // Without this a Mushroom Minion claims the Weakness route and tops the Alchemy table, because
    // the recipe wants 64 brown mushrooms beside 64 Enchanted Spider Eye and the mushrooms are the
    // cheapest way in. They are also a garnish: the spider eyes are 10,240 base items against the
    // mushrooms' 64. Feeding a sixtieth of a brew is not feeding it, and a minion that supplies the
    // small half should not outrank the one supplying the large one.
    const principal = dominantIngredient(recipe, recipes);

    for (const ingredient of recipe.ingredients) {
      if (recipe.ingredients.length > 1 && ingredient !== principal) continue;
      const below = brewChain(ingredient.id, dropId, recipes, depth + 1);
      if (below === null) continue;

      const drops = (ingredient.qty / recipe.yield) * below.drops;
      // Everything the recipe wants that is not on the path to the drop. Scaled by the yield for
      // the same reason the path is, so the figures describe one finished ingredient.
      const alongside = [
        ...recipe.ingredients
          .filter((other) => other !== ingredient)
          .map((other) => ({ id: other.id, qty: other.qty / recipe.yield })),
        ...below.alongside,
      ];
      if (!best || drops < best.drops) best = { drops, alongside };
    }
  }

  return best;
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
    if (row.contributions.length === 0) {
      if (!best.has(row.skill)) best.set(row.skill, null);
      continue;
    }
    // Per skill, not per row. A minion reaching two skills is a candidate for both, and each card
    // has to quote that skill's own share — a Tarantula Minion's Mining figure is its iron and not
    // its iron plus its spider eyes, however the row itself is ranked.
    for (const skill of new Set(row.contributions.map((c) => c.skill))) {
      const narrowed = narrowTo(row, skill);
      if (narrowed.petXpPerHour <= 0 && narrowed.skillXpPerHour <= 0) {
        if (!best.has(skill)) best.set(skill, null);
        continue;
      }
      const held = best.get(skill);
      if (!held || narrowed.petXpPerHour > held.petXpPerHour) best.set(skill, narrowed);
    }
  }
  return best;
}

/** The same row seen as one skill only: its drops in that skill, and nothing else's XP counted. */
export function narrowTo(row: MinionXpRow, skill: SkillKey): MinionXpRow {
  const kept = row.contributions.filter((c) => c.skill === skill);
  if (kept.length === row.contributions.length) return row;
  const lead = kept[0] ?? row.contributions[0];
  const sum = (pick: (c: XpContribution) => number) => kept.reduce((total, c) => total + pick(c), 0);
  return {
    ...row,
    skill,
    itemId: lead?.itemId ?? row.itemId,
    itemName: lead?.itemName ?? row.itemName,
    xpPerItem: lead?.xpPerItem ?? 0,
    baseSkillXpPerHour: sum((c) => c.baseXpPerHour),
    skillXpPerHour: sum((c) => c.skillXpPerHour),
    petXpPerHour: sum((c) => c.petXpPerHour),
    contributions: kept,
  };
}
