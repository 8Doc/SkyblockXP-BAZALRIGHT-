import { coins, num, parseBudget } from "../lib/format";
import { normalise } from "../lib/bazaar";
import type { RawBazaarProduct } from "../lib/bazaarTypes";
import type { Fuel, MinionData, Modifiers, Upgrade } from "../lib/minions";
import {
  BASIS_LABELS,
  planProfit,
  type Basis,
  type Compactor,
  type DropTable,
  type Hopper,
  type ItemPrices,
  type MinionProfitRow,
  type Recipe,
  type StorageChest,
  type StorageTables,
} from "../lib/minionProfit";
import {
  MONTH_HISTORY_URL,
  WINDOW_DAYS,
  varianceFrom,
  type Trust,
  type Variance,
} from "../lib/priceVariance";
import type { CoflnetPoint } from "../lib/bazaarHistory";

/**
 * What a minion is worth an hour, and how much of that you will actually collect.
 *
 * The tab beside this one ranks minions on a collection they are filling; this one ranks them on
 * coins, which is the question most people are actually asking and the one with the most ways to
 * answer it wrongly. Three of those ways are built into the controls rather than into a footnote:
 *
 * **Storage.** An uncapped rate describes a minion nobody owns. A Tier XII holds 960 items and
 * makes thousands an hour, so without a compactor it is full and idle inside the hour, and the
 * "coins per hour" every other calculator quotes is a figure you receive for about forty minutes
 * a day. The claim interval is the input that turns the rate into an income, and it is the first
 * control on the page for that reason.
 *
 * **The market you sell into.** Instaselling pays the top buy order less the bazaar's 2.25%;
 * standing a sell offer pays the ask and takes time; a shopkeeper pays a fixed price and takes
 * nothing, which for a lot of bulk minion output is simply the best of the three. Quoting one and
 * calling it "profit" hides a real decision.
 *
 * **The price being a lie.** This is the failure this tab was asked to fix. A thin book empties,
 * the quote jumps, and the minion attached to it climbs to the top of the table — not because it
 * is good but because nobody is standing behind the number. The guard is a month of that item's
 * own daily prices from Coflnet: how far today sits from its usual, counted in units of how much
 * it normally moves. Past two standard deviations the row falls back to the month's median rather
 * than the quote, and says so. See `priceVariance.ts` for why a median and not a clamp.
 */

/* ---------------------------------------------------------------- tables */

type Tables = {
  production: MinionData;
  modifiers: Modifiers;
  storage: StorageTables;
  drops: DropTable;
  recipes: Recipe[];
  npcPrices: Record<string, { sell?: number; buy?: number }>;
  names: Record<string, string>;
};

/* ----------------------------------------------------------------- state */

type State = {
  count: string;
  tier: number;
  fuel: string;
  upgrades: [string, string];
  chest: string;
  compactor: string;
  hopper: string;
  /** Hours between visits, as typed. "8", "24", "168". */
  claim: string;
  basis: Basis;
  trust: Trust;
  search: string;
  open: string | null;

  market: Map<string, ReturnType<typeof normalise>>;
  variance: Map<string, Variance>;
  status: string;
  error: string;
  lastAt: number;
  historyAt: number;
};

/** Eight hours: a night, which is when a minion is doing the work you are not. */
const DEFAULT_CLAIM = "8";

const state: State = {
  count: localStorage.getItem("sbxp:mpcount") ?? "5",
  tier: Number(localStorage.getItem("sbxp:mptier") ?? 12),
  fuel: localStorage.getItem("sbxp:mpfuel") ?? "NONE",
  upgrades: [localStorage.getItem("sbxp:mpup0") ?? "NONE", localStorage.getItem("sbxp:mpup1") ?? "NONE"],
  chest: localStorage.getItem("sbxp:mpchest") ?? "NONE",
  compactor: localStorage.getItem("sbxp:mpcomp") ?? "SUPER_COMPACTOR_3000",
  hopper: localStorage.getItem("sbxp:mphopper") ?? "NONE",
  claim: localStorage.getItem("sbxp:mpclaim") ?? DEFAULT_CLAIM,
  basis: (localStorage.getItem("sbxp:mpbasis") as Basis) ?? "instasell",
  trust: (localStorage.getItem("sbxp:mptrust") as Trust) ?? "guarded",
  search: "",
  open: null,
  market: new Map(),
  variance: new Map(),
  status: "",
  error: "",
  lastAt: 0,
  historyAt: 0,
};

let tables: Tables | null = null;
let host: HTMLElement | null = null;
/**
 * The host these listeners are attached to, not merely whether any were attached.
 *
 * A boolean here is a bug waiting for a container to be recreated: the flag says "bound" while the
 * element it bound to has been thrown away, and every control on the tab silently stops working.
 * Comparing the host makes the rebind automatic and the failure impossible.
 */
let boundTo: HTMLElement | null = null;
let timer: number | undefined;

/* ------------------------------------------------------------- the bazaar */

/** Hypixel republishes about every twenty seconds; there is nothing to gain by asking faster. */
const POLL_MS = 20_000;

async function refresh(): Promise<void> {
  state.status = state.market.size ? "refreshing" : "loading the bazaar…";
  state.error = "";
  renderMeta();

  try {
    const response = await fetch("https://api.hypixel.net/v2/skyblock/bazaar");
    if (!response.ok) throw new Error(`Hypixel returned ${response.status}`);
    const body = (await response.json()) as { lastUpdated?: number; products: Record<string, RawBazaarProduct> };

    const market = new Map<string, ReturnType<typeof normalise>>();
    for (const [id, raw] of Object.entries(body.products)) {
      const snapshot = normalise(id, raw, body.lastUpdated ?? Date.now());
      if (snapshot) market.set(id, snapshot);
    }
    state.market = market;
    state.lastAt = body.lastUpdated ?? Date.now();
    state.status = "";
  } catch (error) {
    state.error = error instanceof Error ? error.message : "could not reach the bazaar";
    state.status = "";
  }

  renderMeta();
  renderTable();

  if (host) {
    const due = state.lastAt ? state.lastAt + POLL_MS - Date.now() : POLL_MS;
    timer = window.setTimeout(refresh, Math.max(due, 2_000));
  }
  void fetchMonths();
}

/* ------------------------------------------------------------- the month */

const HISTORY_KEY = "sbxp:mpmonths";
/** Six hours. A daily series does not change faster than that, and the fetch is sixty requests. */
const HISTORY_TTL_MS = 6 * 3600_000;
/** Three at a time. Six earns a 429 from Coflnet, which costs an item its month for six hours. */
const HISTORY_WIDTH = 3;
const HISTORY_RETRY_MS = 1_500;

type MonthStore = { fetchedAt: number; variance: Record<string, Variance> };

function readMonths(): Map<string, Variance> {
  try {
    const store = JSON.parse(localStorage.getItem(HISTORY_KEY) ?? "null") as MonthStore | null;
    if (!store?.variance) return new Map();
    state.historyAt = store.fetchedAt;
    return new Map(Object.entries(store.variance));
  } catch {
    return new Map();
  }
}

/**
 * A month of daily prices for every item a minion drops.
 *
 * Sixty items, three at a time, once every six hours. Coflnet's bare history endpoint answers with
 * a daily series going back years and the last thirty entries of it are the window — which is why
 * this can say something useful the first time the tab is opened, where averaging our own polls
 * would take a month to become a month.
 *
 * A failure is swallowed per item rather than per batch: one item Coflnet has never heard of
 * should cost that item its guard and nothing else. Items with no month simply rank on the live
 * quote, and the row says so rather than implying it was checked.
 */
async function fetchMonths(): Promise<void> {
  if (!tables) return;
  if (Date.now() - state.historyAt < HISTORY_TTL_MS && state.variance.size > 0) return;

  const wanted = [...new Set(dropIds().filter((id): id is string => id !== null))];
  if (wanted.length === 0) return;

  const next: Record<string, Variance> = {};
  for (let i = 0; i < wanted.length; i += HISTORY_WIDTH) {
    await Promise.all(
      wanted.slice(i, i + HISTORY_WIDTH).map(async (id) => {
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            const response = await fetch(MONTH_HISTORY_URL(id));
            if (response.status === 429 && attempt === 0) {
              await new Promise((done) => setTimeout(done, HISTORY_RETRY_MS));
              continue;
            }
            if (!response.ok) return;
            // The sell side: this tab is about what a minion's output fetches, not what it costs.
            const variance = varianceFrom((await response.json()) as CoflnetPoint[], "sell");
            if (variance) next[id] = variance;
            return;
          } catch {
            return;
          }
        }
      }),
    );
  }

  if (Object.keys(next).length === 0) return;
  state.variance = new Map(Object.entries(next));
  state.historyAt = Date.now();
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify({ fetchedAt: state.historyAt, variance: next } satisfies MonthStore));
  } catch {
    // In memory is enough for this session; losing it on reload costs one round of requests.
  }
  renderTable();
  renderMeta();
}

/* ------------------------------------------------------------------ rows */

function fuelById(id: string): Fuel {
  return tables!.modifiers.fuels.find((f) => f.id === id) ?? tables!.modifiers.fuels[0];
}
function upgradeById(id: string): Upgrade {
  return tables!.modifiers.upgrades.find((u) => u.id === id) ?? tables!.modifiers.upgrades[0];
}
function chestById(id: string): StorageChest {
  return tables!.storage.chests.find((c) => c.id === id) ?? tables!.storage.chests[0];
}
function hopperById(id: string): Hopper {
  return tables!.storage.hoppers.find((h) => h.id === id) ?? tables!.storage.hoppers[0];
}
function compactorById(id: string): Compactor {
  return tables!.storage.compactors.find((c) => c.id === id) ?? tables!.storage.compactors[0];
}

/**
 * Every item id these rows need a price for.
 *
 * Resolved the same way the profit engine resolves it — curated pin, then the drop's own name,
 * then the collection id — because a month fetched for one id and a price read from another is a
 * guard that silently never fires.
 */
function dropIds(): (string | null)[] {
  if (!tables) return [];
  const byName = new Map<string, string>();
  for (const [id, name] of Object.entries(tables.names)) {
    const key = name.toLowerCase();
    if (!byName.has(key)) byName.set(key, id);
  }
  return tables.production.minions.map((m) => {
    const pinned = tables!.drops.overrides[m.generator];
    if (pinned) return pinned.itemId;
    return byName.get(m.collects.item.trim().toLowerCase()) ?? m.collectionId;
  });
}

/** The three prices for one item, from the live book and the shopkeeper table. */
function priceBook(): Map<string, ItemPrices> {
  const book = new Map<string, ItemPrices>();
  if (!tables) return book;

  const ids = new Set<string>();
  for (const id of dropIds()) if (id) ids.add(id);
  // Fuels are bought, not sold, and need a price for the running cost.
  for (const fuel of tables.modifiers.fuels) ids.add(fuel.id);

  for (const id of ids) {
    const product = state.market.get(id);
    const npc = tables.npcPrices[id];
    book.set(id, {
      instasell: product && product.instasell > 0 ? product.instasell : null,
      instabuy: product && product.instabuy > 0 ? product.instabuy : null,
      npcSell: npc?.sell ?? null,
    });
  }
  return book;
}

/**
 * What is actually in the two upgrade slots.
 *
 * A compactor is a Minion Upgrade and occupies one of them, so choosing one spends the second slot
 * whatever the second dropdown last held. Enforcing that here as well as in the controls means a
 * value left in localStorage from before a compactor was picked cannot quietly buy the setup a
 * Flycatcher it does not have.
 */
function slots(): [Upgrade, Upgrade] {
  const empty = tables!.modifiers.upgrades.find((u) => u.id === "NONE")!;
  const first = upgradeById(state.upgrades[0]);
  return compactorById(state.compactor).kind === "none" ? [first, upgradeById(state.upgrades[1])] : [first, empty];
}

function rows(): MinionProfitRow[] {
  if (!tables) return [];

  const claim = Math.max(0.25, Number(parseBudget(state.claim) ?? Number(state.claim) ?? 8) || 8);
  const all = planProfit({
    data: tables.production,
    storage: tables.storage,
    drops: tables.drops,
    recipes: tables.recipes,
    prices: priceBook(),
    variance: state.variance,
    names: tables.names,
    basis: state.basis,
    trust: state.trust,
    setup: {
      tier: state.tier,
      fuel: fuelById(state.fuel),
      upgrades: slots(),
      count: Math.max(1, Number(state.count.replace(/[^0-9]/g, "")) || 1),
      chest: chestById(state.chest),
      hopper: hopperById(state.hopper),
      compactor: compactorById(state.compactor),
      claimHours: claim,
    },
  });

  const needle = state.search.trim().toLowerCase();
  if (!needle) return all;
  return all.filter((r) => r.family.toLowerCase().includes(needle) || r.itemName.toLowerCase().includes(needle));
}

/* -------------------------------------------------------------- rendering */

export function mountMinionProfit(container: HTMLElement, data: Tables): void {
  host = container;
  tables = data;
  if (state.variance.size === 0) state.variance = readMonths();

  if (boundTo !== container) {
    boundTo = container;

    container.addEventListener("click", (event) => {
      const target = event.target as HTMLElement;

      const basis = target.closest<HTMLElement>("[data-mpbasis]");
      if (basis) {
        state.basis = basis.dataset.mpbasis as Basis;
        localStorage.setItem("sbxp:mpbasis", state.basis);
        return render();
      }

      const trust = target.closest<HTMLElement>("[data-mptrust]");
      if (trust) {
        state.trust = trust.dataset.mptrust as Trust;
        localStorage.setItem("sbxp:mptrust", state.trust);
        return render();
      }

      if (target.closest("#mprefresh")) return void refresh();

      const row = target.closest<HTMLElement>("[data-mpopen]");
      if (row) {
        state.open = state.open === row.dataset.mpopen ? null : row.dataset.mpopen!;
        renderTable();
      }
    });

    container.addEventListener("change", (event) => {
      const el = event.target as HTMLSelectElement;
      const map: Record<string, (value: string) => void> = {
        mptier: (v) => ((state.tier = Number(v)), localStorage.setItem("sbxp:mptier", v)),
        mpfuel: (v) => ((state.fuel = v), localStorage.setItem("sbxp:mpfuel", v)),
        mpup0: (v) => ((state.upgrades[0] = v), localStorage.setItem("sbxp:mpup0", v)),
        mpup1: (v) => ((state.upgrades[1] = v), localStorage.setItem("sbxp:mpup1", v)),
        mpchest: (v) => ((state.chest = v), localStorage.setItem("sbxp:mpchest", v)),
        mpcomp: (v) => ((state.compactor = v), localStorage.setItem("sbxp:mpcomp", v)),
        mphopper: (v) => ((state.hopper = v), localStorage.setItem("sbxp:mphopper", v)),
      };
      const apply = map[el.id];
      if (!apply) return;
      apply(el.value);
      render();
    });

    container.addEventListener("input", (event) => {
      const el = event.target as HTMLInputElement;
      if (el.id === "mpcount") {
        state.count = el.value;
        localStorage.setItem("sbxp:mpcount", el.value);
      } else if (el.id === "mpclaim") {
        state.claim = el.value;
        localStorage.setItem("sbxp:mpclaim", el.value);
      } else if (el.id === "mpsearch") {
        state.search = el.value;
      } else return;
      // Only the results half repaints: rebuilding a control someone is typing into drops the caret.
      renderTable();
      renderSetupNote();
    });
  }

  render();
  if (state.market.size === 0) void refresh();
  else timer = window.setTimeout(refresh, POLL_MS);
}

export function unmountMinionProfit(): void {
  clearTimeout(timer);
  timer = undefined;
  host = null;
}

/**
 * The upgrade slots, minus the compactors.
 *
 * A compactor is a Minion Upgrade and does take one of the two slots, so it belongs in this list
 * on the game's own terms. It is pulled out into its own control anyway, because leaving it here
 * means the same decision is expressed in two places — a Super Compactor in slot one and "no
 * compactor" in the compactor box is a setup nobody meant and the table cannot detect. Choosing it
 * once, and showing the slot it consumed, is the arrangement with no wrong state in it.
 */
function upgradeChoices(): Upgrade[] {
  const compactors = new Set(tables!.storage.compactors.map((c) => c.id));
  return tables!.modifiers.upgrades.filter((u) => !compactors.has(u.id));
}

function options(list: { id: string; name: string }[], selected: string, label?: (item: never) => string): string {
  return list
    .map((item) => {
      const text = label ? label(item as never) : item.name;
      return `<option value="${escapeHtml(item.id)}"${selected === item.id ? " selected" : ""}>${escapeHtml(text)}</option>`;
    })
    .join("");
}

function render(): void {
  if (!host || !tables) return;

  const tiers = Array.from({ length: 12 }, (_, i) => i + 1)
    .map((t) => `<option value="${t}"${state.tier === t ? " selected" : ""}>Tier ${t}</option>`)
    .join("");

  host.innerHTML = `
    <div class="meta" id="mpmeta">${metaHtml()}</div>

    <div class="panel pad controls">
      <div class="row">
        <label title="How many of the one minion you intend to put down.">Minions
          <input id="mpcount" value="${escapeHtml(state.count)}" inputmode="numeric" autocomplete="off">
        </label>
        <label title="The tier to price. A minion that stops below it is costed at its own maximum instead.">Tier
          <select id="mptier">${tiers}</select>
        </label>
        <label title="How many hours pass between visits to the island. This is what turns a rate into an income: past the point a minion fills, it earns nothing more until you come back.">Claim every (hours)
          <input id="mpclaim" value="${escapeHtml(state.claim)}" inputmode="numeric" autocomplete="off">
        </label>
        <label>Search <input id="mpsearch" value="${escapeHtml(state.search)}" placeholder="e.g. clay" autocomplete="off"></label>
      </div>

      <div class="row">
        <label title="One fuel slot. Percentage fuels shorten the timer; xN fuels duplicate the drop instead.">Fuel
          <select id="mpfuel">${options(
            tables.modifiers.fuels,
            state.fuel,
            (f: Fuel) => (f.speed > 0 ? `${f.name} (+${Math.round(f.speed * 100)}%)` : f.multiplier > 1 ? `${f.name} (x${f.multiplier})` : f.name),
          )}</select>
        </label>
        <label title="First of the two upgrade slots. Compactors are chosen below instead, because one of them takes a slot and the choice is easier to get right when it is made once.">Upgrade 1
          <select id="mpup0">${options(upgradeChoices(), state.upgrades[0])}</select>
        </label>
        <label title="${escapeHtml(
          compactorById(state.compactor).kind === "none"
            ? "Second upgrade slot."
            : "Spent on the compactor below, which is a Minion Upgrade and occupies one of the two slots.",
        )}">Upgrade 2
          <select id="mpup1"${compactorById(state.compactor).kind === "none" ? "" : " disabled"}>${
            compactorById(state.compactor).kind === "none"
              ? options(upgradeChoices(), state.upgrades[1])
              : `<option>${escapeHtml(compactorById(state.compactor).name)}</option>`
          }</select>
        </label>
      </div>

      <div class="row">
        <label title="Compacting does not change how much a minion collects — it changes how much fits. 160 cobblestone become one Enchanted Cobblestone, so the same storage lasts 160 times as long. The ratio is read from each item's own recipe.">Compactor
          <select id="mpcomp">${options(tables.storage.compactors, state.compactor)}</select>
        </label>
        <label title="A chest stood beside the minion. Not an upgrade and not in the two slots — the wiki is explicit about that — so it is free of the choice above.">Storage chest
          <select id="mpchest">${options(tables.storage.chests, state.chest, (c: StorageChest) => (c.slots ? `${c.name} (+${c.slots} slots)` : c.name))}</select>
        </label>
        <label title="A hopper sells the overflow once the minion and its chest are both full — at the shopkeeper's price, less its own cut.">Automated shipping
          <select id="mphopper">${options(tables.storage.hoppers, state.hopper, (h: Hopper) => (h.npcShare ? `${h.name} (${Math.round(h.npcShare * 100)}% of NPC)` : h.name))}</select>
        </label>
      </div>

      <div class="row">
        <span class="tabs" title="Which market the output is valued against.">
          ${(Object.keys(BASIS_LABELS) as Basis[])
            .map(
              (id) =>
                `<button class="chip${state.basis === id ? " on" : ""}" data-mpbasis="${id}" title="${escapeHtml(
                  BASIS_HELP[id],
                )}">${escapeHtml(BASIS_LABELS[id])}</button>`,
            )
            .join("")}
        </span>
        <span class="tabs" title="How much to believe today's quote.">
          ${TRUST_TABS.map(
            ([id, label, help]) =>
              `<button class="chip${state.trust === id ? " on" : ""}" data-mptrust="${id}" title="${escapeHtml(help)}">${escapeHtml(
                label,
              )}</button>`,
          ).join("")}
        </span>
      </div>

      <p class="sub dim" id="mpsetup">${setupNote()}</p>
    </div>

    <div id="mptable"></div>
  `;

  renderTable();
}

const BASIS_HELP: Record<Basis, string> = {
  instasell:
    "Sell into the top buy order, right now. The bazaar keeps 2.25%. This is the honest default for someone " +
    "holding items who wants coins today.",
  order:
    "Stand a sell offer at the ask and wait for a buyer. Better coins, no certainty, and only real on items " +
    "somebody is actually buying — the volume column on the bazaar tab is where to check that.",
  npc:
    "Sell to a shopkeeper. A fixed price with no tax and no book to run out, which for cheap bulk output beats " +
    "both bazaar routes more often than people expect.",
};

const TRUST_TABS: [Trust, string, string][] = [
  [
    "guarded",
    "Guarded price",
    "Use today's quote unless it is more than two standard deviations off this item's own month, in which case " +
      "use the month's median instead. This is what stops a manipulated book putting a minion nobody would build " +
      "at the top of the table.",
  ],
  ["live", "Live price", "Take the quote as given, however odd it looks. What every other minion calculator does."],
  [
    "median",
    "Month median",
    "Always use the middle of the last thirty days. Steady, and blind to a real move: a price that genuinely " +
      "doubled last week reads as an anomaly for three more.",
  ],
];

function metaHtml(): string {
  const age = state.lastAt ? `${Math.round((Date.now() - state.lastAt) / 1000)}s ago` : "not yet read";
  const months = state.variance.size;
  return `
    <strong>${num(state.market.size)} products</strong>
    <span class="dim">bazaar read ${escapeHtml(age)}</span>
    <span class="dim" title="Daily prices from Coflnet, refreshed every six hours. Items without one rank on the live quote and say so.">${
      months ? `${num(months)} items with a ${WINDOW_DAYS}-day history` : "no price history yet"
    }</span>
    ${state.status ? `<span class="dim">${escapeHtml(state.status)}</span>` : ""}
    ${state.error ? `<span class="gold">${escapeHtml(state.error)}</span>` : ""}
    <button type="button" class="chip" id="mprefresh">Refresh now</button>
  `;
}

function renderMeta(): void {
  const target = document.getElementById("mpmeta");
  if (target) target.innerHTML = metaHtml();
}

function renderSetupNote(): void {
  const target = document.getElementById("mpsetup");
  if (target) target.innerHTML = setupNote();
}

/**
 * What the setup adds up to, in one sentence, including the thing it costs.
 *
 * The compactor line is the one worth reading twice: it occupies an upgrade slot, so a setup with
 * a Super Compactor and a Flycatcher has used both and cannot have a Minion Expander as well.
 */
function setupNote(): string {
  if (!tables) return "";
  const fuel = fuelById(state.fuel);
  const ups = slots();
  const compactor = compactorById(state.compactor);
  const chest = chestById(state.chest);
  const hopper = hopperById(state.hopper);
  const claim = Math.max(0.25, Number(state.claim) || 8);

  const speed = fuel.speed + ups.reduce((s, u) => s + u.speed, 0);
  const multiplier = fuel.multiplier * ups.reduce((m, u) => m * u.output, 1);

  const parts: string[] = [];
  if (speed > 0) parts.push(`<strong>+${Math.round(speed * 100)}%</strong> speed`);
  if (multiplier !== 1) parts.push(`<strong>x${multiplier}</strong> drops`);
  if (parts.length === 0) parts.push("no speed or output boost");

  const holding =
    compactor.kind === "none"
      ? "Nothing is compacting, so storage is measured in raw drops and fills fast — which is the state most of these rows are in."
      : `${escapeHtml(compactor.name)} is compacting, and it has cost the second upgrade slot to do it. ` +
        `That is almost always the right trade: a Flycatcher is +20% output, and compaction is worth hundreds of ` +
        `times its slot in fill time.`;

  const shipping =
    hopper.npcShare > 0
      ? `A ${escapeHtml(hopper.name)} sells anything past full at ${Math.round(hopper.npcShare * 100)}% of the shopkeeper's price, so nothing is wasted but the difference.`
      : "With no hopper, everything the minion makes after it fills is simply never made.";

  return (
    `This setup is ${parts.join(" and ")}, claimed every <strong>${claim}h</strong>. ${holding} ` +
    `${chest.slots ? `The ${escapeHtml(chest.name)} adds ${chest.slots} slots beside the minion. ` : ""}${shipping}`
  );
}

/* ------------------------------------------------------------------ table */

const COLUMNS: { label: string; title: string; render: (r: MinionProfitRow) => string }[] = [
  {
    label: "Net/hr",
    title:
      "Coins an hour actually realised at this claim interval, less fuel. The ranking figure, and lower than the " +
      "gross wherever storage fills before you come back.",
    render: (r) => (r.itemId === null ? `<span class="dim">—</span>` : coins(Math.round(r.netPerHour))),
  },
  {
    label: "Per claim",
    title: "What one visit hands you, at the interval above.",
    render: (r) => (r.itemId === null ? `<span class="dim">—</span>` : coins(Math.round(r.perClaim))),
  },
  {
    label: "Gross/hr",
    title:
      "Coins an hour if storage never filled — the number other calculators quote. The gap between this and Net " +
      "is what the claim interval costs you.",
    render: (r) => (r.itemId === null ? `<span class="dim">—</span>` : `<span class="dim">${coins(Math.round(r.grossPerHour))}</span>`),
  },
  {
    label: "Fills in",
    title:
      "How long from empty to full and idle. With a hopper this is when the shopkeeper starts taking the overflow " +
      "instead — the wiki is explicit that a hopper only sells once the minion and its chest are both full.",
    render: (r) => hours(r.hoursToFill),
  },
  {
    label: "Items/hr",
    title: "Raw drops the whole setup produces an hour, before storage caps anything.",
    render: (r) => num(Math.round(r.itemsPerHour)),
  },
  {
    label: "Each",
    title: "What one drop is worth on the chosen basis, after tax.",
    render: (r) => (r.itemId === null ? `<span class="dim">—</span>` : coins(r.unitValue)),
  },
  {
    label: "Month",
    title:
      "How far today's price sits from this item's own last thirty days, counted in standard deviations. Past two, " +
      "the guarded basis stops believing the quote and uses the month's median instead.",
    render: monthCell,
  },
];

/**
 * The cell that decides whether to believe the row.
 *
 * A percentage would be the obvious thing to print here and it would be the wrong one: +15% means
 * nothing without knowing whether this item moves 1% a day or 40%. Sigma is the figure that
 * carries both, and the word beside it is what a reader actually acts on.
 */
function monthCell(r: MinionProfitRow): string {
  if (r.itemId === null) return `<span class="dim">—</span>`;
  const variance = state.variance.get(r.itemId);
  if (!variance) {
    return `<span class="dim" title="Coflnet publishes no daily history for this item, so there is nothing to check today's quote against. This row is ranking on the live price alone.">no history</span>`;
  }
  const z = r.price.z;
  if (z === null) {
    return `<span class="dim" title="This item's price did not move at all over the month, so there is no normal movement to measure today against — which is the least suspicious thing a bazaar item can do.">flat</span>`;
  }

  const shown = `${z > 0 ? "+" : "−"}${Math.abs(z).toFixed(1)}σ`;
  const loud = r.price.confidence === "normal" ? "" : " gold";
  const spread = `${(variance.spread * 100).toFixed(0)}% typical swing over ${num(variance.samples)} days`;
  const verdict =
    r.price.confidence === "anomalous"
      ? "Far enough out that a thin book is the likeliest explanation, not a price change."
      : r.price.confidence === "elevated"
        ? "Further out than this item usually goes. Worth checking the book depth before building for it."
        : "Within this item's ordinary range.";
  const used = r.price.substituted ? " The month's median was used instead of today's quote." : "";

  return `<span class="${loud.trim()}" title="${escapeHtml(`${verdict}${used} Month median ${Math.round(variance.median)}, ${spread}.`)}">${shown}${
    r.price.substituted ? `<span class="dim" title="Median used"> ·</span>` : ""
  }</span>`;
}

function hours(h: number): string {
  if (!Number.isFinite(h)) return `<span class="dim" title="Nothing about this setup ever stops it.">never</span>`;
  if (h < 1) return `${Math.round(h * 60)} min`;
  if (h < 48) return `${h.toFixed(1)} hr`;
  const days = h / 24;
  if (days < 60) return `${days.toFixed(1)} days`;
  return `${(days / 30.44).toFixed(1)} months`;
}

function renderTable(): void {
  const target = document.getElementById("mptable");
  if (!target || !tables) return;

  const all = rows();
  if (all.length === 0) {
    return void (target.innerHTML = `<p class="dim pad">Nothing to price yet — the bazaar has not been read.</p>`);
  }

  const head = COLUMNS.map((c) => `<th class="num" title="${escapeHtml(c.title)}">${escapeHtml(c.label)}</th>`).join("");

  const body = all
    .slice(0, 80)
    .map((r) => {
      const cells = COLUMNS.map((c) => `<td class="num">${c.render(r)}</td>`).join("");
      const icon = `<img class="bz-icon" src="https://sky.coflnet.com/static/icon/${encodeURIComponent(
        r.generator,
      )}_GENERATOR_${r.tier}" alt="" width="20" height="20" loading="lazy" decoding="async">`;
      const detail =
        state.open === r.generator ? `<tr class="mn-detail"><td colspan="${COLUMNS.length + 1}">${detailHtml(r)}</td></tr>` : "";
      return `<tr class="bz-open" data-mpopen="${escapeHtml(r.generator)}">
        <td>${icon}${escapeHtml(r.family)}
          <div class="dim bz-path">${escapeHtml(r.itemName)}${r.tier < state.tier ? ` · caps at tier ${r.tier}` : ""}</div>
        </td>${cells}
      </tr>${detail}`;
    })
    .join("");

  target.innerHTML = `
    <p class="dim pad">${NOTE}</p>
    <div class="panel scroll">
      <table class="bz">
        <thead><tr><th>Minion</th>${head}</tr></thead>
        <tbody>${body}</tbody>
      </table>
    </div>
    <p class="dim pad">${num(all.length)} minions${all.length > 80 ? ", showing the first 80" : ""} · ${escapeHtml(
      BASIS_LABELS[state.basis].toLowerCase(),
    )} · claimed every ${escapeHtml(state.claim)}h · ${escapeHtml(state.count)} placed</p>
  `;
}

/** The row opened out: where the number came from, and what it is quietly leaving out. */
function detailHtml(r: MinionProfitRow): string {
  const variance = r.itemId ? state.variance.get(r.itemId) : undefined;
  const lines: string[] = [];

  lines.push(
    `<div class="gh-sub"><strong>${num(Math.round(r.itemsPerHour))}</strong> drops an hour into <strong>${num(
      Math.round(r.capacity),
    )}</strong> drops of storage, so it fills in ${hours(r.hoursToFill)}.</div>`,
  );

  if (r.itemsLost > 0) {
    lines.push(
      `<div class="gh-sub gold">Standing full wastes <strong>${num(Math.round(r.itemsLost))}</strong> drops a claim — ` +
        `about ${coins(Math.round(r.itemsLost * r.unitValue))} left on the table. A compactor, a chest, a hopper or a ` +
        `shorter interval all fix it, and the first is usually cheapest.</div>`,
    );
  }
  if (r.hopperPerHour > 0) {
    lines.push(`<div class="gh-sub">The hopper contributes ${coins(Math.round(r.hopperPerHour))} an hour of that overflow.</div>`);
  }
  if (r.fuelPerHour > 0) {
    lines.push(`<div class="gh-sub">Fuel costs ${coins(Math.round(r.fuelPerHour))} an hour across ${escapeHtml(state.count)} minions.</div>`);
  }
  if (variance) {
    lines.push(
      `<div class="gh-sub">Over ${num(variance.samples)} days this item averaged ${coins(
        Math.round(variance.mean),
      )} with a median of ${coins(Math.round(variance.median))} and a typical swing of ${(variance.spread * 100).toFixed(
        0,
      )}%.</div>`,
    );
  }
  for (const caveat of r.caveats) lines.push(`<div class="gh-sub dim">${escapeHtml(caveat)}</div>`);

  return lines.join("");
}

const NOTE =
  "What each minion pays, ranked on what you actually collect rather than on what it produces. Every figure is " +
  "the offline rate — a minion generates on one action and harvests on the next, so a drop lands every two " +
  "cooldowns — and every figure is capped by storage, because a full minion earns nothing until you come back. " +
  "Prices are a live bazaar read guarded against a month of that item's own daily history: past two standard " +
  "deviations the row stops believing today's quote, which is what keeps a manipulated book from winning the table.";

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
