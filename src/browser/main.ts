import { auctionNameIndex, categoryLabel, type BagItem, type GameData } from "../lib/gameData";
import { coins, num, parseBudget, rate } from "../lib/format";
import { coopProgress, type BinIndex, type GardenState, type MuseumState, type ProfileMember, type SkyblockProfile, type BazaarProduct } from "../lib/profile";
import { petsFrom } from "../lib/auctions";
import { buildCatalog, type Catalog } from "../lib/catalog";
import { groupTaskRuns, levelDividers, levelMarks, type TaskRun } from "../lib/grouping";
import { buildReport, type Report } from "../lib/report";
import type { PriceBook } from "../lib/resolve";
import {
  CATEGORIES,
  CATEGORY_LABELS,
  XP_PER_LEVEL,
  type Category,
  type PackageEntry,
  type ResolvedTask,
} from "../lib/types";
import { ApiError, cacheAge, fetchAccessoryBins, fetchBazaar, fetchReferencePrices, fetchGarden, fetchMuseum, fetchProfiles, readBag, readOwnedItems, resolveUuid } from "./api";
import { mountBazaar, unmountBazaar } from "./bazaarTab";
import { mountGreenhouse, unmountGreenhouse } from "./greenhouseTab";
import { setMinionProfile } from "./minionsTab";
import { mountMinionsSection, unmountMinionsSection } from "./minionsSection";
import type { Collection, MinionData, Modifiers } from "../lib/minions";
import type { GreenhouseData } from "../lib/greenhouse";
import type { NpcPrice, Recipe } from "../lib/bazaarViews";
import type { AnvilRules } from "../lib/bazaarChains";
import type { DropTable, Recipe as MinionRecipe, StorageTables } from "../lib/minionProfit";
import type { PetXpRules, SkillXpTables } from "../lib/minionXp";
import type { PetLevelTable } from "../lib/petLevelling";

/**
 * The standalone build. Same domain logic as the Next app — it imports the very same solver
 * and catalog — with the fetching done from the page instead of a server.
 *
 * One consequence worth the trade: because the profile and prices live in memory once loaded,
 * moving the XP floor or the budget re-solves instantly with no network at all.
 */

declare global {
  interface Window {
    __GAME_DATA__: GameData;
    /**
     * The bazaar tab's tables, kept out of `__GAME_DATA__` on purpose. The two halves of this
     * page answer different questions off different data, and nothing good comes of one being
     * able to reach into the other's tables.
     */
    __BAZAAR_DATA__: {
      recipes: Recipe[];
      /** Steps making something the bazaar does not sell, for the chain finder only. */
      intermediates: Recipe[];
      npcPrices: Record<string, NpcPrice>;
      anvil: AnvilRules;
      names: Record<string, string>;
    };
    /**
     * The greenhouse tab's tables, separate again for the same reason: it answers a question
     * about growing things off a wiki scrape, and shares only the shop prices with the bazaar.
     */
    __GREENHOUSE_DATA__: { greenhouse: GreenhouseData; npcPrices: Record<string, NpcPrice> };
    /**
     * The minions section's tables, shared by its three child tabs.
     *
     * The collection question needs the collections; the profit question needs prices, storage
     * and recipes; the pet question needs the skill XP rates and the pet curves. They are inlined
     * together because all three are asking about the same rate, and split into named groups so a
     * child tab is handed only what it reads.
     */
    __MINION_DATA__: {
      production: MinionData;
      modifiers: Modifiers;
      collections: Collection[];
      storage: StorageTables;
      drops: DropTable;
      recipes: MinionRecipe[];
      npcPrices: Record<string, NpcPrice>;
      names: Record<string, string>;
      skillXp: SkillXpTables;
      petXpRules: PetXpRules;
      petLevels: PetLevelTable;
    };
  }
}

/** Replaced at build time with the key from .env.local (or --key). May be an empty string. */
declare const DEFAULT_API_KEY: string;

const data = window.__GAME_DATA__;
const nameToId = auctionNameIndex(data);

type State = {
  apiKey: string;
  username: string;
  uuid: string | null;
  playerName: string | null;
  profiles: SkyblockProfile[];
  profileId: string | null;
  member: ProfileMember | null;
  bagItems: { items: BagItem[] | null; capacity: number };
  /** Item ids the player is holding, or null when the profile publishes no inventory. */
  owned: Set<string> | null;
  bazaar: Record<string, BazaarProduct>;
  /** Fallback prices for items nothing is listing. Empty if the feed is unreachable. */
  reference: Record<string, number>;
  bins: BinIndex | null;
  museum: MuseumState | null;
  garden: GardenState | null;
  /** Built once per profile — it never depends on the solver knobs. */
  catalog: Catalog | null;
  targetMode: "xp" | "level";
  target: number;
  targetLevel: number;
  minXp: number;
  budget: string;
  packageSize: string;
  packageCount: number;
  categories: Set<Category>;
  strategy: "greedy" | "exact";
  /**
   * Which half of the site is on screen. The planner needs a key, a name and a profile; the
   * bazaar needs none of them, so it is a section rather than another tab inside the report.
   */
  section: "planner" | "bazaar" | "greenhouse" | "minions";
  tab: "plan" | "packages" | "cheapest" | "grind" | "browser";
  status: { kind: "idle" | "busy" | "error"; message: string };
  report: Report | null;
};

const state: State = {
  apiKey: localStorage.getItem("sbxp:key") ?? DEFAULT_API_KEY,
  username: localStorage.getItem("sbxp:username") ?? "",
  uuid: null,
  playerName: null,
  profiles: [],
  profileId: null,
  member: null,
  bagItems: { items: null, capacity: 0 },
  owned: null,
  bazaar: {},
  reference: {},
  bins: null,
  museum: null,
  garden: null,
  catalog: null,
  targetMode: "xp",
  target: 500,
  targetLevel: 300,
  minXp: 0,
  budget: "",
  packageSize: localStorage.getItem("sbxp:packageSize") ?? "10M",
  packageCount: 5,
  categories: new Set(CATEGORIES),
  strategy: "greedy",
  section: (localStorage.getItem("sbxp:section") as State["section"]) ?? "planner",
  tab: "plan",
  status: { kind: "idle", message: "" },
  report: null,
};

/* ------------------------------------------------------------------ solving */

/**
 * The price book, kept as one object for as long as the prices in it are the same ones.
 *
 * The resolver caches what a task costs against the identity of the book it was priced from, so
 * handing it a freshly built object with identical contents on every solve threw that cache
 * away each time. The three feeds are replaced wholesale when they are refreshed, so comparing
 * the references is enough to know when a new book is owed.
 */
let priceBook: PriceBook | null = null;

function bookNow(): PriceBook {
  if (
    !priceBook ||
    priceBook.bazaar !== state.bazaar ||
    priceBook.bins !== state.bins ||
    priceBook.reference !== state.reference
  ) {
    priceBook = { bazaar: state.bazaar, bins: state.bins, reference: state.reference };
  }
  return priceBook;
}

function solveNow(): void {
  if (!state.member || !state.catalog) return;
  const book = bookNow();
  const targetXp =
    state.targetMode === "level"
      ? Math.max(state.targetLevel * XP_PER_LEVEL - (state.member.leveling?.experience ?? 0), 1)
      : Math.max(state.target, 1);

  state.report = buildReport(state.catalog, book, {
    targetXp,
    minXp: state.minXp,
    budget: parseBudget(state.budget),
    categories: state.categories,
    strategy: state.strategy,
    packageSize: parseBudget(state.packageSize) ?? 10_000_000,
    packageCount: state.packageCount,
  });
}

/** Accepts "50M", "1.2b", "500k" or a plain number. Empty means no cap. */
/* ------------------------------------------------------------------ loading */

async function loadPlayer(): Promise<void> {
  const username = state.username.trim();
  if (!username) return;

  setStatus("busy", "Looking up player…");
  try {
    const { uuid, name } = await resolveUuid(username);
    state.uuid = uuid;
    state.playerName = name;
    localStorage.setItem("sbxp:username", username);

    setStatus("busy", "Fetching profiles…");
    state.profiles = await fetchProfiles(uuid, state.apiKey.trim());
    const selected = state.profiles.find((p) => p.selected) ?? state.profiles[0];
    state.profileId = selected.profile_id;

    await loadProfile();
  } catch (error) {
    setStatus("error", error instanceof ApiError ? error.message : String(error));
  }
}

async function loadProfile(): Promise<void> {
  if (!state.uuid || !state.profileId) return;
  const profile = state.profiles.find((p) => p.profile_id === state.profileId);
  const member = profile?.members[state.uuid];
  if (!member) {
    setStatus("error", "No member data on that profile");
    return;
  }
  state.member = member;

  // Six independent reads, none of which needs an answer from any of the others: two gzipped
  // NBT blobs off the profile already in hand, the museum and the garden from Hypixel, and the
  // two price feeds. Done one after another they were four round trips end to end for no
  // reason — the museum cannot tell you anything about the garden.
  setStatus("busy", "Reading profile and prices…");
  const key = state.apiKey.trim();
  // Settled rather than awaited here, so a price feed that fails while the profile reads are
  // still running is a handled rejection rather than an unhandled one.
  const prices = Promise.all([fetchBazaar(), fetchReferencePrices()]).then(
    (value) => ({ ok: true, value }) as const,
    (error: unknown) => ({ ok: false, error }) as const,
  );

  // These four report their own failures as "not available" rather than throwing.
  [state.bagItems, state.owned, state.museum, state.garden] = await Promise.all([
    readBag(member.inventory?.bag_contents?.talisman_bag?.data),
    readOwnedItems(member),
    fetchMuseum(state.profileId, state.uuid, key),
    fetchGarden(state.profileId, key),
  ]);

  {
    // The reference feed is fetched alongside the bazaar: both are cheap, and the museum reads
    // as half-empty without it.
    const priced = await prices;
    if (!priced.ok) {
      const error = priced.error;
      setStatus("error", error instanceof ApiError ? error.message : String(error));
      return;
    }
    [state.bazaar, state.reference] = priced.value;
  }

  rebuildCatalog();

  // Auction prices are the expensive feed; reuse a cached sweep, otherwise let the user ask.
  if (!state.bins && cacheAge("bins") !== null) {
    await loadAuctions();
  }

  solveNow();
  setStatus("idle", "");
}

/**
 * Fetch auction prices. `force` skips the ten-minute cache, which is what the refresh button
 * wants — the cache exists so reopening the file is instant, not to stop you asking for
 * today's prices when a market has moved.
 */
async function loadAuctions(force = false): Promise<void> {
  const verb = force ? "Rescanning" : "Scanning";
  setStatus("busy", `${verb} the auction house…`);
  try {
    state.bins = await fetchAccessoryBins(
      nameToId,
      (done, total) => setStatus("busy", `${verb} the auction house — page ${done} of ${total}…`),
      force,
    );
    rebuildCatalog(); // pets only exist in the catalogue once the sweep has found them
    solveNow();
    setStatus("idle", "");
  } catch (error) {
    setStatus("error", error instanceof ApiError ? error.message : String(error));
  }
}

function rebuildCatalog(): void {
  if (!state.member) return;
  const profile = state.profiles.find((p) => p.profile_id === state.profileId);
  state.catalog = buildCatalog(
    state.member,
    data,
    state.bagItems,
    state.museum,
    state.bins ? petsFrom(state.bins) : null,
    state.garden,
    profile ? coopProgress(profile) : null,
    state.owned,
  );

  // Hand the same reading to the minions tab. It is the island-wide view where there is a co-op,
  // for the same reason the catalog uses it: a co-op player should not be told they are short of
  // something the island finished months ago. Doing it here rather than in the tab keeps the
  // profile fetched once — a second API key box on a tab that otherwise needs none would be a
  // poor trade for data already in memory.
  const coop = profile ? coopProgress(profile) : null;
  const crafted = coop?.craftedGenerators ?? state.member.player_data?.crafted_generators ?? [];
  const ownedTier = new Map<string, number>();
  for (const id of crafted) {
    // "CLAY_GENERATOR_11" — the tier is the trailing number and the generator is the rest.
    const at = id.lastIndexOf("_");
    const tier = Number(id.slice(at + 1));
    const generator = id.slice(0, at).replace(/_GENERATOR$/, "");
    if (!Number.isFinite(tier)) continue;
    ownedTier.set(generator, Math.max(ownedTier.get(generator) ?? 0, tier));
  }
  setMinionProfile(coop?.collected ?? collectedFrom(state.member), ownedTier, state.playerName);
}

/**
 * A member's own collection totals, for the solo case.
 *
 * `coopProgress` already unions these across an island; this is the one-member fallback, and it
 * is separate from the catalog's copy because that one is not exported.
 */
function collectedFrom(member: ProfileMember): Map<string, number> {
  return new Map(Object.entries(member.collection ?? {}).map(([id, n]) => [id, Number(n) || 0]));
}

/** Re-pull every live feed. The profile is left alone — this is about prices, not progress. */
async function refreshPrices(): Promise<void> {
  setStatus("busy", "Refreshing bazaar prices…");
  try {
    [state.bazaar, state.reference] = await Promise.all([fetchBazaar(true), fetchReferencePrices(true)]);
  } catch (error) {
    setStatus("error", error instanceof ApiError ? error.message : String(error));
    return;
  }
  // Only re-sweep the auction house if it was loaded to begin with; it is the expensive feed.
  if (state.bins) {
    await loadAuctions(true);
    return;
  }
  rebuildCatalog();
  solveNow();
  setStatus("idle", "");
}

function setStatus(kind: State["status"]["kind"], message: string): void {
  state.status = { kind, message };
  render();
}

/* ---------------------------------------------------------------- rendering */

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function taskRow(task: ResolvedTask, showBundle: boolean, tag?: string): string {
  const bundled = showBundle && task.bundle.length > 0;
  const unpriced = task.bundleCoins === null;
  const priceText = unpriced
    ? task.cost.kind === "none" || task.cost.kind === "grind"
      ? `<span class="effort ${task.effortBand ?? "marathon"}" title="${
          task.effort === undefined
            ? "No completion data — treated as the longest grind"
            : `${Math.round((1 - task.effort) * 100)}% of sampled players have done this`
        }">${task.effortBand ?? "grind"}</span>`
      : `<span class="dim">no price</span>`
    : task.netCoins !== undefined && task.grossCoins !== undefined && task.netCoins !== task.grossCoins
      ? // What you hand over, and what it comes to once the copy it replaces is sold.
        `${coins(task.grossCoins)}<span class="net">${coins(task.netCoins)} net</span>`
      : (bundled ? task.bundleCoins : task.coins) === 0
        ? `<span class="free">free</span>`
        : coins(bundled ? task.bundleCoins : task.coins);

  const shownName = bundled && task.bundleSpan ? task.bundleSpan : task.name;
  const shownNote = bundled && task.bundleNote ? task.bundleNote : task.note;

  // A contact list is seventy rows long and only the one you are walking to needs an address, so
  // the name is the control: click it and the island and coordinates appear on that row.
  const whereKey = `where:${task.id}`;
  const nameCell = task.where
    ? `<button class="npc-name" data-toggle="${whereKey}" title="Where to find them">${escapeHtml(shownName)}</button>${
        open.has(whereKey) ? `<span class="where">${escapeHtml(task.where)}</span>` : ""
      }`
    : escapeHtml(shownName);

  const aside = task.id.startsWith("bag_upgrade_");

  return `<li class="task${aside ? " aside" : ""}">
    <span class="task-name">${tag ? `<span class="tag cat">${escapeHtml(tag)}</span>` : ""}${nameCell}${
      bundled ? `<span class="tag">+${task.bundle.length} prereq</span>` : ""
    }${task.estimated ? `<span class="tag est" title="Nothing is listing this right now — reference price">est</span>` : ""}${
      task.blocked
        ? `<span class="tag locked" title="The ingredients are not the obstacle — the merchant will not sell you this yet.">${escapeHtml(
            task.blocked,
          )}</span>`
        : ""
    }${
      shownNote ? `<span class="note">${escapeHtml(shownNote)}</span>` : ""
    }</span>
    <span class="task-xp">${bundled ? task.bundleXp : task.xp} xp</span>
    <span class="task-cost">${priceText}</span>
    <span class="task-rate">${rate(task.efficiency)}</span>
  </li>`;
}

/**
 * One line of a plan, where a "line" may be several tiers of the same thing folded together —
 * "Arthropod Resistance 1–6, 30× Voracious Spider Shard" rather than six near-identical rows.
 */
function runRow(run: TaskRun, tag?: string): string {
  const merged = run.tasks.length > 1;
  const efficiency = run.coins !== null && run.xp > 0 ? run.coins / run.xp : null;
  const aside = run.tasks[0]?.id.startsWith("bag_upgrade_") ?? false;

  return `<li class="task${aside ? " aside" : ""}">
    <span class="task-name">${tag ? `<span class="tag cat">${escapeHtml(tag)}</span>` : ""}${escapeHtml(run.name)}${merged ? `<span class="count">×${run.tasks.length}</span>` : ""}${
      run.note ? `<span class="note">${escapeHtml(run.note)}</span>` : ""
    }</span>
    <span class="task-xp">${run.xp} xp</span>
    <span class="task-cost">${run.coins === null ? `<span class="dim">no price</span>` : coins(run.coins)}</span>
    <span class="task-rate">${rate(efficiency)}</span>
  </li>`;
}

const runRows = (tasks: ResolvedTask[]): string => groupTaskRuns(tasks).map((run) => runRow(run)).join("");

function planView(report: Report): string {
  const { plan } = report;
  const currentLevel = Math.floor(report.progress.xp / XP_PER_LEVEL);
  const afterLevel = Math.floor((report.progress.xp + plan.reachedXp) / XP_PER_LEVEL);

  const stats = `<div class="stats">
    ${stat("XP gained", num(plan.reachedXp), `target ${num(plan.targetXp)}`, true)}
    ${stat("Levels gained", `+${plan.levelsGained}`, `${currentLevel} → ${afterLevel}`)}
    ${stat("Coins spent", coins(plan.coins), plan.reachedXp ? `${coins(plan.coins / plan.reachedXp)}/xp` : "—")}
    ${stat("Trips", String(plan.groups.length), `${plan.groups.reduce((s, g) => s + g.tasks.length, 0)} tasks`)}
  </div>`;

  const short = plan.short
    ? `<p class="warn">The priced task pool tops out at ${num(plan.reachedXp)} XP — short of ${num(
        plan.targetXp,
      )}. Lower the XP floor, enable more categories, or raise the budget.</p>`
    : "";

  const groups = plan.groups
    .map(
      (group) => `<div class="panel">
        <button class="group-head" data-toggle="plan:${group.category}">
          <span class="group-name">${CATEGORY_LABELS[group.category]}</span>
          <span class="dim">${group.tasks.length} tasks</span>
          <span class="group-xp">${num(group.xp)} xp</span>
          <span class="group-cost">${coins(group.coins)}</span>
          <span class="chev">${open.has(`plan:${group.category}`) ? "−" : "+"}</span>
        </button>
        ${
          open.has(`plan:${group.category}`)
            ? `<ul class="tasks">${runRows(group.tasks)}</ul>`
            : ""
        }
      </div>`,
    )
    .join("");

  const empty = plan.groups.length
    ? ""
    : `<p class="empty">Nothing eligible. Every priced task is either done, below the XP floor, or outside the budget.</p>`;

  return stats + short + groups + empty;
}

function stat(label: string, value: string, sub: string, gold = false): string {
  return `<div class="stat">
    <div class="stat-label">${label}</div>
    <div class="stat-value${gold ? " gold" : ""}">${value}</div>
    <div class="stat-sub">${sub}</div>
  </div>`;
}

/**
 * The package view: successive fixed-size shopping trips. Each card is a budget you could
 * actually spend in one sitting, and the rate column is the point — it climbs package by
 * package as the cheap XP runs out, which is the signal for when to stop buying.
 */
function packagesView(report: Report): string {
  const { packages, packageSize, exhausted, totalBleedXp, totalIdealXp } = report.packages;

  if (!packages.length) {
    return `<p class="empty">Nothing affordable at ${coins(packageSize)} per package. Lower the XP floor, enable
      more categories, or load accessory prices.</p>`;
  }

  const best = packages[0].rate;

  const cards = packages
    .map((pkg) => {
      const key = `pkg:${pkg.index}`;
      const isOpen = open.has(key);
      // How much worse this package is than the first — the shape of the decay.
      const decay = best > 0 ? pkg.rate / best : 1;

      return `<div class="panel">
        <button class="group-head" data-toggle="${key}">
          <span class="pkg-index">${pkg.index}</span>
          <span class="group-name">${coins(pkg.coins)}<span class="note">of ${coins(packageSize)}</span></span>
          <span class="group-xp">${num(pkg.xp)} xp</span>
          <span class="group-cost">${coins(pkg.rate)}/xp${
            decay > 1.05 ? `<span class="note">${decay.toFixed(1)}× package 1</span>` : ""
          }</span>
          <span class="bleed${pkg.bleedXp >= 1 ? " on" : ""}">${
            pkg.bleedXp >= 1 ? `−${num(Math.round(pkg.bleedXp))} xp` : "—"
          }</span>
          <span class="chev">${isOpen ? "−" : "+"}</span>
        </button>
        ${
          isOpen
            ? `<div class="group-body">
                <p class="sub">Running total: ${coins(pkg.cumulativeCoins)} spent · ${num(
                  pkg.cumulativeXp,
                )} XP · +${pkg.cumulativeLevels} levels${
                  pkg.bleedXp >= 1
                    ? ` · buying by pure efficiency, the same coins reach ${num(
                        Math.round(pkg.idealXp),
                      )} XP — this plan bleeds ${num(Math.round(pkg.bleedXp))}`
                    : ""
                }</p>
                ${packageGroups(pkg, report.progress.xp)}
              </div>`
            : ""
        }
      </div>`;
    })
    .join("");

  const last = packages[packages.length - 1];
  const summary = `<div class="stats">
    ${stat("Packages", String(packages.length), `${coins(packageSize)} each`)}
    ${stat("XP total", num(last.cumulativeXp), `+${last.cumulativeLevels} levels`, true)}
    ${stat("Coins total", coins(last.cumulativeCoins), "across all packages")}
    ${stat(
      "Bled",
      totalBleedXp >= 1 ? `−${num(Math.round(totalBleedXp))} xp` : "none",
      totalIdealXp > 0 ? `${(100 * (last.cumulativeXp / totalIdealXp)).toFixed(0)}% of ideal` : "—",
    )}
  </div>
  <p class="sub bleed-note">Bled = XP given up for convenience. The baseline buys strictly by
  coins per XP with no package walls and <em>no XP floor</em> — including the 1&nbsp;XP chores this
  tool exists to hide. Raise the floor and this number climbs; that is the trade being made.</p>`;

  const note = exhausted
    ? `<p class="warn">The affordable pool ran out after ${packages.length} package${
        packages.length === 1 ? "" : "s"
      } — there is nothing else with a live price to buy.</p>`
    : "";

  return summary + note + cards;
}


const BAND_LABEL: Record<string, string> = {
  nearly: "Nearly there",
  quick: "Quick",
  short: "A session",
  long: "A long haul",
  marathon: "A marathon",
};

const BAND_BLURB: Record<string, string> = {
  nearly: "Already 95% collected. Finish these before starting anything.",
  quick: "Most players already have these. Usually a few minutes.",
  short: "The typical player has done about half of these.",
  long: "A minority have finished these — expect real time.",
  marathon: "Rare. These are the projects people plan around.",
};

/**
 * A task the player is all but standing on top of.
 *
 * This has to be its own band rather than only a sort key, because the panels below regroup by
 * effort — and effort is a population statistic that describes a task from a standing start. A
 * Cobblestone tier 300 items from the end still bands as a marathon, so sorting it to the front
 * of the flat list would put it straight back at the bottom of the last panel.
 */
function nearlyDone(t: { progress?: number }): boolean {
  return t.progress !== undefined && t.progress >= 0.95 && t.progress < 1;
}

/**
 * Free XP, ordered by how much work it looks like — the one ranking that ignores category
 * walls. Difficulty comes from how many sampled players have already finished each task, which
 * is a proxy for effort rather than a measurement, so it is shown in coarse bands.
 */
/**
 * Query D: everything buyable in one list, cheapest per XP first, category walls down.
 *
 * "Group maxed" folds each multi-tier thing into the single purchase it really is — all ten
 * levels of an attribute, but only the best tier of a pet, since the lower ones stop counting
 * the moment you own the higher one.
 */
function cheapestView(report: Report): string {
  const { tasks, truncated, grouped, groupedTruncated } = report.cheapest;
  const on = open.has("cheapest:grouped");
  const hidden = on ? groupedTruncated : truncated;
  // The list is bought top to bottom, so mark where the running total tips into a new level.
  const rows = on
    ? withLevelMarks(
        grouped.map((run) => runRow(run, CATEGORY_LABELS[run.tasks[0].category])),
        grouped.map((run) => run.xp),
        grouped.map((run) => run.coins),
        report.progress.xp,
      )
    : withLevelMarks(
        tasks.map((t) => taskRow(t, true, CATEGORY_LABELS[t.category])),
        tasks.map((t) => t.bundleXp),
        tasks.map((t) => t.bundleCoins),
        report.progress.xp,
      );

  return `<div class="panel pad group-toggle">
      <button class="chip${on ? " on" : ""}" data-toggle="cheapest:grouped">Group maxed</button>
      <span class="dim">${
        on
          ? "each thing folded into one purchase — every tier of an attribute, the best tier of a pet"
          : "one row per individual upgrade"
      }</span>
      <span class="dim push">${num(on ? grouped.length : tasks.length)} shown</span>
    </div>
    <ul class="tasks panel">${rows}</ul>
    ${
      hidden > 0
        ? `<p class="sub">+${num(hidden)} more, all worse value than everything above. Narrow the categories or raise the XP floor to bring the tail into view.</p>`
        : ""
    }`;
}

function grindView(report: Report): string {
  const { grind } = report;
  if (!grind.length) {
    return `<p class="empty">No grind tasks left above the XP floor in the categories you have enabled.</p>`;
  }

  const intro = `<p class="sub bleed-note">Free XP, easiest first, across every category at once. Difficulty is
    estimated from how many real players have already finished each task — a proxy for effort, not a measurement of
    it — so it is grouped into bands rather than pretending to a precise ordering. Two things jump that ordering
    because it cannot see them: <strong>collections you are already 95% through</strong> lead the list whatever
    band they would land in, since effort describes a task from a standing start and not from where you are
    standing; and bestiary tiers are ranked on the kills they actually have left.</p>`;

  const bands = ["nearly", "quick", "short", "long", "marathon"];
  const byBand = bands.map((band) =>
    band === "nearly"
      ? grind.filter(nearlyDone)
      : grind.filter((t) => !nearlyDone(t) && (t.effortBand ?? "marathon") === band),
  );

  // The bands are worked through in order, so the running total carries across them: a level
  // earned late in the quick jobs doesn't restart when the short ones begin.
  const marks = levelMarks(
    byBand.flat().map((task) => task.xp),
    report.progress.xp,
  );

  let index = 0;
  const panels = bands
    .map((band, bandIndex) => {
      const tasks = byBand[bandIndex];
      if (!tasks.length) return "";
      const xp = tasks.reduce((sum, t) => sum + t.xp, 0);
      const rows = tasks
        .map((task) => {
          const crossed = marks.get(index++);
          const row = `<li class="grind-item">
            <div class="grind-cat">${CATEGORY_LABELS[task.category]}</div>
            <ul>${taskRow(task, false)}</ul>
          </li>`;
          return row + (crossed ? crossed.map((level) => levelMark(level)).join("") : "");
        })
        .join("");

      return `<div class="panel">
        <div class="group-head" style="cursor:default">
          <span class="group-name">${BAND_LABEL[band]}</span>
          <span class="flex-note dim">${BAND_BLURB[band]}</span>
          <span class="group-xp">${num(xp)} xp</span>
        </div>
        <ul class="tasks">${rows}</ul>
      </div>`;
    })
    .join("");

  return intro + panels;
}

/**
 * Where the pet category stands, in two numbers that are not the same number.
 *
 * SkyBlock XP is settled on the highest pet score the profile has ever reached, not on what its
 * pets are worth today — so selling one drops the score and keeps the XP. Only the highest is
 * published; what you hold now is worked out from the pets themselves, and the max-level count
 * comes with it because a pet at its ceiling is worth a point beyond its rarity.
 */
function petScoreNote(report: Report): string {
  const { current, highest, max, owned, maxLevel } = report.petScore;
  if (highest === 0 && owned === 0) return "";

  // Three figures and no argument. Why the highest is the one that paid is worth knowing once
  // and not worth reading every time the panel opens, so it lives on the tooltip.
  const pets = owned === 1 ? "pet you own is" : "pets you own are";
  return `<p class="sub" title="SkyBlock XP is settled on the highest score you have ever reached, so selling a pet drops the score and keeps the XP.">Pet score ${num(
    current,
  )} of ${num(max)} · highest ${num(highest)} · ${num(maxLevel)} of the ${num(owned)} ${pets} at max level</p>`;
}

function browserView(report: Report): string {
  const categories = report.browser
    .map((entry) => {
      const { category, summary, tasks, truncated, maxed, maxedTruncated, unpriced, unpricedTruncated } = entry;
      const key = `browser:${category}`;
      // Same toggled-key mechanism as the panels themselves, so the grouped view needs no
      // event plumbing of its own.
      const groupKey = `maxed:${category}`;
      const isGrouped = maxed !== undefined && open.has(groupKey);
      // Coins finish most of a category and none of the rest of it, and the rest is what a
      // player planning an evening's grinding wants to see. Reusing the same toggled-key
      // mechanism as the panels, so it needs no event plumbing of its own.
      const unpricedKey = `unpriced:${category}`;
      const showUnpriced = unpriced !== undefined && open.has(unpricedKey);

      // Jacobus sells 99 of one thing, so his rows are a tenth of this category and say nothing
      // about which accessory to buy. Hidden they stay out of the way; shown they mark where the
      // bag runs out of room.
      const jacobusKey = `jacobus:${category}`;
      const hideJacobus = category === "accessory_bag" && open.has(jacobusKey);

      // A pet's rarity ladder is most of what this category is, and climbing it a rung at a time
      // is not how anyone buys one — so the ladder comes out and each pet is the one purchase it
      // really is.
      const topRarityKey = `toprarity:${category}`;
      const onlyTopRarity = entry.topRarity !== undefined && open.has(topRarityKey);

      // The bestiary ranks on how much work a tier is, measured against its own family's ladder.
      // That buries the tier you are one kill from finishing, so the other order is a click away.
      const closestKey = `closest:${category}`;
      const byClosest = entry.closest !== undefined && open.has(closestKey);

      // Independent questions — "one row per thing", "only the top rarity", "only what I cannot
      // buy" — so they can be on at once, and each combination is a list of its own rather than
      // one toggle quietly cancelling the other.
      // Closest-first stands outside that: it is the same rows in another order, and it is only
      // ever offered on the one category where none of the others are.
      const chosen = byClosest
        ? entry.closest!
        : isGrouped
          ? showUnpriced
            ? (entry.unpricedMaxed ?? [])
            : maxed!
          : onlyTopRarity
            ? showUnpriced
              ? (entry.topRarityUnpriced ?? [])
              : entry.topRarity!
            : showUnpriced
              ? unpriced!
              : tasks;
      const rows = hideJacobus
        ? (chosen as { tasks?: ResolvedTask[]; id?: string }[]).filter((row) =>
            row.id ? !row.id.startsWith("bag_upgrade_") : !row.tasks?.[0]?.id.startsWith("bag_upgrade_"),
          )
        : chosen;
      const hidden = byClosest
        ? (entry.closestTruncated ?? 0)
        : isGrouped
          ? showUnpriced
            ? (entry.unpricedMaxedTruncated ?? 0)
            : (maxedTruncated ?? 0)
          : onlyTopRarity
            ? showUnpriced
              ? (entry.topRarityUnpricedTruncated ?? 0)
              : (entry.topRarityTruncated ?? 0)
            : showUnpriced
              ? (unpricedTruncated ?? 0)
              : truncated;

      const body = open.has(key)
        ? `<div class="group-body">
            ${
              summary.pricedXp > 0 && summary.pricedXp < summary.remainingXp
                ? `<p class="sub">${num(summary.pricedXp)} of ${num(summary.remainingXp)} remaining XP has a live price.</p>`
                : ""
            }
            ${
              // The one category whose total is two unlike things added together. Said out loud
              // here because the sum of it and the magical power you hold overshoots the game's
              // maximum by exactly the slots you have left, which reads as a bug and is not one.
              category === "accessory_bag" && report.bag.powerLeft > 0
                ? `<p class="sub">${num(report.bag.powerLeft)} of that is magical power, the other ${num(
                    summary.remainingXp - report.bag.powerLeft,
                  )} bag slots from Jacobus.</p>`
                : ""
            }
            ${
              // Pet score is the one category where what you hold and what you were paid for
              // come apart: the XP is settled on the highest score you have ever reached, so a
              // pet sold on takes the score with it and leaves the XP behind. Both numbers, or
              // the readout is telling half the story.
              category === "pets" ? petScoreNote(report) : ""
            }
            ${
              category === "accessory_bag"
                ? `<p class="sub group-toggle">
                    <button class="chip${hideJacobus ? " on" : ""}" data-toggle="${jacobusKey}">Hide Jacobus</button>
                    <span class="dim">${
                      hideJacobus
                        ? "bag slots hidden — accessories only"
                        : "bag slots are shown where the bag runs out of room"
                    }</span>
                  </p>`
                : ""
            }
            ${
              entry.closest !== undefined
                ? `<p class="sub group-toggle">
                    <button class="chip${
                      byClosest ? " on" : ""
                    }" data-toggle="${closestKey}">Fewest kills</button>
                    <span class="dim">${
                      byClosest
                        ? "closest to the next tier first, whatever the family — a rare mob one kill away leads"
                        : "least work first, each tier measured against its own family's ladder"
                    }</span>
                  </p>`
                : ""
            }
            ${
              entry.topRarity !== undefined
                ? `<p class="sub group-toggle">
                    <button class="chip${
                      onlyTopRarity ? " on" : ""
                    }" data-toggle="${topRarityKey}">Top rarity only</button>
                    <span class="dim">${
                      onlyTopRarity
                        ? "one row per pet, the best rarity it reaches — priced from what you own rather than from the rarity below it"
                        : "the whole ladder, so a pet can appear once per rung on the way up"
                    }</span>
                  </p>`
                : ""
            }
            ${
              unpriced !== undefined
                ? `<p class="sub group-toggle">
                    <button class="chip${showUnpriced ? " on" : ""}" data-toggle="${unpricedKey}">No price</button>
                    <span class="dim">${
                      showUnpriced
                        ? "only what coins cannot finish — go and get these"
                        : `${num(unpriced.length + (unpricedTruncated ?? 0))} of these cannot be bought at any price`
                    }</span>
                  </p>`
                : ""
            }
            ${
              maxed !== undefined
                ? `<p class="sub group-toggle">
                    <button class="chip${isGrouped ? " on" : ""}" data-toggle="${groupKey}">Group maxed</button>
                    <span class="dim">${
                      isGrouped
                        ? `one row per ${GROUP_NOUN[category] ?? "thing"} — everything it takes to max it`
                        : `one row per ${GROUP_STEP[category] ?? "level"}`
                    }</span>
                  </p>`
                : ""
            }
            <ul class="tasks">${
              isGrouped
                ? (rows as TaskRun[]).map((run) => runRow(run)).join("")
                : (rows as ResolvedTask[]).map((t) => taskRow(t, true)).join("")
            }</ul>
            ${
              isGrouped && showUnpriced && rows.length === 0
                ? `<p class="sub">Nothing in this category is both groupable and unbuyable.</p>`
                : ""
            }
            ${hidden > 0 ? `<p class="sub">+${num(hidden)} more above the XP floor</p>` : ""}
          </div>`
        : "";

      return `<div class="panel">
        <button class="group-head" data-toggle="${key}">
          <span class="group-name">${categoryLabel(category, data)}${inaccuracyBadge(report, category)}</span>
          <span class="dim">${num(summary.remainingTasks)} left</span>
          <span class="group-xp">${num(summary.remainingXp)} xp</span>
          <span class="group-cost">${
            summary.pricedXp > 0
              ? `${coins(summary.pricedCoins)}<span class="note">buys ${num(summary.pricedXp)} xp</span>`
              : `<span class="dim">grind only</span>`
          }</span>
          <span class="chev">${open.has(key) ? "−" : "+"}</span>
        </button>
        ${body}
      </div>`;
    })
    .join("");

  const unmodelled = `<div class="panel pad">
    <h3>Not modelled, or only in part</h3>
    <p class="sub">What each of these is missing, and why. Listed so the totals above read as coverage rather than as the whole game.</p>
    <ul class="unmodelled">
      ${report.unmodelled
        .map(
          (entry) => `<li>
            <span class="um-name">${CATEGORY_LABELS[entry.category]}</span>
            ${
              entry.totalXp
                ? `<span class="um-xp">${
                    entry.earnedXp !== undefined ? `${num(entry.earnedXp)} of ` : "~"
                  }${num(entry.totalXp)} xp</span>`
                : ""
            }
            <span class="dim">${escapeHtml(entry.note)}</span>
          </li>`,
        )
        .join("")}
    </ul>
  </div>`;

  return categories + unmodelled;
}

const open = new Set<string>();


/* ---------------------------------------------------------------- rendering */

/**
 * The page renders in two halves, and the split is load-bearing.
 *
 * Controls are painted once and then left alone; only the results half repaints as you type.
 * Repainting an <input> while someone is typing into it destroys the element and recreates it,
 * which drops the caret to position 0 — so every keystroke would throw the cursor back to the
 * far left of the field. Never re-render a control the user is inside.
 */
const root = document.getElementById("app")!;

function renderShell(): void {
  root.innerHTML = `
    <header>
      <h1>SkyBlock <span class="gold" id="sectiontitle"></span></h1>
      <p class="sub" id="sectionsub"></p>
      <div class="tabs sections">
        <button class="chip" data-section="planner">XP Planner</button>
        <button class="chip" data-section="bazaar">Bazaar</button>
        <button class="chip" data-section="greenhouse">Greenhouse</button>
        <button class="chip" data-section="minions">Minions</button>
      </div>
    </header>
    <div id="planner">
      <form class="panel pad controls" id="controls"></form>
      <div id="status"></div>
      <div id="results"></div>
    </div>
    <div id="bazaar" hidden></div>
    <div id="greenhouse" hidden></div>
    <div id="minions" hidden></div>
  `;

  // Delegated once on the container, so nothing needs re-binding after a repaint.
  root.addEventListener("submit", (event) => {
    event.preventDefault();
    void loadPlayer();
  });

  // A solve is tens of milliseconds for most tabs and the better part of a second for the
  // packages: fine once, unusable at the ~60 events a second a drag produces. Text fields
  // debounce; the slider defers to its release (below), which is the confirm step without an
  // extra button to press; the category chips go through the same debounce, since narrowing a
  // plan is a run of clicks and not one.
  root.addEventListener("input", (event) => {
    const el = event.target as HTMLInputElement;
    switch (el.id) {
      case "username":
        state.username = el.value;
        return; // nothing on screen depends on it until Load is pressed
      case "apikey":
        state.apiKey = el.value;
        localStorage.setItem("sbxp:key", el.value.trim());
        return;
      case "budget":
        state.budget = el.value;
        break;
      case "target":
        if (state.targetMode === "xp") state.target = Number(el.value) || 1;
        else state.targetLevel = Number(el.value) || 1;
        break;
      case "packagesize":
        state.packageSize = el.value;
        localStorage.setItem("sbxp:packageSize", el.value);
        break;
      case "packagecount":
        state.packageCount = Math.min(Math.max(Number(el.value) || 1, 1), 20);
        break;
      case "minxp": {
        state.minXp = Number(el.value);
        // Track the handle live, but don't solve until it's let go.
        const label = document.getElementById("minxpvalue");
        if (label) label.textContent = String(state.minXp);
        markPending(true);
        return;
      }
      default:
        return;
    }
    scheduleSolve();
  });

  // Release of the slider (or an arrow-key nudge) is the commit.
  root.addEventListener("change", (event) => {
    if ((event.target as HTMLElement).id !== "minxp") return;
    solveNow();
    markPending(false);
    renderResults();
  });

  root.addEventListener("change", (event) => {
    const el = event.target as HTMLSelectElement;
    if (el.id !== "profile") return;
    state.profileId = el.value;
    void loadProfile();
  });

  // Committing with the keyboard shouldn't need the mouse.
  root.addEventListener("keydown", (event) => {
    const key = (event as KeyboardEvent).key;
    if (key !== "Enter") return;
    const el = event.target as HTMLElement;
    if (el.tagName !== "INPUT") return;
    event.preventDefault();
    flushSolve();
  });

  root.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;

    const toggle = target.closest<HTMLElement>("[data-toggle]");
    if (toggle) {
      const key = toggle.dataset.toggle!;
      if (open.has(key)) open.delete(key);
      else open.add(key);
      renderResults();
      return;
    }

    const section = target.closest<HTMLElement>("[data-section]");
    if (section) {
      state.section = section.dataset.section as State["section"];
      localStorage.setItem("sbxp:section", state.section);
      renderSection();
      return;
    }

    const tab = target.closest<HTMLElement>("[data-tab]");
    if (tab) {
      state.tab = tab.dataset.tab as State["tab"];
      // A report works each view out the first time it is asked for, and they are not the same
      // size — the packages are six solves. So the tab strip is moved by hand and the body
      // follows in its own turn, rather than the click sitting on an unpainted page while the
      // view it asked for is worked out.
      for (const chip of root.querySelectorAll<HTMLElement>("[data-tab]")) {
        chip.classList.toggle("on", chip.dataset.tab === state.tab);
      }
      markPending(true);
      setTimeout(() => {
        renderResults();
        // A knob moved in the last moment leaves the results dimmed until its own solve lands;
        // this repaint answered a different question and does not clear that.
        markPending(solvePending());
      }, 0);
      return;
    }

    // The chips repaint at once and the solve follows on the same debounce the text fields use.
    // Narrowing a plan is a run of clicks — off with the museum, off with the dungeons, off with
    // the rift — and solving each of them in the click handler meant every click after the first
    // waited behind the last one's answer, which nobody had finished asking for.
    const category = target.closest<HTMLElement>("[data-category]");
    if (category) {
      const key = category.dataset.category as Category;
      if (state.categories.has(key)) state.categories.delete(key);
      else state.categories.add(key);
      renderControls();
      scheduleSolve();
      return;
    }

    const strategy = target.closest<HTMLElement>("[data-strategy]");
    if (strategy) {
      state.strategy = strategy.dataset.strategy as "greedy" | "exact";
      renderControls();
      scheduleSolve();
      return;
    }

    if (target.closest("#targetmode")) {
      state.targetMode = state.targetMode === "xp" ? "level" : "xp";
      renderControls();
      scheduleSolve();
      return;
    }

    if (target.closest("#loadbins")) {
      void loadAuctions();
      return;
    }

    if (target.closest("#refreshprices")) void refreshPrices();
  });
}

function renderControls(): void {
  const profileOptions = state.profiles
    .map(
      (p) =>
        `<option value="${p.profile_id}"${p.profile_id === state.profileId ? " selected" : ""}>${escapeHtml(
          p.cute_name,
        )}${p.selected ? " (active)" : ""}</option>`,
    )
    .join("");

  const categoryChips = CATEGORIES.map(
    (c) =>
      `<button class="chip${state.categories.has(c) ? " on" : ""}" data-category="${c}">${CATEGORY_LABELS[c]}</button>`,
  ).join("");

  document.getElementById("controls")!.innerHTML = `
    <div class="row">
      <label>Minecraft username
        <input id="username" value="${escapeHtml(state.username)}" placeholder="e.g. Refraction" autocomplete="off">
      </label>
      <label>Profile
        <select id="profile" ${state.profiles.length ? "" : "disabled"}>
          ${profileOptions || "<option>—</option>"}
        </select>
      </label>
      <label>Hypixel API key
        <a class="get-key" href="https://developer.hypixel.net/dashboard" target="_blank" rel="noopener noreferrer">Get an API key ↗</a>
        <input id="apikey" value="${escapeHtml(state.apiKey)}" placeholder="paste your key" autocomplete="off">
      </label>
      <button type="submit" class="primary" ${state.status.kind === "busy" ? "disabled" : ""}>
        ${state.status.kind === "busy" ? "Working…" : "Load"}
      </button>
    </div>

    <div class="row">
      <label>${state.targetMode === "xp" ? "XP target" : "Target level"}
        <span class="inline">
          <input id="target" type="number" min="1" value="${
            state.targetMode === "xp" ? state.target : state.targetLevel
          }">
          <button type="button" class="chip" id="targetmode" title="Switch between an XP target and a SkyBlock level">${
            state.targetMode === "xp" ? "xp" : "lvl"
          }</button>
        </span>
      </label>
      <label>Coin budget
        <input id="budget" value="${escapeHtml(state.budget)}" placeholder="optional · 50M">
      </label>
      <label>Package size
        <input id="packagesize" value="${escapeHtml(state.packageSize)}" placeholder="10M">
      </label>
      <label>Packages ahead
        <input id="packagecount" type="number" min="1" max="20" value="${state.packageCount}">
      </label>
      <label>Solver
        <span class="inline">
          <button type="button" class="chip${
            state.strategy === "greedy" ? " on" : ""
          }" data-strategy="greedy">greedy</button>
          <button type="button" class="chip${
            state.strategy === "exact" ? " on" : ""
          }" data-strategy="exact">exact</button>
        </span>
      </label>
    </div>

    <div class="row">
      <label class="wide">Minimum XP per task — <span id="minxpvalue">${state.minXp}</span>
        <span class="hint">hides the death-by-a-thousand-clicks tail · whatever it hides is charged as bleed in Packages</span>
        <input id="minxp" type="range" min="0" max="30" value="${state.minXp}">
      </label>
    </div>

    <div class="chips">${categoryChips}</div>
  `;
}

/** "bazaar 40s old · auctions 6m old" — so the refresh button has something to argue with. */
function priceAge(): string {
  const describe = (label: string, key: string) => {
    const age = cacheAge(key);
    if (age === null) return null;
    const seconds = Math.round(age / 1000);
    if (seconds < 90) return `${label} ${seconds}s old`;
    return `${label} ${Math.round(seconds / 60)}m old`;
  };
  return [describe("bazaar", "bazaar"), describe("auctions", "bins")].filter(Boolean).join(" · ");
}

function renderStatus(): void {
  const host = document.getElementById("status")!;
  host.innerHTML =
    state.status.kind === "error"
      ? `<p class="error">${escapeHtml(state.status.message)}</p>`
      : state.status.kind === "busy"
        ? `<p class="busy">${escapeHtml(state.status.message)}</p>`
        : "";
}

function renderResults(): void {
  const r = state.report;
  const host = document.getElementById("results")!;

  if (!r) {
    host.innerHTML = `<p class="empty">Enter a username and press Load. Everything runs in this page — the only
      thing leaving your browser is the calls to Hypixel.</p>`;
    return;
  }

  const binsNote = state.bins
    ? `${num(Object.keys(state.bins.prices).length)} accessories priced from ${num(state.bins.listings)} BIN listings`
    : `accessory prices not loaded`;

  host.innerHTML = `
    <div class="meta">
      <strong>${escapeHtml(state.playerName ?? "")}</strong>
      <span class="dim">Level ${Math.floor(r.progress.xp / XP_PER_LEVEL)} · ${num(r.progress.xp)} XP</span>
      <span class="dim">${num(r.progress.modelledRemainingXp)} XP still available</span>
      <span class="dim" title="How much of your earned XP this tool can account for.">models ${Math.round(
        (100 * r.progress.modelledEarnedXp) / Math.max(r.progress.xp, 1),
      )}% of your earned XP</span>
      ${
        r.bag.capacity > 0
          ? `<span class="dim" title="Accessory bag slots. Once full, each further accessory also costs the slot it sits in.">${
              r.bag.capacity - r.bag.used
            } of ${r.bag.capacity} bag slots free</span>`
          : ""
      }
      ${
        r.bag.reportedMp !== null
          ? `<span class="dim" title="Magical power you hold, and the most this bag can reach. The Accessory Bag category totals more than the difference because it also holds the bag's slot upgrades, and those are XP for buying room rather than magical power.">${
              r.bag.computedMp
            } of ${r.bag.computedMp + r.bag.powerLeft} MP${
              r.bag.reportedMp !== r.bag.computedMp ? ` · <span class="gold">${r.bag.reportedMp} reported</span>` : ""
            }</span>`
          : ""
      }
      ${state.bins ? "" : `<button type="button" class="chip alert" id="loadbins">Load auction prices (49 pages)</button>`}
      <button type="button" class="chip" id="refreshprices" title="Re-pull the bazaar${
        state.bins ? " and re-sweep the auction house" : ""
      }, ignoring the cache">Refresh prices</button>
      <span class="dim">${priceAge()}</span>
    </div>

    <div class="tabs">
      <button class="chip${state.tab === "plan" ? " on" : ""}" data-tab="plan">Batch plan</button>
      <button class="chip${state.tab === "packages" ? " on" : ""}" data-tab="packages">Packages</button>
      <button class="chip${state.tab === "cheapest" ? " on" : ""}" data-tab="cheapest">Cheapest first</button>
      <button class="chip${state.tab === "grind" ? " on" : ""}" data-tab="grind">Grind order</button>
      <button class="chip${state.tab === "browser" ? " on" : ""}" data-tab="browser">Category browser</button>
    </div>

    ${
      state.tab === "plan"
        ? planView(r)
        : state.tab === "packages"
          ? packagesView(r)
          : state.tab === "cheapest"
            ? cheapestView(r)
            : state.tab === "grind"
              ? grindView(r)
              : browserView(r)
    }

    <footer>${binsNote} · task tables generated ${new Date(data.skills.generatedAt).toLocaleDateString()}${
      r.bag.readable ? "" : " · talisman bag unreadable, accessory XP may be overstated"
    }</footer>
  `;
}

/* -------------------------------------------------------------- scheduling */

let solveTimer: number | undefined;

/**
 * Re-solve shortly after the user stops fiddling. Solving on the raw event stream means a
 * dropped frame per keystroke and a slider that crawls; waiting for a pause costs nothing a
 * person can feel and keeps the knobs responsive.
 */
function scheduleSolve(): void {
  markPending(true);
  clearTimeout(solveTimer);
  solveTimer = window.setTimeout(() => {
    solveTimer = undefined;
    solveNow();
    markPending(false);
    renderResults();
  }, 180);
}

/** Solve right now, cancelling any pending run. */
function flushSolve(): void {
  clearTimeout(solveTimer);
  solveTimer = undefined;
  solveNow();
  markPending(false);
  renderResults();
}

/** True while a knob has been moved and the answer to it has not landed yet. */
const solvePending = (): boolean => solveTimer !== undefined;

/** Dim the results while they are known to be out of date. */
function markPending(pending: boolean): void {
  document.getElementById("results")?.classList.toggle("stale", pending);
}

/** Full repaint. Used on load and on status changes — never on a keystroke. */
/**
 * Show one half of the site and put the other away.
 *
 * The bazaar polls Hypixel every twenty seconds while it is on screen, so leaving it mounted
 * behind the planner would be a request a minute for a page nobody is looking at. Switching
 * away unmounts it; switching back starts it again with a fresh read.
 */
const SECTION_TITLES: Record<State["section"], [string, string]> = {
  planner: [
    "XP Planner",
    "The cheapest set of tasks that reaches your XP target — grouped by where you have to go, with the 1 XP filler filtered out.",
  ],
  bazaar: [
    "Bazaar",
    "Flips and crafts off a live read of the bazaar, ranked on coins per hour rather than on the spread.",
  ],
  greenhouse: [
    "Greenhouse",
    "Which mutation is worth growing, priced off the bazaar and ranked on what it pays for being left alone.",
  ],
  minions: [
    "Minions",
    "One rate, three questions: what a minion fills, what it pays, and what it levels.",
  ],
};

/**
 * The one inlined blob, split into the three shapes its child tabs actually read.
 *
 * Done here rather than in the build script because the split is a statement about the code —
 * the collection tab must not be able to reach a price, and the profit tab must not be able to
 * reach a collection — and a shape enforced at the call site is a shape TypeScript checks.
 */
function minionTables() {
  const d = window.__MINION_DATA__;
  return {
    collections: { production: d.production, modifiers: d.modifiers, collections: d.collections },
    profit: {
      production: d.production,
      modifiers: d.modifiers,
      storage: d.storage,
      drops: d.drops,
      recipes: d.recipes,
      npcPrices: d.npcPrices,
      names: d.names,
    },
    pets: {
      production: d.production,
      modifiers: d.modifiers,
      drops: d.drops,
      recipes: d.recipes,
      names: d.names,
      skillXp: d.skillXp,
      petXpRules: d.petXpRules,
      petLevels: d.petLevels,
    },
  };
}

function renderSection(): void {
  const showing = state.section;

  document.getElementById("planner")!.hidden = showing !== "planner";
  const bazaarHost = document.getElementById("bazaar")!;
  const greenhouseHost = document.getElementById("greenhouse")!;
  const minionHost = document.getElementById("minions")!;
  bazaarHost.hidden = showing !== "bazaar";
  greenhouseHost.hidden = showing !== "greenhouse";
  minionHost.hidden = showing !== "minions";

  const [title, sub] = SECTION_TITLES[showing];
  document.getElementById("sectiontitle")!.textContent = title;
  document.getElementById("sectionsub")!.textContent = sub;

  for (const chip of root.querySelectorAll<HTMLElement>("[data-section]")) {
    chip.classList.toggle("on", chip.dataset.section === state.section);
  }

  // Both live sections poll Hypixel every twenty seconds while they are on screen, so whichever
  // is not showing gets unmounted rather than left running behind the other.
  if (showing === "bazaar") mountBazaar(bazaarHost, window.__BAZAAR_DATA__);
  else unmountBazaar();

  if (showing === "greenhouse") mountGreenhouse(greenhouseHost, window.__GREENHOUSE_DATA__);
  else unmountGreenhouse();

  // The minions section carries three child tabs and one of them — raw profits — does poll, so
  // this unmount stops work as well as letting go of the host. The section decides which child is
  // live; switching away from the whole section stops all three.
  if (showing === "minions") mountMinionsSection(minionHost, minionTables());
  else unmountMinionsSection();
}

function render(): void {
  renderControls();
  renderStatus();
  renderResults();
  renderSection();
}

renderShell();
render();

/** What a grouped row stands for, and what an ungrouped one does, per category. */
const GROUP_NOUN: Partial<Record<Category, string>> = {
  attributes: "attribute",
  essence_shop: "perk",
};
const GROUP_STEP: Partial<Record<Category, string>> = {
  attributes: "shard level",
  essence_shop: "perk level",
};

/**
 * Interleave "you hit level N here" markers into a list of already-rendered rows.
 *
 * A ranked list is bought top to bottom, so the question at any point is not how much XP a row
 * is worth but what it gets you to. The marker goes *after* the row that crosses the boundary,
 * because that is the purchase that earned it.
 */
function withLevelMarks(rows: string[], xp: number[], spend: (number | null)[], startingXp: number): string {
  const dividers = levelDividers(xp, spend, startingXp);
  return rows
    .map((row, index) => {
      const here = dividers.filter((d) => d.index === index);
      return row + here.map((d) => levelMark(d.level, d.costToNext)).join("");
    })
    .join("");
}

/**
 * A divider naming the level the running total has just reached, and what the next one costs
 * from here. The last divider carries no figure: there is no next level in the list.
 */
function levelMark(level: number, costToNext: number | null = null): string {
  const cost = costToNext === null ? "" : `<span class="mark-cost">${coins(costToNext)} to next</span>`;
  return `<li class="level-mark"><span>Level ${level}</span>${cost}</li>`;
}

/**
 * A package's category groups, with the level markers running across them.
 *
 * The marks have to be computed over the package as a whole rather than per group: you buy the
 * lot, and a level earned partway through the minions doesn't restart at the museum. The offset
 * carries between packages too, so package 3 marks the levels package 3 actually reaches.
 */
function packageGroups(pkg: PackageEntry, currentXp: number): string {
  const startingXp = currentXp + pkg.cumulativeXp - pkg.xp;
  const runs = pkg.groups.map((group) => groupTaskRuns(group.tasks));
  const flat = runs.flat();
  const marks = levelMarks(
    flat.map((run) => run.xp),
    startingXp,
  );

  let index = 0;
  return pkg.groups
    .map((group, groupIndex) => {
      const body = runs[groupIndex]
        .map((run) => {
          const crossed = marks.get(index++);
          return runRow(run) + (crossed ? crossed.map((level) => levelMark(level)).join("") : "");
        })
        .join("");

      return `<div class="pkg-group">
        <div class="pkg-group-head">${CATEGORY_LABELS[group.category]}
          <span class="dim">${num(group.xp)} xp · ${coins(group.coins)}</span>
        </div>
        <ul class="tasks">${body}</ul>
      </div>`;
    })
    .join("");
}
/**
 * "+3 inaccuracy" / "-38 inaccuracy" — how far our count is from the profile's own.
 *
 * Negative means the profile holds things we could not place, so the category understates what
 * you have done; positive means we credited more than the profile reports. Silent when they
 * agree, which is the normal case and does not need saying.
 */
function inaccuracyBadge(report: Report, category: Category): string {
  const row = report.reconciliation?.find((r) => r.category === category);
  if (!row) return "";
  const delta = row.credited - row.reported;
  if (delta === 0) return "";
  const sign = delta > 0 ? "+" : "−";
  const title = `Your profile reports ${row.reported}; this app can account for ${row.credited}.`;
  return `<span class="inaccuracy" title="${escapeHtml(title)}">${sign}${Math.abs(delta)} inaccuracy</span>`;
}
