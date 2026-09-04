import { petXpMultiplier, withWisdom, type MinionXpRow, type PetXpRules, type Player, type SkillKey } from "./minionXp";
import type { PetProfitRow } from "./petLevelling";

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
 * **Brewing is not free XP and is priced accordingly.** Every other route here is a by-product of
 * collecting a minion you were collecting anyway. Brewing is not: the drops go into a brewing stand
 * instead of onto the market, so the Alchemy XP costs exactly what those drops would have sold for,
 * and it costs an evening standing at the stand. Both are charged — the coins as an opportunity
 * cost subtracted from the day's profit, and the labour as a hard cap on brews per day, because
 * "22,500 pet XP an hour" is not an offer anybody will take if it means nine thousand brews.
 */

export type PetCatalogueEntry = { key: string; name: string; skill: SkillKey | null };

/** Hours in the day every per-day figure here divides by. */
export const DAY_HOURS = 24;

export type PetPlanRow = {
  /* ------------------------------------------------------------- the pair */
  generator: string;
  family: string;
  tier: number;
  skill: SkillKey;
  route: MinionXpRow["route"];

  petKey: string;
  petName: string;
  petRarity: string;
  /** True when the pet's own skill is the one the minion feeds — the difference is a factor of 3. */
  matched: boolean;

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
  /** Coins a day of drops fed into a brewing stand instead of sold. Zero on every direct route. */
  brewingCostPerDay: number;
  /** Brews a day this route asks of you. Zero on every direct route. */
  brewsPerDay: number;

  /** The ranking figure: pets, plus items, less what brewing consumed. */
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
  const skillXp = withWisdom(row.baseSkillXpPerHour, player.wisdom);
  return skillXp * petXpMultiplier(row.skill, { ...player, petSkill }, rules);
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
        itemProfitPerDay = Math.max(0, itemProfitPerDay - brewingCostPerDay);

        if (brewsPerDay >= o.maxBrewsPerDay - 1e-9) {
          caveats.push(`capped at ${Math.round(o.maxBrewsPerDay)} brews a day — the minion could supply ${Math.round(supplied)}`);
        }
        caveats.push(`each brew eats ${Math.round(perBrew).toLocaleString("en-US")} drops that would otherwise be sold`);
      }

      const petsPerDay = pet.xpNeeded > 0 ? petXpPerDay / pet.xpNeeded : 0;
      const daysPerPet = petXpPerDay > 0 ? pet.xpNeeded / petXpPerDay : Infinity;
      if (daysPerPet > horizon) continue;

      const petProfitPerDay = petsPerDay * pet.profit;
      const totalProfitPerDay = petProfitPerDay + itemProfitPerDay;
      if (totalProfitPerDay <= floor) continue;

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
        route: row.route,
        petKey: pet.key,
        petName: nameOf.get(bare) ?? pet.name,
        petRarity: pet.rarity,
        matched,
        petXpPerDay,
        daysPerPet,
        petsPerDay,
        petProfitPerDay,
        itemProfitPerDay,
        brewingCostPerDay,
        brewsPerDay,
        totalProfitPerDay,
        caveats,
      });
    }
  }

  return out.sort((a, b) => b.totalProfitPerDay - a.totalProfitPerDay);
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
    // Chosen on the PET half alone, not on the total. The item half is identical for every pet on
    // a given minion, so including it makes the comparison a tie broken by nothing — which is how
    // a mismatched pet that keeps a third of the XP ends up recommended over a matched one. The
    // total is still what the rows are ranked by; it is just not what picks the pet.
    if (!held || row.petProfitPerDay > held.petProfitPerDay) best.set(row.generator, row);
  }
  return [...best.values()].sort((a, b) => b.totalProfitPerDay - a.totalProfitPerDay);
}
