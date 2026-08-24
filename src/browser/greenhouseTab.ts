import { normalise } from "../lib/bazaar";
import { observe, observedFor, relativeTo, type Baseline } from "../lib/bazaarHistory";
import type { NpcPrice } from "../lib/bazaarViews";
import type { ProductSnapshot, RawBazaarProduct } from "../lib/bazaarTypes";
import { depthNote } from "../lib/filters";
import { coins, num } from "../lib/format";
import {
  rankMutations,
  stageSeconds,
  type GreenhouseData,
  type GrowthParams,
  type Mutation,
  type MutationProfit,
} from "../lib/greenhouse";

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
  search: string;
  /** One greenhouse or all three. The wiki caps it at three. */
  plots: number;
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
  growth: GrowthParams;
  /** Which row's layout is open, if any. */
  open: string | null;
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

/** The typed boxes as numbers, dropping anything blank or unparseable. */
function cropFortuneValues(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [crop, raw] of Object.entries(state.cropFortune)) {
    const n = Number(String(raw).replace(/[^0-9.]/g, ""));
    if (String(raw).trim() !== "" && Number.isFinite(n) && n > 0) out[crop] = n;
  }
  return out;
}

const state: State = {
  market: new Map(),
  lastUpdated: null,
  status: "",
  error: null,
  sort: { column: "coinsPerHour", descending: true },
  search: "",
  plots: Number(localStorage.getItem("sbxp:ghplots") ?? 1),
  fortune: localStorage.getItem("sbxp:ghfortune") ?? "",
  cropFortune: readCropFortune(),
  showCrops: localStorage.getItem("sbxp:ghshowcrops") === "1",
  growth: {
    uniqueCrops: Number(localStorage.getItem("sbxp:ghunique") ?? DEFAULT_GROWTH.uniqueCrops),
    cropGrowth: Number(localStorage.getItem("sbxp:ghgrowth") ?? DEFAULT_GROWTH.cropGrowth),
    speedAttribute: Number(localStorage.getItem("sbxp:ghspeed") ?? DEFAULT_GROWTH.speedAttribute),
    growthSpeedUpgrade: Number(localStorage.getItem("sbxp:ghupgrade") ?? DEFAULT_GROWTH.growthSpeedUpgrade),
  },
  open: null,
};

let tables: GreenhouseTables = { greenhouse: { mutations: [] } as unknown as GreenhouseData, npcPrices: {} };
let host: HTMLElement | null = null;
let timer: number | undefined;
let bound = false;

/* ------------------------------------------------------- is this price usual? */

/**
 * A mutation's own sale price against what it has been averaging.
 *
 * The single biggest way to be wrong about this page is to read it at the wrong moment. A
 * greenhouse pays out *later* — a Noctilume ordered now is harvested in thirteen hours — so the
 * price that matters is the one at harvest, and the page can only quote the one right now.
 *
 * Mutations are where that bites and crops are not, which is why only mutations are watched here.
 * Pumpkins move a few percent because a hundred thousand of them trade a day; a Snoozling book is
 * thin enough that one player clearing it doubles the quoted ask for a morning. A mutation showing
 * +300% against its own average is not a mutation that got better — it is a book that emptied, and
 * by the time the harvest lands it will have refilled.
 *
 * Measured here rather than fetched: skyblock.bz's history endpoint refuses outside callers, and
 * an invented thirty-day average would make every spike look explicable. This is a running mean
 * folded one read at a time, so it starts empty and is worth more the longer the tab has been
 * open — which is why the window is printed next to the figure rather than hidden in a footnote.
 *
 * Kept apart from the bazaar tab's store: that one averages *margins* for a flipper, and this one
 * averages the *sale price* for a seller. Forty items rather than two thousand, so it is small.
 */
const BASELINE_KEY = "sbxp:ghpricebaselines";
let baselines: Record<string, Baseline> = readBaselines();

function readBaselines(): Record<string, Baseline> {
  try {
    return JSON.parse(localStorage.getItem(BASELINE_KEY) ?? "{}") as Record<string, Baseline>;
  } catch {
    return {};
  }
}

/** Fold the newest read into every mutation's average. Only the forty, and only the sale side. */
function observePrices(): void {
  for (const m of tables.greenhouse.mutations ?? []) {
    const product = state.market.get(m.id);
    if (!product || product.instabuy <= 0) continue;
    baselines[m.id] = observe(baselines[m.id], product.instabuy, product.at);
  }
  try {
    localStorage.setItem(BASELINE_KEY, JSON.stringify(baselines));
  } catch {
    // Storage blocked or full. The averages stay live for this session, which is the part that
    // matters; losing them on reload costs only the history this browser had accumulated.
  }
}

/**
 * The cell: how far today's ask sits from this mutation's own usual, and over how long.
 *
 * The window is on the row because it decides whether the number means anything at all. +180%
 * after four minutes is noise; after four days it is a spike worth waiting out.
 */
function baselineCell(row: MutationProfit): string {
  const product = state.market.get(row.id);
  const baseline = baselines[row.id];
  if (!product || product.instabuy <= 0 || !baseline) {
    return `<span class="dim" title="Nothing to compare against yet — this browser builds the average as it polls, and needs a second read of this mutation first.">—</span>`;
  }
  const relative = relativeTo(product.instabuy, baseline);
  if (relative === null) {
    return `<span class="dim" title="Nothing to compare against yet — this browser builds the average as it polls, and needs a second read of this mutation first.">—</span>`;
  }

  const window = depthNote(observedFor(baseline) / 60_000);
  // Sign off the rounded figure, not the raw one: -0.4% rounds to zero and printing it as "-0%"
  // reads like a fault rather than "sitting exactly on its average".
  const shown = Math.round(relative);
  const sign = shown > 0 ? "+" : "";
  // Loud in both directions, and the reason differs. Well above its usual is a thin book that
  // emptied and will refill before the harvest lands; well below is the harvest being worth less
  // than the page says. Both are reasons not to trust the row at face value.
  const loud = Math.abs(relative) >= 30 ? " gold" : "";
  return `<span class="${loud.trim()}" title="${escapeHtml(row.name)} is asking ${coins(
    product.instabuy,
  )} against a mean of ${coins(baseline.mean)} over the ${window} this browser has been watching it, across ${num(
    baseline.samples,
  )} reads. A mutation well above its own usual is normally a book that emptied rather than a mutation that got better — and a greenhouse pays out hours later, by which time it has refilled.">${sign}${shown}% <span class="dim">${window}</span></span>`;
}
/* ------------------------------------------------------------------ columns */

type Column = { id: string; label: string; value: (r: MutationProfit) => number; render: (r: MutationProfit) => string; title?: string };

const COLUMNS: Column[] = [
  {
    id: "coinsPerHour",
    label: "Coins/hr",
    value: (r) => r.coinsPerHour ?? -1,
    render: (r) => (r.coinsPerHour === null ? `<span class="dim">—</span>` : coins(r.coinsPerHour)),
    title: "What one harvest brings in, divided by how long a harvest takes. This is the ranking figure.",
  },
  {
    id: "coinsPerDay",
    label: "Coins/day",
    value: (r) => r.coinsPerDay ?? -1,
    render: (r) => (r.coinsPerDay === null ? `<span class="dim">—</span>` : coins(r.coinsPerDay)),
    title:
      "The same figure over a day left alone, which is what an AFK method is really sold on. " +
      "Gross: this is what the crops sell for, with nothing taken off for the ring you bought. " +
      "The next two columns are where that comes off.",
  },
  {
    id: "netFirstDay",
    label: "Net day 1",
    value: (r) => r.netFirstDay ?? -Infinity,
    render: (r) =>
      r.netFirstDay === null
        ? `<span class="dim">—</span>`
        : r.netFirstDay < 0
          ? `<span class="gold">-${coins(-r.netFirstDay)}</span>`
          : coins(r.netFirstDay),
    title:
      "Coins/day with the whole setup taken off — the first day only. The ring is bought once and " +
      "then stands, so every day after this one is the gross figure again. A negative number means " +
      "the ring costs more than a day of harvests brings back, not that the mutation loses money.",
  },
  {
    id: "paybackHours",
    label: "Payback",
    value: (r) => r.paybackHours ?? Infinity,
    render: (r) => (r.paybackHours === null ? `<span class="dim">—</span>` : hours(r.paybackHours)),
    title:
      "How long you leave it alone before the ring has paid for itself. This is the honest way to " +
      "compare a cheap setup against an expensive one, because it puts the one-off cost and the " +
      "repeating income in the same unit.",
  },
  {
    id: "hoursPerHarvest",
    label: "Per harvest",
    value: (r) => r.hoursPerHarvest ?? Infinity,
    render: (r) => (r.hoursPerHarvest === null ? `<span class="dim">—</span>` : hours(r.hoursPerHarvest)),
    title:
      "How long from planting the ring to harvesting the mutation: the expected wait for it to " +
      "spawn, which is one over its chance, plus its own growth stages. For most commons the " +
      "first half is nearly all of it.",
  },
  {
    id: "perHarvest",
    label: "Profit/harvest",
    value: (r) => (r.problem ? -1 : r.perHarvest),
    render: (r) => (r.problem || r.perHarvest <= 0 ? `<span class="dim">—</span>` : coins(r.perHarvest)),
    title:
      "What lands in one go: every mutation in every greenhouse, harvested together, crops and " +
      "items and vines. Read it against the column beside it — this much, that often — which is " +
      "the pair that says whether a method is worth checking in for.",
  },
  {
    id: "revenue",
    label: "Each",
    value: (r) => r.revenue,
    render: (r) => coins(r.revenue + r.vineRevenue),
    title:
      "Coins one harvest of one mutation is worth at your fortune. Three things go into it: the " +
      "crops it drops, the mutation itself — you pick up one every harvest and most of them trade " +
      "on the bazaar — and the Ethereal Vine chance. Click the row to see the split; on the " +
      "expensive mutations the item is most of it.",
  },
  {
    id: "vsUsual",
    label: "vs usual",
    value: (r) => {
      const product = state.market.get(r.id);
      if (!product || product.instabuy <= 0) return -Infinity;
      return relativeTo(product.instabuy, baselines[r.id]) ?? -Infinity;
    },
    render: (r) => baselineCell(r),
    title:
      "Where this mutation's own price sits against what it has averaged while this tab has been " +
      "watching. Only the mutations are tracked, because only the mutations move: crops trade in " +
      "the hundreds of thousands and barely budge, while a mutation book is thin enough that one " +
      "player clearing it doubles the ask for a morning. That matters here more than on a flip — " +
      "a greenhouse pays out hours later, so a row that looks huge on a spike will have settled " +
      "back to normal by the time you actually harvest it.",
  },
  {
    id: "setup",
    label: "Setup",
    value: (r) => r.setupTotal ?? Infinity,
    render: (r) =>
      !r.setup
        ? `<span class="dim">—</span>`
        : r.setupTotal === null
          ? `<span class="gold" title="Nothing is selling what this needs.">unpriced</span>`
          : coins(r.setupTotal),
    title:
      "What the ring costs to buy, once, across every greenhouse you have selected — three plots " +
      "is three rings. It is a one-off: the plants stand there and keep feeding harvest after " +
      "harvest, which is why it comes off the first day and no other. A mutation that needs other " +
      "mutations is priced at what those cost on the bazaar, which is the shortcut — growing them " +
      "yourself is cheaper and slower.",
  },
  {
    id: "size",
    label: "Size",
    value: (r) => r.size,
    render: (r) => `${r.size}×${r.size}`,
    title:
      "The square it occupies. It is also how many ring cells one of these fills when something " +
      "else needs it: a 2×2 counts twice, so a condition asking for three of them is met by two.",
  },
];

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
    plots: state.plots,
  });
}

function filtered(all: MutationProfit[]): MutationProfit[] {
  const needle = state.search.trim().toLowerCase();
  if (!needle) return all;
  return all.filter((r) => r.name.toLowerCase().includes(needle));
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
    return;
  }
  bound = true;

  container.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;

    const column = target.closest<HTMLElement>("[data-ghsort]");
    if (column) {
      const id = column.dataset.ghsort!;
      if (state.sort.column === id) state.sort.descending = !state.sort.descending;
      else state.sort = { column: id, descending: true };
      renderTable();
      return;
    }

    const row = target.closest<HTMLElement>("[data-ghopen]");
    if (row) {
      // Clicking the open row closes it, so the layout is a toggle rather than a trap.
      state.open = state.open === row.dataset.ghopen ? null : row.dataset.ghopen!;
      renderTable();
      return;
    }

    const plots = target.closest<HTMLElement>("[data-ghplots]");
    if (plots) {
      state.plots = Number(plots.dataset.ghplots);
      localStorage.setItem("sbxp:ghplots", String(state.plots));
      render();
      return;
    }

    if (target.closest("#ghcroptoggle")) {
      state.showCrops = !state.showCrops;
      localStorage.setItem("sbxp:ghshowcrops", state.showCrops ? "1" : "0");
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
    };

    if (el.id === "ghsearch") {
      state.search = el.value;
      renderTable();
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

  const summary = `<button type="button" class="chip" id="ghcroptoggle">${state.showCrops ? "Hide" : "Add"} crop fortune</button>`;
  if (!state.showCrops) {
    const filled = Object.keys(cropFortuneValues()).length;
    return `<p class="sub">${summary} <span class="dim" title="Wheat Fortune, Carrot Fortune and the rest. Unlike the box above, each lifts one crop only — which makes these the one input here that changes which mutation wins, rather than just how big the numbers are.">${
      filled > 0 ? `${filled} set` : "per-crop — these change the order"
    }</span></p>`;
  }

  const boxes = crops
    .map(
      (c) =>
        `<label title="${escapeHtml(c.stat)} — lifts ${escapeHtml(c.crop)} only.">${escapeHtml(c.crop)}
          <input class="gh-crop" data-ghcrop="${escapeHtml(c.crop)}" value="${escapeHtml(state.cropFortune[c.crop] ?? "")}" placeholder="0" autocomplete="off">
        </label>`,
    )
    .join("");

  return `
    <p class="sub">${summary}</p>
    <div class="row gh-crops">${boxes}</div>
    <p class="sub dim" title="Added to Farming Fortune for that crop only, before the yield is worked out — the wiki's rule, not ours. Sources are the tool you are holding, Anita's shop and Carrolyn.">
      From your hoe, Anita and Carrolyn. The <strong>Overdrive Chip</strong> adds up to
      <strong>+140</strong> — but only during a Jacob's Contest, so leave it out for a normal day.
    </p>
  `;
}

function render(): void {
  if (!host) return;

  host.innerHTML = `
    <div class="meta" id="ghmeta">${metaHtml()}</div>

    <div class="panel pad controls">
      <div class="row">
        <label>Search <input id="ghsearch" value="${escapeHtml(state.search)}" placeholder="e.g. noctilume" autocomplete="off"></label>
        <label title="Your Farming Fortune. Nothing here can read it off your profile, so it is a box rather than a lookup.">Farming Fortune
          <input id="ghfortune" value="${escapeHtml(state.fortune)}" placeholder="${num(ASSUMED_FORTUNE)}" autocomplete="off">
        </label>
        <span class="tabs">
          ${[1, 3].map((n) => `<button class="chip${state.plots === n ? " on" : ""}" data-ghplots="${n}">${n} greenhouse${n > 1 ? "s" : ""}</button>`).join("")}
        </span>
      </div>
      <p class="sub" id="ghfortunenote">${fortuneNote()}</p>

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
  "Ranked on coins an hour left alone. Money figures are gross — Setup is a one-off and comes off " +
  "Net day 1 only. Hover any heading for what it means; click a row for the plot, the split and " +
  "the bill. Drop figures are the wiki's and every base crop's changed on 2026-08-20, so anything " +
  "quoted before that is for a different game.";

function renderTable(): void {
  const target = document.getElementById("ghtable");
  if (!target) return;

  if (state.market.size === 0) {
    target.innerHTML = `<p class="dim pad">Waiting for the first read of the bazaar…</p>`;
    return;
  }

  const all = sorted(filtered(rows()));
  const head = COLUMNS.map((c) => {
    const on = state.sort.column === c.id;
    const arrow = on ? (state.sort.descending ? " ▾" : " ▴") : "";
    return `<th class="num${on ? " on" : ""}" data-ghsort="${c.id}"${c.title ? ` title="${escapeHtml(c.title)}"` : ""}>${escapeHtml(c.label)}${arrow}</th>`;
  }).join("");

  const body = all
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
      return `<tr class="bz-open" data-ghopen="${escapeHtml(row.id)}"><td>${icon}${escapeHtml(row.name)}${rarity}${lifted}${setup}${problem}</td>${cells}</tr>${detail}`;
    })
    .join("");

  target.innerHTML = `
    <p class="dim pad">${escapeHtml(NOTE)}</p>
    <div class="panel scroll">
      <table class="bz">
        <thead><tr><th>Mutation</th>${head}</tr></thead>
        <tbody>${body}</tbody>
      </table>
    </div>
    <p class="dim pad">${num(all.length)} mutations · ${escapeHtml(stageNote())} · ${state.plots} greenhouse${state.plots > 1 ? "s" : ""}</p>
  `;
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
    return `<div class="gh-layout dim">No arrangement of this plot grows one of these.</div>`;
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

  // The ceiling only earns a line when the search fell short of it. When it matches, the answer is
  // provably the best and saying so at length adds nothing a reader can act on.
  const atCeiling = packing.targets >= packing.ceiling;
  const ceilingNote = atCeiling
    ? `<span title="Every support cell is feeding as many rings as it can — no arrangement beats this.">provably the most</span>`
    : `<span title="The search covers repeating patterns, not every irregular one, so it may leave a little on the table.">bound ${num(packing.ceiling)}</span>`;

  return `
    <h4 class="gh-h">One greenhouse</h4>
    <div class="gh-plotgrid">${grid}</div>
    <p class="dim">${legend}</p>
    <p class="dim">
      <strong>${num(packing.targets)}</strong> at once · <strong>${num(row.setup!.plants)}</strong> plants ·
      ${packing.period.rows}×${packing.period.cols} tile · ${ceilingNote}
    </p>
    ${mutation.effects.length ? `<p class="dim">${escapeHtml(mutation.effects.join(" · "))}</p>` : ""}
  `;
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
    )}</strong>.</p>
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

  const net =
    row.coinsPerDay === null || row.setupTotal === null
      ? setup.coins === null
        ? `<p class="gold">Part of this has no price, so there is no total.</p>`
        : ""
      : `
      <table class="gh-break">
        <tbody>
          <tr class="gh-total"><td>Setup, once</td><td class="num gold">-${coins(row.setupTotal)}</td></tr>
          <tr><td>Net, first day</td><td class="num"><strong>${
            row.netFirstDay! < 0 ? `<span class="gold">-${coins(-row.netFirstDay!)}</span>` : coins(row.netFirstDay!)
          }</strong></td></tr>
          <tr><td class="dim">Every day after</td><td class="num dim">${coins(row.coinsPerDay)}</td></tr>
        </tbody>
      </table>`;

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
