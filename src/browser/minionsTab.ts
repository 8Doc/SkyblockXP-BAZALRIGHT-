import { num } from "../lib/format";
import {
  itemsPerHour,
  planMinions,
  type Collection,
  type Fuel,
  type MinionData,
  type MinionPlan,
  type Modifiers,
  type Upgrade,
} from "../lib/minions";

/**
 * The Minions tab: which minion fills a collection fastest.
 *
 * Named for the thing rather than the question, because more will hang off it — a minion is a
 * rate applied to several different problems and this is the first of them.
 *
 * No poll and no bazaar read: unlike the two live tabs beside it, everything here is a static
 * table and three dropdowns. What it does want is a *profile* — how much of each collection you
 * already have, and which minion tiers you have crafted — and that arrives from the planner
 * rather than being asked for twice. Without one it still answers, from zero, and says so.
 *
 * The arithmetic is in `src/lib/minions.ts`, including the factor of two that decides every
 * figure on the page: a minion drops on every *other* action.
 */

type Tables = { production: MinionData; modifiers: Modifiers; collections: Collection[] };

type State = {
  /** How many of the one minion are placed. */
  count: string;
  /** Use the best tier the profile shows, or plan for a tier you intend to have. */
  useOwned: boolean;
  assumeTier: number;
  fuel: string;
  upgrades: [string, string];
  /** Aim at the last tier of a collection rather than the next one. */
  maxOut: boolean;
  search: string;
  /** Collected totals and crafted tiers, handed over by the planner when a profile is loaded. */
  collected: Map<string, number>;
  ownedTier: Map<string, number>;
  profileName: string | null;
};

/**
 * Twelve, not eleven.
 *
 * A player deciding what to build is deciding about the top of the ladder, and the top is XII for
 * the minions that have one. Where a minion stops at XI the plan caps it there rather than
 * refusing the row, so the default costs nothing on the minions it does not apply to.
 */
const DEFAULT_TIER = 12;

/** Five is what a profile starts with, and the number most people have opinions about. */
const DEFAULT_COUNT = "5";

const state: State = {
  count: localStorage.getItem("sbxp:mncount") ?? DEFAULT_COUNT,
  useOwned: localStorage.getItem("sbxp:mnuseowned") !== "0",
  assumeTier: Number(localStorage.getItem("sbxp:mntier") ?? DEFAULT_TIER),
  fuel: localStorage.getItem("sbxp:mnfuel") ?? "NONE",
  upgrades: [localStorage.getItem("sbxp:mnup0") ?? "NONE", localStorage.getItem("sbxp:mnup1") ?? "NONE"],
  maxOut: localStorage.getItem("sbxp:mnmax") === "1",
  search: "",
  collected: new Map(),
  ownedTier: new Map(),
  profileName: null,
};

let tables: Tables = { production: { actionsPerHarvest: 2, minions: [] }, modifiers: { fuels: [], upgrades: [] }, collections: [] };
let host: HTMLElement | null = null;
let bound = false;

/* ---------------------------------------------------------------- profile */

/**
 * Take the collection totals and crafted tiers from whatever the planner has loaded.
 *
 * Called on every profile load rather than fetched here, because the planner already asked for
 * the profile and asking twice would mean a second API key box on a tab that otherwise needs
 * none. A tab that quietly works better once you have used the one next to it is a reasonable
 * trade; a tab that demands a key before it says anything is not.
 */
export function setMinionProfile(collected: Map<string, number>, ownedTier: Map<string, number>, name: string | null): void {
  state.collected = collected;
  state.ownedTier = ownedTier;
  state.profileName = name;
  if (host) render();
}

/* --------------------------------------------------------------- the rows */

function fuelById(id: string): Fuel {
  return tables.modifiers.fuels.find((f) => f.id === id) ?? tables.modifiers.fuels[0];
}

function upgradeById(id: string): Upgrade {
  return tables.modifiers.upgrades.find((u) => u.id === id) ?? tables.modifiers.upgrades[0];
}

function rows(): MinionPlan[] {
  const all = planMinions({
    data: tables.production,
    collections: tables.collections,
    collected: state.collected,
    ownedTier: state.ownedTier,
    assumeTier: state.assumeTier,
    useOwned: state.useOwned,
    fuel: fuelById(state.fuel),
    upgrades: [upgradeById(state.upgrades[0]), upgradeById(state.upgrades[1])],
    count: Math.max(1, Number(state.count.replace(/[^0-9]/g, "")) || 1),
    maxOut: state.maxOut,
  });

  const needle = state.search.trim().toLowerCase();
  if (!needle) return all;
  return all.filter((r) => r.family.toLowerCase().includes(needle) || r.collectionName.toLowerCase().includes(needle));
}

/** "3.4 hr", "2.1 days", "5 min" — a wait, since that is what the number is. */
function hours(h: number): string {
  if (!Number.isFinite(h)) return "—";
  if (h < 1) return `${Math.round(h * 60)} min`;
  if (h < 48) return `${h.toFixed(1)} hr`;
  const days = h / 24;
  if (days < 60) return `${days.toFixed(1)} days`;
  return `${(days / 30.44).toFixed(1)} months`;
}

/* ------------------------------------------------------------- rendering */

export function mountMinions(container: HTMLElement, data: Tables): void {
  host = container;
  tables = data;

  if (!bound) {
    bound = true;

    container.addEventListener("click", (event) => {
      const target = event.target as HTMLElement;

      const owned = target.closest<HTMLElement>("[data-mnowned]");
      if (owned) {
        state.useOwned = owned.dataset.mnowned === "1";
        localStorage.setItem("sbxp:mnuseowned", state.useOwned ? "1" : "0");
        render();
        return;
      }

      const goal = target.closest<HTMLElement>("[data-mngoal]");
      if (goal) {
        state.maxOut = goal.dataset.mngoal === "max";
        localStorage.setItem("sbxp:mnmax", state.maxOut ? "1" : "0");
        render();
      }
    });

    container.addEventListener("change", (event) => {
      const el = event.target as HTMLSelectElement;
      if (el.id === "mnfuel") {
        state.fuel = el.value;
        localStorage.setItem("sbxp:mnfuel", el.value);
      } else if (el.id === "mnup0" || el.id === "mnup1") {
        const at = el.id === "mnup0" ? 0 : 1;
        state.upgrades[at] = el.value;
        localStorage.setItem(`sbxp:mnup${at}`, el.value);
      } else if (el.id === "mntier") {
        state.assumeTier = Number(el.value);
        localStorage.setItem("sbxp:mntier", el.value);
      } else return;
      render();
    });

    container.addEventListener("input", (event) => {
      const el = event.target as HTMLInputElement;
      if (el.id === "mncount") {
        state.count = el.value;
        localStorage.setItem("sbxp:mncount", el.value);
        renderTable();
      } else if (el.id === "mnsearch") {
        state.search = el.value;
        renderTable();
      }
    });
  }

  render();
}

export function unmountMinions(): void {
  host = null;
}

/**
 * What the setup adds up to, said once in plain terms.
 *
 * The three dropdowns interact in a way that is easy to misread — a Hyper Catalyst and a
 * Flycatcher do completely different things to the same number — so the effect is stated as one
 * sentence rather than left to be inferred from three labels.
 */
function setupNote(): string {
  const fuel = fuelById(state.fuel);
  const ups = [upgradeById(state.upgrades[0]), upgradeById(state.upgrades[1])];
  const speed = fuel.speed + ups.reduce((s, u) => s + u.speed, 0);
  const multiplier = fuel.multiplier * ups.reduce((m, u) => m * u.output, 1);

  const parts: string[] = [];
  if (speed > 0) parts.push(`<strong>+${Math.round(speed * 100)}%</strong> speed`);
  if (multiplier !== 1) parts.push(`<strong>×${multiplier}</strong> drops`);
  if (parts.length === 0) parts.push("no boost at all");

  const upkeep =
    fuel.hours !== null
      ? ` ${escapeHtml(fuel.name)} runs out after <strong>${fuel.hours}h</strong>, so a grind longer than that means refilling.`
      : "";

  return (
    `This setup is ${parts.join(" and ")}. Speed shortens the timer — the game divides by it rather ` +
    `than subtracting, so +100% is half the time and not none. A ×N fuel leaves the timer alone and ` +
    `duplicates the drop instead, which is why the two are never added together.${upkeep}`
  );
}

function render(): void {
  if (!host) return;

  const fuels = tables.modifiers.fuels
    .map((f) => {
      const label = f.speed > 0 ? `${f.name} (+${Math.round(f.speed * 100)}%)` : f.multiplier > 1 ? `${f.name} (×${f.multiplier})` : f.name;
      return `<option value="${escapeHtml(f.id)}"${state.fuel === f.id ? " selected" : ""}${
        f.note ? ` title="${escapeHtml(f.note)}"` : ""
      }>${escapeHtml(label)}</option>`;
    })
    .join("");

  const upgradeOptions = (at: 0 | 1) =>
    tables.modifiers.upgrades
      .map((u) => {
        const bits = [u.speed > 0 ? `+${Math.round(u.speed * 100)}%` : "", u.output !== 1 ? `×${u.output} output` : ""].filter(Boolean);
        const label = bits.length ? `${u.name} (${bits.join(", ")})` : u.name;
        return `<option value="${escapeHtml(u.id)}"${state.upgrades[at] === u.id ? " selected" : ""}${
          u.note ? ` title="${escapeHtml(u.note)}"` : ""
        }>${escapeHtml(label)}</option>`;
      })
      .join("");

  const tierOptions = Array.from({ length: 12 }, (_, i) => i + 1)
    .map((t) => `<option value="${t}"${state.assumeTier === t ? " selected" : ""}>Tier ${t}</option>`)
    .join("");

  host.innerHTML = `
    <div class="meta">${profileNote()}</div>

    <div class="panel pad controls">
      <div class="row">
        <label title="How many of the one minion you intend to put down. A profile starts with five slots and they are shared across the co-op.">Minions
          <input id="mncount" value="${escapeHtml(state.count)}" inputmode="numeric" autocomplete="off" style="width:70px">
        </label>

        <span class="tabs">
          <button class="chip${state.useOwned ? " on" : ""}" data-mnowned="1"
            title="Use the best tier of each minion your profile shows you have crafted. Where you have none, the tier beside this is assumed instead.">Tier I own</button>
          <button class="chip${!state.useOwned ? " on" : ""}" data-mnowned="0"
            title="Plan for a tier you intend to build. A minion that stops below it is capped at its own maximum rather than dropped.">Assume a tier</button>
        </span>
        <label title="The tier to assume. Used everywhere in 'assume' mode, and as the fallback in 'tier I own' for minions you have not crafted.">
          <select id="mntier">${tierOptions}</select>
        </label>

        <span class="tabs">
          <button class="chip${!state.maxOut ? " on" : ""}" data-mngoal="next" title="Time to the next tier of each collection.">Next tier</button>
          <button class="chip${state.maxOut ? " on" : ""}" data-mngoal="max" title="Time to the last tier — the whole collection, from where you are now.">Max it out</button>
        </span>
      </div>

      <div class="row">
        <label title="One fuel slot. Percentage fuels speed the minion up; ×N fuels duplicate the drop instead.">Fuel
          <select id="mnfuel">${fuels}</select>
        </label>
        <label title="First of the two upgrade slots.">Upgrade 1
          <select id="mnup0">${upgradeOptions(0)}</select>
        </label>
        <label title="Second upgrade slot.">Upgrade 2
          <select id="mnup1">${upgradeOptions(1)}</select>
        </label>
        <label>Search <input id="mnsearch" value="${escapeHtml(state.search)}" placeholder="e.g. clay" autocomplete="off"></label>
      </div>

      <p class="sub dim">${setupNote()}</p>
      <p class="sub dim">The other two slots are a skin, which does nothing, and whatever keeps the minion
        from filling up — a hopper or a Super Compactor. Neither changes how much is collected, so neither
        is asked about here: compacting 160 cobblestone into an enchanted one still counts as 160.</p>
    </div>

    <div id="mntable"></div>
  `;

  renderTable();
}

/**
 * Whether these figures know anything about you.
 *
 * Said at the top rather than in a footnote, because it is the difference between "the fastest
 * collection to finish" and "the fastest collection to start", and the two lists are nothing alike.
 */
function profileNote(): string {
  if (state.collected.size === 0) {
    return `<span class="gold">No profile loaded</span> <span class="dim">— every collection is counted from zero, so this
      ranks minions by raw speed rather than by what you have left. Load a profile on the XP Planner tab and this
      tab picks it up: the distances become yours, and the tier toggle can use the minions you actually own.</span>`;
  }
  return `<strong>${escapeHtml(state.profileName ?? "Profile")}</strong> <span class="dim">— ${num(
    state.collected.size,
  )} collections read${state.ownedTier.size ? `, ${num(state.ownedTier.size)} minions crafted` : ", no crafted minions found"}.</span>`;
}

const COLUMNS: { id: string; label: string; title: string; value: (r: MinionPlan) => number; render: (r: MinionPlan) => string }[] = [
  {
    id: "hours",
    label: "Time",
    title: "How long these minions take to cover what the collection still needs, running unattended.",
    value: (r) => r.hours,
    render: (r) => hours(r.hours),
  },
  {
    id: "xp",
    label: "XP",
    title: "SkyBlock XP for the tier this finishes. In 'max it out' mode, every tier still open.",
    value: (r) => r.xp,
    render: (r) => num(r.xp),
  },
  {
    id: "xpPerHour",
    label: "XP/hr",
    title:
      "What the wait actually pays, and the ranking figure. Sorting on time alone picks whatever tier is nearly " +
      "done regardless of what it is worth — a 4 XP tier that lands in an hour is not obviously better than a " +
      "60 XP one that lands in six.",
    value: (r) => r.xpPerHour,
    render: (r) => (r.xpPerHour >= 1 ? r.xpPerHour.toFixed(1) : r.xpPerHour.toFixed(3)),
  },
  {
    id: "needed",
    label: "Still needs",
    title: "How many more of the item the collection wants. Collections are cumulative, so this is the distance from where you are, not the tier's own threshold.",
    value: (r) => r.needed,
    render: (r) => num(Math.ceil(r.needed)),
  },
  {
    id: "itemsPerHour",
    label: "Items/hr",
    title: "What the whole setup produces an hour — the minion count, tier, fuel and upgrades all together.",
    value: (r) => r.itemsPerHour,
    render: (r) => num(Math.round(r.itemsPerHour)),
  },
  {
    id: "tier",
    label: "Tier",
    title: "The tier used for this row. A dot means it came from your profile rather than from the assumption.",
    value: (r) => r.tier,
    render: (r) => `${r.tier}${r.owned ? `<span class="dim" title="You have crafted this tier.">·</span>` : ""}`,
  },
];

function renderTable(): void {
  const target = document.getElementById("mntable");
  if (!target) return;

  const all = rows();
  if (all.length === 0) {
    return void (target.innerHTML = `<p class="dim pad">No minion feeds a collection you have not already finished.</p>`);
  }

  const head = COLUMNS.map((c) => `<th class="num" title="${escapeHtml(c.title)}">${escapeHtml(c.label)}</th>`).join("");

  const body = all
    .slice(0, 80)
    .map((r) => {
      const cells = COLUMNS.map((c) => `<td class="num">${c.render(r)}</td>`).join("");
      const icon = `<img class="bz-icon" src="https://sky.coflnet.com/static/icon/${encodeURIComponent(
        r.generator,
      )}_GENERATOR_${r.tier}" alt="" width="20" height="20" loading="lazy" decoding="async">`;
      const range = r.dropRange
        ? ` <span class="dim" title="The wiki quotes this as a range, so the rate uses the midpoint.">${r.dropRange.low}–${r.dropRange.high} a drop</span>`
        : "";
      const goal = r.targetTier === null ? "" : ` <span class="dim">→ tier ${r.targetTier}</span>`;
      return `<tr>
        <td>${icon}${escapeHtml(r.family)}
          <div class="dim bz-path">${escapeHtml(r.collectionName)}${goal}${range}</div>
        </td>${cells}
      </tr>`;
    })
    .join("");

  target.innerHTML = `
    <p class="dim pad">${escapeHtml(NOTE)}</p>
    <div class="panel scroll">
      <table class="bz">
        <thead><tr><th>Minion</th>${head}</tr></thead>
        <tbody>${body}</tbody>
      </table>
    </div>
    <p class="dim pad">${num(all.length)} minions${all.length > 80 ? ", showing the first 80" : ""} · ${
      state.maxOut ? "to the last tier" : "to the next tier"
    } · ${escapeHtml(state.count)} placed</p>
  `;
}

const NOTE =
  "Which minion fills a collection fastest, ranked on what the wait pays rather than on the wait alone. " +
  "A minion drops on every other action, not every action — a 14-second Cobblestone Minion I is one " +
  "cobblestone every 28 seconds — so every rate here is half what a cooldown alone would suggest. " +
  "Rates assume the minion never fills up and never stops, which is what a Super Compactor and a full " +
  "fuel slot are for.";

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
