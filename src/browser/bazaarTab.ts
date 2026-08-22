import { normalise } from "../lib/bazaar";
import { affordableCoinsPerHour, craft, flip, type Craft, type Flip, type Recipe } from "../lib/bazaarViews";
import type { ProductSnapshot, RawBazaarProduct } from "../lib/bazaarTypes";
import { coins, num, parseBudget } from "../lib/format";
import { DEPTH_LADDER, VOLUME_LADDER, depthIndex, depthNote, ladderIndex, volumeNote } from "../lib/filters";

/**
 * The bazaar tab: flips and crafts, off a live read of Hypixel.
 *
 * This is a separate branch of the app and it keeps its own state deliberately. It needs no API
 * key, no username and no profile — the bazaar endpoint is public — so entangling it with the
 * planner's load sequence would only mean asking for three things it does not use.
 *
 * The whole tab is two ranked tables over one payload. Everything that makes them worth reading
 * lives in `lib/bazaarViews.ts`; this file fetches, polls, sorts and draws.
 */

const BAZAAR = "https://api.hypixel.net/v2/skyblock/bazaar";

/**
 * Item art, from Coflnet's public icon service.
 *
 * The only thing on this page that comes from anywhere other than Hypixel, and the only reason
 * it is worth the exception is that a table of two thousand SkyBlock ids is genuinely hard to
 * read without it. Everything degrades if the service is gone or the file is opened offline: the
 * images fail, the space they were in stays reserved, and every number is exactly as it was.
 *
 * Note the missing `/vanilla` on the end. skyblock.bz asks for that variant and it is a much
 * poorer set — a sample of 120 products came back 43% blank, Enchanted Obsidian and every
 * enchanted book among them. The plain path answered all 150 we tried.
 *
 * The ten ids carrying a vanilla damage suffix — `INK_SACK:4`, `LOG:2` and the like — have no
 * icon under any spelling we could find, so they show nothing. That is the better failure: the
 * un-suffixed id does resolve, but it would put an oak log against Birch Log and a black ink sack
 * against Lapis Lazuli, which is worse than an empty square.
 */
function iconUrl(id: string): string {
  return `https://sky.coflnet.com/static/icon/${encodeURIComponent(id)}`;
}

/**
 * Hypixel refreshes the bazaar every 20.017 seconds, dead regular, and stamps each payload with
 * `lastUpdated`. Polling on a blind 20-second timer therefore lands, on average, ten seconds into
 * a stale window; waking just after the stamp says the next one is due halves that for free.
 *
 * Measured against the alternatives, this is as fresh as the data gets anywhere: skyblock.bz's
 * own snapshot runs four seconds behind the origin and Coflnet's runs two minutes behind, because
 * both of them are polling this same endpoint.
 */
const REFRESH_MS = 20_017;
const GRACE_MS = 500;

type BazaarData = {
  recipes: Recipe[];
  names: Record<string, string>;
};

type Sort = { column: string; descending: boolean };

type BazaarState = {
  view: "flips" | "crafts";
  search: string;
  /** Hide rows whose round-trip rate makes the coins-per-hour meaningless. */
  minFills: number;
  /** Coins on hand, as typed. Empty means "don't ask what I can afford". */
  budget: string;
  /** Minutes of flow a book must hold before its price is treated as a price. Flips only. */
  minDepth: number;
  market: Map<string, ProductSnapshot>;
  lastUpdated: number | null;
  fetchedAt: number | null;
  status: string;
  error: string | null;
  sorts: Record<"flips" | "crafts", Sort>;
};

const state: BazaarState = {
  view: "flips",
  search: "",
  budget: localStorage.getItem("sbxp:bzbudget") ?? "",
  minFills: Number(localStorage.getItem("sbxp:bzminfills") ?? 1),
  minDepth: Number(localStorage.getItem("sbxp:bzmindepth") ?? 60),
  market: new Map(),
  lastUpdated: null,
  fetchedAt: null,
  status: "",
  error: null,
  sorts: {
    flips: { column: "coinsPerHour", descending: true },
    crafts: { column: "coinsPerHour", descending: true },
  },
};

let data: BazaarData = { recipes: [], names: {} };
let host: HTMLElement | null = null;
let timer: number | undefined;
/** Listeners are delegated on the container and bind once; only the polling starts and stops. */
let bound = false;

/* ------------------------------------------------------------------ columns */

type Column<T> = {
  id: string;
  label: string;
  /** What to sort on, and what to draw. Kept apart so a formatted "3.4M" still sorts as a number. */
  value: (row: T) => number;
  render: (row: T) => string;
  title?: string;
};

const BASE_FLIP_COLUMNS: Column<Flip>[] = [
  { id: "buyAt", label: "Buy order", value: (r) => r.buyAt, render: (r) => coins(r.buyAt), title: "What buyers are already bidding — put your buy order here." },
  { id: "sellAt", label: "Sell order", value: (r) => r.sellAt, render: (r) => coins(r.sellAt), title: "What sellers are already asking — put your sell order here." },
  { id: "margin", label: "Margin", value: (r) => r.margin, render: (r) => coins(r.margin), title: "The gross spread between the two order books." },
  { id: "netMargin", label: "After tax", value: (r) => r.netMargin, render: (r) => coins(r.netMargin), title: "The spread once the bazaar has taken its 2.25% of the sale." },
  { id: "marginPercent", label: "Margin %", value: (r) => r.marginPercent, render: (r) => `${(r.marginPercent * 100).toFixed(1)}%` },
  { id: "hourlyBought", label: "Instabuys/hr", value: (r) => r.hourlyBought, render: (r) => num(Math.round(r.hourlyBought)), title: "Items instabought per hour, averaged over the moving week. How fast your sell order fills." },
  { id: "hourlySold", label: "Instasells/hr", value: (r) => r.hourlySold, render: (r) => num(Math.round(r.hourlySold)), title: "Items instasold per hour. How fast your buy order fills." },
  { id: "hourlyFills", label: "Round trips/hr", value: (r) => r.hourlyFills, render: (r) => num(Math.round(r.hourlyFills)), title: "The slower of the two sides. Both legs have to fill for the flip to close." },
  {
    id: "capital",
    label: "Allocate",
    value: (r) => r.capital,
    render: (r) => `${coins(r.capital)} <span class="dim">· ${num(r.orderSize)}</span>`,
    title:
      "What to put in, and how many to order. Twenty minutes of the market's flow — the order " +
      "fills in twenty minutes, so it is big enough to leave alone and small enough that no part " +
      "of it is idling in a queue. The bazaar holds the whole order up front, so this is real " +
      "money committed, not a notional position. Never below one item: on something this thin " +
      "the smallest order allowed is already more than twenty minutes of flow.",
  },
  {
    id: "bookHours",
    label: "Depth",
    value: (r) => r.bookHours,
    render: (r) => {
      const side = r.supplyHours <= r.demandHours ? "supply" : "demand";
      return `${depthNote(r.bookHours * 60)} <span class="dim">${side}</span>`;
    },
    title:
      "How long the thinner side of the book would last against the traffic going through it. A " +
      "quote is set by whoever is at the front, and a nearly empty book behind them is one " +
      "straggler rather than a market — which is how a 457k ask stands against a 72k bid on an " +
      "item nobody is trading at either price.",
  },
  { id: "badHourCoins", label: "Bad hour", value: (r) => r.badHourCoins, render: (r) => coins(r.badHourCoins), title: "What a quarter of your hours are worse than. Coins per hour is a mean, and a mean is a poor summary of four trades — zero here means a quarter of the time this pays nothing at all." },
  { id: "coinsPerHour", label: "Coins/hr", value: (r) => r.coinsPerHour, render: (r) => coins(r.coinsPerHour), title: "After-tax margin times the round-trip rate. This is the ranking figure." },
];

/**
 * The budget column only exists once there is a budget, because a column of em-dashes is noise.
 * It goes last, where the eye already is, and the default sort is left alone — this is a second
 * opinion on the ranking rather than a replacement for it.
 */
function flipColumns(): Column<Flip>[] {
  const budget = parseBudget(state.budget);
  if (budget === null) return BASE_FLIP_COLUMNS;

  return [
    ...BASE_FLIP_COLUMNS,
    {
      id: "affordable",
      label: `With ${coins(budget)}`,
      value: (r) => affordableCoinsPerHour(r, budget),
      render: (r) => coins(affordableCoinsPerHour(r, budget)),
      title:
        "What your coins can actually take out of this, per hour. The market only turns over so " +
        "fast and your coins only turn over so fast; the lower ceiling binds.",
    },
  ];
}

const CRAFT_COLUMNS: Column<Craft>[] = [
  { id: "craftCost", label: "Craft cost", value: (r) => r.craftCost, render: (r) => coins(r.craftCost), title: "What one costs to make, every ingredient bought through a buy order. Per item, not per craft — some recipes make thirty-two." },
  { id: "sellAt", label: "Sell order", value: (r) => r.sellAt, render: (r) => coins(r.sellAt) },
  { id: "margin", label: "Margin", value: (r) => r.margin, render: (r) => coins(r.margin), title: "Revenue after the 2.25% tax, less what one costs to make." },
  { id: "outputLimit", label: "Demand/hr", value: (r) => r.outputLimit, render: (r) => num(Math.round(r.outputLimit)), title: "Items per hour the output's own demand will absorb." },
  { id: "inputLimit", label: "Supply/hr", value: (r) => r.inputLimit, render: (r) => num(Math.round(r.inputLimit)), title: "Items per hour the scarcest ingredient will supply." },
  { id: "bottleneck", label: "Items/hr", value: (r) => r.bottleneck, render: (r) => num(Math.round(r.bottleneck)), title: "The binding one of the two. Production is a queue question, not a price question." },
  { id: "coinsPerHour", label: "Coins/hr", value: (r) => r.coinsPerHour, render: (r) => coins(r.coinsPerHour), title: "Margin times the bottleneck. This is the ranking figure." },
  { id: "instaCoinsPerHour", label: "Impatient", value: (r) => r.instaCoinsPerHour, render: (r) => coins(r.instaCoinsPerHour), title: "The same trade with no waiting: instabuy the ingredients, instasell the output. The gap is what patience is worth." },
];

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
    state.fetchedAt = Date.now();
    state.status = "";
  } catch (error) {
    // A failed refresh leaves the last good read on screen rather than blanking the table; stale
    // prices with a visible age on them beat an empty page.
    state.error = error instanceof Error ? error.message : "Could not reach the Hypixel API.";
    state.status = "";
  }

  // Only the meta line and the table, never the controls: this runs every twenty seconds, and a
  // full repaint would take the cursor out of the search box mid-word.
  renderMeta();
  renderTable();
  schedule();
}

/** Wake just after the next payload is due, not on a blind interval. */
function schedule(): void {
  clearTimeout(timer);
  const due = state.lastUpdated ? state.lastUpdated + REFRESH_MS + GRACE_MS - Date.now() : REFRESH_MS;
  timer = window.setTimeout(refresh, Math.max(due, 2_000));
}

/* ----------------------------------------------------------------- rows */

function flipRows(): Flip[] {
  const rows: Flip[] = [];
  for (const product of state.market.values()) {
    const f = flip(product);
    if (f) rows.push(f);
  }
  return rows;
}

function craftRows(): Craft[] {
  // A recipe with alternatives appears once per alternative, and only the cheapest is a real
  // answer — nobody crafts Enchanted Iron out of blocks when ingots are cheaper today.
  const best = new Map<string, Craft>();
  for (const recipe of data.recipes) {
    const c = craft(recipe, state.market);
    if (!c || c.margin <= 0) continue;
    const prior = best.get(c.id);
    if (!prior || c.craftCost < prior.craftCost) best.set(c.id, c);
  }
  return [...best.values()];
}

/**
 * What each floor is holding back, counted on its own.
 *
 * Separately, and not as "everything the search left out", or typing a word would look like the
 * floors had suddenly swallowed a thousand rows.
 */
function hiddenCounts(rows: (Flip | Craft)[]): { volume: number; depth: number } {
  return {
    volume: rows.reduce((n, row) => n + (volumeOf(row) < state.minFills ? 1 : 0), 0),
    depth: rows.reduce((n, row) => n + (tooThin(row) ? 1 : 0), 0),
  };
}

/** How much of this row moves in an hour — round trips for a flip, items for a craft. */
function volumeOf(row: Flip | Craft): number {
  return "hourlyFills" in row ? row.hourlyFills : row.bottleneck;
}

function nameOf(id: string): string {
  return data.names[id] ?? id;
}

function filtered<T extends Flip | Craft>(rows: T[]): T[] {
  const needle = state.search.trim().toLowerCase();
  return rows.filter((row) => {
    if (volumeOf(row) < state.minFills) return false;
    if (tooThin(row)) return false;
    if (!needle) return true;
    return nameOf(row.id).toLowerCase().includes(needle) || row.id.toLowerCase().includes(needle);
  });
}

/**
 * A row whose price is not standing on anything.
 *
 * Flips only. A craft's price comes from a recipe rather than from whoever is left at the front
 * of a book, so the same failure does not arise, and the bottleneck already says how fast it can
 * really go.
 */
function tooThin(row: Flip | Craft): boolean {
  return "bookHours" in row && row.bookHours * 60 < state.minDepth;
}

function sorted<T extends Flip | Craft>(rows: T[], columns: Column<T>[], sort: Sort): T[] {
  const column = columns.find((c) => c.id === sort.column);
  if (!column) return rows;
  const direction = sort.descending ? -1 : 1;
  return rows.slice().sort((a, b) => direction * (column.value(a) - column.value(b)));
}

/* --------------------------------------------------------------- rendering */

const ROW_LIMIT = 250;

export function mountBazaar(container: HTMLElement, tables: BazaarData): void {
  host = container;
  data = tables;

  if (bound) {
    render();
    void refresh();
    return;
  }
  bound = true;

  container.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;

    const view = target.closest<HTMLElement>("[data-bzview]");
    if (view) {
      state.view = view.dataset.bzview as BazaarState["view"];
      render();
      return;
    }

    const column = target.closest<HTMLElement>("[data-bzsort]");
    if (column) {
      const id = column.dataset.bzsort!;
      const sort = state.sorts[state.view];
      // Clicking the column you are already on flips it; a new column starts descending, because
      // every column here is a "more is better" figure.
      if (sort.column === id) sort.descending = !sort.descending;
      else state.sorts[state.view] = { column: id, descending: true };
      renderTable();
      return;
    }

    if (target.closest("#bzrefresh")) void refresh();
  });

  // Error events do not bubble, so this listens on the way down. A missing icon is hidden rather
  // than removed, which keeps the names in a column instead of letting them jog left and right.
  container.addEventListener(
    "error",
    (event) => {
      const target = event.target;
      if (target instanceof HTMLImageElement && target.classList.contains("bz-icon")) {
        target.style.visibility = "hidden";
      }
    },
    true,
  );

  container.addEventListener("input", (event) => {
    const el = event.target as HTMLInputElement;
    if (el.id === "bzsearch") {
      state.search = el.value;
      renderTable();
      return;
    }
    if (el.id === "bzbudget") {
      state.budget = el.value;
      localStorage.setItem("sbxp:bzbudget", el.value);
      // The column set changes with it, so this is a header repaint rather than a body one.
      renderTable();
      return;
    }
    if (el.id === "bzmindepth") {
      state.minDepth = DEPTH_LADDER[Number(el.value)] ?? 0;
      localStorage.setItem("sbxp:bzmindepth", String(state.minDepth));
      const label = document.getElementById("bzmindepthvalue");
      if (label) label.textContent = depthNote(state.minDepth);
      renderTable();
      return;
    }
    if (el.id === "bzminfills") {
      state.minFills = VOLUME_LADDER[Number(el.value)] ?? 0;
      localStorage.setItem("sbxp:bzminfills", String(state.minFills));
      // The handle should track the finger even if the table takes a moment behind it.
      const label = document.getElementById("bzminfillsvalue");
      if (label) label.textContent = volumeNote(state.minFills);
      renderTable();
    }
  });

  render();
  void refresh();
}

export function unmountBazaar(): void {
  clearTimeout(timer);
  timer = undefined;
  host = null;
}

function render(): void {
  if (!host) return;

  host.innerHTML = `
    <div class="meta" id="bzmeta">${metaHtml()}</div>

    <div class="tabs">
      <button class="chip${state.view === "flips" ? " on" : ""}" data-bzview="flips">Flips</button>
      <button class="chip${state.view === "crafts" ? " on" : ""}" data-bzview="crafts">Crafts</button>
    </div>

    <div class="panel pad controls">
      <div class="row">
        <label>Search
          <input id="bzsearch" value="${escapeHtml(state.search)}" placeholder="e.g. enchanted cactus" autocomplete="off">
        </label>
        <label title="What you have to flip with. Adds a column for what each row can actually pay you, rather than what it would pay someone with unlimited coins.">Coins on hand
          <input id="bzbudget" value="${escapeHtml(state.budget)}" placeholder="optional · 500M" autocomplete="off">
        </label>
        <label class="wide" title="A huge spread on something that trades twice a week is not an opportunity. This hides anything moving slower than the floor — round trips an hour on flips, items an hour on crafts.">
          Minimum volume <span class="dim" id="bzminfillsvalue">${volumeNote(state.minFills)}</span>
          <input type="range" id="bzminfills" min="0" max="${VOLUME_LADDER.length - 1}" step="1" value="${ladderIndex(state.minFills)}">
        </label>
        ${
          state.view === "flips"
            ? `<label class="wide" title="A price is only a price if something is standing behind it. This hides rows where the thinner side of the book would be gone in less than this much of its own traffic — the state a 457k ask against a 72k bid is always in.">
          Minimum book depth <span class="dim" id="bzmindepthvalue">${depthNote(state.minDepth)}</span>
          <input type="range" id="bzmindepth" min="0" max="${DEPTH_LADDER.length - 1}" step="1" value="${depthIndex(state.minDepth)}">
        </label>`
            : ""
        }
      </div>
    </div>

    <div id="bztable"></div>
  `;

  renderTable();
}

function metaHtml(): string {
  return `
    <strong>${num(state.market.size)} products</strong>
    <span class="dim">${ageNote()}</span>
    ${state.status ? `<span class="dim">${escapeHtml(state.status)}</span>` : ""}
    ${state.error ? `<span class="gold">${escapeHtml(state.error)}</span>` : ""}
    <button type="button" class="chip" id="bzrefresh" title="Hypixel republishes every 20 seconds; this tab already wakes for it.">Refresh now</button>
  `;
}

function renderMeta(): void {
  const meta = document.getElementById("bzmeta");
  if (meta) meta.innerHTML = metaHtml();
}

function renderTable(): void {
  const target = document.getElementById("bztable");
  if (!target) return;

  if (state.view === "flips") {
    const all = flipRows();
    target.innerHTML = table(filtered(all), hiddenCounts(all), flipColumns(), state.sorts.flips, FLIPS_NOTE);
  } else {
    const all = craftRows();
    target.innerHTML = table(filtered(all), hiddenCounts(all), CRAFT_COLUMNS, state.sorts.crafts, CRAFTS_NOTE);
  }
}

const FLIPS_NOTE =
  "Buy at the top of the buy book, sell at the top of the sell book. Ranked on coins per hour " +
  "rather than on the spread, because both legs have to fill and the slower side sets the pace. " +
  "Read that figure against the two beside it: a bad hour says what the mean is hiding on a thin " +
  "item, and capital says how much you need on hand before the rate is even available to you.";

const CRAFTS_NOTE =
  "Ingredients bought through buy orders, the output sold through a sell order. Ranked on coins " +
  "per hour, which is the margin times whichever runs out first — the output's demand or the " +
  "scarcest ingredient's supply.";

function table<T extends Flip | Craft>(
  rows: T[],
  hidden: { volume: number; depth: number },
  columns: Column<T>[],
  sort: Sort,
  note: string,
): string {
  if (state.market.size === 0) return `<p class="dim pad">Waiting for the first read of the bazaar…</p>`;
  if (rows.length === 0) {
    const because = state.minFills > 0 ? ` Nothing moves ${num(state.minFills)} times an hour that also matches.` : "";
    return `<p class="dim pad">Nothing matches.${because}</p>`;
  }

  const ordered = sorted(rows, columns, sort);
  const shown = ordered.slice(0, ROW_LIMIT);

  const head = columns
    .map((c) => {
      const on = sort.column === c.id;
      const arrow = on ? (sort.descending ? " ▾" : " ▴") : "";
      return `<th class="num${on ? " on" : ""}" data-bzsort="${c.id}"${
        c.title ? ` title="${escapeHtml(c.title)}"` : ""
      }>${escapeHtml(c.label)}${arrow}</th>`;
    })
    .join("");

  const body = shown
    .map((row) => {
      const cells = columns.map((c) => `<td class="num">${c.render(row)}</td>`).join("");
      const name = escapeHtml(nameOf(row.id));
      // Decorative: the name is right beside it, so an empty alt keeps it out of a screen reader
      // rather than having every row read twice.
      // Lazy because only a screenful is ever on show, async-decoded because the table is rebuilt
      // every twenty seconds and a decode should never hold up the repaint. The service caches for
      // a year, so the rebuild costs nothing on the wire either.
      const icon = `<img class="bz-icon" src="${iconUrl(row.id)}" alt="" width="20" height="20" loading="lazy" decoding="async">`;
      return `<tr><td>${icon}${name}${limitNote(row)}</td>${cells}</tr>`;
    })
    .join("");

  const more = ordered.length > shown.length ? ` · showing the top ${num(shown.length)}` : "";
  const floor =
    (hidden.volume > 0 ? ` · ${num(hidden.volume)} below the volume floor` : "") +
    (hidden.depth > 0 ? ` · ${num(hidden.depth)} on too thin a book` : "");

  return `
    <p class="dim pad">${escapeHtml(note)}</p>
    <div class="panel scroll">
      <table class="bz">
        <thead><tr><th>Item</th>${head}</tr></thead>
        <tbody>${body}</tbody>
      </table>
    </div>
    <p class="dim pad">${num(ordered.length)} rows${more}${floor}</p>
  `;
}

/** Which ingredient is holding a craft back, when one is. Silent on flips. */
function limitNote(row: { id: string } & Partial<Craft>): string {
  if (!row.limitedBy) return "";
  return ` <span class="dim" title="This craft is capped by how fast people sell you this ingredient, not by what it sells for.">· held up by ${escapeHtml(
    nameOf(row.limitedBy),
  )}</span>`;
}

function ageNote(): string {
  if (!state.lastUpdated) return "";
  const age = Math.round((Date.now() - state.lastUpdated) / 1000);
  return `priced ${age}s ago · Hypixel republishes every 20s`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
