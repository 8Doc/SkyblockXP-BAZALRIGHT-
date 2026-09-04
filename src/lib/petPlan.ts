import {
  petXpMultiplier,
  withWisdom,
  wisdomFor,
  type MinionXpRow,
  type PetXpRules,
  type Player,
  type SkillKey,
  type XpContribution,
} from "./minionXp";
import type { Liquidity, PetProfitRow } from "./petLevelling";

/**
 * Which minion to put down, which pet to sit on it, and what the pair makes in a day.
 *
 * The two halves of this tab were previously two lists that a reader had to multiply in their
 * head, and the multiplication is not the hard part — the *pairing* is. A pet gains the full Skill
 * XP of its own skill and a third of anything else, so the best minion and the best pet are very
 * often not a good plan: a Pumpkin Minion under a Combat pet throws two thirds of its output away,
 * and a worse minion whose skill matches beats it outright. Ranking pairs rather than ranking two
 * lists is the whole point of this module.
 *
 * **Profit has two halves and both are real.** A minion levelling a pet is still a minion: it goes
 * on producing items you can sell while the XP accumulates, and for the setups people actually run
 * that is the larger half. The Revenant Minion is the case worth naming — people put down a wall
 * of them, level Golden Dragons off the Combat XP, and sell the rotten flesh to the bazaar the
 * whole time. Counting only the pet margin describes half of that and calls it the answer.
 *
 * **Brewing is not free XP, and what it costs is an opportunity rather than a loss.** Every other
 * route here is a by-product of collecting a minion you were collecting anyway. Brewing is not: the
 * drops go into a brewing stand instead of onto the market. That is not money lost — it is money
 * not made, and the only question it raises is whether the pet XP is worth more than the sale would
 * have been. So the figure that matters is `advantagePerDay`: what this plan makes *over and above
 * simply selling everything the minion produces*. A brewing route whose advantage is negative is
 * not a bad plan with a cost attached, it is a worse plan than doing nothing, and the caller is
 * told so rather than being shown a subtraction.
 *
 * The labour is capped separately and bluntly, because it is not economic: "22,500 pet XP an hour"
 * is not an offer anybody takes if it means nine thousand brews a day.
 */

export type PetCatalogueEntry = { key: string; name: string; skill: SkillKey | null };

/**
 * The second pet on a brewing plan — the one that levels off collecting rather than off brewing.
 *
 * Carries its own copy of every figure the main pet has, because the two are levelled from
 * different XP streams at different rates and averaging them would describe neither.
 */
export type PartnerPet = {
  petKey: string;
  petName: string;
  petRarity: string;
  petLiquidity: Liquidity;
  buyPrice: number;
  matched: boolean;
  petXpPerDay: number;
  daysPerPet: number;
  petsPerDay: number;
  /** Coins a day this pet adds on its own. Already included in the row's pet profit. */
  profitPerDay: number;
};

/** Hours in the day every per-day figure here divides by. */
export const DAY_HOURS = 24;

export type PetPlanRow = {
  /* ------------------------------------------------------------- the pair */
  generator: string;
  family: string;
  tier: number;
  skill: SkillKey;
  /**
   * Every skill this route's XP arrives in, biggest share first. Usually one; sometimes not.
   *
   * A minion drops more than one thing and the things are not all the same skill — a Tarantula
   * Minion pays Combat for its spider eyes and Mining for its iron, a Voidling Minion pays Mining
   * for both its obsidian and its quartz, a Revenant Minion pays Mining for diamonds it drops
   * beside flesh that pays nothing published. One pet is standing there for all of it, taking the
   * matching share at full rate and the rest at a third, which is why the pairing is worked out
   * across the whole list rather than against `skill` alone.
   */
  feeds: SkillKey[];
  route: MinionXpRow["route"];

  petKey: string;
  petName: string;
  petRarity: string;
  /** How deep the market is behind the pet's sell price. A plan to list an unsellable pet is not one. */
  petLiquidity: Liquidity;
  /** What the cheap end costs today. The headline is a shopping instruction, so it needs the price. */
  buyPrice: number;
  /** The level that cheap end is listed at — 1 unless nobody is selling one that low. */
  buyLevel: number;
  /** True when the pet's own skill is the one the minion feeds — the difference is a factor of 3. */
  matched: boolean;

  /**
   * The skill collecting pays on a brewing route, and the second pet that levels off it.
   *
   * A brewing plan runs two XP streams off one set of drops: collecting the minion pays its own
   * skill, and brewing what you collected pays Alchemy. Only one pet is out at a time, so this is
   * two pets swapped rather than two levelled at once — the alchemy pet while you brew, the other
   * while you collect — which is exactly how the setup is played, and why the plan names both.
   *
   * Both absent on a direct route, where there is only one stream and one pet.
   */
  baseSkill?: SkillKey;
  partner?: PartnerPet;

  /* ----------------------------------------------------------- the numbers */
  petXpPerDay: number;
  /** How long one pet takes, start to max, at this rate. */
  daysPerPet: number;
  /** Pets finished a day. Below one for almost everything, which is the honest shape. */
  petsPerDay: number;

  /** Coins a day from buying, levelling and reselling pets at this rate. */
  petProfitPerDay: number;
  /** Coins a day from selling what the minion produced while it did it. */
  itemProfitPerDay: number;
  /**
   * Coins a day of drops fed into a brewing stand instead of sold. Zero on every direct route.
   *
   * An opportunity cost, not a loss: this is revenue forgone, and it is only worth anything as the
   * thing `advantagePerDay` is measured against.
   */
  brewingCostPerDay: number;
  /** Brews a day this route asks of you. Zero on every direct route. */
  brewsPerDay: number;
  /**
   * Things you have to actually do in a day: collections, plus brews.
   *
   * The figure the whole tab is really ranked against. "The best money from minion pet-levelling
   * without doing any excessive action" is a constrained optimisation, and this is the constraint —
   * a plan worth 300k a day for one collection is a different proposition from one worth 400k that
   * wants two hundred trips to a brewing stand, and a table that prints only the coins hides that.
   */
  actionsPerDay: number;

  /** Coins a day from doing none of this — just running the minion and selling everything. */
  sellOnlyPerDay: number;
  /**
   * What this plan makes over simply selling the output. The figure the plan is actually chosen on.
   *
   * For a direct route it is the pet profit, since the XP arrived free with a collection you were
   * making anyway. For a brewing route it is the pet profit less the drops the stand ate. Negative
   * means the plan is worse than not having one.
   */
  advantagePerDay: number;
  /** False when you would make more coins by ignoring pets entirely and selling the lot. */
  beatsSelling: boolean;

  /** Total coins a day: pets, plus whatever items were left to sell. */
  totalProfitPerDay: number;

  caveats: string[];
};

export type PetPlanOptions = {
  /** Every route every minion has into a skill, from `planMinionXp`. */
  xpRows: MinionXpRow[];
  /** Every pet worth levelling, from `planPetProfit`. */
  pets: PetProfitRow[];
  /** Which skill each pet levels off. A pet with no skill cannot be planned for. */
  catalogue: PetCatalogueEntry[];
  rules: PetXpRules;
  player: Player;
  /** Coins an hour each minion makes selling its output, keyed by generator, from `planProfit`. */
  itemCoinsPerHour: Map<string, number>;
  /** What one raw drop of each minion sells for, for costing the brewing route. */
  dropValue: Map<string, number>;
  /**
   * The most brews a day worth recommending.
   *
   * A cap rather than a penalty because the constraint is not economic. Standing at a brewing stand
   * is a chore with a ceiling nobody argues about: past a few hundred a day the route is a second
   * job and the profit figure beside it is a fiction.
   */
  maxBrewsPerDay: number;
  /**
   * Collections a day, which is the other half of the effort budget and the one nobody counts.
   *
   * Also decides how much of the minion's output survives: past the point storage fills, a minion
   * earns nothing until someone empties it, so collecting once a day and collecting four times are
   * different incomes as well as different amounts of work.
   */
  claimsPerDay: number;
  /** Drop pairs whose profit is below this, in coins a day. Keeps the table to real plans. */
  minProfitPerDay?: number;
  /**
   * The longest a pet may take before the pairing stops counting as a plan.
   *
   * Needed because the item half of the profit dwarfs the pet half for almost every real setup, so
   * ranking on the total alone makes the pet choice arbitrary: every minion picks whichever pet has
   * the best coins-per-XP, skill mismatch and all, and the table cheerfully recommends a pet that
   * finishes in twenty-three thousand days. A horizon turns that into an honest answer — either a
   * pet can be levelled here in a time you would accept, or none can and the minion is worth
   * running for its items alone.
   */
  maxDaysPerPet?: number;
};

/**
 * Recompute a route's Pet XP for one specific pet.
 *
 * The rows arriving from `planMinionXp` were computed against whatever pet skill the tab had
 * selected, which is the wrong basis here: this module is choosing the pet, so the multiplier has
 * to be recomputed per candidate. Doing it from `baseSkillXpPerHour` rather than scaling the
 * finished figure keeps Wisdom applied once and in the right place.
 */
export function petXpPerHourFor(row: MinionXpRow, petSkill: SkillKey | null, player: Player, rules: PetXpRules): number {
  return xpFromContributions(row.contributions, petSkill, player, rules);
}

/**
 * One pet standing over a minion that pays into several skills at once.
 *
 * The multiplier is per skill, so the sum has to be taken after it and not before: a Mining pet on
 * a Tarantula Minion keeps all of the iron's Mining XP and a third of the spider eyes' Combat XP,
 * and a Combat pet keeps the other way round. Summing the skill XP first and applying one
 * multiplier would give both pets the same answer, and it would be wrong for at least one of them.
 */
function xpFromContributions(
  contributions: XpContribution[],
  petSkill: SkillKey | null,
  player: Player,
  rules: PetXpRules,
): number {
  const asked = { ...player, petSkill };
  let total = 0;
  for (const c of contributions) {
    total += withWisdom(c.baseXpPerHour, wisdomFor(player, c.skill)) * petXpMultiplier(c.skill, asked, rules);
  }
  return total;
}

/**
 * Every worthwhile (minion, pet) pairing, best coins a day first.
 *
 * Pairs are formed against the pet's own skill rather than across the whole catalogue, which is
 * both the correct model and a large saving: sixty minions against forty pets is a small number
 * once a Mining minion only has to consider Mining pets and the mismatched pairings are left to
 * the caller to ask about explicitly.
 */
export function planPetPairs(o: PetPlanOptions): PetPlanRow[] {
  const skillOf = new Map(o.catalogue.map((p) => [p.key, p.skill]));
  const nameOf = new Map(o.catalogue.map((p) => [p.key, p.name]));
  const floor = o.minProfitPerDay ?? 0;
  const horizon = o.maxDaysPerPet ?? Infinity;
  const out: PetPlanRow[] = [];

  for (const row of o.xpRows) {
    if (!(row.baseSkillXpPerHour > 0)) continue;

    const itemCoinsPerHour = o.itemCoinsPerHour.get(row.generator) ?? 0;
    const dropValue = o.dropValue.get(row.generator) ?? 0;

    // The collection half of a brewing plan, settled once per route rather than once per candidate.
    // It does not depend on which pet is chosen for the brewing half — the two streams are
    // independent — so working it out inside the pet loop would be the same answer sixty times.
    const partner = bestPartner(row, o, skillOf, nameOf, horizon);

    for (const pet of o.pets) {
      const bare = pet.key.replace(/^PET:/, "");
      const petSkill = skillOf.get(bare) ?? null;
      // A pet nothing says a skill for cannot be planned: the multiplier would be a guess, and it
      // is a factor of three either way.
      if (!petSkill) continue;

      const petXpPerHour = petXpPerHourFor(row, petSkill, o.player, o.rules);
      if (!(petXpPerHour > 0)) continue;

      const caveats: string[] = [];
      const matched = petSkill === row.skill;

      let petXpPerDay = petXpPerHour * DAY_HOURS;
      let brewsPerDay = 0;
      let brewingCostPerDay = 0;
      let itemProfitPerDay = itemCoinsPerHour * DAY_HOURS;

      if (row.route === "brewing") {
        const perBrew = row.itemsPerBrew ?? 0;
        if (!(perBrew > 0)) continue;

        // Two ceilings, and the tighter one wins: how many brews the minion can supply, and how
        // many a person will actually stand and do.
        const dropsPerDay = row.itemsPerHour * DAY_HOURS;
        const supplied = dropsPerDay / perBrew;
        brewsPerDay = Math.min(supplied, o.maxBrewsPerDay);
        if (brewsPerDay <= 0) continue;

        // The XP is per brew, so capping the brews caps the XP with it — this is the line that
        // stops the table quoting a rate nobody would sit through.
        petXpPerDay = petXpPerDay * (brewsPerDay / Math.max(supplied, 1e-9));

        // And the drops that went into the stand did not go onto the market.
        const dropsConsumed = brewsPerDay * perBrew;
        brewingCostPerDay = dropsConsumed * dropValue;
        // The drops are gone from the market whether or not the brewing was wise, so the item half
        // genuinely falls. What that costs is judged by `advantagePerDay` below, not here.
        itemProfitPerDay = Math.max(0, itemProfitPerDay - brewingCostPerDay);

        if (brewsPerDay >= o.maxBrewsPerDay - 1e-9) {
          caveats.push(`capped at ${Math.round(o.maxBrewsPerDay)} brews a day — the minion could supply ${Math.round(supplied)}`);
        }
        caveats.push(`each brew eats ${Math.round(perBrew).toLocaleString("en-US")} drops that would otherwise be sold`);
      }

      const petsPerDay = pet.xpNeeded > 0 ? petXpPerDay / pet.xpNeeded : 0;
      const daysPerPet = petXpPerDay > 0 ? pet.xpNeeded / petXpPerDay : Infinity;
      if (daysPerPet > horizon) continue;

      // The partner's margin is real income from the same drops, so it belongs in the profit rather
      // than in a footnote. It is added once, here, and every total below inherits it.
      const petProfitPerDay = petsPerDay * pet.profit + (partner?.profitPerDay ?? 0);
      const totalProfitPerDay = petProfitPerDay + itemProfitPerDay;
      const sellOnlyPerDay = itemCoinsPerHour * DAY_HOURS;
      const advantagePerDay = totalProfitPerDay - sellOnlyPerDay;
      if (totalProfitPerDay <= floor) continue;

      if (advantagePerDay <= 0) {
        caveats.push(
          `worse than not bothering: selling everything the minion makes is ${Math.round(
            -advantagePerDay,
          ).toLocaleString("en-US")} coins a day better`,
        );
      }

      if (!matched) {
        caveats.push(`a ${petSkill.toLowerCase()} pet on a ${row.skill.toLowerCase()} minion keeps only part of the XP`);
      }
      for (const c of row.caveats) caveats.push(c);
      for (const c of pet.caveats) caveats.push(c);

      out.push({
        generator: row.generator,
        family: row.family,
        tier: row.tier,
        skill: row.skill,
        feeds: [...new Set(row.contributions.map((c) => c.skill))],
        route: row.route,
        petKey: pet.key,
        petName: nameOf.get(bare) ?? pet.name,
        petRarity: pet.rarity,
        petLiquidity: pet.liquidity,
        buyPrice: pet.buy.price,
        buyLevel: pet.buy.level,
        matched,
        ...(row.baseSkill === undefined ? {} : { baseSkill: row.baseSkill }),
        ...(partner === null ? {} : { partner }),
        petXpPerDay,
        daysPerPet,
        petsPerDay,
        actionsPerDay: o.claimsPerDay + brewsPerDay,
        petProfitPerDay,
        itemProfitPerDay,
        brewingCostPerDay,
        brewsPerDay,
        sellOnlyPerDay,
        advantagePerDay,
        beatsSelling: advantagePerDay > 0,
        totalProfitPerDay,
        caveats,
      });
    }
  }

  // Ranked on the ADVANTAGE, not the total. The total is dominated by item income the minion would
  // earn with no pet on it at all, so ranking on it answers "which minion sells the most" — a
  // question the Raw profits tab already answers better — and attaches whatever pet happens to be
  // along for the ride. This tab is about what pet-levelling adds, so that is what it sorts by.
  return out.sort((a, b) => b.advantagePerDay - a.advantagePerDay);
}

/**
 * The best pet for the collection half of a brewing plan.
 *
 * Only brewing rows have a collection half worth naming — on a direct route the collection *is* the
 * route, and its pet is the one being chosen in the main loop. Returns null wherever there is no
 * second stream: a direct row, a brewing row whose drop has no published direct rate, or one where
 * nothing on the market can level a pet of that skill inside the horizon.
 *
 * Chosen on margin a day, which for a fixed XP stream is the same ranking as coins per point of Pet
 * XP — the figure that makes a Rabbit comparable to a Golden Dragon.
 */
function bestPartner(
  row: MinionXpRow,
  o: PetPlanOptions,
  skillOf: Map<string, SkillKey | null>,
  nameOf: Map<string, string>,
  horizon: number,
): PartnerPet | null {
  const skill = row.baseSkill;
  const collection = row.baseContributions ?? [];
  if (row.route !== "brewing" || !skill || collection.length === 0) return null;

  let best: PartnerPet | null = null;
  for (const pet of o.pets) {
    const bare = pet.key.replace(/^PET:/, "");
    const petSkill = skillOf.get(bare) ?? null;
    if (!petSkill) continue;

    // The collection stream on its own, so the Wisdom and multiplier chain is applied to the skills
    // that actually pay it rather than to Alchemy.
    const petXpPerDay = xpFromContributions(collection, petSkill, o.player, o.rules) * DAY_HOURS;
    if (!(petXpPerDay > 0) || !(pet.xpNeeded > 0)) continue;

    const daysPerPet = pet.xpNeeded / petXpPerDay;
    if (daysPerPet > horizon) continue;

    const petsPerDay = petXpPerDay / pet.xpNeeded;
    const profitPerDay = petsPerDay * pet.profit;
    if (!(profitPerDay > 0) || (best && profitPerDay <= best.profitPerDay)) continue;

    best = {
      petKey: pet.key,
      petName: nameOf.get(bare) ?? pet.name,
      petRarity: pet.rarity,
      petLiquidity: pet.liquidity,
      buyPrice: pet.buy.price,
      matched: petSkill === skill,
      petXpPerDay,
      daysPerPet,
      petsPerDay,
      profitPerDay,
    };
  }
  return best;
}

/**
 * The best plan per minion, so one very profitable minion does not fill the whole table.
 *
 * Without this the list is forty rows of the same Revenant Minion against forty different pets,
 * which answers "which pet" and buries "which minion". One row per minion, carrying its best pet,
 * answers both at once.
 */
export function bestPerMinion(rows: PetPlanRow[]): PetPlanRow[] {
  const best = new Map<string, PetPlanRow>();
  for (const row of rows) {
    const held = best.get(row.generator);
    // Chosen on the ADVANTAGE, which is the only figure that means anything here. The total is
    // dominated by item income that is identical for every pet on a given minion, so choosing on it
    // makes the comparison a tie broken by nothing — that is how a mismatched pet keeping a third
    // of the XP got recommended over a matched one. And choosing on the pet half alone would pick a
    // brewing route that eats more in drops than the pet is worth. What is left is "how much better
    // is this than just selling the output", which is the question being asked.
    if (!held || row.advantagePerDay > held.advantagePerDay) best.set(row.generator, row);
  }
  return [...best.values()].sort((a, b) => b.advantagePerDay - a.advantagePerDay);
}
