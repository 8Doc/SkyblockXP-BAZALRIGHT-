import type { Category, Task } from "./types";
import type { GardenState, MuseumState, ProfileMember } from "./profile";
import { petKey } from "./auctions";
import {
  bagUpgradeCost,
  bumpRarity,
  effortOf,
  familyOf,
  magicalPowerOf,
  scoreBag,
  type BagItem,
  type BagState,
  type GameData,
} from "./gameData";

/** "DRAGON_ESSENCE_ONE_PUNCH_3" -> "Dragon essence · one punch 3" */
function prettyTaskName(id: string): string {
  const words = id.replace(/_/g, " ").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * A track of levels gated by cumulative XP — catacombs, a dungeon class, anything with a curve.
 * Each level requires the one below it, so the bundle logic prices the whole climb.
 */
function addLevelTrack(input: {
  tasks: Task[];
  done: Set<string>;
  idPrefix: string;
  label: string;
  category: Category;
  levels: { level: number; totalXp: number }[];
  currentXp: number;
  xpFor: (level: number) => number;
}): void {
  let previous: string | null = null;
  for (const level of input.levels) {
    const id = `${input.idPrefix}_${level.level}`;
    input.tasks.push({
      id,
      category: input.category,
      name: `${input.label} ${level.level}`,
      xp: input.xpFor(level.level),
      requires: previous ? [previous] : [],
      cost: { kind: "none" },
      repeatable: false,
    });
    if (input.currentXp >= level.totalXp) input.done.add(id);
    previous = id;
  }
}

/**
 * Builds the task universe for one profile, and marks what's already done.
 *
 * Each category is its own builder. A category is only in here if we can source both its XP
 * values and its completion state from real data — the rest are declared in UNMODELLED so the
 * UI can say "we don't cover this yet" instead of quietly reporting a smaller game.
 *
 * Pure and synchronous: the caller supplies the tables and the already-decoded talisman bag,
 * because decompressing gzip is the one step Node and the browser do differently.
 */

export type Catalog = {
  tasks: Task[];
  done: Set<string>;
  bag: BagState;
  /** SkyBlock XP the profile has already earned. */
  currentXp: number;
  /** Category-level notes for anything we can't model as tasks yet. */
  unmodelled: { category: Category; note: string; earnedXp?: number; totalXp?: number }[];
  meta: {
    fairySouls: { collected: number };
    skills: Record<string, number>;
  };
};

export const UNMODELLED: { category: Category; note: string; totalXp?: number }[] = [
  {
    category: "misc",
    note: "Bestiary is the largest single gap: ~4,370 XP. It needs per-mob kill brackets, which the wiki has but only as a bracket-multiplier table — the mob list itself has to be assembled from the profile's own bestiary keys.",
    totalXp: 4370,
  },
  {
    category: "misc",
    note: "Garden is partly covered: plots, crop upgrades and the composter are modelled. Garden level (~140 XP), visitor and offer milestones (~135), crop milestones (~598), greenhouse (~100) and DNA analysis (~90) need threshold tables the wiki doesn't publish in a form worth trusting.",
    totalXp: 1063,
  },
  {
    category: "misc",
    note: "Peak of the Mountain (~1,000 XP) and Heart of the Forest (~545) have published XP tables, but a deep search of a maxed profile finds no field carrying their tier. Modelling them would show every player zero progress and overstate what they have left, so they wait for the API to expose a tier.",
    totalXp: 1545,
  },
  {
    category: "attributes",
    note: "Attribute levels are priced from the shards that feed them, which assumes buying every shard outright. Fusing shards you already own is cheaper, so those costs are an upper bound. Six attributes have no bazaar-traded shard and stay unpriced. The attribute list itself comes from the Fandom wiki, which is behind the game.",
  },
];

export function buildCatalog(
  member: ProfileMember,
  data: GameData,
  bag: { items: BagItem[] | null; capacity: number },
  museum: MuseumState | null = null,
  pets: { name: string; rarity: string }[] | null = null,
  garden: GardenState | null = null,
  /** Island-wide progress, unioned across co-op members. Falls back to this member alone. */
  coop: { craftedGenerators: string[]; unlockedCollectionTiers: string[]; collected: Map<string, number> } | null = null,
): Catalog {
  const tasks: Task[] = [];
  const done = new Set<string>();

  /* ------------------------------------------------------------- skills */

  const skillXp = member.player_data?.experience ?? {};
  const skillLevels: Record<string, number> = {};

  for (const skill of data.skills.skills) {
    const xp = skillXp[`SKILL_${skill.key}`] ?? 0;
    let current = 0;
    for (const lv of skill.levels) if (xp >= lv.totalExpRequired) current = lv.level;
    skillLevels[skill.key] = current;

    let previous: string | null = null;
    for (const lv of skill.levels) {
      if (lv.xp <= 0) continue;
      const id = `skill_${skill.key}_${lv.level}`;
      tasks.push({
        id,
        category: "skills",
        name: `${skill.name} ${lv.level}`,
        xp: lv.xp,
        requires: previous ? [previous] : [],
        cost: { kind: "none" },
        repeatable: false,
      });
      if (lv.level <= current) done.add(id);
      previous = id;
    }
  }

  /* -------------------------------------------------------- collections */

  // Two signals, and the second one is the reliable half.
  //
  // `unlocked_coll_tiers` reads like an event log rather than a state: a maxed Fig Log turns up
  // as FIG_LOG_4, FIG_LOG_8 and FIG_LOG_-1, with the other six tiers simply absent. Trusting it
  // alone means offering tiers the player passed long ago — this profile has collected 3.5M figs
  // against a final tier of 150k.
  //
  // The amount collected is the thing the game actually counts, so a tier is done if either
  // signal says so. Neither is dropped: the list still catches a tier unlocked by some route the
  // amount doesn't reflect.
  const unlockedTiers = new Set(coop?.unlockedCollectionTiers ?? member.player_data?.unlocked_coll_tiers ?? []);
  const collectedTotals = coop?.collected ?? collectedFrom(member);
  for (const coll of data.collections.collections) {
    let previous: string | null = null;
    for (const tier of coll.tiers) {
      if (tier.xp <= 0) continue;
      const id = `collection_${coll.itemId}_${tier.tier}`;
      tasks.push({
        id,
        category: "collections",
        name: `${coll.name} ${tier.tier}`,
        xp: tier.xp,
        requires: previous ? [previous] : [],
        cost: { kind: "none" },
        repeatable: false,
        note: `${tier.amountRequired.toLocaleString("en-US")} collected`,
      });
      const have = collectedTotals.get(coll.itemId) ?? 0;
      if (unlockedTiers.has(`${coll.itemId}_${tier.tier}`) || have >= tier.amountRequired) done.add(id);
      previous = id;
    }
  }

  /* ------------------------------------------------------------ minions */

  // Island-wide: in a co-op one member crafts tiers I-VI and another upgrades to XI, and each
  // only ever records their own half.
  const crafted = new Set(coop?.craftedGenerators ?? member.player_data?.crafted_generators ?? []);
  for (const minion of data.minions.minions) {
    let previous: string | null = null;
    for (const tier of minion.tiers) {
      const id = `minion_${minion.generator}_${tier.tier}`;
      // Tier XII is the one tier with a published price: it's applied with an upgrade stone
      // that trades on the bazaar. Tiers I-XI are crafting recipes, which the API doesn't ship.
      const stone = `GENERATOR_UPGRADE_STONE_${minion.generator}_12`;
      // Tier XII is applied with an upgrade stone; every tier below it is a craft, and the
      // recipe comes from the wiki with its ingredients resolved to bazaar products.
      const recipe = data.costs.minions[minion.generator]?.[String(tier.tier)];
      // A recipe is either a plain ingredient list or ingredients plus other minion tiers —
      // Revenant is crafted from a Zombie minion, and those become real prerequisites so the
      // bundle prices the whole dependency rather than treating it as unbuyable.
      const ingredients = Array.isArray(recipe) ? recipe : recipe?.items;
      const alsoRequires = Array.isArray(recipe) ? [] : (recipe?.requires ?? []);

      tasks.push({
        id,
        category: "minions",
        name: tier.name,
        xp: tier.xp,
        requires: [...(previous ? [previous] : []), ...alsoRequires],
        cost:
          tier.tier === 12
            ? { kind: "bazaar", items: [{ id: stone, qty: 1 }] }
            : ingredients
              ? { kind: "bazaar", items: ingredients }
              : { kind: "unknown", note: "Recipe needs something the bazaar doesn't trade" },
        repeatable: false,
      });
      if (crafted.has(`${minion.generator}_${tier.tier}`)) done.add(id);
      previous = id;
    }
  }

  /* ------------------------------------------------------- accessory bag */

  const bagState = scoreBag(
    data,
    bag.items,
    member.accessory_bag_storage?.highest_magical_power ?? null,
    bag.capacity,
  );

  // Slots are a real constraint on buying accessories: the bag holds what it holds, and more
  // room is bought from Jacobus at +2 slots a time. Each upgrade is its own task below, but an
  // accessory bought into a *full* bag genuinely costs the accessory plus the slot it sits in,
  // so half an upgrade is added to its price. With slots to spare that surcharge is zero, which
  // is why it's computed rather than always applied.
  const upgradesPurchased = member.accessory_bag_storage?.bag_upgrades_purchased ?? 0;
  const freeSlots = Math.max(bagState.capacity - bagState.used, 0);
  const nextUpgrade = upgradesPurchased + 1;
  const nextUpgradeCost = nextUpgrade <= data.bagUpgrades.maxUpgrades ? bagUpgradeCost(data, nextUpgrade) : null;
  // A full bag makes a *new* accessory cost the accessory plus the slot it needs, so a share of
  // the next bag upgrade is added to its price. Upgrading a family you already own is the
  // exception and it is the common case: the artifact goes into the slot the ring vacates, so it
  // needs no new slot. Charging it anyway added several million to almost every row and pushed
  // the genuinely cheap upgrades down the ranking.
  const slotSurcharge =
    freeSlots > 0 || nextUpgradeCost === null ? 0 : Math.round(nextUpgradeCost / data.bagUpgrades.slotsPerUpgrade);

  const excluded = new Set(data.magicalPower.excludedItems.ids);
  const accessoryById = new Map(data.accessories.accessories.map((a) => [a.id, a]));
  for (const acc of data.accessories.accessories) {
    if (excluded.has(acc.id)) continue;
    const power = magicalPowerOf(data, acc.tier);
    if (power <= 0) continue;

    const family = familyOf(data, acc.name, acc.id);
    const alreadyHave = bagState.familyPower.get(family) ?? 0;
    const gain = power - alreadyHave;
    const id = `accessory_${acc.id}`;

    tasks.push({
      id,
      category: "accessory_bag",
      name: acc.name,
      // 1 XP per magical power, and only the improvement over the family's current best counts.
      xp: Math.max(gain, 0),
      exclusiveGroup: `accessory:${family}`,
      groupLevel: power,
      groupBase: alreadyHave,
      requires: [],
      cost: acc.tradeable
        ? {
            kind: "auction",
            itemId: acc.id,
            surcharge: (alreadyHave > 0 ? 0 : slotSurcharge) || undefined,
            // The member this replaces comes off and goes back on the auction house, so the
            // upgrade costs the difference rather than the sticker price.
            sells: bagState.familyBest.get(family)?.id,
          }
        : { kind: "unknown", note: acc.soulbound ? "Soulbound — cannot be bought" : "Not tradeable" },
      repeatable: false,
      note: `${acc.tier.toLowerCase()} · ${power} MP${alreadyHave > 0 ? ` (family already gives ${alreadyHave})` : ""}`,
    });

    if (bagState.owned.has(acc.id) || gain <= 0) done.add(id);
  }

  /* ------------------------------------------------------ discrete tasks */

  // Everything Hypixel tracks by id: essence perks, abiphone contacts, fast travel unlocks,
  // bank upgrades, dojo belts, slayer tiers, event perks, harp songs. The id list was harvested
  // from live profiles and the XP comes from wiki-derived rules — see scripts/build-task-table.
  const completed = new Set(member.leveling?.completed_tasks ?? []);
  const scrollFor = new Map(data.travelScrolls.scrolls.map((s) => [s.taskId, s]));

  for (const task of data.tasks.tasks) {
    tasks.push({
      id: task.id,
      category: task.category as Category,
      name: prettyTaskName(task.id),
      xp: task.xp,
      requires: [],
      cost: discreteCost(task.id, data, scrollFor),
      repeatable: false,
      note: task.rule,
    });
    if (completed.has(task.id)) done.add(task.id);
  }

  /* --------------------------------------------------------------- museum */

  // donation_xp is published per item in the items resource, and the museum endpoint says what
  // has already been donated — so this category is exact on both halves.
  const donated = museum?.donatedItemIds ?? null;
  for (const donation of data.museum.donations) {
    const id = `museum_${donation.itemId}`;
    tasks.push({
      id,
      category: "museum",
      name: donation.name,
      xp: donation.xp,
      requires: [],
      cost: donation.tradeable ? { kind: "auction", itemId: donation.itemId } : { kind: "unknown", note: "Not tradeable" },
      repeatable: false,
      note: `${donation.category.toLowerCase()} · donation is permanent`,
    });
    if (donated?.has(donation.itemId)) done.add(id);
  }
  for (const set of data.museum.armorSets) {
    const id = `museum_set_${set.setId}`;
    tasks.push({
      id,
      category: "museum",
      name: `${set.name} (set)`,
      xp: set.xp,
      requires: [],
      cost: { kind: "unknown", note: "Whole armour set" },
      repeatable: false,
      note: `${set.category.toLowerCase()} · ${set.pieces.length} pieces`,
    });
    // A set counts once every piece is in; the endpoint lists the pieces individually.
    if (donated && set.pieces.every((piece) => donated.has(piece))) done.add(id);
  }

  /* ------------------------------------------------------------- dungeons */

  const dungeonLevels = data.curves.dungeoneering.levels;
  const catacombsXp = member.dungeons?.dungeon_types?.catacombs?.experience ?? 0;
  addLevelTrack({
    tasks,
    done,
    idPrefix: "catacombs",
    label: "Catacombs",
    category: "dungeons",
    levels: dungeonLevels,
    currentXp: catacombsXp,
    // +20 per level to 39, +40 from 40 up: 1,220 total.
    xpFor: (level) => (level <= 39 ? 20 : 40),
  });

  for (const [className, classData] of Object.entries(member.dungeons?.player_classes ?? {})) {
    addLevelTrack({
      tasks,
      done,
      idPrefix: `class_${className}`,
      label: className.charAt(0).toUpperCase() + className.slice(1),
      category: "dungeons",
      levels: dungeonLevels,
      currentXp: classData?.experience ?? 0,
      xpFor: () => 4,
    });
  }

  /* --------------------------------------------------------------- slayer */

  const slayerBosses = member.slayer?.slayer_bosses ?? {};
  for (const [boss, thresholds] of Object.entries(data.curves.slayer.bosses)) {
    const bossXp = slayerBosses[boss]?.xp ?? 0;
    let previous: string | null = null;
    thresholds.forEach((threshold, index) => {
      const level = index + 1;
      const id = `slayer_${boss}_${level}`;
      tasks.push({
        id,
        category: "slayer",
        name: `${boss.charAt(0).toUpperCase() + boss.slice(1)} slayer ${level}`,
        xp: data.curves.slayer.levelXp[index] ?? 0,
        requires: previous ? [previous] : [],
        cost: { kind: "none" },
        repeatable: false,
        note: `${threshold.toLocaleString("en-US")} slayer xp`,
      });
      if (bossXp >= threshold) done.add(id);
      previous = id;
    });
  }

  /* ----------------------------------------------------------------- pets */

  // Pet score isn't ground, it's bought: every pet you own contributes by rarity, and only the
  // best copy of a given pet counts — the same rule accessory families follow. So the tasks are
  // the pets themselves, priced from the auction house, worth three XP per point of score they
  // add. The auction house doubles as the pet catalogue: there is no pet list in the API, and a
  // pet nobody is selling is one you can't buy anyway.
  const petScoreByRarity = data.petScore.byRarity;
  const ownedPetScore = new Map<string, number>();
  for (const pet of member.pets_data?.pets ?? []) {
    if (!pet?.type) continue;
    const key = petKey(pet.type);
    ownedPetScore.set(key, Math.max(ownedPetScore.get(key) ?? 0, petScoreByRarity[pet.tier ?? ""] ?? 0));
  }

  for (const pet of pets ?? []) {
    const score = petScoreByRarity[pet.rarity] ?? 0;
    if (score <= 0) continue;
    const key = petKey(pet.name);
    const owned = ownedPetScore.get(key) ?? 0;
    const id = `pet_${key}_${pet.rarity}`;

    tasks.push({
      id,
      category: "pets",
      name: `${titleCase(pet.name)} (${pet.rarity.toLowerCase()})`,
      xp: Math.max(score - owned, 0) * 3,
      exclusiveGroup: `pet:${key}`,
      groupLevel: score * 3,
      groupBase: owned * 3,
      requires: [],
      cost: { kind: "auction", itemId: key, tier: pet.rarity },
      repeatable: false,
      note: `${score} pet score`,
    });
    if (owned >= score) done.add(id);
  }

  /* --------------------------------------------- perk trees: HOTM and HOTF */

  // Heart of the Mountain, its Peak extension, and the two forest equivalents are all the same
  // shape: numbered tiers worth escalating XP. The tier a player has reached is a node level in
  // skill_tree, which is where the game moved this data — mining_core no longer carries it.
  const treeNode = (category: string, node: string): number => {
    const value = member.skill_tree?.nodes?.[category]?.[node];
    return typeof value === "number" ? value : 0;
  };

  // Only the two tracks whose tier the API actually reports. Peak of the Mountain and Heart of
  // the Forest have published XP tables, but a full deep search of a maxed profile turns up no
  // field carrying their tier under any name — so modelling them would mean every player reads
  // zero, inflating their remaining XP by ~1,545 and polluting the grind ordering with work
  // they may have already finished. They're declared in UNMODELLED instead.
  const perkTracks: { id: string; label: string; category: Category; tiers: number[]; current: number }[] = [
    {
      id: "hotm",
      label: "Heart of the Mountain",
      category: "misc",
      tiers: data.curves.progressTracks.heartOfTheMountain,
      current: treeNode("mining", "core_of_the_mountain"),
    },
    {
      id: "center_of_the_forest",
      label: "Center of the Forest",
      category: "misc",
      tiers: data.curves.progressTracks.centerOfTheForest,
      current: treeNode("foraging", "center_of_the_forest"),
    },
  ];

  for (const track of perkTracks) {
    let previous: string | null = null;
    track.tiers.forEach((xp, index) => {
      const tier = index + 1;
      const id = `${track.id}_${tier}`;
      tasks.push({
        id,
        category: track.category,
        name: `${track.label} ${tier}`,
        xp,
        requires: previous ? [previous] : [],
        cost: { kind: "none" },
        repeatable: false,
      });
      if (track.current >= tier) done.add(id);
      previous = id;
    });
  }

  /* ------------------------------------------------------ attribute shards */


  // Every attribute levels on the same shard thresholds, and every level is worth +1 XP.
  //
  // The universe comes from the wiki rather than from the player's own stacks: the profile only
  // lists attributes they already hold shards in, so deriving it from there would cap each
  // player's ceiling at whatever they happened to have touched.
  //
  // These are priced, not grind. Each attribute is fed by a named shard that trades on the
  // bazaar — under the mob's name, not the attribute's ("Snow Elemental" is fed by
  // SHARD_BLIZZARD — so a level costs the shards it adds times their live price. That's the
  // direct-purchase path; fusing shards you already own is cheaper and isn't modelled, so this
  // is an upper bound on what the level costs.
  const heldShards = attributeStacks(member.attributes?.stacks, data);
  const strandedAttributes = unplacedAttributes(member.attributes?.stacks, data.attributeShards.attributes, data);

  for (const attribute of data.attributeShards.attributes) {
    const held = heldShards(attribute.key);
    // Rarer attributes level on far fewer shards — a legendary maxes at 24 where a common needs
    // 96 — so the ladder has to be picked per attribute. Using the common one throughout made
    // every maxed legendary read as level 5 of 10 and put five levels that don't exist up for
    // sale. Falls back to common only if an attribute arrives with a rarity we don't have.
    const shardThresholds = cumulativeShards(data, attribute.rarity);
    let previous: string | null = null;

    shardThresholds.forEach((needed, index) => {
      const level = index + 1;
      const id = `attribute_${attribute.key}_${level}`;
      // Only the shards this level adds on top of the last one.
      const increment = needed - (shardThresholds[index - 1] ?? 0);

      tasks.push({
        id,
        category: "attributes",
        name: `${attribute.name} ${level}`,
        xp: 1,
        requires: previous ? [previous] : [],
        cost: attribute.tradeable
          ? { kind: "bazaar", items: [{ id: attribute.shardId, qty: increment }] }
          : { kind: "unknown", note: `${attribute.shardName} doesn't trade on the bazaar` },
        repeatable: false,
        note: `${increment}× ${attribute.shardName}`,
      });
      if (held >= needed) done.add(id);
      previous = id;
    });
  }

  /* --------------------------------------------------------------- garden */

  // Only the garden tracks whose completion the API states outright. Garden level, visitor and
  // crop-milestone counts need threshold tables the wiki doesn't publish in a parseable form,
  // so they stay out rather than being estimated — see UNMODELLED.
  if (garden) {
    const PLOT_XP = 5;
    const TOTAL_PLOTS = 24;
    let previousPlot: string | null = null;
    for (let plot = 1; plot <= TOTAL_PLOTS; plot++) {
      const id = `garden_plot_${plot}`;
      tasks.push({
        id,
        category: "misc",
        name: `Garden plot ${plot}`,
        xp: PLOT_XP,
        requires: previousPlot ? [previousPlot] : [],
        cost: { kind: "none" },
        repeatable: false,
      });
      if (garden.unlockedPlots >= plot) done.add(id);
      previousPlot = id;
    }

    // 13 crops, 9 upgrade levels each, 1 XP apiece — 117 XP, matching the wiki total.
    for (const [crop, level] of Object.entries(garden.cropUpgrades)) {
      let previousUpgrade: string | null = null;
      for (let tier = 1; tier <= 9; tier++) {
        const id = `garden_crop_${crop}_${tier}`;
        tasks.push({
          id,
          category: "misc",
          name: `${titleCase(crop.replace(/[:_]/g, " "))} upgrade ${tier}`,
          xp: 1,
          requires: previousUpgrade ? [previousUpgrade] : [],
          cost: { kind: "none" },
          repeatable: false,
        });
        if (level >= tier) done.add(id);
        previousUpgrade = id;
      }
    }

    // Composter tiers pay 1/2/3/4 XP in bands of 6-7 — five upgrades of 25 tiers is 305 XP,
    // exactly the wiki's stated maximum.
    const composterXp = (tier: number) => (tier <= 7 ? 1 : tier <= 13 ? 2 : tier <= 19 ? 3 : 4);
    for (const upgrade of ["speed", "multi_drop", "fuel_cap", "organic_matter_cap", "cost_reduction"]) {
      const level = garden.composterUpgrades[upgrade] ?? 0;
      let previousTier: string | null = null;
      for (let tier = 1; tier <= 25; tier++) {
        const id = `garden_composter_${upgrade}_${tier}`;
        tasks.push({
          id,
          category: "misc",
          name: `Composter ${upgrade.replace(/_/g, " ")} ${tier}`,
          xp: composterXp(tier),
          requires: previousTier ? [previousTier] : [],
          cost: { kind: "none" },
          repeatable: false,
        });
        if (level >= tier) done.add(id);
        previousTier = id;
      }
    }
  }

  // Recombobulating an accessory raises its rarity by one, which is magical power without
  // buying anything new. It competes with buying a better family member rather than stacking
  // with it — both set the family's power — so it shares the family's exclusive group and is
  // priced at whatever a Recombobulator 3000 costs on the bazaar.
  //
  // Only the member actually holding the family is worth recombobulating, and only once: the
  // game allows a single rarity upgrade per item, which `rarityUpgrades` already records.
  for (const [family, best] of bagState.familyBest) {
    if (best.recombobulated) continue;
    const bumped = bumpRarity(data, best.rarity, 1);
    if (bumped === best.rarity) continue; // already at the top of the ladder
    const power = magicalPowerOf(data, bumped);
    const alreadyHave = bagState.familyPower.get(family) ?? 0;
    if (power <= alreadyHave) continue;

    const meta = accessoryById.get(best.id);
    tasks.push({
      id: `recombobulate_${best.id}`,
      category: "accessory_bag",
      name: `Recombobulate ${meta?.name ?? best.id}`,
      xp: power - alreadyHave,
      exclusiveGroup: `accessory:${family}`,
      groupLevel: power,
      groupBase: alreadyHave,
      requires: [],
      cost: { kind: "bazaar", items: [{ id: "RECOMBOBULATOR_3000", qty: 1 }] },
      repeatable: false,
      note: `${best.rarity.toLowerCase()} → ${bumped.toLowerCase()} · ${power - alreadyHave} MP`,
    });
  }

  /* ------------------------------------------------- accessory bag slots */

  // Jacobus sells 99 upgrades, each +2 slots and +2 XP, at a rising price. They're worth
  // buying for the XP alone, and they're what makes room for more accessories.
  {
    let previousUpgrade: string | null = null;
    for (let upgrade = 1; upgrade <= data.bagUpgrades.maxUpgrades; upgrade++) {
      const id = `bag_upgrade_${upgrade}`;
      const coins = bagUpgradeCost(data, upgrade);
      tasks.push({
        id,
        category: "accessory_bag",
        name: `Accessory bag upgrade ${upgrade}`,
        xp: data.bagUpgrades.xpPerUpgrade,
        requires: previousUpgrade ? [previousUpgrade] : [],
        cost: coins === null ? { kind: "unknown", note: "No published price" } : { kind: "npc", coins },
        repeatable: false,
        note: `+${data.bagUpgrades.slotsPerUpgrade} slots`,
      });
      if (upgradesPurchased >= upgrade) done.add(id);
      previousUpgrade = id;
    }
  }

  /* --------------------------------------------------------- fairy souls */

  // +10 XP per 5 souls, 570 XP total (README table; the API reports the count but not the reward).
  const collected = member.fairy_soul?.total_collected ?? 0;
  const FAIRY_CHUNKS = 57;
  let previousSoul: string | null = null;
  for (let chunk = 1; chunk <= FAIRY_CHUNKS; chunk++) {
    const souls = chunk * 5;
    const id = `fairy_souls_${souls}`;
    tasks.push({
      id,
      category: "fairy_souls",
      name: `${souls} fairy souls`,
      xp: 10,
      requires: previousSoul ? [previousSoul] : [],
      cost: { kind: "none" },
      repeatable: false,
    });
    if (collected >= souls) done.add(id);
    previousSoul = id;
  }

  // Grind tasks have no price to rank on, so they carry an observed effort score instead.
  for (const task of tasks) {
    if (task.cost.kind !== "none") continue;
    const { effort, band } = effortOf(data, task.id);
    task.effort = effort;
    task.effortBand = band;
  }

  return {
    tasks,
    done,
    bag: bagState,
    currentXp: member.leveling?.experience ?? 0,
    // Pet score is unmodelled as *tasks*, but the profile still tells us exactly how much XP
    // it has already paid out — worth showing rather than discarding.
    unmodelled: UNMODELLED.map((u) =>
      u.category === "attributes" && strandedAttributes > 0
        ? {
            ...u,
            note: `${u.note} This profile also has shards in ${strandedAttributes} attributes that aren't on the wiki list this app is built from — their progress isn't credited and their levels aren't offered.`,
          }
        : { ...u },
    ),
    meta: {
      fairySouls: { collected },
      skills: skillLevels,
    },
  };
}

/**
 * What a discrete task costs. Bank upgrades are a flat coin price from the wiki; an essence perk
 * costs its essence amount at whatever the bazaar charges today; a fast-travel unlock costs the
 * scroll that opens it, where one exists. The rest are actions rather than purchases — including
 * the fourteen fast-travel spots you unlock by walking there, which are free but not buyable.
 */
function discreteCost(id: string, data: GameData, scrollFor: Map<string, { itemId: string }>): Task["cost"] {
  const bank = data.costs.bank[id];
  if (bank !== undefined) return { kind: "npc", coins: bank };

  const essence = /^([A-Z]+)_ESSENCE_(.+)_(\d+)$/.exec(id);
  if (essence) {
    const perk = data.costs.essence[`${essence[1]}|${essence[2]}`];
    const amount = perk?.tiers[essence[3]];
    if (perk && amount) return { kind: "bazaar", items: [{ id: perk.essence, qty: amount }] };
    return { kind: "unknown", note: "Perk name not matched to a wiki cost table" };
  }

  const scroll = scrollFor.get(id);
  if (scroll) return { kind: "auction", itemId: scroll.itemId };

  return { kind: "none" };
}

const titleCase = (value: string) =>
  value
    .toLowerCase()
    .split(/[\s_]+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");

/**
 * How many shards the player holds for one of our attributes.
 *
 * The profile publishes progress under `attributes.stacks`, keyed by the game's own attribute
 * ids, while our list comes from the wiki keyed by display name. Those two vocabularies disagree
 * in four ways, and a key we fail to place reads as zero — so the app offers every level of an
 * attribute the player has already maxed.
 *
 * Three of the four are mechanical, and comparing keys as an order-independent set of singular,
 * stopword-free words handles all of them at once: possessives ("Hunter's Karma" slugs to
 * hunter_s_karma, the API says hunter_karma), word order (essence_of_ice against ice_essence)
 * and plurals (essence_of_dragons against dragon_essence). It is strict — never a partial
 * overlap — which is what keeps crop_speed away from attack_speed.
 *
 * The fourth isn't mechanical and needs naming: the API sometimes drops the family noun
 * ("Undead Ruler" is just `undead`, though `skeletal_ruler` keeps it) and it calls one family
 * by a different word entirely (arthropod is arachno). Those live in attribute_api_keys.json.
 *
 * Candidates are tried most-specific first, so an attribute that matches outright never gets
 * taken by a looser rule meant for a different one.
 */
function attributeStacks(stacks: Record<string, number> | undefined, data: GameData): (key: string) => number {
  const held = stacks ?? {};
  const byShape = new Map<string, number>();
  for (const [key, amount] of Object.entries(held)) {
    const shape = attributeShape(key);
    byShape.set(shape, Math.max(byShape.get(shape) ?? 0, amount));
  }

  return (key) => {
    for (const candidate of attributeCandidates(key, data)) {
      const direct = held[candidate];
      if (direct !== undefined) return direct;
      const shaped = byShape.get(attributeShape(candidate));
      if (shaped !== undefined) return shaped;
    }
    return 0;
  };
}

/** The forms one of our attribute keys might appear under in the profile, best guess first. */
function attributeCandidates(key: string, data: GameData): string[] {
  const { wordAliases, droppableSuffixes } = data.attributeApiKeys;

  const aliased = key
    .split("_")
    .map((word) => wordAliases[word] ?? word)
    .join("_");

  const forms = [key, aliased];
  // Dropping the family noun is a *fallback*: skeletal_ruler keeps it and matches outright, so
  // trying the full key first stops the stem rule stealing an attribute that was never ambiguous.
  for (const base of [key, aliased]) {
    for (const suffix of droppableSuffixes) {
      if (base.endsWith(`_${suffix}`)) forms.push(base.slice(0, -suffix.length - 1));
    }
  }
  return [...new Set(forms)];
}

const ATTRIBUTE_STOPWORDS = new Set(["of", "the", "a", "s"]);

/** "essence_of_dragons" and "dragon_essence" both reduce to "dragon_essence". */
function attributeShape(key: string): string {
  return key
    .split("_")
    .filter((word) => word && !ATTRIBUTE_STOPWORDS.has(word))
    .map((word) => (word.endsWith("s") && word.length > 3 ? word.slice(0, -1) : word))
    .sort()
    .join("_");
}

/**
 * Attributes the profile has progress in that our list doesn't contain at all.
 *
 * Worth counting rather than ignoring: the wiki page this app's attribute list comes from is a
 * snapshot, and the game keeps adding families. A silent gap reads as "you have nothing there";
 * a counted one reads as "this app doesn't know about these yet", which is the true statement.
 */
function unplacedAttributes(
  stacks: Record<string, number> | undefined,
  attributes: { key: string }[],
  data: GameData,
): number {
  if (!stacks) return 0;
  const known = new Set<string>();
  for (const attribute of attributes) {
    for (const form of attributeCandidates(attribute.key, data)) known.add(attributeShape(form));
  }
  return Object.entries(stacks).filter(([key, amount]) => amount > 0 && !known.has(attributeShape(key))).length;
}

/** Cumulative shards needed for levels 1-10 of an attribute of the given rarity. */
function cumulativeShards(data: GameData, rarity: string): number[] {
  const perLevel = data.attributeLevels.perLevel[rarity] ?? data.attributeLevels.perLevel.COMMON;
  let running = 0;
  return perLevel.map((step: number) => (running += step));
}

/** One member's own collection totals, for a profile with no co-op to sum across. */
function collectedFrom(member: ProfileMember): Map<string, number> {
  const out = new Map<string, number>();
  for (const [item, amount] of Object.entries(member.collection ?? {})) {
    if (typeof amount === "number") out.set(item, amount);
  }
  return out;
}
