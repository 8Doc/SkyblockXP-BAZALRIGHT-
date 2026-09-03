import { coins, num } from "../lib/format";
import type { Fuel, MinionData, MinionProduction, Modifiers, Upgrade } from "../lib/minions";
import type { DropTable, Recipe } from "../lib/minionProfit";
import {
  bestPerSkill,
  planMinionXp,
  petXpMultiplier,
  withWisdom,
  type MinionXpRow,
  type PetXpRules,
  type Player,
  type SkillKey,
  type SkillXpTables,
} from "../lib/minionXp";
import {
  absorbPetPage,
  createPetBinIndex,
  hoursToLevel,
  planPetProfit,
  type PetBinIndex,
  type PetLevelTable,
  type PetProfitRow,
} from "../lib/petLevelling";
import type { AuctionRecord } from "../lib/auctions";

/**
 * Minions as pet levelling, and pets as a trade.
 *
 * The tab is two halves of one loop. A minion produces Skill XP when you collect it, that Skill XP
 * levels whatever pet is out, and a levelled pet sells for more than an unlevelled one. So the
 * first half asks which minion generates the most Pet XP an hour for each skill, and the second
 * asks which pet is worth the most per point of that XP — and multiplied together they answer the
 * question underneath both: what is an hour of this setup worth in coins, through pets rather than
 * through selling the drops.
 *
 * That the loop exists at all is documented rather than deduced. The Minions page notes that a
 * co-op member away at collection time "will receive the Skill XP from them once they go to
 * Private Island", and immediately spells out the exploit people run on it — levelling the same
 * pet several times off one collection. The rates come from the Farming and Mining pages' own
 * "Minion XP" columns; see `minionXp.ts` for why that column cannot be derived from the one beside
 * it, and `pet_xp.json` for the multipliers and the two divisors that decide most of the ranking.
 *
 * **The divisors are the interesting part.** A pet earning XP outside its own skill keeps a third
 * of it; a pet earning Alchemy XP that is not an Alchemy pet keeps a twelfth. That second one
 * quietly retires the brewing route for most people, and Carpentry — which a minion feeds
 * generously through crafting — grants no Pet XP whatsoever. Naming the pet's skill is therefore
 * not a refinement of this tab, it is most of the answer.
 */

/* ---------------------------------------------------------------- tables */

type Tables = {
  production: MinionData;
  modifiers: Modifiers;
  drops: DropTable;
  recipes: Recipe[];
  names: Record<string, string>;
  skillXp: SkillXpTables;
  petXpRules: PetXpRules;
  petLevels: PetLevelTable;
};

/* ----------------------------------------------------------------- state */

type State = {
  wisdom: string;
  taming: string;
  petSkill: SkillKey | "ANY";
  tier: number;
  count: string;
  fuel: string;
  upgrades: [string, string];
  showRoutes: boolean;

  /** The pet half, which costs a full auction sweep and is therefore opt-in. */
  pets: PetBinIndex | null;
  scanning: boolean;
  scanned: number;
  scanTotal: number;
  scanError: string;
  /** Which pet the coins-an-hour figure is computed against, if any is chosen. */
  pairedWith: string | null;
};

const state: State = {
  wisdom: localStorage.getItem("sbxp:pxwisdom") ?? "0",
  taming: localStorage.getItem("sbxp:pxtaming") ?? "0",
  petSkill: (localStorage.getItem("sbxp:pxpetskill") as SkillKey | "ANY") ?? "ANY",
  tier: Number(localStorage.getItem("sbxp:pxtier") ?? 12),
  count: localStorage.getItem("sbxp:pxcount") ?? "5",
  fuel: localStorage.getItem("sbxp:pxfuel") ?? "NONE",
  upgrades: [localStorage.getItem("sbxp:pxup0") ?? "NONE", localStorage.getItem("sbxp:pxup1") ?? "NONE"],
  showRoutes: localStorage.getItem("sbxp:pxroutes") === "1",
  pets: null,
  scanning: false,
  scanned: 0,
  scanTotal: 0,
  scanError: "",
  pairedWith: localStorage.getItem("sbxp:pxpair"),
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

/* -------------------------------------------------------------- the pets */

const PET_CACHE_KEY = "sbxp:pxpets";
/** Ten minutes, matching the accessory sweep the planner already runs against the same endpoint. */
const PET_CACHE_MS = 10 * 60_000;

function readPetCache(): PetBinIndex | null {
  try {
    const raw = localStorage.getItem(PET_CACHE_KEY);
    if (!raw) return null;
    const entry = JSON.parse(raw) as { at: number; value: PetBinIndex };
    if (Date.now() - entry.at > PET_CACHE_MS) return null;
    return entry.value;
  } catch {
    return null;
  }
}

/**
 * Sweep the auction house for pet prices.
 *
 * Fifty-odd pages and about a hundred megabytes on the wire, which is why this is a button rather
 * than something the tab does on arrival. Only the two ends of each pet's ladder survive the pass
 * — cheapest at the bottom level anyone is selling, cheapest at max — so what gets cached is a few
 * kilobytes rather than the sweep itself.
 *
 * A pet's level is inside its display name and nowhere else in the payload, which is the entire
 * reason this cannot reuse the accessory index the planner already builds: that one throws the
 * level away, and a level 1 and a level 100 of the same pet are not the same purchase.
 */
async function scanPets(): Promise<void> {
  if (!tables || state.scanning) return;
  state.scanning = true;
  state.scanError = "";
  state.scanned = 0;
  state.scanTotal = 0;
  renderPets();

  try {
    const index = createPetBinIndex();
    const first = (await (await fetch("https://api.hypixel.net/v2/skyblock/auctions?page=0")).json()) as {
      totalPages: number;
      auctions: AuctionRecord[];
    };
    absorbPetPage(index, first.auctions, tables.petLevels);
    state.scanTotal = first.totalPages;
    state.scanned = 1;
    renderPets();

    const WIDTH = 6;
    const rest = Array.from({ length: first.totalPages - 1 }, (_, i) => i + 1);
    for (let i = 0; i < rest.length; i += WIDTH) {
      const pages = await Promise.all(
        rest.slice(i, i + WIDTH).map((page) =>
          fetch(`https://api.hypixel.net/v2/skyblock/auctions?page=${page}`)
            .then((r) => r.json() as Promise<{ auctions: AuctionRecord[] }>)
            .catch(() => ({ auctions: [] as AuctionRecord[] })),
        ),
      );
      for (const page of pages) absorbPetPage(index, page.auctions, tables.petLevels);
      state.scanned = Math.min(i + 1 + WIDTH, first.totalPages);
      renderPets();
    }

    state.pets = index;
    try {
      localStorage.setItem(PET_CACHE_KEY, JSON.stringify({ at: Date.now(), value: index }));
    } catch {
      // A sweep that cannot be cached is still a sweep. It just costs another one next time.
    }
  } catch (error) {
    state.scanError = error instanceof Error ? error.message : "the auction sweep failed";
  }

  state.scanning = false;
  renderPets();
}

/* ------------------------------------------------------------------ rows */

function fuelById(id: string): Fuel {
  return tables!.modifiers.fuels.find((f) => f.id === id) ?? tables!.modifiers.fuels[0];
}
function upgradeById(id: string): Upgrade {
  return tables!.modifiers.upgrades.find((u) => u.id === id) ?? tables!.modifiers.upgrades[0];
}

function player(): Player {
  return {
    wisdom: Math.max(0, Number(state.wisdom) || 0),
    taming: Math.max(0, Number(state.taming) || 0),
    petSkill: state.petSkill === "ANY" ? null : state.petSkill,
  };
}

function dropIdFor(minion: MinionProduction): string | null {
  const pinned = tables!.drops.overrides[minion.generator];
  if (pinned) return pinned.itemId;
  const byName = nameIndex();
  return byName.get(minion.collects.item.trim().toLowerCase()) ?? minion.collectionId;
}

let nameCache: Map<string, string> | null = null;
function nameIndex(): Map<string, string> {
  if (nameCache) return nameCache;
  const map = new Map<string, string>();
  for (const [id, name] of Object.entries(tables!.names)) {
    const key = name.toLowerCase();
    if (!map.has(key)) map.set(key, id);
  }
  nameCache = map;
  return map;
}

function xpRows(): MinionXpRow[] {
  if (!tables) return [];
  return planMinionXp({
    data: tables.production,
    tables: tables.skillXp,
    rules: tables.petXpRules,
    player: player(),
    setup: {
      tier: state.tier,
      fuel: fuelById(state.fuel),
      upgrades: [upgradeById(state.upgrades[0]), upgradeById(state.upgrades[1])],
      count: Math.max(1, Number(state.count.replace(/[^0-9]/g, "")) || 1),
    },
    dropIdFor,
    names: tables.names,
    recipes: tables.recipes,
  });
}

function petRows(): PetProfitRow[] {
  if (!tables || !state.pets) return [];
  return planPetProfit({ index: state.pets, levels: tables.petLevels, minProfit: 0 });
}

/* -------------------------------------------------------------- rendering */

export function mountMinionPet(container: HTMLElement, data: Tables): void {
  host = container;
  tables = data;
  nameCache = null;
  if (!state.pets) state.pets = readPetCache();

  if (boundTo !== container) {
    boundTo = container;

    container.addEventListener("click", (event) => {
      const target = event.target as HTMLElement;

      if (target.closest("#pxscan")) return void scanPets();

      const routes = target.closest<HTMLElement>("#pxroutes");
      if (routes) {
        state.showRoutes = !state.showRoutes;
        localStorage.setItem("sbxp:pxroutes", state.showRoutes ? "1" : "0");
        return render();
      }

      const pair = target.closest<HTMLElement>("[data-pxpair]");
      if (pair) {
        const key = pair.dataset.pxpair!;
        state.pairedWith = state.pairedWith === key ? null : key;
        if (state.pairedWith) localStorage.setItem("sbxp:pxpair", state.pairedWith);
        else localStorage.removeItem("sbxp:pxpair");
        return render();
      }
    });

    container.addEventListener("change", (event) => {
      const el = event.target as HTMLSelectElement;
      const map: Record<string, (v: string) => void> = {
        pxpetskill: (v) => ((state.petSkill = v as SkillKey | "ANY"), localStorage.setItem("sbxp:pxpetskill", v)),
        pxtier: (v) => ((state.tier = Number(v)), localStorage.setItem("sbxp:pxtier", v)),
        pxfuel: (v) => ((state.fuel = v), localStorage.setItem("sbxp:pxfuel", v)),
        pxup0: (v) => ((state.upgrades[0] = v), localStorage.setItem("sbxp:pxup0", v)),
        pxup1: (v) => ((state.upgrades[1] = v), localStorage.setItem("sbxp:pxup1", v)),
      };
      const apply = map[el.id];
      if (!apply) return;
      apply(el.value);
      render();
    });

    container.addEventListener("input", (event) => {
      const el = event.target as HTMLInputElement;
      if (el.id === "pxwisdom") {
        state.wisdom = el.value;
        localStorage.setItem("sbxp:pxwisdom", el.value);
      } else if (el.id === "pxtaming") {
        state.taming = el.value;
        localStorage.setItem("sbxp:pxtaming", el.value);
      } else if (el.id === "pxcount") {
        state.count = el.value;
        localStorage.setItem("sbxp:pxcount", el.value);
      } else return;
      // Repaint the results only: rebuilding the field being typed into would drop the caret.
      renderSkills();
      renderPets();
    });
  }

  render();
}

export function unmountMinionPet(): void {
  host = null;
}

const SKILLS: SkillKey[] = ["FARMING", "MINING", "FORAGING", "COMBAT", "FISHING", "ALCHEMY", "ENCHANTING", "TAMING", "CARPENTRY"];

function render(): void {
  if (!host || !tables) return;

  const tiers = Array.from({ length: 12 }, (_, i) => i + 1)
    .map((t) => `<option value="${t}"${state.tier === t ? " selected" : ""}>Tier ${t}</option>`)
    .join("");

  const petSkills = ["ANY", ...SKILLS]
    .map(
      (s) =>
        `<option value="${s}"${state.petSkill === s ? " selected" : ""}>${
          s === "ANY" ? "whatever matches (best case)" : title(s)
        }</option>`,
    )
    .join("");

  host.innerHTML = `
    <div class="panel pad controls">
      <div class="row">
        <label title="Your Wisdom for the skill in question. Wisdom is additive and applies first: the Skill XP itself is multiplied by 1 + Wisdom/100, and everything else scales the Pet XP that becomes.">Wisdom
          <input id="pxwisdom" value="${escapeHtml(state.wisdom)}" inputmode="numeric" autocomplete="off">
        </label>
        <label title="Your Taming level, 0 to 60. Each level is one level of Zoologist, which is +1% Pet XP — so Taming 60 is a flat x1.60 on everything below.">Taming level
          <input id="pxtaming" value="${escapeHtml(state.taming)}" inputmode="numeric" autocomplete="off">
        </label>
        <label title="The skill the pet you are levelling belongs to. A pet earning XP outside its own skill keeps a third of it; outside its own skill AND in Alchemy or Enchanting, a twelfth. Leaving this on 'whatever matches' answers the best case rather than your case.">Pet's skill
          <select id="pxpetskill">${petSkills}</select>
        </label>
      </div>

      <div class="row">
        <label title="How many of the one minion are placed.">Minions
          <input id="pxcount" value="${escapeHtml(state.count)}" inputmode="numeric" autocomplete="off">
        </label>
        <label>Tier <select id="pxtier">${tiers}</select></label>
        <label>Fuel <select id="pxfuel">${optionList(tables.modifiers.fuels, state.fuel)}</select></label>
        <label>Upgrade 1 <select id="pxup0">${optionList(tables.modifiers.upgrades, state.upgrades[0])}</select></label>
        <label>Upgrade 2 <select id="pxup1">${optionList(tables.modifiers.upgrades, state.upgrades[1])}</select></label>
      </div>

      <p class="sub dim">${chainNote()}</p>
    </div>

    <div id="pxskills"></div>
    <div id="pxpets"></div>
  `;

  renderSkills();
  renderPets();
}

function optionList(list: { id: string; name: string }[], selected: string): string {
  return list
    .map((i) => `<option value="${escapeHtml(i.id)}"${selected === i.id ? " selected" : ""}>${escapeHtml(i.name)}</option>`)
    .join("");
}

/** The chain, spelled out with this player's own numbers in it. */
function chainNote(): string {
  if (!tables) return "";
  const p = player();
  const example = withWisdom(100, p.wisdom);
  const matched = petXpMultiplier("FARMING", { ...p, petSkill: "FARMING" }, tables.petXpRules);
  const mismatched = petXpMultiplier("FARMING", { ...p, petSkill: "COMBAT" }, tables.petXpRules);

  return (
    `Collecting a minion grants Skill XP, and a pet that is out levels off it. With <strong>${escapeHtml(
      String(p.wisdom),
    )}</strong> Wisdom, 100 raw Skill XP becomes <strong>${example.toFixed(0)}</strong>; at Taming ` +
    `<strong>${escapeHtml(String(p.taming))}</strong> that reaches a matching pet as <strong>${(example * matched).toFixed(
      0,
    )}</strong> Pet XP and a pet of another skill as <strong>${(example * mismatched).toFixed(0)}</strong>. ` +
    `The Farming and Mining pages are the only ones that publish a per-item minion rate, so every other minion here ` +
    `says "not published" rather than claiming a zero.`
  );
}

/* --------------------------------------------------------- the skill half */

function renderSkills(): void {
  const target = document.getElementById("pxskills");
  if (!target || !tables) return;

  const all = xpRows();
  // Both routes compete for the card. Alchemy is only ever reached by brewing, so filtering to
  // the direct route would report "not published" for a skill that has a perfectly real answer —
  // it just happens to involve a brewing stand, which is what the row then says.
  const best = bestPerSkill(all);
  const paired = state.pairedWith ? petRows().find((r) => `${r.key}:${r.rarity}` === state.pairedWith) : undefined;

  const cards = SKILLS.map((skill) => {
    const row = best.get(skill) ?? null;
    const known = row && row.petXpPerHour > 0;
    const noPet = tables!.petXpRules.noPetXp.includes(skill);

    const value = known
      ? `${num(Math.round(row!.petXpPerHour))}<span class="stat-sub"> pet xp/hr</span>`
      : `<span class="dim">${noPet ? "no pet xp" : "not published"}</span>`;

    const sub = known
      ? `${row!.family}${row!.route === "brewing" ? ", brewed" : ""} · ${num(Math.round(row!.skillXpPerHour))} skill xp/hr`
      : noPet
        ? "this skill grants no pet XP at all"
        : "no minion rate on the wiki for this skill";

    const earns =
      known && paired
        ? `<div class="stat-sub">${coins(Math.round(row!.petXpPerHour * paired.coinsPerXp))}/hr levelling ${escapeHtml(
            paired.name,
          )}</div>`
        : "";

    return `<div class="stat">
      <div class="stat-label">${escapeHtml(title(skill))}</div>
      <div class="stat-value${known ? " gold" : ""}">${value}</div>
      <div class="stat-sub">${escapeHtml(sub)}</div>
      ${earns}
    </div>`;
  }).join("");

  const routes = state.showRoutes ? routesTable(all) : "";

  target.innerHTML = `
    <h3 class="gh-h">Best minion for XP, by skill</h3>
    <p class="dim pad">${SKILL_NOTE}</p>
    <div class="stats" style="grid-template-columns: repeat(3, 1fr)">${cards}</div>
    <div class="tabs" style="margin-top:12px">
      <button class="chip${state.showRoutes ? " on" : ""}" id="pxroutes" title="Every minion and every route it has into a skill, including the brewing one, rather than only the winner per skill.">Show every route</button>
    </div>
    ${routes}
  `;
}

const SKILL_NOTE =
  "Which minion generates the most Pet XP an hour, per skill, at the setup above. Pet XP is Skill XP after " +
  "Wisdom, after Taming, and after the divisor the pet's own skill imposes — a third for any mismatch, a twelfth " +
  "for Alchemy or Enchanting reaching a pet that is not one. Carpentry is on the list and grants no Pet XP at " +
  "all, which is worth seeing rather than being left off.";

function routesTable(all: MinionXpRow[]): string {
  const shown = all.filter((r) => r.petXpPerHour > 0 || r.skillXpPerHour > 0).slice(0, 60);
  if (shown.length === 0) return `<p class="dim pad">No minion has a published XP rate at this setup.</p>`;

  const body = shown
    .map(
      (r) => `<tr>
        <td>${escapeHtml(r.family)}<div class="dim bz-path">${escapeHtml(r.itemName)}${
          r.route === "brewing" ? " · brewed" : ""
        }</div></td>
        <td>${escapeHtml(title(r.skill))}</td>
        <td class="num">${r.xpPerItem >= 1 ? r.xpPerItem.toFixed(1) : r.xpPerItem.toFixed(3)}</td>
        <td class="num">${num(Math.round(r.skillXpPerHour))}</td>
        <td class="num">${num(Math.round(r.petXpPerHour))}</td>
      </tr>`,
    )
    .join("");

  return `<div class="panel scroll" style="margin-top:8px">
    <table class="bz">
      <thead><tr>
        <th>Minion</th><th>Skill</th>
        <th class="num" title="Skill XP one drop is worth on this route. For a brewing row this is the brew's yield divided by the drops one brewing ingredient costs — Enchanted Sugar Cane is 25,600 sugar cane, so its 15,000 XP is well under one XP a drop.">XP/item</th>
        <th class="num">Skill xp/hr</th>
        <th class="num">Pet xp/hr</th>
      </tr></thead>
      <tbody>${body}</tbody>
    </table>
  </div>`;
}

/* ----------------------------------------------------------- the pet half */

function renderPets(): void {
  const target = document.getElementById("pxpets");
  if (!target || !tables) return;

  if (state.scanning) {
    const pct = state.scanTotal ? Math.round((state.scanned / state.scanTotal) * 100) : 0;
    target.innerHTML = `<h3 class="gh-h">Best pet to level</h3>
      <div class="busy">Sweeping the auction house — page ${num(state.scanned)} of ${num(state.scanTotal || 1)} (${pct}%)</div>`;
    return;
  }

  if (!state.pets) {
    target.innerHTML = `<h3 class="gh-h">Best pet to level</h3>
      <p class="dim pad">${PET_NOTE}</p>
      ${state.scanError ? `<div class="error">${escapeHtml(state.scanError)}</div>` : ""}
      <div class="tabs"><button class="chip" id="pxscan">Read the auction house</button></div>`;
    return;
  }

  const all = petRows();
  if (all.length === 0) {
    target.innerHTML = `<h3 class="gh-h">Best pet to level</h3>
      <p class="dim pad">The sweep found no pet listed at both ends of its ladder. That happens: the auction house is
      a snapshot rather than a catalogue, and a pet needs somebody selling it at level 1 <em>and</em> somebody selling
      it maxed before there is a trade to price.</p>
      <div class="tabs"><button class="chip" id="pxscan">Read the auction house again</button></div>`;
    return;
  }

  // The best route of any kind, whatever skill it belongs to — the rate the "at best rate" column
  // runs at. It is the ceiling rather than a plan: the pet being levelled has to be one the winning
  // skill actually feeds, which the cards above are where you check.
  const bestRate = Math.max(0, ...xpRows().map((r) => r.petXpPerHour));

  const body = all
    .slice(0, 40)
    .map((r) => {
      const key = `${r.key}:${r.rarity}`;
      const on = state.pairedWith === key;
      const wait = bestRate > 0 ? hoursToLevel(bestRate, r) : Infinity;
      return `<tr class="bz-open${on ? " gold" : ""}" data-pxpair="${escapeHtml(key)}" title="Pair this pet with the skill cards above to see what an hour of each minion is worth in coins.">
        <td>${escapeHtml(r.name)}<div class="dim bz-path">${escapeHtml(title(r.rarity))}${
          r.approximate ? ` · cheapest copy is level ${r.buy.level}` : ""
        }</div></td>
        <td class="num">${coins(r.buy.price)}</td>
        <td class="num">${coins(r.sell.price)}</td>
        <td class="num">${coins(Math.round(r.profit))}</td>
        <td class="num">${num(Math.round(r.xpNeeded))}</td>
        <td class="num">${r.coinsPerXp.toFixed(2)}</td>
        <td class="num">${Number.isFinite(wait) ? hoursLabel(wait) : `<span class="dim">—</span>`}</td>
      </tr>`;
    })
    .join("");

  const scanned = new Date(state.pets.scannedAt).toLocaleTimeString();

  target.innerHTML = `
    <h3 class="gh-h">Best pet to level</h3>
    <p class="dim pad">${PET_NOTE}</p>
    ${rateReality(bestRate, all[0])}
    <div class="panel scroll">
      <table class="bz">
        <thead><tr>
          <th>Pet</th>
          <th class="num" title="Cheapest BIN at the lowest level anyone is selling — usually 1.">Buy at</th>
          <th class="num" title="Cheapest BIN at max level. This is what you would have to undercut, not what you are promised.">Sell at</th>
          <th class="num" title="The sale less the auction house's 1% cut, less what the pet cost.">Profit</th>
          <th class="num" title="Pet XP between the two ends, from the published per-rarity totals.">Pet XP</th>
          <th class="num" title="Profit per point of Pet XP. The figure that makes a Rabbit comparable to a Golden Dragon, and the one the minion half of this tab multiplies into coins an hour.">Coins/xp</th>
          <th class="num" title="How long the best minion route above would take to generate that XP.">At best rate</th>
        </tr></thead>
        <tbody>${body}</tbody>
      </table>
    </div>
    <p class="dim pad">${num(all.length)} pets priced at both ends${all.length > 40 ? ", showing the first 40" : ""} ·
      ${num(state.pets.listings)} pet listings read from ${num(state.pets.pages)} pages at ${escapeHtml(scanned)} ·
      click a row to pair it with the skill cards above</p>
    <div class="tabs"><button class="chip" id="pxscan">Read the auction house again</button></div>
  `;
}

const PET_NOTE =
  "Buy a pet cheap, level it, sell it dear — ranked on coins per point of Pet XP rather than on the margin, " +
  "because the margin alone always picks the Golden Dragon and the Dragon needs 210 million Pet XP to earn it. " +
  "Both ends are the cheapest listing right now: the buy side is a price you can pay, the sell side is a price " +
  "you would have to undercut. Reading the whole auction house is about a hundred megabytes, so it happens on " +
  "the button rather than on arrival, and the result is cached for ten minutes.";

/**
 * What the two halves multiplied together actually come to, said out loud.
 *
 * This is the least flattering number on the page and the most useful one. The published minion XP
 * rates are small — a tenth of a point an item, mostly — so even the best minion setup measures its
 * pet levelling in months rather than evenings, and a tab that showed a coins-per-hour figure
 * without that context would read as a recommendation. It is not one: minions are a background
 * trickle of Pet XP that costs nothing to run, not a way to level a pet on purpose. Saying so here
 * is cheaper than letting someone work it out after building the island.
 */
function rateReality(bestRate: number, best: PetProfitRow | undefined): string {
  if (!(bestRate > 0) || !best) return "";
  const perHour = bestRate * best.coinsPerXp;
  return `<div class="warn">At the best minion rate above — <strong>${num(Math.round(bestRate))}</strong> pet XP an hour —
    the top row here is worth about <strong>${coins(Math.round(perHour))}</strong> an hour, and one pet takes
    <strong>${hoursLabel(hoursToLevel(bestRate, best))}</strong>. Minion XP is a trickle: the published rates are
    fractions of a point an item, so this is a thing that happens in the background of an island you built for other
    reasons, not a way to level a pet on purpose. The Raw profits tab is where a minion pays properly.</div>`;
}

function hoursLabel(h: number): string {
  if (h < 48) return `${h.toFixed(0)} hr`;
  const days = h / 24;
  if (days < 60) return `${days.toFixed(1)} days`;
  return `${(days / 30.44).toFixed(1)} months`;
}

function title(key: string): string {
  return key.charAt(0) + key.slice(1).toLowerCase();
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
