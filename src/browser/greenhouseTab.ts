import { normalise } from "../lib/bazaar";
import { baselineFrom, observe, observedFor, relativeTo, type Baseline, type CoflnetPoint } from "../lib/bazaarHistory";
import type { NpcPrice } from "../lib/bazaarViews";
import type { ProductSnapshot, RawBazaarProduct } from "../lib/bazaarTypes";
import { parseFilter, type FilterKind, type ParsedFilter } from "../lib/columnFilter";
import { depthNote } from "../lib/filters";
import { coins, num } from "../lib/format";
import {
  FULL_PLOT,
  OVERDRIVE_CHIP_FORTUNE,
  cropFortuneFromLore,
  cropResolver,
  cropUpgradeFortune,
  layoutStateOf,
  optimiseLayout,
  rankMutations,
  restoreLayout,
  settledLayouts,
  stageSeconds,
  yieldMultiplierOf,
  type GreenhouseData,
  type GrowthParams,
  type Mutation,
  type MutationProfit,
  type PriceMode,
} from "../lib/greenhouse";
import type { Packing } from "../lib/greenhouseLayout";

/**
 * The Greenhouse tab: which mutation is worth growing, and what it takes to grow it.
 *
 * Built the same way as the bazaar tab beside it — its own state, its own poll, no API key, no
 * username, no profile — because the answer is a function of the bazaar and a wiki table and
 * nothing about who is asking. The one thing it *would* want from a profile is Farming Fortune,
 * and that is a text box rather than a lookup; see `fortuneNote`.
 *
 * The ranking is coins an hour, which for an AFK method is really coins per growth stage divided
 * by how long a stage takes. Both halves are set by the player: the stage timer comes off the
 * upgrades, and how many stages a mutation needs comes off its spawn chance and its growth time.
 * It is ranked on but no longer printed — an hourly figure is the daily one over 24 and never
 * disagreed with it, so it was a column's width spent saying the same thing in smaller units.
 *
 * One thing does come from outside Hypixel: Coflnet's bazaar history, for the "vs usual" column.
 * See the block above `fetchHistory` for why a fetched average beats a measured one here.
 */

const BAZAAR = "https://api.hypixel.net/v2/skyblock/bazaar";
const REFRESH_MS = 20_017;
const GRACE_MS = 500;

function iconUrl(id: string): string {
  return `https://sky.coflnet.com/static/icon/${encodeURIComponent(id)}`;
}

type GreenhouseTables = { greenhouse: GreenhouseData; npcPrices: Record<string, NpcPrice> };

type Sort = { column: string; descending: boolean };

type State = {
  market: Map<string, ProductSnapshot>;
  lastUpdated: number | null;
  status: string;
  error: string | null;
  sort: Sort;
  /**
   * What is typed in each column's box, keyed by column id. Kept as typed rather than as parsed
   * predicates so a half-finished ">" survives a repaint and reads back exactly as it was left.
   */
  filters: Record<string, string>;
  /** Whether rows that fail a filter are dropped outright rather than sunk and dimmed. */
  hideFiltered: boolean;
  /** One greenhouse or all three. The wiki caps it at three. */
  plots: number;
  /**
   * Whether mutations are traded across the spread or by leaving an order up.
   *
   * On a deep book this would not deserve a control. On mutation books it is the single widest
   * uncertainty on the page — wider than fortune, wider than the layout — because the two sides of
   * a thin book can be a hundredfold apart.
   */
  priceMode: PriceMode;
  /** As typed. Empty means "use the estimate". */
  fortune: string;
  /**
   * Crop Fortune per crop, as typed, keyed by the wiki's crop name.
   *
   * Separate from the box above because it behaves differently: it lifts one crop rather than all
   * of them, so it is the only figure here that can change which mutation comes out on top.
   */
  cropFortune: Record<string, string>;
  /** Whether the per-crop boxes are on screen; they are a dozen inputs nobody always wants. */
  showCrops: boolean;
  /**
   * Which crops are being harvested under a Jacob's Contest, for the Overdrive Chip's +140.
   *
   * One switch per crop rather than a single "contest day" mode, because the chip lifts the
   * *active* crop only. A contest runs three crops and nobody farms all three, so a flat +140 on
   * everything would describe a day that cannot happen — and a flat nothing hides the only
   * condition under which one crop pulls far ahead of the rest.
   */
  contestCrops: Record<string, boolean>;
  /** Passive crop fortune read off the profile, per crop. Anything typed wins over it. */
  detected: Record<string, number> | null;
  /** The best farming tool found per crop, from item lore. Applies only to the crop you hold it for. */
  tools: Record<string, number> | null;
  /** How many tools the last read saw, as against how many are remembered. */
  lastFound: number;
  /** True while a tool read is in flight, so the button can say so. */
  loadingTools: boolean;
  /**
   * What the last profile read actually saw.
   *
   * On the page rather than in a console, because this read has now been wrong twice in ways that
   * looked identical from outside — no tools found, and six crops silently unmatched — and neither
   * was visible without saying out loud what went in and what came back.
   */
  scan: { items: number; upgradeKeys: string[]; unresolved: string[] } | null;
  growth: GrowthParams;
  /** Which row's layout is open, if any. */
  open: string | null;
  /** The mutation whose layout is being searched right now, if any. */
  optimising: string | null;
  /** What the last search bought, by mutation id, so the row can say so once it is done. */
  optimiseNote: Record<string, string>;
};

/**
 * What a player who has bothered to unlock the Greenhouse probably has.
 *
 * Not a measurement — it is an opening position for the boxes, chosen so the page says something
 * useful before anything is typed. Every one of them is stated on screen and every one is
 * editable, which is the honest way to carry a guess: visible, labelled, and overridable.
 */
const DEFAULT_GROWTH: GrowthParams = {
  uniqueCrops: 12,
  cropGrowth: 210,
  speedAttribute: 10,
  growthSpeedUpgrade: 9,
  plantYieldUpgrade: 9,
  evergreenChip: 0,
};

/**
 * The general Farming Fortune the figures use when the box is empty.
 *
 * 1,500 is a mid-to-late farming setup and it is a *placeholder*, not a reading — nothing here can
 * see your gear. Getting this one wrong is comparatively cheap: it lifts every crop equally, so it
 * scales every row by the same factor and leaves the order alone. The per-crop boxes below are the
 * ones worth filling in, because those do move the ranking.
 */
const ASSUMED_FORTUNE = 1_500;

const CROP_KEY = "sbxp:ghcropfortune";

function readCropFortune(): Record<string, string> {
  try {
    const parsed = JSON.parse(localStorage.getItem(CROP_KEY) ?? "{}");
    return parsed && typeof parsed === "object" ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

/**
 * The tools found so far, remembered across sessions and added to rather than replaced.
 *
 * You hold one tool at a time and the Farming Toolkit is not published, so any single read of a
 * profile sees at most the one tool that happens to be out. Replacing the set on every read would
 * mean the page could never know about more than one — so each read merges, and the collection
 * builds up over however many visits it takes. A figure from last week is a fine answer here: a
 * tool's crop fortune changes when you upgrade the tool, which is rarely, and the box is editable.
 */
const TOOLS_KEY = "sbxp:ghtools";

function readTools(): Record<string, number> {
  try {
    const raw = localStorage.getItem(TOOLS_KEY);
    const parsed = raw ? (JSON.parse(raw) as Record<string, number>) : {};
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function rememberTools(found: Record<string, number>): Record<string, number> {
  // The larger of what was known and what was just seen: a better tool replaces a worse one, and a
  // read that did not see a crop's tool does not forget it.
  const merged = { ...readTools() };
  for (const [crop, value] of Object.entries(found)) merged[crop] = Math.max(merged[crop] ?? 0, value);
  try {
    localStorage.setItem(TOOLS_KEY, JSON.stringify(merged));
  } catch {
    // In memory is enough for this session.
  }
  return merged;
}

const CONTEST_KEY = "sbxp:ghcontest";

function readContestCrops(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(CONTEST_KEY);
    return raw ? (JSON.parse(raw) as Record<string, boolean>) : {};
  } catch {
    return {};
  }
}

/**
 * The passive crop fortune per crop — what you have whatever you are holding.
 *
 * A typed box wins over anything read off the profile, for the same reason the Wisdom boxes work
 * that way: somebody who has read their own stat knows better than a floor assembled from the parts
 * this page can see.
 */
function cropFortuneValues(): Record<string, number> {
  const out: Record<string, number> = { ...(state.detected ?? {}) };
  for (const [crop, raw] of Object.entries(state.cropFortune)) {
    const n = Number(String(raw).replace(/[^0-9.]/g, ""));
    if (String(raw).trim() !== "" && Number.isFinite(n) && n > 0) out[crop] = n;
  }
  return out;
}

/**
 * The fortune that rides on what you are holding, per crop.
 *
 * The tool's own crop fortune plus, where the box is ticked, the Overdrive Chip. Both are
 * single-crop by nature — one tool in your hand, one active crop in a contest — so they are handed
 * to the model separately from the passive figures and applied to one drop rather than to all of
 * them. See `heldCropFortune` in `greenhouse.ts` for why summing them into the passive map was
 * wrong for every mutation that drops more than one crop.
 */
function heldFortuneValues(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [crop, on] of Object.entries(state.contestCrops)) {
    if (on) out[crop] = (out[crop] ?? 0) + OVERDRIVE_CHIP_FORTUNE;
  }
  for (const [crop, value] of Object.entries(state.tools ?? {})) {
    if (value > 0) out[crop] = (out[crop] ?? 0) + value;
  }
  return out;
}

/**
 * Optimised layouts, kept across reloads.
 *
 * Worth storing because of what they cost: a second of searching each, asked for one at a time.
 * Losing them on every refresh would make the button feel like a toy rather than a decision.
 *
 * The key already carries everything the answer depends on — the plot, the shape of the condition,
 * and the price ranks — so a stored layout can only ever be handed back to the question it answers.
 * A shift in what the plants cost changes the key, and the layout is simply searched again.
 */
const LAYOUT_KEY = "sbxp:ghlayouts";
/** Enough for every mutation several times over; the oldest fall off the end. */
const LAYOUT_LIMIT = 120;

function readLayouts(): void {
  try {
    const parsed = JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? "{}");
    if (!parsed || typeof parsed !== "object") return;
    for (const [key, packing] of Object.entries(parsed as Record<string, Packing>)) {
      // Shape-checked rather than trusted: this is an old string out of a browser, and a
      // half-written grid would otherwise reach the drawing code as if it were a layout.
      if (packing && Array.isArray(packing.grid) && Array.isArray(packing.plants)) restoreLayout(key, packing);
    }
  } catch {
    /* a corrupt store is the same as no store */
  }
}

function rememberLayouts(): void {
  try {
    const out: Record<string, Packing> = {};
    for (const [key, packing] of settledLayouts().slice(-LAYOUT_LIMIT)) out[key] = packing;
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(out));
  } catch {
    /* out of quota; the layouts still hold for this session */
  }
}

const FILTER_KEY = "sbxp:ghfilters";
const HIDE_KEY = "sbxp:ghhide";

function readFilters(): Record<string, string> {
  try {
    const parsed = JSON.parse(localStorage.getItem(FILTER_KEY) ?? "{}");
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, string> = {};
    for (const [id, value] of Object.entries(parsed)) if (typeof value === "string") out[id] = value;
    return out;
  } catch {
    return {};
  }
}

const state: State = {
  market: new Map(),
  lastUpdated: null,
  status: "",
  error: null,
  sort: { column: "sustainedPerDay", descending: true },
  filters: readFilters(),
  hideFiltered: localStorage.getItem(HIDE_KEY) === "1",
  plots: Number(localStorage.getItem("sbxp:ghplots") ?? 1),
  priceMode: (localStorage.getItem("sbxp:ghpricemode") as PriceMode) === "instant" ? "instant" : "order",
  fortune: localStorage.getItem("sbxp:ghfortune") ?? "",
  cropFortune: readCropFortune(),
  showCrops: localStorage.getItem("sbxp:ghshowcrops") === "1",
  contestCrops: readContestCrops(),
  detected: null,
  tools: Object.keys(readTools()).length > 0 ? readTools() : null,
  lastFound: 0,
  loadingTools: false,
  scan: null,
  optimising: null,
  optimiseNote: {},
  growth: {
    uniqueCrops: Number(localStorage.getItem("sbxp:ghunique") ?? DEFAULT_GROWTH.uniqueCrops),
    cropGrowth: Number(localStorage.getItem("sbxp:ghgrowth") ?? DEFAULT_GROWTH.cropGrowth),
    speedAttribute: Number(localStorage.getItem("sbxp:ghspeed") ?? DEFAULT_GROWTH.speedAttribute),
    growthSpeedUpgrade: Number(localStorage.getItem("sbxp:ghupgrade") ?? DEFAULT_GROWTH.growthSpeedUpgrade),
    plantYieldUpgrade: Number(localStorage.getItem("sbxp:ghyield") ?? DEFAULT_GROWTH.plantYieldUpgrade),
    evergreenChip: Number(localStorage.getItem("sbxp:ghevergreen") ?? DEFAULT_GROWTH.evergreenChip),
  },
  open: null,
};

let tables: GreenhouseTables = { greenhouse: { mutations: [] } as unknown as GreenhouseData, npcPrices: {} };
let host: HTMLElement | null = null;
let timer: number | undefined;
let bound = false;

/* ------------------------------------------------------- is this price usual? */

/**
 * A mutation's own ask against what it has actually been going for.
 *
 * The single biggest way to be wrong about this page is to read it at the wrong moment. A
 * greenhouse pays out *later* — a Noctilume planted now is harvested in thirteen hours, a Devourer
 * in thirty-five — so the price that matters is the one at harvest, and the page can only ever
 * quote the one right now. A row that looks enormous on a spike will have settled back to normal
 * before there is anything to sell.
 *
 * Mutations are where that bites and crops are not, which is why only the forty are tracked.
 * Pumpkins move a few percent because a hundred thousand trade a day; a Noctilume's ask has run
 * between 550k and 3.1M inside three months. A mutation well above its own usual is normally a
 * book that emptied, not a mutation that got better.
 *
 * **The average is fetched, not waited for.** An earlier cut folded one live read at a time, which
 * is honest and useless: it needs the tab left open for a day before it says anything, and nobody
 * leaves a planner open for a day to find out what to plant. Coflnet publishes the history and
 * allows cross-origin reads, so a week of real prices arrives on load. Polling is kept underneath
 * as the fallback for when that fetch fails, because a figure that degrades to "measured here" is
 * better than a column that empties.
 */
const BASELINE_KEY = "sbxp:ghpricebaselines";
const HISTORY_KEY = "sbxp:ghpricehistory";

/**
 * How stale a fetched history may get before it is worth re-fetching.
 *
 * Six hours: long enough that opening the tab repeatedly in an evening costs one round of
 * requests, short enough that a genuine multi-day move is reflected the next time you look.
 */
const HISTORY_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * Coflnet's per-item history. One request each, fired a few at a time.
 *
 * Three wide rather than six, and it is Coflnet's icons that set that limit rather than these:
 * every row loads its icon from the same host, so a full table is already forty requests in flight
 * before this starts. Six alongside that earns a 429, which costs a mutation its figure for six
 * hours. Three is slower and lands.
 */
const HISTORY_URL = (id: string) => `https://sky.coflnet.com/api/bazaar/${encodeURIComponent(id)}/history/week`;
const HISTORY_FETCH_WIDTH = 3;
/** One retry, after a pause, for the rate-limited case. Anything else is not worth hammering. */
const HISTORY_RETRY_MS = 1_500;

type HistoryStore = { fetchedAt: number; baselines: Record<string, Baseline> };

/** Averages this browser measured itself, one poll at a time. The fallback. */
let polled: Record<string, Baseline> = readStore(BASELINE_KEY);
/** Averages fetched from Coflnet's published history. Preferred wherever present. */
let fetched: Record<string, Baseline> = readHistory();

function readStore(key: string): Record<string, Baseline> {
  try {
    return JSON.parse(localStorage.getItem(key) ?? "{}") as Record<string, Baseline>;
  } catch {
    return {};
  }
}

function readHistory(): Record<string, Baseline> {
  try {
    const store = JSON.parse(localStorage.getItem(HISTORY_KEY) ?? "null") as HistoryStore | null;
    // A cached history is still worth using while the refresh is in flight — stale by a few hours
    // beats blank, and the row prints the window it covers either way.
    return store && typeof store === "object" && store.baselines ? store.baselines : {};
  } catch {
    return {};
  }
}

function historyIsFresh(): boolean {
  try {
    const store = JSON.parse(localStorage.getItem(HISTORY_KEY) ?? "null") as HistoryStore | null;
    return !!store && Date.now() - store.fetchedAt < HISTORY_TTL_MS && Object.keys(store.baselines ?? {}).length > 0;
  } catch {
    return false;
  }
}

/**
 * Pull a week of real prices for every mutation.
 *
 * Forty requests, six at a time — Coflnet answers each in about half a second, so the whole set
 * lands in a few seconds, once every six hours. A failure anywhere is swallowed per item rather
 * than per batch: one mutation Coflnet has never heard of should cost that mutation its figure and
 * nothing else.
 */
async function fetchHistory(): Promise<void> {
  const mutations = tables.greenhouse.mutations ?? [];
  if (mutations.length === 0 || historyIsFresh()) return;

  const next: Record<string, Baseline> = {};
  for (let i = 0; i < mutations.length; i += HISTORY_FETCH_WIDTH) {
    await Promise.all(
      mutations.slice(i, i + HISTORY_FETCH_WIDTH).map(async (m) => {
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            const response = await fetch(HISTORY_URL(m.id));
            // 429 is the only status worth trying again: a 404 means Coflnet has never seen this
            // item and asking twice will not change that.
            if (response.status === 429 && attempt === 0) {
              await new Promise((done) => setTimeout(done, HISTORY_RETRY_MS));
              continue;
            }
            if (!response.ok) return;
            const baseline = baselineFrom((await response.json()) as CoflnetPoint[]);
            if (baseline) next[m.id] = baseline;
            return;
          } catch {
            // Offline or blocked. The polled average still covers this one.
            return;
          }
        }
      }),
    );
  }

  if (Object.keys(next).length === 0) return;
  fetched = next;
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify({ fetchedAt: Date.now(), baselines: next } satisfies HistoryStore));
  } catch {
    // Storage blocked or full: the averages stay live for this session, which is the part that
    // matters. Losing them on reload costs one round of requests, not correctness.
  }
  renderTable();
}

/** Fold the newest read into the fallback average. Only the forty, and only the ask. */
function observePrices(): void {
  for (const m of tables.greenhouse.mutations ?? []) {
    const product = state.market.get(m.id);
    if (!product || product.instabuy <= 0) continue;
    polled[m.id] = observe(polled[m.id], product.instabuy, product.at);
  }
  try {
    localStorage.setItem(BASELINE_KEY, JSON.stringify(polled));
  } catch {
    // As above: in-memory is enough for this session.
  }
}

/** The fetched week where there is one, otherwise whatever this browser has measured. */
function baselineFor(id: string): { baseline: Baseline; measured: boolean } | null {
  const history = fetched[id];
  if (history) return { baseline: history, measured: false };
  const own = polled[id];
  return own ? { baseline: own, measured: true } : null;
}

/**
 * The cell: how far today's ask sits from this mutation's own usual, and over how long.
 *
 * The window is on the row because it decides whether the number means anything. A week of real
 * history is worth acting on; four minutes of self-polling is not, and a reader who is not told
 * which one they are looking at cannot tell them apart.
 */
function baselineCell(row: MutationProfit): string {
  const product = state.market.get(row.id);
  const found = baselineFor(row.id);
  const relative = product && product.instabuy > 0 && found ? relativeTo(product.instabuy, found.baseline) : null;
  if (!product || !found || relative === null) {
    return `<span class="dim" title="No price history for this one. Coflnet publishes a week for most mutations; where it does not, this tab falls back to averaging its own reads and needs a second one first.">—</span>`;
  }

  const { baseline, measured } = found;
  const window = depthNote(observedFor(baseline) / 60_000);
  // Sign off the rounded figure, not the raw one: -0.4% rounds to zero and printing it as "-0%"
  // reads like a fault rather than "sitting exactly on its average".
  const shown = Math.round(relative);
  const sign = shown > 0 ? "+" : "";
  // Loud in both directions, and the reason differs. Well above its usual is a thin book that
  // emptied and will refill before the harvest lands; well below means the harvest is worth less
  // than the row says. Both are reasons not to take the number at face value.
  const loud = Math.abs(relative) >= 30 ? " gold" : "";
  const source = measured
    ? `measured by this tab over the ${window} it has been open, across ${num(baseline.samples)} reads — Coflnet had no history for it`
    : `Coflnet's published history: ${num(baseline.samples)} readings over the last ${window}`;

  return `<span class="${loud.trim()}" title="${escapeHtml(row.name)} is asking ${coins(
    product.instabuy,
  )} against a mean of ${coins(
    baseline.mean,
  )} — ${source}. A mutation well above its own usual is normally a book that emptied rather than a mutation that got better, and a greenhouse pays out hours later, by which time it has refilled.">${sign}${shown}% <span class="dim">${
    measured ? `${window}*` : window
  }</span></span>`;
}
/* ------------------------------------------------------------------ columns */

type Column = {
  id: string;
  label: string;
  value: (r: MutationProfit) => number;
  render: (r: MutationProfit) => string;
  title?: string;
  /** What its box accepts. Defaults to a plain number, which most of them are. */
  kind?: FilterKind;
  /** The cell as words, for the columns a number cannot filter. Only `boolean` and `text` need it. */
  plain?: (r: MutationProfit) => string;
  /** What to show in the empty box. Short: these are the narrowest controls on the page. */
  hint?: string;
};

/**
 * The table, after decay.
 *
 * Two columns are gone because the 2026-08-20 update made them wrong rather than merely redundant.
 * **Net day 1** said the ring was bought once and every day after was pure gross; base crops now rot
 * in 72 hours, so it is bought again and again, and the honest daily figure spreads it across the
 * days it survives — that is `Net/day` below. **Payback** measured how long until the ring repaid
 * itself, which stops meaning anything once the ring can die before it gets there; `Per setup`
 * going negative says the same thing and says it in coins.
 *
 * Two more are gone because they are true and not decision-relevant, which is a different reason:
 * **Each** (one mutation, one harvest) and **Size**. Both are still in the expanded row, where
 * there is room for the things you look at once rather than the things you sort by.
 */
const COLUMNS: Column[] = [
  {
    id: "sustainedPerDay",
    label: "Net/day",
    value: (r) => r.sustainedPerDay ?? -Infinity,
    render: (r) =>
      r.sustainedPerDay === null
        ? `<span class="dim">—</span>`
        : r.sustainedPerDay < 0
          ? `<span class="gold">-${coins(-r.sustainedPerDay)}</span>`
          : coins(r.sustainedPerDay),
    title:
      "What it actually pays a day, keeping it running: gross takings less the ring spread across " +
      "the days that ring survives. This is the ranking figure, and it is the one that changed " +
      "when base crops started rotting — a setup you replace every three days is a running cost, " +
      "not a one-off. Negative means replanting costs more than the harvests bring in.",
  },
  {
    id: "coinsPerDay",
    label: "Gross/day",
    value: (r) => r.coinsPerDay ?? -1,
    render: (r) => (r.coinsPerDay === null ? `<span class="dim">—</span>` : coins(r.coinsPerDay)),
    title:
      "What the harvests sell for in a day, with nothing taken off for the ring. Read it against " +
      "Net/day beside it: where the two are close the setup is nearly free, and where they are far " +
      "apart most of what you grow is paying for the plants around it.",
  },
  {
    id: "hoursPerHarvest",
    label: "Per harvest",
    kind: "hours",
    hint: "<12",
    value: (r) => r.hoursPerHarvest ?? Infinity,
    render: (r) => (r.hoursPerHarvest === null ? `<span class="dim">—</span>` : hours(r.hoursPerHarvest)),
    title:
      "How long from planting the ring to harvesting the mutation: the expected wait for it to " +
      "spawn, which is one over its chance, plus its own growth stages. For most commons the " +
      "first half is nearly all of it. Against a ring that rots in 72 hours, this is what decides " +
      "how many harvests you get out of one planting.",
  },
  {
    id: "perHarvest",
    label: "Profit/harvest",
    value: (r) => (r.problem ? -1 : r.perHarvest),
    render: (r) => (r.problem || r.perHarvest <= 0 ? `<span class="dim">—</span>` : coins(r.perHarvest)),
    title:
      "What lands in one go: every mutation in every greenhouse, harvested together, crops and " +
      "items and vines. Read it against the column beside it — this much, that often.",
  },
  {
    id: "needsWater",
    label: "Water",
    kind: "boolean",
    hint: "no",
    plain: (r) => (r.wateringNeeded ? "yes" : "no"),
    // Sorted so the ones that want no attention come first, which is the useful end of it.
    value: (r) => (r.wateringNeeded ? 1 : 0),
    render: (r) => waterCell(r),
    title:
      "Whether you will ever have to pick up a watering can. Not the same question as whether the " +
      "plant drinks — water is spent per growth stage and the floor is -100, so thirty-three stages " +
      "are covered with no watering at all, and a mutation that finishes inside that can be planted " +
      "and left. Nineteen of the twenty-one that take water do. Once it is fully grown it stops " +
      "losing water altogether; what kills it after that is decay, which is a separate timer. Also " +
      "not the Water Retain and Water Drain effects in the expanded row — those are what a mutation " +
      "does to its neighbours.",
  },
  {
    id: "setup",
    label: "Setup",
    hint: "<10m",
    value: (r) => r.setupTotal ?? Infinity,
    render: (r) =>
      !r.setup
        ? `<span class="dim">—</span>`
        : r.setupTotal === null
          ? `<span class="gold" title="Nothing is selling what this needs.">unpriced</span>`
          : coins(r.setupTotal),
    title:
      "What the ring costs to buy, across every greenhouse you have selected — three plots is " +
      "three rings. It is no longer a one-off: the plants rot, so this is what you pay every time " +
      "the Harvests column runs out. A mutation that needs other mutations is priced at what those " +
      "cost on the bazaar, which is the shortcut — growing them yourself is cheaper and slower.",
  },
  {
    id: "netPerSetup",
    label: "Per setup",
    hint: ">10m",
    // A ring that never rots has no finite per-setup figure, and it is the *best* case rather than
    // the worst: you plant it once and it keeps paying. Sorting it as null would bury it at the
    // bottom next to the rows nothing can price, which is the opposite of true.
    value: (r) => (r.netPerSetup !== null ? r.netPerSetup : r.setupLife.hours === null && r.setup ? Infinity : -Infinity),
    render: (r) =>
      r.netPerSetup === null
        ? r.setupLife.hours === null && r.setup
          ? `<span title="Nothing in this ring rots, so one planting keeps paying and there is no per-setup total to quote. Net/day is the whole answer.">∞</span>`
          : `<span class="dim">—</span>`
        : r.netPerSetup < 0
          ? `<span class="gold">-${coins(-r.netPerSetup)}</span>`
          : coins(r.netPerSetup),
    title:
      "What one planting nets you: everything it yields before the ring rots, less what the ring " +
      "cost. This is the figure that says whether a setup is worth buying at all, and it does not " +
      "follow from the daily one — Startlevine takes 40M and gets two harvests, Noctilume takes 6M " +
      "and gets five. A negative number means the planting never earns back what it cost, however " +
      "good its coins-a-day looks.",
  },
  {
    id: "vsUsual",
    label: "vs usual",
    value: (r) => {
      const product = state.market.get(r.id);
      const found = baselineFor(r.id);
      if (!product || product.instabuy <= 0 || !found) return -Infinity;
      return relativeTo(product.instabuy, found.baseline) ?? -Infinity;
    },
    render: (r) => baselineCell(r),
    title:
      "Where this mutation's own price sits against its average over the last week, from Coflnet's " +
      "published history — so it says something the moment the page opens rather than after a day " +
      "of watching. Only the mutations are tracked, because only the mutations move: crops trade " +
      "in the hundreds of thousands and barely budge, while a mutation book is thin enough that " +
      "one player clearing it doubles the ask for a morning. That matters here more than on a " +
      "flip — a greenhouse pays out hours later, so a row that looks huge on a spike will have " +
      "settled back to normal by the time you actually harvest it. A star means Coflnet had no " +
      "history and the figure is this tab's own reads instead.",
  },
];

/**
 * The leftmost column, which the table draws by hand rather than from `COLUMNS` — it carries the
 * icon, the rarity, the ring and any problem, none of which fits a `render` returning one cell.
 * It still needs a box, so it is described here and drawn with the others.
 */
const NAME_COLUMN: Column = {
  id: "name",
  label: "Mutation",
  kind: "text",
  hint: "name",
  value: () => 0,
  plain: (r) => r.name,
  render: (r) => escapeHtml(r.name),
};

const FILTER_COLUMNS: Column[] = [NAME_COLUMN, ...COLUMNS];

/**
 * The arithmetic behind the Water column, spelled out where there is room for it.
 *
 * The column has one word and the word is often "no" for a plant whose own wiki page says it needs
 * water. That is the kind of answer a reader should be able to check rather than take, so the two
 * numbers it comes from are printed here.
 */
function waterLine(row: MutationProfit): string {
  const { stages, budget } = row.drought;
  if (row.needsWater !== true) {
    return `<p class="dim">Takes no water — plant it and leave it.</p>`;
  }
  if (row.wateringNeeded) {
    const over = stages - budget;
    return `<p class="dim"><span class="gold">Has to be watered.</span> It grows for ${num(stages)} stages and loses 2-3 water
      a stage from a floor of -100, so it runs dry ${num(over)} stage${over === 1 ? "" : "s"} short of ready.</p>`;
  }
  return `<p class="dim">Takes water, but never needs any: ${num(stages)} growth stage${
    stages === 1 ? "" : "s"
  } against the ${num(budget)} its water covers. It stops losing water the moment it is fully grown, so what
    ends it after that is decay rather than thirst.</p>`;
}

/**
 * Whether you will ever have to water this one, in a word.
 *
 * The column used to print what the wiki says about the plant, and the wiki's answer turns out not
 * to be the player's. Water goes per growth stage, 2-3 of it, from zero down to a floor of -100 —
 * thirty-three stages. Nineteen of the twenty-one mutations that drink finish growing well inside
 * that, so the can never comes out: plant it, walk away, harvest it. Two do not, and those two are
 * the whole content of this column.
 *
 * The narrower fact is still shown, as the reason under the yes or the no, because a reader who
 * knows the mutation takes water and sees "no" is owed the arithmetic rather than left to wonder
 * whether the page is wrong.
 */
function waterCell(row: MutationProfit): string {
  const { stages, budget } = row.drought;
  if (row.wateringNeeded) {
    return `<span class="gold" title="Grows for ${stages} stages, and its water covers ${budget} — so it runs dry partway and has to be topped up. Below zero it has a chance not to advance a stage; at -100 it becomes a Dead Plant.">yes</span>`;
  }
  if (row.needsWater === true) {
    // Drinks, but finishes first. Marked rather than printed as a flat no, because it is the answer
    // most likely to be doubted by someone who has read the mutation's own page.
    return `<span class="soft" title="It does take water, but it is fully grown after ${stages} stages and its water covers ${budget} — so it cannot run dry before you harvest it. Plant it and leave it.">no</span>`;
  }
  if (row.needsWater === false) {
    return `<span title="Takes no water at all — plant it and leave it.">no</span>`;
  }
  return `<span class="dim" title="The wiki no longer states this one's watering, so it is unknown rather than no.">—</span>`;
}


/** "3.4 hr", "2.1 days" — a wait, since that is what the number is. */
function hours(h: number): string {
  // Choconut's whole ring is 44 coins against 768k an hour, which rounds to "0 min" and reads like
  // a missing figure rather than the answer. It is the answer: the setup is free in practice.
  if (h * 60 < 0.5) return "instant";
  if (h < 1) return `${Math.round(h * 60)} min`;
  if (h < 48) return `${h.toFixed(1)} hr`;
  return `${(h / 24).toFixed(1)} days`;
}

/* --------------------------------------------------------------- fetching */

async function refresh(): Promise<void> {
  state.status = state.market.size ? "refreshing" : "loading the bazaar…";
  state.error = null;
  renderMeta();

  try {
    const response = await fetch(BAZAAR);
    if (!response.ok) throw new Error(`Hypixel returned ${response.status}`);
    const body = (await response.json()) as { lastUpdated: number; products: Record<string, RawBazaarProduct> };
    const market = new Map<string, ProductSnapshot>();
    for (const [id, raw] of Object.entries(body.products)) {
      const snapshot = normalise(id, raw, body.lastUpdated);
      if (snapshot) market.set(id, snapshot);
    }
    state.market = market;
    state.lastUpdated = body.lastUpdated;
    state.status = "";
    observePrices();
  } catch (error) {
    state.error = error instanceof Error ? error.message : "Could not reach the Hypixel API.";
    state.status = "";
  }

  renderMeta();
  renderTable();
  schedule();
}

function schedule(): void {
  clearTimeout(timer);
  const due = state.lastUpdated ? state.lastUpdated + REFRESH_MS + GRACE_MS - Date.now() : REFRESH_MS;
  timer = window.setTimeout(refresh, Math.max(due, 2_000));
}

/* ------------------------------------------------------------------- rows */

function fortuneValue(): number {
  const typed = Number(state.fortune.replace(/[^0-9.]/g, ""));
  return state.fortune.trim() !== "" && Number.isFinite(typed) && typed >= 0 ? typed : ASSUMED_FORTUNE;
}

function rows(): MutationProfit[] {
  return rankMutations(tables.greenhouse, {
    market: state.market,
    npcPrices: tables.npcPrices,
    growth: state.growth,
    farmingFortune: fortuneValue(),
    cropFortune: cropFortuneValues(),
    heldCropFortune: heldFortuneValues(),
    // Each mutation picks the drop its held bonus earns most on, which is what a person does when
    // they choose which tool to bring to it.
    heldCrop: "best",
    yieldMultiplier: yieldMultiplierOf(state.growth),
    plots: state.plots,
    priceMode: state.priceMode,
  });
}

/**
 * Every box that is currently saying something, in column order.
 *
 * The name is a column like any other here, which is why the tab's old standalone Search box is
 * gone: two controls filtering names from two pieces of state can disagree, and the one above the
 * table did not repaint when the one in the heading was typed into. One box, one filter, and a
 * name reads back in the same summary line as everything else.
 */
function activeFilters(): { column: Column; parsed: ParsedFilter }[] {
  return FILTER_COLUMNS.map((column) => ({
    column,
    parsed: parseFilter(state.filters[column.id] ?? "", column.kind ?? "number"),
  })).filter((f) => f.parsed.state !== "blank");
}

/**
 * Split the table on the filters rather than cutting it down.
 *
 * A row that fails sinks to the bottom and greys out instead of vanishing, and that is the whole
 * design decision here. A filter you cannot see the effect of is a filter you will misread: type
 * `<10m` in Setup and a disappearing row looks the same whether it cost 40M or whether nothing
 * could price it at all. Sunk and dimmed, the near misses stay one glance away — and `hide` is
 * there for when the list is what you want rather than the comparison.
 *
 * A box that cannot be read filters nothing, so a half-typed ">" leaves the table alone.
 */
function partition(all: MutationProfit[]): { matching: MutationProfit[]; failing: MutationProfit[] } {
  const active = activeFilters();
  if (active.length === 0) return { matching: all, failing: [] };

  const matching: MutationProfit[] = [];
  const failing: MutationProfit[] = [];
  for (const row of all) {
    const passes = active.every(({ column, parsed }) =>
      parsed.state !== "ok" ? true : parsed.test(column.value(row), plainOf(column, row)),
    );
    (passes ? matching : failing).push(row);
  }
  return { matching, failing };
}

/** The cell as words. Columns that need it say so; the rest are only ever compared as numbers. */
function plainOf(column: Column, row: MutationProfit): string {
  return column.plain ? column.plain(row) : "";
}

function sorted(all: MutationProfit[]): MutationProfit[] {
  const column = COLUMNS.find((c) => c.id === state.sort.column);
  if (!column) return all;
  const direction = state.sort.descending ? -1 : 1;
  return all.slice().sort((a, b) => direction * (column.value(a) - column.value(b)));
}

/* -------------------------------------------------------------- rendering */

export function mountGreenhouse(container: HTMLElement, data: GreenhouseTables): void {
  host = container;
  tables = data;

  if (bound) {
    render();
    void refresh();
    void fetchHistory();
    return;
  }
  bound = true;
  readLayouts();

  container.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;

    const hide = target.closest<HTMLElement>("[data-ghhide]");
    if (hide) {
      state.hideFiltered = hide.dataset.ghhide === "1";
      localStorage.setItem(HIDE_KEY, state.hideFiltered ? "1" : "0");
      renderTable();
      return;
    }

    const clear = target.closest<HTMLElement>("[data-ghclearfilters]");
    if (clear) {
      state.filters = {};
      localStorage.setItem(FILTER_KEY, "{}");
      renderTable();
      return;
    }

    // A click in a box is a click in a box. Without this it would land on the heading's sort or the
    // row's expander, and typing a filter would reorder the table under the caret.
    if (target.closest<HTMLElement>("[data-ghfilter]")) return;

    const column = target.closest<HTMLElement>("[data-ghsort]");
    if (column) {
      const id = column.dataset.ghsort!;
      if (state.sort.column === id) state.sort.descending = !state.sort.descending;
      else state.sort = { column: id, descending: true };
      renderTable();
      return;
    }

    const optimising = target.closest<HTMLElement>("[data-ghoptimise]");
    if (optimising) {
      runOptimise(optimising.dataset.ghoptimise!);
      return;
    }

    const row = target.closest<HTMLElement>("[data-ghopen]");
    if (row) {
      // Clicking the open row closes it, so the layout is a toggle rather than a trap.
      state.open = state.open === row.dataset.ghopen ? null : row.dataset.ghopen!;
      renderTable();
      return;
    }

    const dry = target.closest<HTMLElement>("[data-ghdry]");
    if (dry) {
      state.filters = { ...state.filters, needsWater: dry.dataset.ghdry === "1" ? "no" : "" };
      if (!state.filters.needsWater) delete state.filters.needsWater;
      localStorage.setItem(FILTER_KEY, JSON.stringify(state.filters));
      // The whole panel, because the chip itself has to light up with the filter it set.
      render();
      return;
    }

    const plots = target.closest<HTMLElement>("[data-ghplots]");
    if (plots) {
      state.plots = Number(plots.dataset.ghplots);
      localStorage.setItem("sbxp:ghplots", String(state.plots));
      render();
      return;
    }

    const priced = target.closest<HTMLElement>("[data-ghmode]");
    if (priced) {
      state.priceMode = priced.dataset.ghmode === "instant" ? "instant" : "order";
      localStorage.setItem("sbxp:ghpricemode", state.priceMode);
      render();
      return;
    }

    if (target.closest("#ghcroptoggle")) {
      state.showCrops = !state.showCrops;
      localStorage.setItem("sbxp:ghshowcrops", state.showCrops ? "1" : "0");
      render();
      return;
    }

    if (target.closest("#ghloadtools")) {
      if (reloadTools && !state.loadingTools) {
        state.loadingTools = true;
        render();
        void reloadTools()
          .catch(() => {
            // A failed read leaves what was already remembered, which is the useful outcome.
          })
          .finally(() => {
            state.loadingTools = false;
            render();
          });
      }
      return;
    }

    if (target.closest("#ghforgettools")) {
      localStorage.removeItem(TOOLS_KEY);
      state.tools = null;
      state.lastFound = 0;
      render();
      return;
    }

    if (target.closest("#ghrefresh")) void refresh();
  });

  container.addEventListener(
    "error",
    (event) => {
      const target = event.target;
      if (target instanceof HTMLImageElement && target.classList.contains("bz-icon")) target.style.visibility = "hidden";
    },
    true,
  );

  container.addEventListener("input", (event) => {
    const el = event.target as HTMLInputElement;
    const growthFields: Record<string, [keyof GrowthParams, string]> = {
      ghunique: ["uniqueCrops", "sbxp:ghunique"],
      ghgrowth: ["cropGrowth", "sbxp:ghgrowth"],
      ghspeed: ["speedAttribute", "sbxp:ghspeed"],
      ghupgrade: ["growthSpeedUpgrade", "sbxp:ghupgrade"],
      ghyield: ["plantYieldUpgrade", "sbxp:ghyield"],
      ghevergreen: ["evergreenChip", "sbxp:ghevergreen"],
    };

    const filterId = el.dataset.ghfilter;
    if (filterId !== undefined) {
      state.filters = { ...state.filters, [filterId]: el.value };
      if (el.value.trim() === "") delete state.filters[filterId];
      localStorage.setItem(FILTER_KEY, JSON.stringify(state.filters));
      renderTable();
      // The chip above the table shows the state of the Water box, so typing in that box by hand
      // has to move it. Repainted on its own rather than through `render`, which would take the
      // caret out of the box being typed in.
      if (filterId === "needsWater") {
        const chip = host?.querySelector<HTMLElement>("[data-ghdry]");
        if (chip) {
          const on = el.value.trim().toLowerCase() === "no";
          chip.classList.toggle("on", on);
          chip.dataset.ghdry = on ? "0" : "1";
        }
      }
      return;
    }
    // The contest tick. A full panel repaint rather than just the table, because the label beside
    // the box shows what the tick is worth and has to move with it.
    const contest = el.dataset.ghcontest;
    if (contest !== undefined) {
      state.contestCrops = { ...state.contestCrops, [contest]: el.checked };
      localStorage.setItem(CONTEST_KEY, JSON.stringify(state.contestCrops));
      render();
      return;
    }
    // A per-crop box. Only the table repaints, so the cursor stays where it is being typed.
    const crop = el.dataset.ghcrop;
    if (crop !== undefined) {
      state.cropFortune = { ...state.cropFortune, [crop]: el.value };
      localStorage.setItem(CROP_KEY, JSON.stringify(state.cropFortune));
      renderTable();
      return;
    }
    if (el.id === "ghfortune") {
      state.fortune = el.value;
      localStorage.setItem("sbxp:ghfortune", el.value);
      const note = document.getElementById("ghfortunenote");
      if (note) note.innerHTML = fortuneNote();
      renderTable();
      return;
    }
    const field = growthFields[el.id];
    if (field) {
      state.growth = { ...state.growth, [field[0]]: Number(el.value) || 0 };
      localStorage.setItem(field[1], el.value);
      const label = document.getElementById("ghstagenote");
      if (label) label.textContent = stageNote();
      renderTable();
    }
  });

  render();
  void refresh();
  // Not awaited: the table is useful the moment the bazaar lands, and the week of history only
  // fills one column. It repaints itself when it arrives.
  void fetchHistory();
}

/**
 * Take the crop fortune a loaded profile can be made to admit to.
 *
 * Two halves, and they are kept apart because they behave differently in the model:
 *
 * **Passive**, into the boxes. The Garden's Crop Upgrades are published outright as levels, at +5
 * fortune each to +45, which makes them the one part of a farming setup that can simply be read.
 * Accessories go here too — a Fermento Artifact's +30 applies to every crop at once.
 *
 * **Held**, behind the tick. A farming tool's crop fortune is worth up to +200 and you can hold one
 * of them, so it belongs to whichever crop you brought the tool for and to no other.
 *
 * Both are floors. This sees the Garden levels and whatever lore is in the inventory, equipment and
 * bags — which now includes the farming toolkit, since the scan walks every bag rather than naming
 * one. It cannot see Dedication, Anita's personal bests or Carrolyn without more digging, so a
 * typed box always wins.
 */
/**
 * How the tab asks for a fresh look at the inventory.
 *
 * The profile belongs to the planner tab, which owns the key and the fetch, so this is a callback
 * registered from there rather than a second loader here. Null until a profile has been loaded,
 * which is also what the button uses to know it has nothing to offer yet.
 */
let reloadTools: (() => Promise<void>) | null = null;

export function setToolReloader(fn: () => Promise<void>): void {
  reloadTools = fn;
  if (host) render();
}

export function setDetectedFortune(input: {
  cropUpgrades: Record<string, number>;
  gardenUpgrades: Record<string, number>;
  lore: string[];
}): void {
  state.scan = {
    items: input.lore.length,
    upgradeKeys: Object.keys(input.cropUpgrades),
    unresolved: [],
  };

  /**
   * The two Garden upgrade tiers, which are published and were being guessed at nine.
   *
   * `GROWTH_SPEED` and `YIELD` are the boxes below, and the defaults assumed both maxed — which
   * overstates every figure on the page for anybody who is not. Taken only where the profile has
   * them, and only into boxes the player has not already set for themselves.
   */
  const tiers = input.gardenUpgrades;
  const growth = tiers.GROWTH_SPEED;
  const plantYield = tiers.YIELD;
  if (Number.isFinite(growth) && localStorage.getItem("sbxp:ghupgrade") === null) {
    state.growth = { ...state.growth, growthSpeedUpgrade: Number(growth) };
  }
  if (Number.isFinite(plantYield) && localStorage.getItem("sbxp:ghyield") === null) {
    state.growth = { ...state.growth, plantYieldUpgrade: Number(plantYield) };
  }
  const resolve = cropResolver(tables.greenhouse);

  const passive: Record<string, number> = {};
  for (const [key, level] of Object.entries(input.cropUpgrades)) {
    // The Garden keys these by Hypixel's item ids — `CARROT_ITEM`, `INK_SACK:3` — which are not the
    // names on the page. `cropResolver` knows all three vocabularies.
    const crop = resolve(key);
    if (crop) passive[crop] = (passive[crop] ?? 0) + cropUpgradeFortune(level);
  }

  // The largest figure found per crop, not the sum: a chest with three sickles in it is still one
  // sickle in your hand, and the same rule the Wisdom detection uses for held items.
  //
  // The lore arrives as loose lines rather than grouped by item, so this cannot tell a tool's +200
  // from an accessory's +30 and takes the larger. That makes the held figure a good reading of the
  // tool and makes the accessory's contribution invisible — which is a floor in the passive box, and
  // why a typed box beats this.
  const tools: Record<string, number> = {};
  for (const [raw, value] of Object.entries(cropFortuneFromLore(input.lore))) {
    const crop = resolve(raw);
    if (crop) tools[crop] = Math.max(tools[crop] ?? 0, value);
    // A stat this page could not place. Recorded rather than dropped: a crop named in lore under a
    // spelling the crop table does not carry is the failure this whole read has had twice already,
    // and it is invisible unless the page says so.
    else state.scan?.unresolved.push(raw);
  }

  state.detected = Object.keys(passive).length > 0 ? passive : null;
  const kept = rememberTools(tools);
  state.tools = Object.keys(kept).length > 0 ? kept : null;
  state.lastFound = Object.keys(tools).length;
  if (host) render();
}

export function unmountGreenhouse(): void {
  clearTimeout(timer);
  timer = undefined;
  host = null;
}

/** How long a stage takes at the current settings, which sets every figure on the page. */
function stageNote(): string {
  const seconds = stageSeconds(tables.greenhouse, state.growth);
  const m = Math.round(seconds / 60);
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m a growth stage`;
}

/**
 * What the fortune box is doing, and why being wrong about it matters less than it looks.
 *
 * Nothing here can see a player's gear — the tab takes no API key and asks for no username — so a
 * figure typed here is the only real one available. Saying so plainly beats presenting the
 * default as though it had been measured.
 */
/**
 * What the price toggle is doing, with the cost of it measured rather than asserted.
 *
 * The spread on a mutation is not a few percent. Rather than say "it can be large", this counts
 * the live books and reports the median, because a reader deciding whether to bother leaving
 * orders up wants the size of the prize and not an adjective.
 */
function priceModeNote(): string {
  const spreads: number[] = [];
  for (const m of tables.greenhouse.mutations ?? []) {
    const p = state.market.get(m.id);
    if (!p || p.instabuy <= 0 || p.instasell <= 0) continue;
    spreads.push(100 * (1 - p.instasell / p.instabuy));
  }
  spreads.sort((a, b) => a - b);
  const median = spreads.length ? spreads[Math.floor(spreads.length / 2)] : null;
  const widest = spreads.length ? spreads[spreads.length - 1] : null;

  const measured =
    median === null
      ? ""
      : ` The median mutation's bid sits <strong>${median.toFixed(0)}%</strong> below its ask and the` +
        ` widest is <strong>${widest!.toFixed(0)}%</strong>, so this is worth more than most of the` +
        ` other settings on this page.`;

  return state.priceMode === "order"
    ? `Mutations priced as <strong>orders left up</strong> — bought at the bid, sold at the ask.${measured}` +
        ` Crops are always instasold whatever this says: a harvest is tens of thousands of them and nobody waits on pumpkins.`
    : `Mutations priced as <strong>crossing the spread</strong> — bought from the cheapest offer, sold into the best bid.${measured}` +
        ` Crops are instasold either way.`;
}

function fortuneNote(): string {
  const typed = state.fortune.trim() !== "" && Number.isFinite(Number(state.fortune.replace(/[^0-9.]/g, "")));
  if (typed) {
    return `Crops scale <strong>${(1 + fortuneValue() / 100).toFixed(1)}×</strong>.`;
  }
  return (
    `Assuming <strong>${num(ASSUMED_FORTUNE)}</strong> <span class="dim" title="A placeholder for a ` +
    `mid-to-late farming setup, not a reading of your profile. Being wrong is cheap here: it lifts ` +
    `every mutation by the same amount, so it scales the coins and leaves the order alone.">(placeholder)</span>.`
  );
}

/**
 * A box per crop, because crop fortune is per crop.
 *
 * Folded away by default: thirteen inputs is a lot to meet on arrival, and the page says something
 * sensible without them. Opened, it is the only control here that changes the *order* of the
 * table rather than the size of its numbers, which the heading says.
 *
 * The Overdrive Chip is called out because it is the easiest figure to enter wrongly — it is worth
 * up to +140 to one crop and it only exists during a Jacob's Contest, so typing it in as a
 * standing stat overstates every mutation dropping that crop for the other twenty-three hours.
 */
function cropFortunePanel(): string {
  const crops = tables.greenhouse.cropFortunes ?? [];
  if (crops.length === 0) return "";

  /**
   * One read gets one tool, so this is a button rather than something that happens on load.
   *
   * The Farming Toolkit is not published, which leaves only whatever is in your hand — so building
   * the set means holding a tool, pressing this, swapping, pressing it again. Saying "reads the one
   * you are holding" up front is what stops that reading as a broken feature.
   */
  const kept = Object.keys(state.tools ?? {}).length;
  // Shown even with no profile loaded, greyed and saying why. A control that appears only once
  // some other tab has been used is a feature nobody discovers.
  const ready = reloadTools !== null;
  const loadTools =
    `<button type="button" class="chip${state.loadingTools ? " on" : ""}" id="ghloadtools"${
      state.loadingTools || !ready ? " disabled" : ""
    } title="${escapeHtml(
      ready
        ? "Reads the crop fortune off the farming tool you are holding, and remembers it. Hypixel does not publish the Farming Toolkit, so one press finds one tool — hold the next and press again. Kept between visits."
        : "Load a profile on the XP Planner tab first; this reads the tool you are holding from it.",
    )}">${state.loadingTools ? "Reading…" : "Load tools"}</button>` +
    (kept > 0
      ? ` <button type="button" class="chip" id="ghforgettools" title="Forget the remembered tools and start again.">${num(
          kept,
        )} remembered</button>`
      : "");

  const summary = `<button type="button" class="chip" id="ghcroptoggle">${
    state.showCrops ? "Hide" : "Add"
  } crop fortune</button> ${loadTools}`;
  if (!state.showCrops) {
    const filled = Object.keys(cropFortuneValues()).length;
    return `<p class="sub">${summary} <span class="dim" title="Wheat Fortune, Carrot Fortune and the rest. Unlike the box above, each lifts one crop only — which makes these the one input here that changes which mutation wins, rather than just how big the numbers are.">${
      filled > 0 ? `${filled} set` : "per-crop — these change the order"
    }</span></p>`;
  }

  const held = heldFortuneValues();
  const boxes = crops
    .map((c) => {
      const tool = state.tools?.[c.crop] ?? 0;
      const on = state.contestCrops[c.crop] === true;
      const bonus = held[c.crop] ?? 0;
      return `<label title="${escapeHtml(c.stat)} — lifts ${escapeHtml(c.crop)} only.">${escapeHtml(c.crop)}
          <input class="gh-crop" data-ghcrop="${escapeHtml(c.crop)}" value="${escapeHtml(
            state.cropFortune[c.crop] ?? (state.detected?.[c.crop] ? String(state.detected[c.crop]) : ""),
          )}" placeholder="${state.detected?.[c.crop] ?? 0}" autocomplete="off">
          <span class="gh-held" title="${escapeHtml(
            `Only the crop you bring the tool for gets this${tool > 0 ? `. Your best ${c.crop} tool carries +${tool}` : ""}${
              on ? `, and the Overdrive Chip adds +${OVERDRIVE_CHIP_FORTUNE} during a contest` : ""
            }. A mutation dropping several crops gets it on one of them — whichever it earns the most on.`,
          )}">
            <input type="checkbox" data-ghcontest="${escapeHtml(c.crop)}"${on ? " checked" : ""}>
            ${bonus > 0 ? `+${num(bonus)}` : `<span class="dim">contest</span>`}
          </span>
        </label>`;
    })
    .join("");

  return `
    <p class="sub">${summary}</p>
    <div class="row gh-crops">${boxes}</div>
    <p class="sub dim" title="Added to Farming Fortune for that crop only, before the yield is worked out — the wiki's rule, not ours.">
      The box is what you have whatever you hold — Garden crop upgrades, Anita, Carrolyn, accessories.
      The tick is what rides on the <strong>one tool you can hold</strong>: its crop fortune, plus the
      <strong>Overdrive Chip's +${OVERDRIVE_CHIP_FORTUNE}</strong> during a Jacob's Contest. A mutation
      dropping several crops gets that on one of them, not on all.
    </p>
    ${scanNote()}
  `;
}

/**
 * What the profile read found, said out loud.
 *
 * Silence is the wrong default here. A read that finds nothing and a read that never ran look
 * exactly alike from the page — empty boxes — and this one has been wrong twice on that basis. So
 * it reports the three numbers that distinguish them: how many items it looked at, how many tools
 * it recognised, and anything it saw and could not place.
 */
function scanNote(): string {
  const scan = state.scan;
  if (!scan) {
    return `<p class="sub dim">Load a profile on the XP Planner tab and these fill in from your Garden
      upgrades and the crop fortune your tools state.</p>`;
  }

  const tools = Object.entries(state.tools ?? {});
  const upgrades = Object.keys(state.detected ?? {});
  const parts = [
    `${num(scan.items)} item${scan.items === 1 ? "" : "s"} read`,
    tools.length > 0
      ? `<strong>${tools.length}</strong> tool${tools.length === 1 ? "" : "s"} remembered (${tools
          .sort((a, b) => b[1] - a[1])
          .slice(0, 4)
          .map(([crop, value]) => `${escapeHtml(crop)} +${num(value)}`)
          .join(", ")}${tools.length > 4 ? ", …" : ""})`
      : `<strong class="gold">no tools found</strong>`,
    `Garden upgrades on ${upgrades.length} of ${scan.upgradeKeys.length}`,
  ];

  const stuck =
    scan.unresolved.length > 0
      ? ` <span class="gold">Could not place: ${[...new Set(scan.unresolved)].map(escapeHtml).join(", ")}.</span>`
      : "";

  /**
   * The limit, stated rather than left to look like a bug.
   *
   * Hypixel does not publish the Farming Toolkit's contents. Not under a bag, not in
   * `shared_inventory`, not on the garden endpoint — a sweep of one real profile found 147 NBT
   * blobs and 670 items with lore, and of every farming tool that account owns exactly one turned
   * up: the hoe that happened to be loose in the inventory. So a tool in the toolkit is invisible
   * here, and the box beside its crop stays a box.
   */
  const toolkit = ` <span class="gold">Hypixel does not publish the Farming Toolkit, so a read finds only the
    tool in your hand — hold the next one and press <strong>Load tools</strong> again. They are kept.</span>`;

  return `<p class="sub dim">From your profile — ${parts.join(" · ")}.${stuck}${toolkit}</p>`;
}

/**
 * One click for "only the ones I can plant and walk away from".
 *
 * It writes `no` into the Water column's own box rather than filtering behind your back, so the
 * table's summary line explains itself and the box can be cleared like any other. Pressing it again
 * clears it.
 *
 * It sets the *Water* filter and not an hours cutoff on Per harvest, which is where you might
 * expect it, and the reason is the unit. Water is spent per growth stage, so what decides whether a
 * mutation ever runs dry is its stage count against the thirty-three its water covers — a
 * comparison with no hours in it at all. Per harvest is mostly the wait for the thing to *appear*,
 * during which it does not exist and cannot be thirsty, so a cutoff there would have condemned
 * every rare mutation for a drought it never sees.
 */
function dryChip(): string {
  const on = (state.filters.needsWater ?? "").trim().toLowerCase() === "no";
  return `<span class="tabs"><button class="chip${on ? " on" : ""}" data-ghdry="${on ? "0" : "1"}"
    title="Show only what never needs the watering can. Water goes 2-3 a growth stage down to a floor of -100, so thirty-three stages are covered unwatered — and all but two mutations finish growing well inside that. Sets the Water column's box to no.">Never needs watering</button></span>`;
}

function render(): void {
  if (!host) return;

  host.innerHTML = `
    <div class="meta" id="ghmeta">${metaHtml()}</div>

    <div class="panel pad controls">
      <div class="row">
        <label title="Your Farming Fortune. Nothing here can read it off your profile, so it is a box rather than a lookup.">Farming Fortune
          <input id="ghfortune" value="${escapeHtml(state.fortune)}" placeholder="${num(ASSUMED_FORTUNE)}" autocomplete="off">
        </label>
        <span class="tabs">
          ${[1, 3].map((n) => `<button class="chip${state.plots === n ? " on" : ""}" data-ghplots="${n}">${n} greenhouse${n > 1 ? "s" : ""}</button>`).join("")}
        </span>
        ${dryChip()}
        <span class="tabs">
          <button class="chip${state.priceMode === "order" ? " on" : ""}" data-ghmode="order"
            title="Leave orders up: buy the ring with buy orders at the bid, sell the harvest with sell offers at the ask. Costs nothing but the wait, and on a thin mutation book the wait is the whole difference.">Buy / sell order</button>
          <button class="chip${state.priceMode === "instant" ? " on" : ""}" data-ghmode="instant"
            title="Cross the spread both ways: instabuy the ring from the cheapest sell offers, instasell the harvest into the best buy orders. Immediate, and on a thin mutation book it can cost most of the value.">Instant buy / sell</button>
        </span>
      </div>
      <p class="sub" id="ghfortunenote">${fortuneNote()}</p>
      <p class="sub dim">${priceModeNote()}</p>

      ${cropFortunePanel()}

      <div class="row">
        <label title="Unique non-mutated crops growing in any plot. Twelve is the documented maximum and each one speeds every plot up.">Unique crops
          <input type="number" id="ghunique" min="0" max="12" value="${state.growth.uniqueCrops}"></label>
        <label title="The Crop Growth stat, 0-210.">Crop Growth
          <input type="number" id="ghgrowth" min="0" max="210" value="${state.growth.cropGrowth}"></label>
        <label title="The Greenhouse Speed attribute, 0-10.">Speed attribute
          <input type="number" id="ghspeed" min="0" max="10" value="${state.growth.speedAttribute}"></label>
        <label title="The Growth Speed garden upgrade, 0-9. The ninth tier is worth double a normal one.">Growth upgrade
          <input type="number" id="ghupgrade" min="0" max="9" value="${state.growth.growthSpeedUpgrade}"></label>
        <label title="The Plant Yield greenhouse upgrade, 0-9. +2% base crops a tier and +4% for the ninth, so +20% at the top — the same double-last-tier step Growth Speed has. Multiplies the crops a harvest gives, on top of fortune.">Plant yield
          <input type="number" id="ghyield" min="0" max="9" value="${state.growth.plantYieldUpgrade ?? 0}"></label>
        <label title="The Evergreen Chip's bonus, 0-60%. More base crops in the Greenhouse, stacking with Plant Yield and the unique-crop bonus.">Evergreen chip %
          <input type="number" id="ghevergreen" min="0" max="60" value="${state.growth.evergreenChip ?? 0}"></label>
        <span class="dim" id="ghstagenote">${stageNote()}</span>
      </div>
    </div>

    <div id="ghtable"></div>
  `;

  renderTable();
}

function metaHtml(): string {
  const gh = tables.greenhouse;
  const age = state.lastUpdated ? `priced ${Math.round((Date.now() - state.lastUpdated) / 1000)}s ago` : "";
  return `
    <strong>${num(gh.mutations?.length ?? 0)} mutations</strong>
    <span class="dim">${escapeHtml(age)}</span>
    ${state.status ? `<span class="dim">${escapeHtml(state.status)}</span>` : ""}
    ${state.error ? `<span class="gold">${escapeHtml(state.error)}</span>` : ""}
    <button type="button" class="chip" id="ghrefresh">Refresh now</button>
  `;
}

function renderMeta(): void {
  const meta = document.getElementById("ghmeta");
  if (meta) meta.innerHTML = metaHtml();
}

/**
 * The one paragraph above the table.
 *
 * It used to restate what every column now says in its own tooltip — how a harvest is two waits,
 * what the three income streams are, which figures are gross. Said twice it is noise, and a reader
 * hunting for the caveat has to wade through the parts they already understood. What is left is
 * only what a column heading cannot carry: coins/hr is the ranking, the numbers are gross, and the
 * drop table has a date on it that makes every older guide wrong.
 */
const NOTE =
  "Ranked on what it nets a day once you count replanting. Plants rot: base crops last 72 hours, " +
  "so the ring is a running cost and the question is how many harvests one planting buys — a " +
  "mutation at 35 hours a harvest gets two, one at 13 hours gets five. Hover any heading for what " +
  "it means; click a row for the plot, the split and the bill. Both changes landed on 2026-08-20, " +
  "so anything quoted before that is for a different game.";

function renderTable(): void {
  const target = document.getElementById("ghtable");
  if (!target) return;

  if (state.market.size === 0) {
    target.innerHTML = `<p class="dim pad">Waiting for the first read of the bazaar…</p>`;
    return;
  }

  const { matching, failing } = partition(sorted(rows()));
  const shown = state.hideFiltered ? matching : [...matching, ...failing];
  const dimmed = new Set(state.hideFiltered ? [] : failing.map((r) => r.id));
  // Where the matches stop. Fading alone says a row is lesser but not where the line was drawn,
  // and on a forty-row table you scroll past the boundary without noticing you crossed it.
  const cut = state.hideFiltered || matching.length === 0 ? null : failing[0]?.id;
  const head = COLUMNS.map((c) => {
    const on = state.sort.column === c.id;
    const arrow = on ? (state.sort.descending ? " ▾" : " ▴") : "";
    return `<th class="num${on ? " on" : ""}" data-ghsort="${c.id}"${
      c.title ? ` title="${escapeHtml(c.title)}"` : ""
    }><span class="gh-head">${escapeHtml(c.label)}${arrow}</span>${filterBox(c)}</th>`;
  }).join("");

  const body = shown
    .map((row) => {
      const cells = COLUMNS.map((c) => `<td class="num">${c.render(row)}</td>`).join("");
      const icon = `<img class="bz-icon" src="${iconUrl(row.id)}" alt="" width="20" height="20" loading="lazy" decoding="async">`;
      const problem = row.problem
        ? `<div class="gold bz-path" title="Kept on the list rather than hidden: a mutation nobody can price is still one worth knowing about.">${escapeHtml(row.problem)}</div>`
        : "";
      // Every crop the condition names, because it names all of them at once — the slash on the
      // wiki reads like "or" and means "and". Listing only one, as this did at first, halves the
      // bill and hides the expensive half of the setup.
      const setup = row.setup && !row.problem
        ? `<div class="dim bz-path" title="Every plant this needs, for the whole plot — all of them at once.">${row.setup.items
            .map(
              (i) =>
                `${num(i.plants)} × ${escapeHtml(i.name)}${i.free ? ` <span class="dim">(free)</span>` : ""}${
                  i.grown ? `<span class="dim" title="Itself a mutation, so it has to be grown before it can be planted — or bought outright.">*</span>` : ""
                }`,
            )
            .join(" <span class=\"dim\">+</span> ")}</div>`
        : "";
      const rarity = row.rarity ? ` <span class="dim">${escapeHtml(row.rarity)}</span>` : "";
      // Which crop fortune lifted this row, when one did. Named rather than folded silently into
      // the total, because it is the input most likely to be a contest-day figure entered as a
      // standing one — and this is where that would show up.
      const lifted = row.cropsLifted.length
        ? ` <span class="dim" title="Lifted by the crop fortune you entered for ${escapeHtml(
            row.cropsLifted.join(", "),
          )}, on top of your general Farming Fortune.">+${escapeHtml(row.cropsLifted.join(", "))}</span>`
        : "";
      // The detail is its own row spanning every column rather than a block inside the name cell,
      // so it gets the whole width instead of the narrowest column on the page. It carries no
      // data-ghopen: clicking inside it should let you read and select, not slam it shut.
      const detail =
        state.open === row.id ? `<tr class="gh-detail"><td colspan="${COLUMNS.length + 1}">${detailHtml(row)}</td></tr>` : "";
      const off = `${dimmed.has(row.id) ? " bz-faded" : ""}${row.id === cut ? " gh-cut" : ""}`;
      return `<tr class="bz-open${off}" data-ghopen="${escapeHtml(row.id)}"><td>${icon}${escapeHtml(row.name)}${rarity}${lifted}${setup}${problem}</td>${cells}</tr>${detail}`;
    })
    .join("");

  // Read before the innerHTML below throws the focused input away with everything else.
  const focused = focusedFilter();

  target.innerHTML = `
    <p class="dim pad">${escapeHtml(NOTE)}</p>
    <div class="panel scroll">
      <table class="bz">
        <thead><tr><th><span class="gh-head">Mutation</span>${filterBox(NAME_COLUMN)}</th>${head}</tr></thead>
        <tbody>${body}</tbody>
      </table>
    </div>
    <p class="dim pad">${filterNote(matching.length, failing.length)}${escapeHtml(stageNote())} · ${state.plots} greenhouse${
      state.plots > 1 ? "s" : ""
    }</p>
  `;
  restoreFilterFocus(focused);
}

/**
 * One column's box, drawn inside its own heading.
 *
 * Inside rather than in a second header row, and the reason is sticky positioning: the heading row
 * is pinned to the top of the scroller, and a second pinned row would need to know the first one's
 * height in pixels to sit below it. Nested in the same cell, the box is under its label by
 * construction and stays there at any font size.
 *
 * As wide as its column and no wider. Nine of these across a table that already scrolls sideways
 * means anything roomier costs a column its width, and the strings being typed here are four
 * characters long.
 */
function filterBox(column: Column): string {
  const typed = state.filters[column.id] ?? "";
  const parsed = parseFilter(typed, column.kind ?? "number");
  // A box it cannot read is marked rather than obeyed, so the table never empties mid-keystroke.
  const bad = parsed.state === "bad" ? " bad" : "";
  const reading =
    parsed.state === "ok"
      ? `Showing ${column.label} ${parsed.label}. ${filterHelp(column)}`
      : parsed.state === "bad"
        ? `Cannot read that, so it is filtering nothing. ${filterHelp(column)}`
        : filterHelp(column);
  return `<input class="gh-box${bad}" data-ghfilter="${column.id}" value="${escapeHtml(typed)}" placeholder="${escapeHtml(
    column.hint ?? "",
  )}" autocomplete="off" spellcheck="false" title="${escapeHtml(reading)}">`;
}

/** What this particular box takes, said in one line. */
function filterHelp(column: Column): string {
  switch (column.kind) {
    case "text":
      return "Part of a name. Case does not matter.";
    case "boolean":
      return "yes or no. Case does not matter.";
    case "hours":
      return "A number of hours, decimals and all: >6.2, <14.8, 6-12. A bare number means that many or more.";
    default:
      return "A figure, with k, m or b if you like: >10m, <500k, 1m-5m. A bare number means that much or more.";
  }
}

/**
 * The line under the table: "7 of 40 match — Setup under 10m, Water no · hide the other 33 · clear".
 *
 * It says back what it read, in words rather than in the symbols that were typed, because that is
 * the only place a misread box shows up. `>10` in a column of millions is valid, parses cleanly and
 * matches everything — and "Setup 10 or more" beside it is what makes that obvious.
 */
function filterNote(matching: number, failing: number): string {
  const active = activeFilters();
  if (active.length === 0) return `${num(matching)} mutations · `;

  const said = active
    .flatMap((f) => (f.parsed.state === "ok" ? [`${f.column.label} ${f.parsed.label}`] : []))
    .join(", ");
  const unreadable = active.flatMap((f) => (f.parsed.state === "bad" ? [f.column.label] : []));
  const trouble = unreadable.length
    ? ` · <span class="gold">${escapeHtml(unreadable.join(", "))} unreadable, so filtering nothing</span>`
    : "";
  const toggle =
    failing > 0 || state.hideFiltered
      ? ` · <button class="linky" data-ghhide="${state.hideFiltered ? "0" : "1"}">${
          state.hideFiltered ? "show the rest" : `hide the other ${num(failing)}`
        }</button>`
      : "";
  return `${num(matching)} of ${num(matching + failing)} match${
    said ? ` — ${escapeHtml(said)}` : ""
  }${trouble}${toggle} · <button class="linky" data-ghclearfilters="1">clear</button> · `;
}

/**
 * Put the caret back where it was.
 *
 * The table is rebuilt from scratch on every keystroke, which throws away the focused input along
 * with everything else. Without this, typing ">10m" gets one character in and then types the rest
 * somewhere else entirely.
 *
 * Asked of the live DOM at the moment of the repaint rather than remembered from the last
 * keystroke, because a repaint is not always a keystroke: the bazaar poll fires one every twenty
 * seconds, and a remembered box would have it reach out and take the caret back from wherever the
 * player had moved on to.
 */
type FilterFocus = { id: string; caret: number } | null;

function focusedFilter(): FilterFocus {
  const active = document.activeElement;
  if (!(active instanceof HTMLInputElement)) return null;
  const id = active.dataset.ghfilter;
  return id === undefined ? null : { id, caret: active.selectionStart ?? active.value.length };
}

function restoreFilterFocus(focus: FilterFocus): void {
  if (!focus) return;
  const box = document.querySelector<HTMLInputElement>(`[data-ghfilter="${CSS.escape(focus.id)}"]`);
  if (!box) return;
  box.focus();
  const caret = Math.min(focus.caret, box.value.length);
  box.setSelectionRange(caret, caret);
}
/**
 * The expanded row: the plot on the left, where the coins come from in the middle, what it costs on
 * the right.
 *
 * Three questions the table cannot answer in a cell. *Where does the money come from* — because a
 * single coins/day hides that one mutation is carrying its own item price and another is carrying a
 * pile of pumpkins. *What exactly am I buying* — because the expensive plant is usually the whole
 * bill and a total does not name it. And *is that figure net* — because it is not, and the only
 * honest place to say so is beside the number it qualifies.
 */
function detailHtml(row: MutationProfit): string {
  const mutation = tables.greenhouse.mutations.find((m) => m.id === row.id);
  const packing = row.packing;
  if (!mutation || !packing || packing.targets === 0 || !row.setup) {
    // A row with nothing growing on it still gets the button, and it is the row that needs it most:
    // PlantBoy Advance reads as unbuildable only because no repeating tile can express a ring of
    // six cells of a 3x3 plant. Searched properly, it grows. Bailing out here left the one mutation
    // the optimiser exists for as the one place it could not be reached.
    const offer = mutation ? optimiseHtml(row, mutation) : "";
    return `<div class="gh-layout"><p class="dim">No repeating pattern of this plot grows one of these.</p>${offer}</div>`;
  }

  return `<div class="gh-expand">
    <div class="gh-expand-col">${plotHtml(row, mutation, packing)}</div>
    <div class="gh-expand-col">${incomeHtml(row, mutation)}</div>
    <div class="gh-expand-col">${costHtml(row, mutation)}</div>
  </div>`;
}

/**
 * The whole plot, not the wiki's single 3x3.
 *
 * The wiki draws one mutation in isolation, which is a pattern to copy rather than a plan. A real
 * greenhouse overlaps them — the ring of one is the ring of its neighbour — and the overlap is
 * where the yield comes from.
 */
function plotHtml(row: MutationProfit, mutation: Mutation, packing: NonNullable<MutationProfit["packing"]>): string {
  const items = row.setup!.items;
  const swatch = (i: number) => `<span class="gh-key gh-c${i % 5}"></span>`;
  const legend =
    items.map((i, at) => `${swatch(at)} ${escapeHtml(i.name)}`).join(" ") +
    ` <span class="gh-key gh-k-target"></span> ${escapeHtml(mutation.name)}` +
    ` <span class="gh-key gh-k-empty"></span> spare`;

  const grid = packing.grid
    .map(
      (line) =>
        `<div class="gh-row">${line
          .map((cell) => {
            if (cell === "locked") return `<span class="gh-plot gh-locked" title="Not unlocked."></span>`;
            if (cell === "target") return `<span class="gh-plot gh-k-target" title="${escapeHtml(mutation.name)} grows here"></span>`;
            if (cell === "empty") return `<span class="gh-plot gh-k-empty" title="Empty — its ring is not fed, so nothing grows here."></span>`;
            const item = items[cell as number];
            return `<span class="gh-plot gh-c${(cell as number) % 5}" title="${escapeHtml(item?.name ?? "support")}"></span>`;
          })
          .join("")}</div>`,
    )
    .join("");

  // A period of zero is how an optimised plot announces itself: it was not stamped from a tile, so
  // there is no tile to quote.
  const shape =
    packing.period.rows === 0
      ? `<span title="Laid out one mutation at a time rather than stamped from a repeating tile, which is why it does not look regular.">irregular</span>`
      : `${packing.period.rows}×${packing.period.cols} tile`;

  return `
    <h4 class="gh-h">One greenhouse</h4>
    <div class="gh-plotgrid">${grid}</div>
    <p class="dim">${legend}</p>
    <p class="dim">
      <strong>${num(packing.targets)}</strong> at once · <strong>${num(row.setup!.plants)}</strong> plants · ${shape}
    </p>
    ${waterLine(row)}
    ${optimiseHtml(row, mutation)}
    ${mutation.effects.length ? `<p class="dim">${escapeHtml(mutation.effects.join(" · "))}</p>` : ""}
  `;
}

/**
 * The button, and the one word beside it saying whether it has already been pressed.
 *
 * Three states rather than two, and the third is the point. Twenty-one of the forty mutations fill
 * their ring completely, and a full ring means no two can touch and none can sit against the edge —
 * so the positions are a lattice of known spacing and the count is arithmetic, not search. Those
 * rows are told outright that nothing can beat what they already have, rather than being offered a
 * second of waiting that provably cannot pay.
 *
 * The rest get the button. It is not on by default because it costs about a second each and buys
 * nothing at all on most of them; it is worth it on eight, and two of those are dramatic — All-in
 * Aloe grows eleven where the tile search managed four, and PlantBoy Advance grows at all.
 */
function optimiseHtml(row: MutationProfit, mutation: Mutation): string {
  const layout = layoutStateOf(mutation, mutationIndex(), state.market, tables.npcPrices, FULL_PLOT, state.priceMode);
  if (!layout) return "";

  if (layout.capped) {
    return `<p class="dim gh-opt"><span class="gh-tag" title="Every cell of this ring has to hold a plant, so no two of these can touch and none can sit against the plot edge. That fixes where they go and how many fit — it is arithmetic rather than a search, and this is already that number.">provably the most</span></p>`;
  }

  if (state.optimising === row.id) {
    return `<p class="dim gh-opt"><button class="chip" disabled>searching…</button> <span class="gh-tag">a second or so</span></p>`;
  }

  const note = state.optimiseNote[layout.key];
  const tag = layout.optimised
    ? `<span class="gh-tag on" title="${escapeHtml(
        note ?? "This layout came from the expensive search and is kept until the plants change price.",
      )}">optimised</span>`
    : `<span class="gh-tag" title="Showing the repeating-tile layout. The expensive search looks at irregular arrangements too, which on some conditions grow considerably more.">not optimised</span>`;

  const label = layout.optimised ? "Search again" : "Optimise";
  return `<p class="dim gh-opt"><button class="chip" data-ghoptimise="${escapeHtml(row.id)}" title="Lay this plot out one mutation at a time instead of stamping a repeating tile. Takes about a second, and the answer is kept.">${label}</button> ${tag}${
    note ? ` <span class="dim">${escapeHtml(note)}</span>` : ""
  }</p>`;
}

/** The mutations keyed by id, which several of the library calls want. */
let indexed: Map<string, Mutation> | null = null;
function mutationIndex(): Map<string, Mutation> {
  if (!indexed || indexed.size !== tables.greenhouse.mutations.length) {
    indexed = new Map(tables.greenhouse.mutations.map((m) => [m.id, m]));
  }
  return indexed;
}

/**
 * Search one mutation's layout, then redraw.
 *
 * Handed to a timer rather than run inline so the "searching…" label actually reaches the screen
 * first — the search is a straight second of arithmetic and would otherwise freeze the page with
 * the old text still on it, which reads as a click that did nothing.
 */
function runOptimise(id: string): void {
  const mutation = tables.greenhouse.mutations.find((m) => m.id === id);
  if (!mutation || state.optimising) return;
  state.optimising = id;
  renderTable();

  window.setTimeout(() => {
    try {
      const result = optimiseLayout(mutation, mutationIndex(), state.market, tables.npcPrices, FULL_PLOT, state.priceMode);
      if (result) {
        const layout = layoutStateOf(mutation, mutationIndex(), state.market, tables.npcPrices, FULL_PLOT, state.priceMode);
        const grew = result.after.targets - result.before.targets;
        const saved = result.before.cost > 0 ? (result.before.cost - result.after.cost) / result.before.cost : 0;
        const said =
          grew > 0
            ? `${grew} more at once — ${result.before.targets} → ${result.after.targets}`
            : saved > 0.01
              ? `same yield, ring ${Math.round(saved * 100)}% cheaper`
              : "searched every arrangement it could reach; the tile layout was already the best of them";
        if (layout) state.optimiseNote[layout.key] = said;
      }
      rememberLayouts();
    } finally {
      state.optimising = null;
      renderTable();
    }
  }, 30);
}

/**
 * Where coins/day actually comes from.
 *
 * Three kinds of income and they are not interchangeable. The **crops** are the wiki's drop table:
 * they arrive in thousands and fortune multiplies them. The **mutation itself** is one item a
 * harvest, fortune does not touch it, and on the expensive rows it is most of the money — which is
 * exactly what a single total hides. The **Ethereal Vine** is a chance, so it is quoted as one.
 */
function incomeHtml(row: MutationProfit, mutation: Mutation): string {
  const gross = row.coinsPerDay;
  if (gross === null || row.harvestsPerDay === null) {
    return `<h4 class="gh-h">Where the coins come from</h4><p class="dim">${escapeHtml(
      row.problem ?? "No cycle time, so no daily figure.",
    )}</p>`;
  }

  // How many times a day one drop actually happens: one target's harvest, times how many targets
  // are growing at once across every plot, times how many times a day each one cycles. Every line
  // below multiplies its own quantity by its own price — no hidden factor between the two columns
  // a reader can see and the total beside them, which a "1 × price" detail did not do: a single
  // Noctilume reads as one, but forty-eight of them are actually harvested in a day.
  const perDayCount = row.perPlot * row.plots * row.harvestsPerDay!;
  const line = (label: string, qty: string, each: number, day: number) => {
    const share = gross > 0 ? `${Math.round((100 * day) / gross)}%` : "";
    return `<tr><td>${label}</td><td class="num dim">${qty} × ${coins(each)}</td><td class="num"><strong>${coins(
      day,
    )}</strong></td><td class="num dim">${share}</td></tr>`;
  };

  const cropLines = row.drops
    .map((d) =>
      d.each === null
        ? `<tr><td>${escapeHtml(d.name)}</td><td class="gold" colspan="3">nothing is bidding on it</td></tr>`
        : line(escapeHtml(d.name), num(Math.round(d.amount * d.multiplier * perDayCount)), d.each, d.coins * perDayCount),
    )
    .join("");

  const selfLine = row.self
    ? line(
        `<strong>${escapeHtml(mutation.name)}</strong> <span class="dim">itself</span>`,
        num(Math.round(perDayCount)),
        row.self.each ?? 0,
        row.self.coins * perDayCount,
      )
    : `<tr><td>${escapeHtml(mutation.name)} itself</td><td class="gold" colspan="3">not on the bazaar</td></tr>`;

  const chance = tables.greenhouse.etherealVineByRarity?.[(row.rarity ?? "").toLowerCase()] ?? 0;
  const vineLine =
    row.vineRevenue > 0
      ? `<tr><td>Ethereal Vine</td><td class="num dim">${Math.round(chance * 100)}% a harvest</td><td class="num"><strong>${coins(
          row.vineRevenue * perDayCount,
        )}</strong></td><td class="num dim">${gross > 0 ? `${Math.round((100 * row.vineRevenue * perDayCount) / gross)}%` : ""}</td></tr>`
      : "";

  // The crop-versus-item split used to be spelled out here. It is the % column, read twice.
  const fortune = row.drops.length
    ? `Crop counts include your <strong>${row.drops[0].multiplier.toFixed(1)}×</strong> fortune${
        row.cropsLifted.length ? ` (${escapeHtml(row.cropsLifted.join(", "))})` : ""
      }; the mutation itself is one item, so fortune does not touch it.`
    : "";

  const cadence =
    row.harvestsPerDay >= 1
      ? `${row.harvestsPerDay.toFixed(1)}× a day`
      : `every ${hours(row.hoursPerHarvest ?? 0)}`;

  return `
    <h4 class="gh-h">Where the coins come from</h4>
    <p class="dim">A day's worth: <strong>${num(row.perPlot * row.plots)}</strong> growing, harvested <strong>${escapeHtml(
      cadence,
    )}</strong> · <span title="One mutation, one harvest — crops, the item itself and the vine chance.">${coins(
      row.revenue + row.vineRevenue,
    )} each</span> · <span title="The square it occupies, and how many ring cells one of these fills when something else needs it.">${
      row.size
    }×${row.size}</span>.</p>
    <table class="gh-break">
      <tbody>
        ${cropLines}
        ${selfLine}
        ${vineLine}
        <tr class="gh-total">
          <td>Gross a day</td>
          <td></td>
          <td class="num"><strong>${coins(gross)}</strong></td>
          <td></td>
        </tr>
      </tbody>
    </table>
    <p class="dim">${fortune}</p>
  `;
}

/**
 * What it costs, itemised — and whether the coins/day beside it is net of that.
 *
 * It is not, and this is where that gets said. The ring is a one-off: you buy it once and the
 * plants stand there, so it comes off the first day and off no other. Folding it into a running
 * cost would understate every expensive setup permanently; ignoring it flatters them on day one.
 * Payback time is the figure that puts a one-off and a repeating income in the same unit.
 */
function costHtml(row: MutationProfit, mutation: Mutation): string {
  const setup = row.setup!;
  const bill = setup.items
    .map((i) => {
      const cost = i.free
        ? `<span class="dim">free — lit, not bought</span>`
        : i.each === null
          ? `<span class="gold">nothing is selling it</span>`
          : `${coins(i.each)} each · <strong>${coins((i.coins ?? 0) * row.plots)}</strong>`;
      const share = setup.coins && i.coins ? ` <span class="dim">${Math.round((100 * i.coins) / setup.coins)}%</span>` : "";
      // The asterisk carries "this is itself a mutation, grow it or buy it" in its tooltip. It was
      // also a paragraph underneath naming the same plants again, which the marks already do.
      const grown = i.grown
        ? `<span class="dim" title="Itself a mutation: priced at what the bazaar asks, but you can grow it in another plot instead — cheaper and slower.">*</span>`
        : "";
      return `<tr>
        <td>${num(i.plants * row.plots)} × ${escapeHtml(i.name)}${grown}
          <span class="dim gh-sub" title="Ring cells this plant fills at each ${escapeHtml(mutation.name)}.">${i.cells} cells</span>
        </td>
        <td class="num">${cost}${share}</td>
      </tr>`;
    })
    .join("");

  // The old version of this table said "every day after" and quoted the gross figure, which was
  // true until base crops started rotting and is now the opposite of true: the ring comes back
  // every 72 hours. What replaces it is the life of one planting, start to finish.
  const life = row.setupLife.hours;
  const net =
    row.netPerSetup === null || row.setupTotal === null || row.harvestsPerSetup === null
      ? setup.coins === null
        ? `<p class="gold">Part of this has no price, so there is no total.</p>`
        : ""
      : `
      <table class="gh-break">
        <tbody>
          <tr class="gh-total"><td>Setup, once</td><td class="num gold">-${coins(row.setupTotal)}</td></tr>
          <tr><td>${num(row.harvestsPerSetup)} harvest${row.harvestsPerSetup === 1 ? "" : "s"} × ${coins(
            row.perHarvest,
          )}</td><td class="num">${coins(row.harvestsPerSetup * row.perHarvest)}</td></tr>
          <tr><td><strong>Net, one planting</strong></td><td class="num"><strong>${
            row.netPerSetup < 0 ? `<span class="gold">-${coins(-row.netPerSetup)}</span>` : coins(row.netPerSetup)
          }</strong></td></tr>
          <tr><td class="dim">then replant</td><td class="num dim">${life === null ? "never" : `every ${hours(life)}`}</td></tr>
        </tbody>
      </table>
      <p class="dim">${
        row.netPerSetup < 0
          ? `<span class="gold">One planting does not earn back what it costs</span>, however good the daily figure looks — the ring rots before enough harvests land.`
          : `The ring is gone in ${life === null ? "no time at all" : hours(life)}, so this is what a planting is worth start to finish.`
      }${
        row.setupLife.exact
          ? ""
          : " That life is a floor: this ring holds a mutation whose decay timer has never been published, only that the shortest is three days."
      }</p>`;

  return `
    <h4 class="gh-h" title="Every plant is needed at the same time — the wiki writes the condition with slashes, but it is an &quot;and&quot;. The number after each name is how many ring cells it fills.">What it costs${
      row.plots > 1 ? ` <span class="dim">· ${row.plots} greenhouses</span>` : ""
    }</h4>
    <table class="gh-break"><tbody>${bill}</tbody></table>
    ${net}
  `;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
