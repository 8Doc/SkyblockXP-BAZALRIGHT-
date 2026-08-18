export type Category =
  | "museum"
  | "minions"
  | "abiphone"
  | "fast_travel"
  | "bank"
  | "essence_shop"
  | "fairy_souls"
  | "accessory_bag"
  | "pets"
  | "collections"
  | "skills"
  | "dungeons"
  | "events"
  | "rift"
  | "slayer"
  | "attributes"
  | "misc";

export const CATEGORIES: Category[] = [
  "accessory_bag",
  "minions",
  "skills",
  "collections",
  "fairy_souls",
  "pets",
  "museum",
  "abiphone",
  "fast_travel",
  "bank",
  "essence_shop",
  "dungeons",
  "slayer",
  "attributes",
  "events",
  "rift",
  "misc",
];

export const CATEGORY_LABELS: Record<Category, string> = {
  museum: "Museum",
  minions: "Minions",
  abiphone: "Abiphone",
  fast_travel: "Fast Travel",
  bank: "Bank",
  essence_shop: "Essence Shops",
  fairy_souls: "Fairy Souls",
  accessory_bag: "Accessory Bag",
  pets: "Pets",
  collections: "Collections",
  skills: "Skills",
  dungeons: "Dungeons",
  events: "Events",
  rift: "Rift",
  slayer: "Slayer",
  attributes: "Attribute Shards",
  misc: "Misc",
};

export type EssenceType =
  | "WITHER"
  | "UNDEAD"
  | "DRAGON"
  | "SPIDER"
  | "ICE"
  | "DIAMOND"
  | "GOLD"
  | "CRIMSON"
  | "FOREST"
  | "FOSSIL"
  | "SAFARI";

export type CostSpec =
  | { kind: "bazaar"; items: { id: string; qty: number }[] }
  | { kind: "auction"; itemId: string; tier?: string }
  | { kind: "npc"; coins: number }
  | { kind: "essence"; type: EssenceType; amount: number }
  | { kind: "none" }
  /**
   * Not in the README's spec. Added because the alternative is worse: several categories have
   * a known XP value but no price we can source yet (minion tiers I-XI have no recipe data in
   * the API). Inventing a number would poison every ranking downstream, and dropping the task
   * would hide real XP from the browser. "unknown" keeps it visible and out of the solver.
   */
  | { kind: "unknown"; note: string };

export type Task = {
  id: string;
  category: Category;
  name: string;
  xp: number;
  requires: string[];
  cost: CostSpec;
  repeatable: false;
  /** Short provenance / caveat shown in the UI. */
  note?: string;
  /**
   * Tasks that compete rather than stack. An accessory family is the case that forces this:
   * Bat Talisman, Bat Ring and Bat Artifact are 3, 8 and 12 magical power, but owning all
   * three is still worth 12 — only the best member counts. Without this the bag would
   * advertise 3,329 XP against a real ceiling of ~2,100, and a plan could "buy" the same
   * magical power three times.
   */
  exclusiveGroup?: string;
  /** Where this task sits in its group — magical power, for accessories. */
  groupLevel?: number;
  /** What the group is already worth before this plan starts. */
  groupBase?: number;
  /**
   * How much work a grind task looks like, 0 (trivial) to 1 (brutal), measured as the share of
   * sampled players who have *not* done it. Coin-priced tasks don't need it — they rank on
   * price — but without it the grind categories had no ordering at all.
   */
  effort?: number;
  effortBand?: "quick" | "short" | "long" | "marathon";
};

/** A task after prices and the player's profile have been folded in. */
export type ResolvedTask = Task & {
  done: boolean;
  /** Coin cost of this task alone. null when unpriceable (grind-only or unknown). */
  coins: number | null;
  /** Cost of this task plus every unmet prerequisite. */
  bundleCoins: number | null;
  /** XP of this task plus every unmet prerequisite. */
  bundleXp: number;
  /** Unmet prerequisites, closest-first. Excludes the task itself. */
  bundle: string[];
  /** bundleCoins / bundleXp. null when unpriceable. */
  efficiency: number | null;
};

export type PlanGroup = {
  category: Category;
  xp: number;
  coins: number;
  tasks: ResolvedTask[];
};

/**
 * One fixed-size chunk of spending. The plan answers "what does N XP cost"; a package answers
 * the question you actually ask at the bazaar — "I have 10M, what's the best thing to buy with
 * it?" — and the sequence of them shows how fast the rate decays as the cheap XP runs out.
 */
export type PackageEntry = {
  index: number;
  /** Coins actually committed. Never more than the package size, often a little under. */
  coins: number;
  xp: number;
  /** Coins per XP for this package alone. Rises with every package. */
  rate: number;
  groups: PlanGroup[];
  /** Totals including every earlier package. */
  cumulativeCoins: number;
  cumulativeXp: number;
  cumulativeLevels: number;
  /**
   * What the same coins would have bought spending in pure coins-per-XP order, ignoring package
   * boundaries entirely. The baseline for the bleed below.
   */
  idealXp: number;
  /**
   * XP given up to keep the spending in tidy packages — `idealXp - cumulativeXp`.
   *
   * A package closes when nothing left fits its remaining headroom, so the fill has to take a
   * worse-value item to use the space (or leave it unspent). That is the price of convenience,
   * and it is the number this whole view exists to make visible. Negative is possible on the
   * exact solver, which can out-plan a naive efficiency ordering inside a package.
   */
  bleedXp: number;
};

export type PackagePlan = {
  strategy: "greedy" | "exact";
  packageSize: number;
  packages: PackageEntry[];
  /** True when the affordable pool ran dry before the requested number of packages was filled. */
  exhausted: boolean;
  /** Bleed across every package — the total convenience tax. */
  totalBleedXp: number;
  /** XP the ideal ordering reaches at the same total spend. */
  totalIdealXp: number;
};

export type Plan = {
  strategy: "greedy" | "exact";
  targetXp: number;
  reachedXp: number;
  coins: number;
  levelsGained: number;
  groups: PlanGroup[];
  /** True when the eligible task pool could not reach the target. */
  short: boolean;
};

export type CategorySummary = {
  category: Category;
  modelled: boolean;
  remainingTasks: number;
  remainingXp: number;
  /** XP we can attach a coin price to. */
  pricedXp: number;
  pricedCoins: number;
  note?: string;
};

export const XP_PER_LEVEL = 100;
