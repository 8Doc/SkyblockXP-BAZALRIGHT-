import { auctionNameIndex, categoryLabel, type BagItem, type GameData } from "../lib/gameData";
import { coins, num, rate } from "../lib/format";
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
import { ApiError, cacheAge, fetchAccessoryBins, fetchBazaar, fetchReferencePrices, fetchGarden, fetchMuseum, fetchProfiles, readBag, resolveUuid } from "./api";

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
  tab: "plan",
  status: { kind: "idle", message: "" },
  report: null,
};

/* ------------------------------------------------------------------ solving */

function solveNow(): void {
  if (!state.member || !state.catalog) return;
  const book: PriceBook = { bazaar: state.bazaar, bins: state.bins, reference: state.reference };
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
function parseBudget(input: string): number | null {
  const match = /^([\d.]+)\s*([kmb])?$/i.exec(input.trim());
  if (!match) return null;
  const scale = { k: 1e3, m: 1e6, b: 1e9 }[match[2]?.toLowerCase() ?? ""] ?? 1;
  return Math.round(Number(match[1]) * scale);
}

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

  setStatus("busy", "Reading accessory bag…");
  state.bagItems = await readBag(member.inventory?.bag_contents?.talisman_bag?.data);

  setStatus("busy", "Reading museum donations…");
  state.museum = await fetchMuseum(state.profileId, state.uuid, state.apiKey.trim());

  setStatus("busy", "Reading garden progress…");
  state.garden = await fetchGarden(state.profileId, state.apiKey.trim());

  setStatus("busy", "Fetching bazaar prices…");
  try {
    // Fetched alongside the bazaar: both are cheap, and the museum reads as half-empty without it.
    [state.bazaar, state.reference] = await Promise.all([fetchBazaar(), fetchReferencePrices()]);
  } catch (error) {
    setStatus("error", error instanceof ApiError ? error.message : String(error));
    return;
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
  );
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
    ? task.cost.kind === "none"
      ? `<span class="effort ${task.effortBand ?? "marathon"}" title="${
          task.effort === undefined
            ? "No completion data — treated as the longest grind"
            : `${Math.round((1 - task.effort) * 100)}% of sampled players have done this`
        }">${task.effortBand ?? "grind"}</span>`
      : `<span class="dim">no price</span>`
    : task.netCoins !== undefined && task.grossCoins !== undefined && task.netCoins !== task.grossCoins
      ? // What you hand over, and what it comes to once the copy it replaces is sold.
        `${coins(task.grossCoins)}<span class="net">${coins(task.netCoins)} net</span>`
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

  return `<li class="task">
    <span class="task-name">${tag ? `<span class="tag cat">${escapeHtml(tag)}</span>` : ""}${nameCell}${
      bundled ? `<span class="tag">+${task.bundle.length} prereq</span>` : ""
    }${task.estimated ? `<span class="tag est" title="Nothing is listing this right now — reference price">est</span>` : ""}${
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

  return `<li class="task">
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
  quick: "Quick",
  short: "A session",
  long: "A long haul",
  marathon: "A marathon",
};

const BAND_BLURB: Record<string, string> = {
  quick: "Most players already have these. Usually a few minutes.",
  short: "The typical player has done about half of these.",
  long: "A minority have finished these — expect real time.",
  marathon: "Rare. These are the projects people plan around.",
};

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
    it — so it is grouped into bands rather than pretending to a precise ordering. Bestiary tiers are the exception:
    they are ranked on the kills they actually have left.</p>`;

  const bands = ["quick", "short", "long", "marathon"];
  const byBand = bands.map((band) => grind.filter((t) => (t.effortBand ?? "marathon") === band));

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

function browserView(report: Report): string {
  const categories = report.browser
    .map(({ category, summary, tasks, truncated, maxed, maxedTruncated }) => {
      const key = `browser:${category}`;
      // Same toggled-key mechanism as the panels themselves, so the grouped view needs no
      // event plumbing of its own.
      const groupKey = `maxed:${category}`;
      const isGrouped = maxed !== undefined && open.has(groupKey);
      const hidden = isGrouped ? (maxedTruncated ?? 0) : truncated;

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
              isGrouped ? maxed!.map((run) => runRow(run)).join("") : tasks.map((t) => taskRow(t, true)).join("")
            }</ul>
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
      <h1>SkyBlock <span class="gold">XP Planner</span></h1>
      <p class="sub">The cheapest set of tasks that reaches your XP target — grouped by where you have to go, with the 1 XP filler filtered out.</p>
    </header>
    <form class="panel pad controls" id="controls"></form>
    <div id="status"></div>
    <div id="results"></div>
  `;

  // Delegated once on the container, so nothing needs re-binding after a repaint.
  root.addEventListener("submit", (event) => {
    event.preventDefault();
    void loadPlayer();
  });

  // A solve is ~60-90ms on a full profile: fine once, unusable at the ~60 events a second a
  // drag produces. Text fields debounce; the slider defers to its release (below), which is the
  // confirm step without an extra button to press.
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

    const tab = target.closest<HTMLElement>("[data-tab]");
    if (tab) {
      state.tab = tab.dataset.tab as State["tab"];
      renderResults();
      return;
    }

    const category = target.closest<HTMLElement>("[data-category]");
    if (category) {
      const key = category.dataset.category as Category;
      if (state.categories.has(key)) state.categories.delete(key);
      else state.categories.add(key);
      solveNow();
      renderControls();
      renderResults();
      return;
    }

    const strategy = target.closest<HTMLElement>("[data-strategy]");
    if (strategy) {
      state.strategy = strategy.dataset.strategy as "greedy" | "exact";
      solveNow();
      renderControls();
      renderResults();
      return;
    }

    if (target.closest("#targetmode")) {
      state.targetMode = state.targetMode === "xp" ? "level" : "xp";
      solveNow();
      renderControls();
      renderResults();
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
    solveNow();
    markPending(false);
    renderResults();
  }, 180);
}

/** Solve right now, cancelling any pending run. */
function flushSolve(): void {
  clearTimeout(solveTimer);
  solveNow();
  markPending(false);
  renderResults();
}

/** Dim the results while they are known to be out of date. */
function markPending(pending: boolean): void {
  document.getElementById("results")?.classList.toggle("stale", pending);
}

/** Full repaint. Used on load and on status changes — never on a keystroke. */
function render(): void {
  renderControls();
  renderStatus();
  renderResults();
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
