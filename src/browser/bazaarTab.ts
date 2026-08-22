import { normalise } from "../lib/bazaar";
import { craft, flip, type Craft, type Flip, type Recipe } from "../lib/bazaarViews";
import type { ProductSnapshot, RawBazaarProduct } from "../lib/bazaarTypes";
import { coins, num } from "../lib/format";

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
  minFills: 1,
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

const FLIP_COLUMNS: Column<Flip>[] = [
  { id: "buyAt", label: "Buy order", value: (r) => r.buyAt, render: (r) => coins(r.buyAt), title: "What buyers are already bidding — put your buy order here." },
  { id: "sellAt", label: "Sell order", value: (r) => r.sellAt, render: (r) => coins(r.sellAt), title: "What sellers are already asking — put your sell order here." },
  { id: "margin", label: "Margin", value: (r) => r.margin, render: (r) => coins(r.margin), title: "The gross spread between the two order books." },
  { id: "netMargin", label: "After tax", value: (r) => r.netMargin, render: (r) => coins(r.netMargin), title: "The spread once the bazaar has taken its 2.25% of the sale." },
  { id: "marginPercent", label: "Margin %", value: (r) => r.marginPercent, render: (r) => `${(r.marginPercent * 100).toFixed(1)}%` },
  { id: "hourlyBought", label: "Instabuys/hr", value: (r) => r.hourlyBought, render: (r) => num(Math.round(r.hourlyBought)), title: "Items instabought per hour, averaged over the moving week. How fast your sell order fills." },
  { id: "hourlySold", label: "Instasells/hr", value: (r) => r.hourlySold, render: (r) => num(Math.round(r.hourlySold)), title: "Items instasold per hour. How fast your buy order fills." },
  { id: "hourlyFills", label: "Round trips/hr", value: (r) => r.hourlyFills, render: (r) => num(Math.round(r.hourlyFills)), title: "The slower of the two sides. Both legs have to fill for the flip to close." },
  { id: "coinsPerHour", label: "Coins/hr", value: (r) => r.coinsPerHour, render: (r) => coins(r.coinsPerHour), title: "After-tax margin times the round-trip rate. This is the ranking figure." },
];

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
  render();

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

  render();
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
    if (f && f.hourlyFills >= state.minFills) rows.push(f);
  }
  return rows;
}

function craftRows(): Craft[] {
  // A recipe with alternatives appears once per alternative, and only the cheapest is a real
  // answer — nobody crafts Enchanted Iron out of blocks when ingots are cheaper today.
  const best = new Map<string, Craft>();
  for (const recipe of data.recipes) {
    const c = craft(recipe, state.market);
    if (!c || c.bottleneck < state.minFills || c.margin <= 0) continue;
    const prior = best.get(c.id);
    if (!prior || c.craftCost < prior.craftCost) best.set(c.id, c);
  }
  return [...best.values()];
}

function nameOf(id: string): string {
  return data.names[id] ?? id;
}

function filtered<T extends { id: string }>(rows: T[]): T[] {
  const needle = state.search.trim().toLowerCase();
  if (!needle) return rows;
  return rows.filter((row) => nameOf(row.id).toLowerCase().includes(needle) || row.id.toLowerCase().includes(needle));
}

function sorted<T extends { id: string }>(rows: T[], columns: Column<T>[], sort: Sort): T[] {
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
      render();
      return;
    }

    if (target.closest("#bzrefresh")) void refresh();
  });

  container.addEventListener("input", (event) => {
    const el = event.target as HTMLInputElement;
    if (el.id === "bzsearch") {
      state.search = el.value;
      renderTable();
      return;
    }
    if (el.id === "bzminfills") {
      state.minFills = Number(el.value) || 0;
      const label = document.getElementById("bzminfillsvalue");
      if (label) label.textContent = num(state.minFills);
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
    <div class="meta">
      <strong>${num(state.market.size)} products</strong>
      <span class="dim" id="bzage">${ageNote()}</span>
      ${state.status ? `<span class="dim">${escapeHtml(state.status)}</span>` : ""}
      ${state.error ? `<span class="gold">${escapeHtml(state.error)}</span>` : ""}
      <button type="button" class="chip" id="bzrefresh" title="Hypixel republishes every 20 seconds; this tab already wakes for it.">Refresh now</button>
    </div>

    <div class="tabs">
      <button class="chip${state.view === "flips" ? " on" : ""}" data-bzview="flips">Flips</button>
      <button class="chip${state.view === "crafts" ? " on" : ""}" data-bzview="crafts">Crafts</button>
    </div>

    <div class="panel pad controls">
      <div class="row">
        <label>Search
          <input id="bzsearch" value="${escapeHtml(state.search)}" placeholder="e.g. enchanted cactus" autocomplete="off">
        </label>
        <label title="A huge spread on something that trades twice a week is not an opportunity. This hides anything that cannot complete this many round trips an hour.">
          Minimum round trips per hour <span id="bzminfillsvalue">${num(state.minFills)}</span>
          <input type="range" id="bzminfills" min="0" max="200" step="1" value="${state.minFills}">
        </label>
      </div>
    </div>

    <div id="bztable"></div>
  `;

  renderTable();
}

function renderTable(): void {
  const target = document.getElementById("bztable");
  if (!target) return;

  target.innerHTML =
    state.view === "flips"
      ? table(filtered(flipRows()), FLIP_COLUMNS, state.sorts.flips, FLIPS_NOTE)
      : table(filtered(craftRows()), CRAFT_COLUMNS, state.sorts.crafts, CRAFTS_NOTE);
}

const FLIPS_NOTE =
  "Buy at the top of the buy book, sell at the top of the sell book. Ranked on coins per hour " +
  "rather than on the spread, because both legs have to fill and the slower side sets the pace.";

const CRAFTS_NOTE =
  "Ingredients bought through buy orders, the output sold through a sell order. Ranked on coins " +
  "per hour, which is the margin times whichever runs out first — the output's demand or the " +
  "scarcest ingredient's supply.";

function table<T extends { id: string }>(rows: T[], columns: Column<T>[], sort: Sort, note: string): string {
  if (state.market.size === 0) return `<p class="dim pad">Waiting for the first read of the bazaar…</p>`;
  if (rows.length === 0) return `<p class="dim pad">Nothing matches. Try a lower round-trip floor.</p>`;

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
      return `<tr><td>${escapeHtml(nameOf(row.id))}${limitNote(row)}</td>${cells}</tr>`;
    })
    .join("");

  const more = ordered.length > shown.length ? ` · showing the top ${num(shown.length)}` : "";

  return `
    <p class="dim pad">${escapeHtml(note)}</p>
    <div class="panel scroll">
      <table class="bz">
        <thead><tr><th>Item</th>${head}</tr></thead>
        <tbody>${body}</tbody>
      </table>
    </div>
    <p class="dim pad">${num(ordered.length)} rows${more}</p>
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
