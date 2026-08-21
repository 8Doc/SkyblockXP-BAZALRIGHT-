import type { Category, Task } from "./types";
import type { GardenState, MuseumState, ProfileMember } from "./profile";
import { petKey } from "./auctions";
import { num } from "./format";
import {
  abicaseBonusFor,
  accessoryPower,
  bagUpgradeCost,
  bestiaryFamilyOf,
  bestiaryTierOf,
  bumpRarity,
  effortOf,
  familyOf,
  grantsMagicalPower,
  magicalPowerOf,
  scoreBag,
  type BagItem,
  type BagState,
  type GameData,
  type NpcEntry,
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
  /**
   * XP the profile has plainly earned that no task can be credited with.
   *
   * Magical power and pet score pay out continuously rather than per purchase: an accessory you
   * already own is worth nothing *more*, so its task carries zero XP and contributes nothing to
   * any tally of what you have done. The profile states both totals outright, and leaving them
   * out understated coverage by thousands — it read as missing sources when the sources were
   * modelled and merely uncounted.
   */
  earnedOutsideTasks: { magicalPower: number; petScore: number; bestiary: number };
  /**
   * What the profile says you have against what this app could credit you for.
   *
   * Every gap chased in these three categories has been a matching failure rather than a missing
   * feature: a museum donation filed under a starred id, an attribute keyed by a name the wiki
   * doesn't use, an accessory the items resource never listed. Each looked like "the numbers are
   * wrong" and took a profile dump to pin down. Counting both sides makes the discrepancy a
   * figure on the category instead.
   */
  reconciliation: { category: Category; credited: number; reported: number }[];
  /** Category-level notes for anything we can't model as tasks yet. */
  unmodelled: { category: Category; note: string; earnedXp?: number; totalXp?: number }[];
  meta: {
    fairySouls: { collected: number };
    skills: Record<string, number>;
  };
};

export const UNMODELLED: { category: Category; note: string; totalXp?: number }[] = [
  {
    category: "pets",
    note: "Pet score already earned is exact — the profile reports it outright. The catalogue is now fixed at 85 pets rather than read off the auction house, so a pet nobody is selling is a row with no price instead of a row that does not exist. What is still missing is the +1 a pet awards for reaching its maximum level: 85 points across the catalogue, which would need the pet level curve to know whether you have it.",
  },
  {
    category: "bestiary",
    note: "Bestiary tiers are offered where the next one is under 5,000 kills away; past that a tier is a week of one mob and there is no honest way to rank it against a purchase. Two further gaps are the wiki's rather than the API's: King Minos and Manticore are listed with no tier cap, and Galatea's mobs have no family entries at all yet, so the ceiling below is a floor.",
  },
  {
    category: "misc",
    note: "Garden is partly covered: plots, crop upgrades and the composter are modelled. The profile has the raw progress for the rest — garden_experience, resources_collected per crop, the visitor ledger and greenhouse slot count all come off the garden endpoint — but turning those into XP needs the level curve and the per-crop milestone thresholds, and the wiki carries neither in a parseable form. Garden level (~140 XP), visitor and offer milestones (~135), crop milestones (~598), greenhouse (~100) and DNA analysis (~90) wait on those tables rather than on the API.",
    totalXp: 1063,
  },
  {
    category: "misc",
    note: "Heart of the Mountain (1,175 XP) and Center of the Forest (250) are modelled — the profile reports both tiers under skill_tree.nodes. Peak of the Mountain (~1,000) and Heart of the Forest (~545) are not: their XP tables are known, but no node in that tree matches either track, and guessing at one would credit or deny progress on the strength of a name.",
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
  /** Item ids the player is already holding, or null when the profile publishes no inventory. */
  owned: Set<string> | null = null,
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

  // A contact's XP and a contact's magical power are earned on different terms, so they are
  // counted off different fields and the difference is not a discrepancy.
  //
  // The XP is paid once, when the contact is first saved, and keeps paying after the contact is
  // deleted — so it is credited from `completed_tasks` with the rest of the discrete tasks, and
  // is permanent. The magical power is not: the Abicase reads the phone as it stands, so a
  // contact removed is magical power lost.
  //
  // That is why `active_contacts` is the count here rather than the larger `contact_data`. One
  // profile has XP for 45 contacts and data for 51, but only 12 in the phone, and its magical
  // power reconciles exactly on the 12. The other two fields are fallbacks for profiles that
  // carry no `active_contacts` at all.
  const abiphone = member.nether_island_player_data?.abiphone;
  const abiphoneContacts =
    abiphone?.active_contacts?.length ??
    Math.max(
      Object.keys(abiphone?.contact_data ?? {}).length,
      (member.leveling?.completed_tasks ?? []).filter((id) => id.startsWith("ABIPHONE_")).length,
    );
  const riftPrismConsumed = member.rift?.access?.consumed_prism === true;
  const bagState = scoreBag(
    data,
    bag.items,
    member.accessory_bag_storage?.highest_magical_power ?? null,
    bag.capacity,
    { abiphoneContacts, riftPrismConsumed },
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
  // A full bag makes a *new* accessory cost the slot it sits in as well — but as a prerequisite
  // rather than a markup. The upgrade is a real task at a real price, so requiring it prices the
  // pair honestly and only once, where smearing a share of it across every accessory added
  // several million to each and buried the rows that were genuinely cheap. Upgrading a family
  // already in the bag is the common case and needs no slot: the artifact goes where the ring was.
  const slotNeeded = freeSlots <= 0 && nextUpgradeCost !== null;
  const slotTaskId = `bag_upgrade_${nextUpgrade}`;

  // Doug sells seven of these for Carnival Tokens, which is minigame play rather than coins.
  // The rows are priced from the auction house like everything else — a Bee Mask really is nine
  // million there — but the token price is worth saying, because it is the cheap way to the
  // same XP whenever Foxy is mayor.
  const carnivalPrice = new Map(
    (data.carnivalShop?.items ?? []).map((item) => [
      item.id,
      `${item.tokens.toLocaleString()} ${data.carnivalShop!.currency} from ${data.carnivalShop!.npc}`,
    ]),
  );

  const excluded = new Set(data.magicalPower.excludedItems.ids);
  const accessoryById = new Map(data.accessories.accessories.map((a) => [a.id, a]));

  /**
   * The best accessory each family has, and what it is worth once recombobulated.
   *
   * A player holding a lesser member of a family still has two steps ahead of them — buy the
   * better one, then recombobulate that — and the pair was invisible. Buying the better one
   * alone often gains nothing, because a recombobulated Bat Person Ring is worth exactly as much
   * as a fresh Bat Person Artifact, so the purchase was marked done and hidden; and the
   * recombobulator row only ever covered what was already in the bag, which was the Ring, and
   * the Ring had already had one. On one profile that hid 73 magical power across seventeen
   * families.
   */
  const familyTop = new Map<string, { id: string; base: number; top: number }>();
  for (const acc of data.accessories.accessories) {
    if (excluded.has(acc.id) || !grantsMagicalPower(acc) || !acc.obtainable) continue;
    const base = accessoryPower(data, acc.id, acc.tier);
    if (base <= 0) continue;
    const top =
      acc.recombobulatable === false ? base : Math.max(base, accessoryPower(data, acc.id, bumpRarity(data, acc.tier, 1)));
    const family = familyOf(data, acc.name, acc.id);
    const held = familyTop.get(family);
    if (!held || top > held.top || (top === held.top && base > held.base)) familyTop.set(family, { id: acc.id, base, top });
  }

  for (const acc of data.accessories.accessories) {
    if (excluded.has(acc.id)) continue;
    // A rift-bound accessory never reaches the bag, so its magical power is not on offer.
    if (!grantsMagicalPower(acc)) continue;
    // Neither is a staff curio or something the game has withdrawn. A player who owns one is
    // still credited for it by scoreBag — this only stops it being listed as XP left to get.
    if (!acc.obtainable) continue;
    const power = accessoryPower(data, acc.id, acc.tier);
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
      // A full bag makes a new accessory cost the slot it sits in as well, and that is a
      // prerequisite rather than a markup: the upgrade is a real task with a real price, and
      // smearing a share of it across every row hid which rows were actually cheap. Upgrading a
      // family already in the bag needs no new slot — the artifact goes where the ring was.
      requires: slotNeeded && alreadyHave <= 0 ? [slotTaskId] : [],
      cost: acc.tradeable
        ? {
            kind: "auction",
            itemId: acc.id,
            // The member this replaces comes off and goes back on the auction house, so the
            // upgrade costs the difference rather than the sticker price.
            sells: bagState.familyBest.get(family)?.id,
          }
        : {
            // A grind rather than an unknown: these have no price because nobody may sell them,
            // not because we failed to find one. That is the difference between "go and get it"
            // and "we cannot say", and only the first belongs in the grind order.
            kind: "grind",
            note: acc.soulbound ? "Soulbound — cannot be bought" : "Not tradeable",
          },
      repeatable: false,
      note: `${acc.tier.toLowerCase()} · ${power} MP${alreadyHave > 0 ? ` (family already gives ${alreadyHave})` : ""}${
        slotNeeded && alreadyHave <= 0 ? " · bag is full, needs a slot" : ""
      }${carnivalPrice.has(acc.id) ? ` · or ${carnivalPrice.get(acc.id)}` : ""}`,
    });

    // An accessory worth nothing on its own is still worth buying when a Recombobulator on top
    // of it beats what the family has. Marking it done then would hide the purchase and, worse,
    // let the Recombobulator row below treat it as already paid for.
    const top = familyTop.get(family);
    const stepAfterIt = top?.id === acc.id && top.top > alreadyHave;
    if (bagState.owned.has(acc.id) || (gain <= 0 && !stepAfterIt)) done.add(id);
  }

  /* ------------------------------------------------------ discrete tasks */

  // Everything Hypixel tracks by id: essence perks, abiphone contacts, fast travel unlocks,
  // bank upgrades, dojo belts, slayer tiers, event perks, harp songs. The id list was harvested
  // from live profiles and the XP comes from wiki-derived rules — see scripts/build-task-table.
  const completed = new Set(member.leveling?.completed_tasks ?? []);
  const scrollFor = new Map(data.travelScrolls.scrolls.map((s) => [s.taskId, s]));

  // Tiered ladders — essence perks above all — need the rung below them. Without it the list
  // offers "eager miner 6" priced as a single purchase when reaching it means buying 1 through 6,
  // which is why the ungrouped view disagreed with the grouped one about where you stand.
  const discreteIds = new Set(data.tasks.tasks.map((t) => t.id));
  const rungBelow = (id: string): string[] => {
    if (id.startsWith("OBJECTIVE_")) return []; // story steps, not a purchase ladder
    const match = /^(.*)_(\d+)$/.exec(id);
    if (!match) return [];
    const previous = `${match[1]}_${Number(match[2]) - 1}`;
    return discreteIds.has(previous) ? [previous] : [];
  };

  for (const task of data.tasks.tasks) {
    tasks.push({
      id: task.id,
      category: discreteCategory(task.id, task.category as Category),
      name: objectiveName(task.id, data),
      xp: task.xp,
      requires: rungBelow(task.id),
      cost: discreteCost(task.id, data, scrollFor),
      repeatable: false,
      note: abiphoneNote(task.id, data) ?? directionsTo(task.id, data) ?? task.rule,
      where: contactLocation(task.id, data),
    });
    if (completed.has(task.id)) done.add(task.id);
  }

  /* --------------------------------------------------------------- museum */

  // donation_xp is published per item in the items resource, and the museum endpoint says what
  // has already been donated — so this category is exact on both halves.
  const donated = museum?.donatedItemIds ?? null;
  // An entry counts as accounted for only if it actually completes a slot. Merely being a
  // recognised id isn't enough: three pieces of a four-piece set are three real donations that
  // finish nothing, and the museum's own counter still credits them — so they belong in the
  // gap, not hidden by it.
  const filledBy = new Set<string>();
  for (const donation of data.museum.donations) {
    for (const id of [donation.itemId, ...(donation.mappedIds ?? [])]) filledBy.add(id);
    // Anything up the line fills this slot too, so those ids are accounted for as well.
    let up: string | null | undefined = donation.parentId;
    for (let hop = 0; up && hop < 12; hop++) {
      filledBy.add(up);
      up = data.museum.donations.find((d) => d.itemId === up)?.parentId ?? null;
    }
  }
  for (const set of data.museum.armorSets) filledBy.add(set.setId);
  // Special-section donations fill none of the 636 numbered slots, so they can only ever widen
  // the gap — but the game counts them, and leaving them out made our total read short by
  // exactly their number against the in-game one.
  const specials = museum?.specialItemIds ?? new Set<string>();
  const strandedDonations = donated
    ? [...donated].filter((held) => !filledBy.has(held)).length + specials.size
    : specials.size;
  const donatedCount = (donated ? donated.size : 0) + specials.size;
  // A slot is filled by its own item, by an alternate id the same item is filed under, or by
  // anything further up its upgrade line: donate a Wand of Atonement and the Healing, Mending
  // and Restoration slots below it are filled too. Walking that chain is the difference between
  // 275 and 311 slots on a profile the game scores at 313.
  const parentOf = new Map(data.museum.donations.map((d) => [d.itemId, d.parentId ?? null]));
  const altsOf = new Map(data.museum.donations.map((d) => [d.itemId, d.mappedIds ?? []]));
  const slotFilled = (itemId: string): boolean => {
    let current: string | null | undefined = itemId;
    // The chains are short; the guard is against bad data, not depth.
    for (let hop = 0; current && hop < 12; hop++) {
      if (donated!.has(current)) return true;
      for (const alt of altsOf.get(current) ?? []) if (donated!.has(alt)) return true;
      current = parentOf.get(current);
    }
    return false;
  };
  // Anything already in hand is a walk to the museum, not a purchase. Pricing it at what one
  // costs on the auction house buries the free donations under the bought ones, when they are
  // the cheapest experience on the profile by a distance.
  const inHand = (itemId: string): boolean => owned?.has(itemId) ?? false;

  for (const donation of data.museum.donations) {
    const id = `museum_${donation.itemId}`;
    const held = inHand(donation.itemId) || (donation.mappedIds ?? []).some(inHand);
    tasks.push({
      id,
      category: "museum",
      name: donation.name,
      xp: donation.xp,
      requires: [],
      cost: held
        ? { kind: "owned", note: "already in your inventory" }
        : donation.tradeable
          ? { kind: "auction", itemId: donation.itemId }
          : { kind: "unknown", note: "Not tradeable" },
      repeatable: false,
      note: `${donation.category.toLowerCase()} · ${held ? "already in your inventory" : "donation is permanent"}${
        !held && carnivalPrice.has(donation.itemId) ? ` · or ${carnivalPrice.get(donation.itemId)}` : ""
      }`,
    });
    if (donated && slotFilled(donation.itemId)) done.add(id);
  }
  for (const set of data.museum.armorSets) {
    const id = `museum_set_${set.setId}`;
    tasks.push({
      id,
      category: "museum",
      name: `${set.name} (set)`,
      xp: set.xp,
      requires: [],
      cost: set.pieces.every((piece) => inHand(piece))
        ? { kind: "owned", note: "every piece already in your inventory" }
        : { kind: "unknown", note: "Whole armour set" },
      repeatable: false,
      note: `${set.category.toLowerCase()} · ${set.pieces.length} pieces${
        set.pieces.every((piece) => inHand(piece)) ? ", all already in your inventory" : ""
      }`,
    });
    // A set's slot is filled by its own id, by holding every piece, or by anything further up
    // its upgrade line — donate the Backwater set and the Angler slot below it is filled too.
    let setChain: string | null | undefined = set.setId;
    let setDone = false;
    for (let hop = 0; setChain && hop < 12; hop++) {
      if (donated?.has(setChain)) {
        setDone = true;
        break;
      }
      setChain = data.museum.armorSets.find((s) => s.setId === setChain)?.parentId ?? null;
    }
    if (donated && (setDone || set.pieces.every((piece) => slotFilled(piece)))) done.add(id);
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
  // the pets themselves, priced from the auction house, worth three XP per point of score.
  //
  // The catalogue is fixed, not read off the auction house. Taking it from live listings meant a
  // pet nobody happened to be selling did not exist: a full sweep saw 97 pets worth 495 score
  // against a real maximum of 521, so the ceiling drifted with the market. Listings now do only
  // what they are good for, which is prices — an unlisted pet is a task with no price, not a
  // task that vanished.
  //
  // The catalogue is keyed by the wiki's page titles and the profile by the game's own ids, and
  // for two pets those are different words entirely. A T-Rex is a TYRANNOSAURUS on the profile,
  // and the Wisp — the one pet that renames as it climbs, which its own wiki page says outright
  // — is a DROPLET, FROST, GLACIAL or SUBZERO_WISP depending on rarity, so it has four ids and
  // no single name can match it. Both were being offered to players who owned them.
  const petScoreByRarity = data.petScore.byRarity;
  const petAliases = data.petApiKeys?.aliases ?? {};
  const ownedPetScore = new Map<string, number>();
  for (const pet of member.pets_data?.pets ?? []) {
    if (!pet?.type) continue;
    const key = petKey(petAliases[pet.type] ?? pet.type);
    ownedPetScore.set(key, Math.max(ownedPetScore.get(key) ?? 0, petScoreByRarity[pet.tier ?? ""] ?? 0));
  }

  for (const pet of data.pets.pets) {
    // A pet the auction house never carries cannot be bought, and this is a shopping list. The
    // Rift's are the case that matters: rift-bound pets were being offered to players who had
    // every purchasable one.
    if (pet.buyable === false) continue;
    const key = petKey(pet.name);
    const owned = ownedPetScore.get(key) ?? 0;

    for (const rarity of pet.rarities) {
      const score = petScoreByRarity[rarity] ?? 0;
      if (score <= 0) continue;
      const id = `pet_${key}_${rarity}`;

      tasks.push({
        id,
        category: "pets",
        name: `${titleCase(pet.name)} (${rarity.toLowerCase()})`,
        xp: Math.max(score - owned, 0) * 3,
        exclusiveGroup: `pet:${key}`,
        groupLevel: score * 3,
        groupBase: owned * 3,
        requires: [],
        cost: { kind: "auction", itemId: key, tier: rarity },
        repeatable: false,
        note: `${score} pet score`,
      });
      if (owned >= score) done.add(id);
    }
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
  const attributeCount = Object.values(member.attributes?.stacks ?? {}).filter((n) => n > 0).length;

  // An attribute whose key we cannot find in the profile has unknown progress, not zero. The
  // two vocabularies disagree on about twenty names — the wiki writes Arthropod Ruler where the
  // game writes arachno — and offering all ten levels of those told a player with every
  // attribute maxed that 171 levels were outstanding. Unknown is not the same as undone, so
  // they are held back and counted in the reconciliation instead.
  //
  // Only when the profile actually reports attributes: a fresh profile legitimately has none,
  // and there the whole category really is ahead of you.
  const reportsAttributes = Object.keys(member.attributes?.stacks ?? {}).length > 0;

  for (const attribute of data.attributeShards.attributes) {
    if (reportsAttributes && !heldShards.placed(attribute.key)) continue;
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
    // Nine accessories refuse a Recombobulator outright, and the resource says which. Offering
    // one anyway is an impossible task priced at a real Recombobulator: on a maxed profile every
    // recombobulate row the app produced was one of these — all four of them, the Voter's Badge
    // among them.
    if (accessoryById.get(best.id)?.recombobulatable === false) continue;
    const bumped = bumpRarity(data, best.rarity, 1);
    if (bumped === best.rarity) continue; // already at the top of the ladder
    const power = accessoryPower(data, best.id, bumped);
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

  // The same step, for a family the player does not hold anything in yet.
  //
  // Buying the accessory is only half the magical power that family is worth, because a maxed
  // bag is recombobulated throughout — one profile had done it to 124 of the 128 families it
  // held, and the four it hadn't were the four that refuse a Recombobulator. Offering the step
  // only on what is already owned quoted the rest of the bag at base rarities, so the category's
  // remaining XP read far below what is actually left to get.
  //
  // The accessory is a prerequisite rather than a separate row, so the bundle is priced at the
  // accessory plus the Recombobulator, which is what the pair really costs.
  for (const [family, top] of familyTop) {
    // What is already in the bag is the loop above's business — including the case where it has
    // had its Recombobulator and there is nothing left to do to it.
    if (bagState.owned.has(top.id)) continue;
    const acc = accessoryById.get(top.id);
    if (!acc || acc.recombobulatable === false) continue;
    const bumped = bumpRarity(data, acc.tier, 1);
    const power = accessoryPower(data, acc.id, bumped);
    // A step that gains nothing is no step: the top of the ladder wraps onto the odd rarities,
    // which are worth less than the mythic they would be replacing.
    if (power <= top.base) continue;
    const alreadyHave = bagState.familyPower.get(family) ?? 0;
    if (power <= alreadyHave) continue;

    tasks.push({
      id: `recombobulate_${acc.id}`,
      category: "accessory_bag",
      name: `Recombobulate ${acc.name}`,
      xp: power - alreadyHave,
      exclusiveGroup: `accessory:${family}`,
      groupLevel: power,
      groupBase: alreadyHave,
      requires: [`accessory_${acc.id}`],
      cost: { kind: "bazaar", items: [{ id: "RECOMBOBULATOR_3000", qty: 1 }] },
      repeatable: false,
      note: `${acc.tier.toLowerCase()} → ${bumped.toLowerCase()} · buy the accessory first`,
    });
  }

  // What no purchase can reach.
  //
  // Six accessories climb past their bought rarity through a mechanic of their own — a Pandora's
  // Box won at Shen's Auction, a Pulse Ring fed Thunder in a Bottle — and imbuing a Rift Prism
  // pays eleven for good. None of it can be priced, so all of it was simply absent, and the
  // category's total came up short by exactly that much on every profile short of the maximum.
  // Grind rows keep them in the browser and out of the coin plans, which is where they belong.
  for (const climb of data.magicalPower.climbing.items) {
    const meta = accessoryById.get(climb.id);
    if (!meta) continue;
    const family = familyOf(data, meta.name, meta.id);
    const power = accessoryPower(data, meta.id, climb.reaches);
    const alreadyHave = bagState.familyPower.get(family) ?? 0;
    if (power <= alreadyHave) continue;

    tasks.push({
      id: `climb_${meta.id}`,
      category: "accessory_bag",
      name: `${meta.name} to ${climb.reaches.toLowerCase().replace("_", " ")}`,
      xp: power - alreadyHave,
      exclusiveGroup: `accessory:${family}`,
      groupLevel: power,
      groupBase: alreadyHave,
      requires: [],
      cost: { kind: "none" },
      repeatable: false,
      note: `${power} MP · ${climb.by}`,
    });
  }

  if (!riftPrismConsumed) {
    const prism = accessoryById.get("RIFT_PRISM");
    const { power, by } = data.magicalPower.climbing.riftPrism;
    if (prism) {
      const family = familyOf(data, prism.name, prism.id);
      const alreadyHave = bagState.familyPower.get(family) ?? 0;
      if (power > alreadyHave) {
        tasks.push({
          id: "climb_RIFT_PRISM",
          category: "accessory_bag",
          name: "Imbue the Rift Prism",
          xp: power - alreadyHave,
          exclusiveGroup: `accessory:${family}`,
          groupLevel: power,
          groupBase: alreadyHave,
          requires: [],
          cost: { kind: "none" },
          repeatable: false,
          note: `${power} MP · ${by}`,
        });
      }
    }
  }

  // The Abicase turns Abiphone contacts into magical power, one for every two, so every contact
  // is half a point of accessory XP on top of the ten the contact itself pays. It is not a
  // purchase of its own — it arrives with the contacts, which stay priced in their own category
  // — so it is a grind row here, and without it the bag reads short by the whole Abiphone book.
  {
    // How many contacts there are to have, counted off the task list rather than off the pricing
    // table. The two disagree and only one of them is complete: the tasks come from the id
    // namespace harvested from live players and hold all 84, while the wiki's contacts table
    // states 71 and never mentions the drill fuel mechanic, the forge foreman, or eleven others.
    // Reading the short one capped the Abicase seven magical power below what it reaches.
    const everyContact = data.tasks.tasks.filter((t) => t.id.startsWith("ABIPHONE_")).length;
    const reachable = abicaseBonusFor(everyContact);
    const now = abicaseBonusFor(abiphoneContacts);
    const hasAbicase = [...bagState.owned].some((id) => id.startsWith("ABICASE"));
    // Offered whether or not there is an Abicase in the bag yet: on a sample of live profiles
    // most players had none, and holding the row back left every one of them 42 magical power
    // short of a ceiling they can perfectly well reach by buying one. Not owning it makes the
    // Abicase a prerequisite, not a reason to hide the XP behind it.
    if (reachable > now) {
      tasks.push({
        id: "abicase_contacts",
        category: "accessory_bag",
        name: "Abicase — more Abiphone contacts",
        xp: reachable - (hasAbicase ? now : 0),
        requires: hasAbicase ? [] : ["accessory_ABICASE"],
        cost: { kind: "none" },
        repeatable: false,
        note: `1 MP per 2 contacts in the phone · ${abiphoneContacts} of ${everyContact} active${
          hasAbicase ? "" : " · needs an Abicase"
        }`,
      });
    }
  }

  // Powers. Nine of one Power Stone handed to Maxwell unlocks its power for good, and the
  // profile lists what is already unlocked, so this is exact on the done half. The stones trade,
  // so the cost is nine of them at whatever they are going for.
  {
    const unlocked = new Set(
      (member.accessory_bag_storage?.unlocked_powers ?? []).map((p) => String(p).toLowerCase()),
    );
    const { stonesPerPower, xpPerPower, powers } = data.powerStones;

    for (const entry of powers) {
      const id = `power_${entry.power}`;
      tasks.push({
        id,
        category: "powers",
        name: `Unlock ${titleCase(entry.power)} power`,
        xp: xpPerPower,
        requires: [],
        cost: entry.itemId
          ? { kind: "bazaar", items: [{ id: entry.itemId, qty: stonesPerPower }] }
          : { kind: "unknown", note: `No item id for ${entry.stone}` },
        repeatable: false,
        note: `${stonesPerPower}× ${entry.stone} to Maxwell`,
      });
      if (unlocked.has(entry.power)) done.add(id);
    }
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

  /* ------------------------------------------------------------- bestiary */

  // The bestiary is a kill counter, and the profile reports only the raw counts: 2,467 crypt
  // lurkers, no tier, no threshold, no family. Tiers come from the wiki's seven cumulative
  // kill brackets, and the kills that feed a family have to be gathered from every mob id and
  // every level that belongs to it.
  //
  // A tier is worth 1 SkyBlock XP. The other half of the category is the milestones, which the
  // task table pays at 10 per ten of them — and a milestone is a thing the bestiary counts in
  // its own right, not every tenth tier. Reading it as every tenth tier made a tier worth 2 and
  // the category worth 7,840 against a stated 4,370. What the milestones pay is credited from
  // the profile's own count instead of being spread across these rows, because nothing published
  // says how many tiers a milestone takes.
  const bestiaryKills = new Map<string, number>();
  const unaccounted = new Map<string, number>();
  for (const [mobId, count] of Object.entries(member.bestiary?.kills ?? {})) {
    if (typeof count !== "number") continue;
    const family = bestiaryFamilyOf(data, mobId);
    if (family === undefined) {
      const base = mobId.replace(/_-?\d+$/, "");
      unaccounted.set(base, (unaccounted.get(base) ?? 0) + count);
    } else if (family !== null) {
      bestiaryKills.set(family, (bestiaryKills.get(family) ?? 0) + count);
    }
  }

  // An id we couldn't place is only harmless if it belonged to no family. When it shares a word
  // with a family's name it probably fed that family, and crediting that family the kills we
  // *did* place would put it at a lower tier than the player is really on — which, since the
  // list is ordered by how close the next tier is, would push a wrong row to the very top.
  // Those families are held back rather than guessed at.
  const suspect = new Set<string>();
  for (const id of unaccounted.keys()) {
    const words = new Set(id.split("_"));
    for (const family of data.bestiary.families) {
      if (family.id.split("_").every((word) => words.has(word))) suspect.add(family.id);
    }
  }

  // A family with no kills against it is only at tier 0 if we could have seen its kills. When
  // the profile is carrying mob ids we cannot place — 163 of them and 201,000 kills on one maxed
  // bag — "no kills" means we did not look in the right place, not that the player never fought
  // it. That profile has never once killed a Golden Ghoul according to this map, and was being
  // told to go and get tier 1.
  //
  // The ids and the families are the same list seen from two ends: the game names mobs
  // internally (`old_blaze_110`) and the bestiary names families by display name
  // (Millennia-Aged Blaze), and nothing published joins them — no items resource, no bestiary
  // endpoint, and no id on any wiki page. Until that map is complete, a family we have no
  // evidence about is unknown rather than empty, and unknown is not something to sell.
  if (unaccounted.size > 0) {
    for (const family of data.bestiary.families) {
      if (!bestiaryKills.has(family.id)) suspect.add(family.id);
    }
  }

  const BESTIARY_REACH = 5_000;
  let bestiaryTiers = 0;
  let bestiaryOffered = 0;

  for (const family of data.bestiary.families) {
    const kills = bestiaryKills.get(family.id) ?? 0;
    const tier = bestiaryTierOf(family, data.bestiary.brackets, kills);
    bestiaryTiers += tier;
    if (suspect.has(family.id)) continue;

    const ladder = data.bestiary.brackets[String(family.bracket)] ?? [];
    let previousTier: string | null = null;
    for (let next = tier + 1; next <= family.maxTier; next++) {
      const needed = (ladder[next - 1] ?? Infinity) - kills;
      // Brackets only ever climb, so the first tier out of reach ends the family.
      if (needed >= BESTIARY_REACH) break;
      const id = `bestiary_${family.id}_${next}`;
      tasks.push({
        id,
        category: "bestiary",
        name: `${family.name} tier ${next} — ${family.island}`,
        // One. The task table pays 1 per tier and 10 per ten *milestones*, and reading the second
        // as every tenth tier made every row here worth double.
        xp: 1,
        requires: previousTier ? [previousTier] : [],
        cost: { kind: "none" },
        repeatable: false,
        note: `${num(needed)} more kill${needed === 1 ? "" : "s"} (${num(kills)} of ${num(ladder[next - 1] ?? 0)})`,
        // Grind tasks normally rank on how many players have finished them. The bestiary has
        // something better: the exact number of kills left. It is the same 0-to-1 scale, but
        // measured rather than sampled, so it replaces the proxy for this category alone.
        effort: Math.min(needed / BESTIARY_REACH, 1),
        effortBand: needed <= 50 ? "quick" : needed <= 500 ? "short" : needed <= 2_000 ? "long" : "marathon",
      });
      previousTier = id;
      bestiaryOffered++;
    }
  }

  // The profile's own claimed-milestone count is a floor on the tiers it has earned, and it is
  // the only independent check on the whole join. Ten tiers to a milestone, and a milestone is
  // claimed rather than granted, so the count can lag — but it can never run ahead.
  const bestiaryClaimedFloor = (member.bestiary?.milestone?.last_claimed_milestone ?? 0) * 10;
  const bestiaryUnaccountedKills = [...unaccounted.values()].reduce((sum, n) => sum + n, 0);
  const bestiaryCoverage = [
    `On this profile ${num(bestiaryOffered)} tiers sit under ${num(BESTIARY_REACH)} kills away`,
    ` across ${num(data.bestiary.totals.families)} documented families`,
    suspect.size > 0 ? `, with ${num(suspect.size)} families held back` : "",
    unaccounted.size > 0
      ? ` because ${num(unaccounted.size)} mob ids (${num(bestiaryUnaccountedKills)} kills) match no family we know`
      : "",
    `. Tiers we can account for come to ${num(bestiaryTiers)}`,
    bestiaryClaimedFloor > 0
      ? bestiaryTiers >= bestiaryClaimedFloor
        ? `, against the ${num(bestiaryClaimedFloor)} the profile's own claimed milestones vouch for — so nothing is missing that the profile can prove.`
        : `, short of the ${num(bestiaryClaimedFloor)} the profile's own claimed milestones vouch for, so ${num(
            bestiaryClaimedFloor - bestiaryTiers,
          )} tiers sit in families this map can't reach.`
      : ".",
  ].join("");

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
  // Both kinds of grind: one that ends in an item is ranked the same way as one that does not.
  for (const task of tasks) {
    if (task.cost.kind !== "none" && task.cost.kind !== "grind") continue;
    // The bestiary already carries a measured effort — kills remaining — so it opts out.
    if (task.category === "bestiary") continue;
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
    earnedOutsideTasks: {
      magicalPower: bagState.computedMp,
      // The highest score reached is what the game paid out on, not what the pets are worth now.
      petScore: (member.leveling?.highest_pet_score ?? 0) * 3,
      bestiary: bestiaryXp(data, member, bestiaryTiers),
    },
    reconciliation: [
      { category: "museum" as Category, credited: donatedCount - strandedDonations, reported: donatedCount },
      { category: "attributes" as Category, credited: attributeCount - strandedAttributes, reported: attributeCount },
      { category: "accessory_bag" as Category, credited: bagState.identified, reported: bagState.held },
    ],
    unmodelled: UNMODELLED.concat(
      strandedDonations > 0
        ? [
            {
              category: "museum" as Category,
              note:
                "This profile holds " +
                strandedDonations +
                " museum donation(s) the app has no slot for, so they count against you as missing. Every slot the game publishes is modelled, which means these are filed under an id the items resource does not carry — worth reporting rather than guessing at.",
            },
          ]
        : [],
    ).map((u) =>
      u.category === "bestiary"
        ? {
            ...u,
            totalXp: data.bestiary.totals.statedTotal ?? data.bestiary.totals.xp,
            earnedXp: bestiaryXp(data, member, bestiaryTiers),
            note: `${u.note} ${bestiaryCoverage}`,
          }
        :
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
/**
 * What a contact actually asks for, so the price on the row has something to justify it.
 *
 * A caveat is the half of the requirement that isn't a purchase — Walter wants the Sulphur
 * collection as well as the item — and saying so is the difference between a row you can act
 * on and one that looks a click away when it isn't.
 */
function abiphoneNote(id: string, data: GameData): string | undefined {
  if (!id.startsWith("ABIPHONE_")) return undefined;
  const contact = data.abiphone?.contacts.find((c) => c.taskId === id);
  if (!contact) return undefined;
  const parts = [contact.needs ?? null, contact.caveat ? `also ${contact.caveat}` : null].filter(Boolean);
  if (contact.cost.kind === "npc" && contact.cost.coins === 0) parts.unshift("Just talk to them");
  return parts.length ? `${contact.npc} — ${parts.join(", ")}` : undefined;
}


function discreteCost(id: string, data: GameData, scrollFor: Map<string, { itemId: string }>): Task["cost"] {
  const bank = data.costs.bank[id];
  if (bank !== undefined) return { kind: "npc", coins: bank };

  // A contact is 10 XP for one item handed over, which makes these the cheapest purchases in
  // the game — they were grind-priced until the wiki's requirement column got parsed.
  if (id.startsWith("ABIPHONE_")) {
    const contact = data.abiphone?.contacts.find((c) => c.taskId === id);
    if (contact) return contact.cost;
  }

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
type AttributeStacks = ((key: string) => number) & {
  /** Whether the profile carries this attribute at all under any name we recognise. */
  placed: (key: string) => boolean;
};

function attributeStacks(stacks: Record<string, number> | undefined, data: GameData): AttributeStacks {
  const held = stacks ?? {};
  const byShape = new Map<string, number>();
  for (const [key, amount] of Object.entries(held)) {
    const shape = attributeShape(key);
    byShape.set(shape, Math.max(byShape.get(shape) ?? 0, amount));
  }

  const lookup = (key: string): number | undefined => {
    for (const candidate of attributeCandidates(key, data)) {
      const direct = held[candidate];
      if (direct !== undefined) return direct;
      const shaped = byShape.get(attributeShape(candidate));
      if (shaped !== undefined) return shaped;
    }
    return undefined;
  };

  const read = ((key: string) => lookup(key) ?? 0) as AttributeStacks;
  read.placed = (key) => lookup(key) !== undefined;
  return read;
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
  // A migrated attribute is left in the profile twice, under its old key and under the same key
  // with `_new` on the end, and the old one keeps whatever it held when the game moved on. One
  // maxed profile carries humanoid_ruler at 48 and humanoid_ruler_new at 64, and reading the
  // first offered the last level of an attribute that was already full. The new key is tried
  // ahead of each form it belongs to: it names one attribute and cannot be mistaken for another.
  return [...new Set(forms.flatMap((form) => [`${form}_new`, form]))];
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

/**
 * "OBJECTIVE_TALK_TO_FARMER" -> "Talk to Farmer Rigby".
 *
 * The ids are bare slugs harvested off live profiles, so the fallback prettifier rendered them
 * as "Objective talk to farmer" — which farmer, and where, being left to the reader. Where the
 * wiki knows the NPC, the real name goes in; the island and coordinates go in the note.
 */
function objectiveName(id: string, data: GameData): string {
  if (!id.startsWith("OBJECTIVE_")) return prettyTaskName(id);
  const npc = npcFor(id, data);
  if (npc && id.startsWith("OBJECTIVE_TALK_TO_")) {
    // The trailing number is part of the id, not a position in a sequence: the table carries
    // INCREASE_FARMING_SKILL_5, and TALK_TO_DAVID_7 with no David 1 through 6 anywhere. Calling
    // it a step invented six errands that do not exist.
    //
    // It is still needed where two objectives send you to the same character, or they render
    // identically and finishing one leaves a row that looks untouched. Only then, and only as
    // the bare number.
    const plain = `Talk to ${npc.name}`;
    // The un-numbered id is the first of its pair, so it reads as 1 rather than borrowing the
    // other one's number.
    return sharesAnNpc(id, data) ? `${plain} (${/_(\d+)$/.exec(id)?.[1] ?? "1"})` : plain;
  }

  const label = prettyTaskName(id.replace(/^OBJECTIVE_/, ""));
  if (!npc) return label;
  // "Give sam wheat" -> "Give Sam wheat": the slug flattened the name, so put it back rather
  // than leaving a character looking like a noun.
  const key = data.npcs.objectives[id];
  return key ? label.replace(new RegExp(key, "i"), npc.name) : label;
}

/** Whether another talk-to objective resolves to the same NPC, making the bare name ambiguous. */
function sharesAnNpc(id: string, data: GameData): boolean {
  const mine = npcKeyFrom(id);
  return data.tasks.tasks.some(
    (task) => task.id !== id && task.id.startsWith("OBJECTIVE_TALK_TO_") && npcKeyFrom(task.id) === mine,
  );
}

/** "Farm · 62, 72, -147" — where to actually go. */
function directionsTo(id: string, data: GameData): string | null {
  const npc = npcFor(id, data);
  if (!npc) return null;
  const where = npc.coords ? `${npc.coords.x}, ${npc.coords.y}, ${npc.coords.z}` : null;
  const parts = [npc.location, where].filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
}

function npcFor(id: string, data: GameData): NpcEntry | null {
  // Named outright by the objective table, or derivable from a talk-to slug.
  const listed = data.npcs.objectives[id];
  if (listed) return data.npcs.npcs[listed] ?? null;
  if (!id.startsWith("OBJECTIVE_TALK_TO_")) return null;
  return data.npcs.npcs[npcKeyFrom(id)] ?? null;
}

/**
 * The key the NPC table is built under. Mirrors scripts/fetch-npcs.mjs: the trailing number on
 * an objective is a quest step, not part of the character's name.
 */
function npcKeyFrom(id: string): string {
  return id
    .replace(/^OBJECTIVE_TALK_TO_/, "")
    .replace(/_\d+$/, "")
    .replace(/_NEW$/, "")
    .replace(/^LUMBER_JACK$/, "LUMBERJACK")
    .split("_")
    .filter(Boolean)
    .map((word) => word.charAt(0) + word.slice(1).toLowerCase())
    .join(" ");
}

/**
 * Bestiary XP already earned: the tiers the kills reach, plus what the milestones pay.
 *
 * The task table gives two rewards — "Each Tier: +1" and "Every 10 Milestones: +10" — and this
 * used to read the second as every tenth *tier*, making a tier worth 2 and the whole category
 * 7,840 against a stated 4,370. Credited that way a maxed profile came out at 10,260, more than
 * twice everything the bestiary holds, which is the kind of figure that should never have been
 * possible: it is checked against the total now, and cannot exceed it.
 *
 * The two halves come from different places because only one of them is knowable. Tiers are
 * computed from the kills the profile publishes, which is exact where a mob id can be placed and
 * short where it cannot — 163 ids on one profile, 201,000 kills, so this reads low rather than
 * high. Milestones are taken from `last_claimed_milestone`, which is exact but claimed rather
 * than granted, so it lags. Neither is inflated to cover the other.
 */
function bestiaryXp(data: GameData, member: ProfileMember, tiersReached: number): number {
  const milestones = member.bestiary?.milestone?.last_claimed_milestone ?? 0;
  const totals = data.bestiary.totals;
  const earned = tiersReached + Math.floor(milestones / 10) * 10;
  return Math.min(earned, totals.statedTotal ?? totals.xp);
}

/** Where an Abiphone contact stands — island and coordinates, from the wiki's NPC infobox. */
function contactLocation(id: string, data: GameData): string | undefined {
  if (!id.startsWith("ABIPHONE_")) return undefined;
  const contact = data.abiphone?.contacts.find((c) => c.taskId === id);
  const npc = contact?.npc ? data.npcs.npcs[contact.npc] : undefined;
  if (!npc) return undefined;
  const where = npc.coords ? `${npc.coords.x}, ${npc.coords.y}, ${npc.coords.z}` : null;
  const parts = [npc.location, where].filter(Boolean);
  return parts.length ? parts.join(" · ") : undefined;
}

/**
 * Where a discrete task belongs.
 *
 * The harvested table files everything it can't place under misc, which had swallowed 120 trophy
 * fish tasks worth 1,800 XP — a whole fishing track buried in a bucket of odds and ends, with no
 * way to switch it off on its own.
 */
function discreteCategory(id: string, declared: Category): Category {
  return id.startsWith("TROPHY_") ? "trophy_fish" : declared;
}
