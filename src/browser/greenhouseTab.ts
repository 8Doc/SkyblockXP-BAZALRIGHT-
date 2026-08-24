import { normalise } from "../lib/bazaar";
import type { NpcPrice } from "../lib/bazaarViews";
import type { ProductSnapshot, RawBazaarProduct } from "../lib/bazaarTypes";
import { coins, num } from "../lib/format";
import { rankMutations, stageSeconds, type GreenhouseData, type GrowthParams, type MutationProfit } from "../lib/greenhouse";

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
    title: "The same figure over a day left alone, which is what an AFK method is really sold on.",
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
    id: "perPlot",
    label: "Per plot",
    value: (r) => r.perPlot,
    render: (r) => (r.perPlot > 0 ? num(r.perPlot) : `<span class="dim">—</span>`),
    title:
      "How many of these grow at once in one greenhouse, at the best layout found. This is the " +
      "figure that decides the ranking: the ring of support crops around each one is shared with " +
      "its neighbours, so a condition needing two adjacent crops fits seventy in a 10×10 while " +
      "one needing all eight fits sixteen. Dividing the plot by nine gets both badly wrong.",
  },
  { id: "revenue", label: "Each", value: (r) => r.revenue, render: (r) => coins(r.revenue + r.vineRevenue), title: "Coins one harvest of one mutation is worth at your fortune, the Ethereal Vine chance included. Multiply by the per-plot count for what the greenhouse actually yields." },
  {
    id: "setup",
    label: "Setup",
    value: (r) => r.setup?.coins ?? Infinity,
    render: (r) =>
      !r.setup
        ? `<span class="dim">—</span>`
        : r.setup.coins === null
          ? `<span class="gold" title="Nothing is selling what this needs.">unpriced</span>`
          : coins(r.setup.coins),
    title:
      "What the ring costs to buy once. A mutation that needs other mutations is priced at what " +
      "those cost on the bazaar, which is the shortcut — growing them yourself is cheaper and slower.",
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
    return `Using <strong>${num(fortuneValue())}</strong>. Every drop scales by <strong>${(1 + fortuneValue() / 100).toFixed(1)}×</strong>.`;
  }
  return (
    `Assuming <strong>${num(ASSUMED_FORTUNE)}</strong> — a placeholder for a mid-to-late farming setup, ` +
    `not a reading of your profile. It matters less than it looks: fortune multiplies every mutation ` +
    `by the same amount, so a wrong figure scales the coins and leaves the <em>order</em> alone.`
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
    return `<p class="sub">${summary} <span class="dim">${
      filled > 0
        ? `${filled} crop${filled > 1 ? "s" : ""} set — these change the order, not just the totals.`
        : "Wheat Fortune, Carrot Fortune and the rest. Unlike the box above, these lift one crop each, so they change which mutation wins."
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
    <p class="sub dim">
      Added to Farming Fortune for that crop only, before the yield is worked out — the wiki's rule,
      not ours. Sources are the tool you are holding, Anita's shop and Carrolyn. The
      <strong>Overdrive Chip</strong> adds up to <strong>+140</strong> more, but only to the active
      crop during a Jacob's Farming Contest — so put it in when you are asking about a contest, and
      leave it out when you are asking about a normal day.
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

const NOTE =
  "Every Greenhouse mutation, ranked on what it pays per hour left alone. A harvest is two waits " +
  "— the expected time for the mutation to spawn, which is one over its chance, and then its own " +
  "growth stages — so a rare mutation with a huge drop can still lose to a common one that keeps " +
  "coming back. Setup is what the ring around it costs to buy once. Click a row for its layout. " +
  "Drop figures are the wiki's, and every base crop's changed on 2026-08-20, so a number quoted " +
  "anywhere older than that is for a different game.";

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
        ? `<div class="dim bz-path">${row.setup.items
            .map(
              (i) =>
                `${num(i.plants)} × ${escapeHtml(i.name)}${i.free ? ` <span class="dim">(free)</span>` : ""}${
                  i.grown ? `<span class="dim" title="Itself a mutation, so it has to be grown before it can be planted — or bought outright.">*</span>` : ""
                }`,
            )
            .join(" <span class=\"dim\">+</span> ")} <span class="dim">for the whole plot</span></div>`
        : "";
      const rarity = row.rarity ? ` <span class="dim">${escapeHtml(row.rarity)}</span>` : "";
      // Which crop fortune lifted this row, when one did. Named rather than folded silently into
      // the total, because it is the input most likely to be a contest-day figure entered as a
      // standing one — and this is where that would show up.
      const lifted = row.cropsLifted.length
        ? ` <span class="dim" title="This row is lifted by the crop fortune you entered for these, on top of your general Farming Fortune.">· ${escapeHtml(
            row.cropsLifted.join(", "),
          )} fortune applied</span>`
        : "";
      const open = state.open === row.id ? layoutHtml(row) : "";
      return `<tr class="bz-open" data-ghopen="${escapeHtml(row.id)}"><td>${icon}${escapeHtml(row.name)}${rarity}${lifted}${setup}${problem}${open}</td>${cells}</tr>`;
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
 * The 3x3 the mutation spreads into the middle of.
 *
 * This is the layout as the wiki draws it, which is one mutation in isolation. A real greenhouse
 * overlaps them — the ring of one is the ring of its neighbour — so this is the pattern to copy
 * rather than a plan for a whole plot.
 */
function layoutHtml(row: MutationProfit): string {
  const mutation = tables.greenhouse.mutations.find((m) => m.id === row.id);
  const packing = row.packing;
  if (!mutation || !packing || packing.targets === 0 || !row.setup) {
    return `<div class="gh-layout dim">No arrangement of this plot grows one of these.</div>`;
  }

  const items = row.setup.items;
  const swatch = (i: number) => `<span class="gh-key gh-c${i % 5}"></span>`;
  const legend =
    items.map((i, at) => `${swatch(at)} ${escapeHtml(i.name)}`).join(" ") +
    ` <span class="gh-key gh-k-target"></span> ${escapeHtml(mutation.name)}` +
    ` <span class="gh-key gh-k-empty"></span> spare`;

  // The whole plot, not the wiki's single 3x3. The wiki draws one mutation in isolation; a real
  // greenhouse overlaps them, and the overlap is where the yield comes from.
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

  /**
   * The bill, itemised. Which plant is the expensive one is the thing a single total hides, and it
   * is usually the whole answer: a condition wanting four of a legendary mutation and four of a
   * common one costs almost exactly the legendary.
   */
  const bill = items
    .map((i) => {
      const cost =
        i.free
          ? `<span class="dim">free — lit rather than bought</span>`
          : i.each === null
            ? `<span class="gold">nothing is selling it</span>`
            : `${coins(i.each)} each · <strong>${coins(i.coins ?? 0)}</strong>`;
      const share =
        row.setup!.coins && i.coins ? ` <span class="dim">${Math.round((100 * i.coins) / row.setup!.coins)}% of the bill</span>` : "";
      return `<li>${num(i.plants)} × ${escapeHtml(i.name)} — ${cost}${share}
        <span class="dim">· ${i.cells} ring cell${i.cells === 1 ? "" : "s"} at each ${escapeHtml(mutation.name)}${
          i.grown ? ", and itself a mutation you have to grow or buy" : ""
        }</span></li>`;
    })
    .join("");

  const atCeiling = packing.targets >= packing.ceiling;
  const sizeNote =
    mutation.size > 1
      ? ` It is ${mutation.size}×${mutation.size}, so it needs that much clear room and has a ${
          mutation.size === 2 ? "twelve" : "sixteen"
        }-cell ring rather than eight — which is why so few fit.`
      : "";

  return `
    <div class="gh-layout">
      <div class="gh-plotgrid">${grid}</div>
      <p class="dim">${legend}</p>
      <p class="dim">
        <strong>${num(packing.targets)}</strong> grow at once, from <strong>${num(row.setup.plants)}</strong>
        plants in all, tiling a ${packing.period.rows}×${packing.period.cols} pattern.
        ${
          atCeiling
            ? "That is the most any arrangement could manage — every support cell is feeding as many rings as it can."
            : `The counting bound says no arrangement beats ${num(packing.ceiling)}, so this may leave a little on the table: the search covers repeating patterns, not every irregular one.`
        }${sizeNote}
      </p>
      <p class="dim">Everything below is needed <em>at the same time</em> — the wiki writes the condition with slashes, but it is an "and".</p>
      <ul class="gh-bill">${bill}</ul>
      <p class="dim">
        ${row.setup.coins === null ? `<span class="gold">Part of this has no price, so there is no total.</span>` : `<strong>${coins(row.setup.coins)}</strong> to set the whole plot up once.`}
        ${escapeHtml(mutation.effects.join(" · "))}
      </p>
    </div>
  `;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
