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
import { bestPerMinion, planPetPairs, type PetPlanRow } from "../lib/petPlan";
import { planProfit, type ExtrasTable, type ItemPrices, type StorageTables } from "../lib/minionProfit";
import { normalise } from "../lib/bazaar";
import type { RawBazaarProduct } from "../lib/bazaarTypes";

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
  extras: ExtrasTable;
  recipes: Recipe[];
  names: Record<string, string>;
  npcPrices: Record<string, { sell?: number; buy?: number }>;
  storage: StorageTables;
  skillXp: SkillXpTables;
  petXpRules: PetXpRules;
  petLevels: PetLevelTable;
  /** Which skill each pet levels off — the field the whole pairing turns on. */
  petCatalogue: { key: string; name: string; skill: SkillKey | null }[];
};

/* ----------------------------------------------------------------- state */

type State = {
  /** Wisdom per skill, as typed. Keyed by SkillKey; missing reads as zero. */
  wisdom: Record<string, string>;
  taming: string;
  petSkill: SkillKey | "ANY";
  tier: number;
  count: string;
  fuel: string;
  upgrades: [string, string];
  showRoutes: boolean;
  /** Brews a day worth recommending. The chore ceiling, not an economic one. */
  maxBrews: string;
  /** How long a pet may take before the pairing stops counting as a plan. */
  horizon: string;
  /** Which routes the plan is allowed to use. */
  routes: "all" | "collect" | "brew";
  /** Hide pairings that make less than simply selling the output. */
  hideLosers: boolean;
  /** A live bazaar read, so the plan can price what the minion sells alongside the pet. */
  market: Map<string, ReturnType<typeof normalise>>;

  /** The pet half, which costs a full auction sweep and is therefore opt-in. */
  pets: PetBinIndex | null;
  scanning: boolean;
  scanned: number;
  scanTotal: number;
  scanError: string;
  /** Which pet the coins-an-hour figure is computed against, if any is chosen. */
  pairedWith: string | null;
  /** Which plan row is opened out. */
  openPlan: string | null;
};

const state: State = {
  wisdom: readWisdom(),
  taming: localStorage.getItem("sbxp:pxtaming") ?? "0",
  petSkill: (localStorage.getItem("sbxp:pxpetskill") as SkillKey | "ANY") ?? "ANY",
  tier: Number(localStorage.getItem("sbxp:pxtier") ?? 12),
  count: localStorage.getItem("sbxp:pxcount") ?? "5",
  fuel: localStorage.getItem("sbxp:pxfuel") ?? "NONE",
  upgrades: [localStorage.getItem("sbxp:pxup0") ?? "NONE", localStorage.getItem("sbxp:pxup1") ?? "NONE"],
  showRoutes: localStorage.getItem("sbxp:pxroutes") === "1",
  maxBrews: localStorage.getItem("sbxp:pxbrews") ?? "100",
  horizon: localStorage.getItem("sbxp:pxhorizon") ?? "365",
  routes: (localStorage.getItem("sbxp:pxroutefilter") as State["routes"]) ?? "all",
  hideLosers: localStorage.getItem("sbxp:pxhideloss") === "1",
  market: new Map(),
  pets: null,
  scanning: false,
  scanned: 0,
  scanTotal: 0,
  scanError: "",
  pairedWith: localStorage.getItem("sbxp:pxpair"),
  openPlan: null,
};

/**
 * The saved Wisdom figures, one per skill.
 *
 * Migrates the single number this tab used to keep: an account that had typed 40 into the old box
 * meant "40 for whatever I am doing", so it is copied across every skill rather than dropped. Wrong
 * in detail and much closer than zero, and one edit puts it right.
 */
function readWisdom(): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    const saved = localStorage.getItem("sbxp:pxwisdomby");
    if (saved) return JSON.parse(saved) as Record<string, string>;
    const old = localStorage.getItem("sbxp:pxwisdom");
    if (old && old !== "0") for (const skill of WISDOM_SKILLS) out[skill] = old;
  } catch {
    // A corrupt entry is not worth a broken tab; zero is a fine place to start from.
  }
  return out;
}

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
  renderPlan();
}

/* ----------------------------------------------------------- the bazaar */

/**
 * A price read, so the plan can count what the minion sells as well as what the pet earns.
 *
 * The skill half of this tab needs no prices at all and did not have any. The plan does: a
 * Revenant Minion levelling a Golden Dragon makes most of its money selling rotten flesh, and a
 * planner that counted only the pet margin would describe half the strategy and call it the
 * answer. One read on mount, refreshed with the tab, no poll — nothing here moves fast enough to
 * need twenty-second updates and the profits tab next door is already doing that job.
 */
async function readBazaar(): Promise<void> {
  try {
    const response = await fetch("https://api.hypixel.net/v2/skyblock/bazaar");
    if (!response.ok) return;
    const body = (await response.json()) as { lastUpdated?: number; products: Record<string, RawBazaarProduct> };
    const market = new Map<string, ReturnType<typeof normalise>>();
    for (const [id, raw] of Object.entries(body.products)) {
      const snapshot = normalise(id, raw, body.lastUpdated ?? Date.now());
      if (snapshot) market.set(id, snapshot);
    }
    state.market = market;
    renderPlan();
  } catch {
    // No prices is a plan without its item half, which the section says rather than hides.
  }
}

function priceBook(): Map<string, ItemPrices> {
  const book = new Map<string, ItemPrices>();
  if (!tables) return book;
  const ids = new Set<string>(Object.keys(tables.npcPrices));
  for (const [id] of state.market) ids.add(id);
  for (const id of ids) {
    const product = state.market.get(id);
    book.set(id, {
      instasell: product && product.instasell > 0 ? product.instasell : null,
      instabuy: product && product.instabuy > 0 ? product.instabuy : null,
      npcSell: tables.npcPrices[id]?.sell ?? null,
    });
  }
  return book;
}

/* ------------------------------------------------------------------ rows */

function fuelById(id: string): Fuel {
  return tables!.modifiers.fuels.find((f) => f.id === id) ?? tables!.modifiers.fuels[0];
}
function upgradeById(id: string): Upgrade {
  return tables!.modifiers.upgrades.find((u) => u.id === id) ?? tables!.modifiers.upgrades[0];
}

function player(): Player {
  const wisdom: Partial<Record<SkillKey, number>> = {};
  for (const skill of WISDOM_SKILLS) wisdom[skill] = Math.max(0, Number(state.wisdom[skill]) || 0);
  return {
    wisdom,
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

      if (target.closest("#pxhideloss")) {
        state.hideLosers = !state.hideLosers;
        localStorage.setItem("sbxp:pxhideloss", state.hideLosers ? "1" : "0");
        return renderPlan();
      }

      const route = target.closest<HTMLElement>("[data-pxroute]");
      if (route) {
        state.routes = route.dataset.pxroute as State["routes"];
        localStorage.setItem("sbxp:pxroutefilter", state.routes);
        return renderPlan();
      }

      const planRow = target.closest<HTMLElement>("[data-pxplanopen]");
      if (planRow) {
        const key = planRow.dataset.pxplanopen!;
        state.openPlan = state.openPlan === key ? null : key;
        return renderPlan();
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
      const wisdomSkill = el.dataset?.pxwisdom;
      if (wisdomSkill) {
        state.wisdom[wisdomSkill] = el.value;
        localStorage.setItem("sbxp:pxwisdomby", JSON.stringify(state.wisdom));
        renderPlan();
        renderSkills();
        renderPets();
        return;
      }
      if (el.id === "pxtaming") {
        state.taming = el.value;
        localStorage.setItem("sbxp:pxtaming", el.value);
      } else if (el.id === "pxcount") {
        state.count = el.value;
        localStorage.setItem("sbxp:pxcount", el.value);
      } else if (el.id === "pxbrews") {
        state.maxBrews = el.value;
        localStorage.setItem("sbxp:pxbrews", el.value);
      } else if (el.id === "pxhorizon") {
        state.horizon = el.value;
        localStorage.setItem("sbxp:pxhorizon", el.value);
      } else return;
      // Repaint the results only: rebuilding the field being typed into would drop the caret.
      renderPlan();
      renderSkills();
      renderPets();
    });
  }

  render();
  if (state.market.size === 0) void readBazaar();
}

export function unmountMinionPet(): void {
  host = null;
}

/**
 * The skills a minion can actually reach.
 *
 * Enchanting, Taming and Carpentry are gone from this list deliberately. No minion produces
 * Enchanting XP by any route; Taming and Carpentry grant no Pet XP at all, so their cards were
 * three permanent zeroes taking up a third of the grid. The facts are still in `pet_xp.json` and
 * still enforced by `petXpMultiplier` — a Carpentry route would still come back worth nothing —
 * they are simply no longer given a tile that never changes.
 */
const SKILLS: SkillKey[] = ["FARMING", "MINING", "FORAGING", "COMBAT", "FISHING", "ALCHEMY"];

/** The skills a Wisdom box is offered for — the same six, since those are the ones a minion feeds. */
const WISDOM_SKILLS = SKILLS;

/**
 * Where each skill's Wisdom actually comes from, for the box's tooltip.
 *
 * Worth naming per skill because the sources are nothing alike, and because the totals are much
 * larger than people expect — a geared account runs well past a hundred, which doubles every XP
 * figure on this tab. Somebody typing 0 into all six because they have never heard of the stat is
 * the failure these tooltips exist to prevent.
 */
const WISDOM_HELP: Record<string, string> = {
  FARMING: "Mostly tools and equipment — a good hoe carries a lot of it — plus pets, accessories and a Booster Cookie.",
  MINING: "Pets and accessories, plus consumables. Smaller ceilings than Farming or Combat.",
  FORAGING: "Armour and equipment, plus pets and accessories. The smallest ceiling of the six.",
  COMBAT: "Has a permanent base from Slayer tiers and Essence Shop perks, on top of weapons, equipment, enchantments and attributes. The largest and most varied of the six.",
  FISHING: "Rods and their enchantments dominate — Expertise is multiplicative rather than additive — plus pets and accessories.",
  ALCHEMY: "A permanent base from Essence Shop perks, plus pets, accessories and consumables.",
};

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
        ${WISDOM_SKILLS.map(
          (skill) => `<label style="flex:1 1 120px" title="${escapeHtml(
            `${title(skill)} Wisdom. It multiplies ${title(skill)} XP by 1 + Wisdom/100 before anything else touches it. ${
              WISDOM_HELP[skill] ?? ""
            }`,
          )}">${escapeHtml(title(skill))} wisdom
            <input data-pxwisdom="${skill}" value="${escapeHtml(state.wisdom[skill] ?? "")}" placeholder="0" inputmode="decimal" autocomplete="off">
          </label>`,
        ).join("")}
      </div>

      <p class="sub dim">${WISDOM_NOTE}</p>

      <div class="row">
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
        <label title="Pairings where one pet would take longer than this are not plans and are left out. It matters more than it looks: the coins from selling the minion's output dwarf the pet margin, so without a horizon every minion picks whichever pet has the best coins-per-XP regardless of skill, and the table recommends a pet that finishes in twenty-three thousand days.">Pet must finish within (days)
          <input id="pxhorizon" value="${escapeHtml(state.horizon)}" inputmode="numeric" autocomplete="off">
        </label>
        <label title="The most brews a day worth recommending. Brewing is the one route here that is not a by-product of collecting a minion you were collecting anyway — it costs an evening at a brewing stand and it costs the drops, which is why both are charged. Set it to what you would actually sit through.">Brews a day, at most
          <input id="pxbrews" value="${escapeHtml(state.maxBrews)}" inputmode="numeric" autocomplete="off">
        </label>
      </div>

      <p class="sub dim">${chainNote()}</p>
    </div>

    <div id="pxplan"></div>
    <div id="pxskills"></div>
    <div id="pxpets"></div>
  `;

  renderPlan();
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
  // Farming is the worked example because it is the skill most readers arrive with a minion for.
  const farmingWisdom = p.wisdom.FARMING ?? 0;
  const example = withWisdom(100, farmingWisdom);
  const matched = petXpMultiplier("FARMING", { ...p, petSkill: "FARMING" }, tables.petXpRules);
  const mismatched = petXpMultiplier("FARMING", { ...p, petSkill: "COMBAT" }, tables.petXpRules);

  return (
    `Collecting a minion grants Skill XP, and a pet that is out levels off it. With <strong>${escapeHtml(
      String(farmingWisdom),
    )}</strong> Farming Wisdom, 100 raw Farming XP becomes <strong>${example.toFixed(0)}</strong>; at Taming ` +
    `<strong>${escapeHtml(String(p.taming))}</strong> that reaches a matching pet as <strong>${(example * matched).toFixed(
      0,
    )}</strong> Pet XP and a pet of another skill as <strong>${(example * mismatched).toFixed(0)}</strong>. ` +
    `The Farming and Mining pages are the only ones that publish a per-item minion rate, so every other minion here ` +
    `says "not published" rather than claiming a zero.`
  );
}

/* ----------------------------------------------------------- the plan */

/**
 * What the minion half and the pet half come to when they are multiplied together.
 *
 * Everything the two sections below say separately, said once as a plan: put this minion down, sit
 * that pet on it, make this many coins a day. The pairing is the part neither list can do on its
 * own — a pet keeps the full Skill XP of its own skill and a third of anything else, so the best
 * minion under the wrong pet loses to a worse minion under the right one.
 */
function planRows(over: { maxDaysPerPet?: number } = {}): PetPlanRow[] {
  if (!tables || !state.pets) return [];

  const prices = priceBook();
  const setup = {
    tier: state.tier,
    fuel: fuelById(state.fuel),
    upgrades: [upgradeById(state.upgrades[0]), upgradeById(state.upgrades[1])] as [Upgrade, Upgrade],
    count: Math.max(1, Number(state.count.replace(/[^0-9]/g, "")) || 1),
  };

  // What each minion earns selling its output, on the same setup the XP is computed for. Priced at
  // instasell with a long claim, because a minion being farmed for pet XP is one you are visiting
  // anyway — the storage cap is not the binding constraint on this tab.
  const profit = planProfit({
    data: tables.production,
    storage: tables.storage,
    drops: tables.drops,
    extras: tables.extras,
    recipes: tables.recipes,
    prices,
    variance: new Map(),
    names: tables.names,
    basis: "instasell",
    trust: "live",
    setup: {
      ...setup,
      chest: tables.storage.chests[0],
      hopper: tables.storage.hoppers[0],
      compactor: tables.storage.compactors.find((c) => c.id === "SUPER_COMPACTOR_3000") ?? tables.storage.compactors[0],
      claimHours: 24,
    },
  });

  const itemCoinsPerHour = new Map(profit.map((r) => [r.generator, r.netPerHour]));
  const dropValue = new Map(profit.map((r) => [r.generator, r.unitValue]));

  // The route filter is applied before pairing rather than after, so "collect only" genuinely
  // re-plans — each minion picks the best pet for the XP it makes by being collected, rather than
  // showing whatever was left over once the brewing rows were struck out.
  const allowed = xpRows().filter((r) =>
    state.routes === "all" ? true : state.routes === "brew" ? r.route === "brewing" : r.route === "direct",
  );

  const planned = bestPerMinion(
    planPetPairs({
      xpRows: allowed,
      pets: petRows(),
      catalogue: tables.petCatalogue,
      rules: tables.petXpRules,
      player: player(),
      itemCoinsPerHour,
      dropValue,
      maxBrewsPerDay: Math.max(0, Number(state.maxBrews) || 0),
      maxDaysPerPet: over.maxDaysPerPet ?? Math.max(1, Number(state.horizon) || 365),
      minProfitPerDay: 0,
    }),
  );
  return state.hideLosers ? planned.filter((r) => r.beatsSelling) : planned;
}

/**
 * The minions this section cannot plan, and why — because their absence is misleading.
 *
 * A wall of Revenant Minions levelling a Golden Dragon is one of the better-known coin setups in
 * the game, and it does not appear anywhere above. Not because it is bad: because nobody has
 * published a minion XP rate for Rotten Flesh. Only Farming and Mining have a Minion XP column,
 * and the item infoboxes fill in about forty more items; everything else is genuinely unmeasured.
 *
 * Left silent, that reads as a verdict on the strategy. Said out loud, it is a gap in the sources —
 * and the Raw profits tab still prices those minions perfectly well for what they sell, which is
 * where most of that setup's money comes from anyway.
 */
function unplannableNote(planned: PetPlanRow[]): string {
  if (!tables) return "";
  const have = new Set(planned.map((r) => r.generator));
  const rated = new Set(xpRows().filter((r) => r.baseSkillXpPerHour > 0).map((r) => r.generator));

  const missing = tables.production.minions
    .filter((m) => !have.has(m.generator) && !rated.has(m.generator))
    .map((m) => m.family.replace(/ Minion$/, ""));
  if (missing.length === 0) return "";

  const shown = missing.slice(0, 12).join(", ");
  return `<div class="warn"><strong>${num(missing.length)} minions cannot be planned here at all</strong>, because
    no minion XP rate has ever been published for what they drop: ${escapeHtml(shown)}${
      missing.length > 12 ? `, and ${num(missing.length - 12)} more` : ""
    }. That is a gap in the wiki rather than a verdict — the Revenant Minion is in that list, and a wall of them
    levelling a Golden Dragon is a well-known setup. What is missing is only the XP half; the
    <strong>Raw profits</strong> tab prices exactly what those minions sell, which is where most of that
    strategy's money comes from.</div>`;
}

function routeTabsHtml(): string {
  return `<div class="tabs">
    ${ROUTE_TABS.map(
      ([id, label, help]) =>
        `<button class="chip${state.routes === id ? " on" : ""}" data-pxroute="${id}" title="${escapeHtml(
          help,
        )}">${escapeHtml(label)}</button>`,
    ).join("")}
    <button class="chip${state.hideLosers ? " on" : ""}" id="pxhideloss"
      title="Hide any pairing that makes less than simply running the minion and selling everything. On the brewing routes that is most of them: a stand that eats more in drops than the pet is worth is a worse plan than no plan.">Hide the ones that lose</button>
  </div>`;
}

/**
 * Why the plan is empty, and which control to move.
 *
 * "No pairing comes out ahead" is true and useless. There are only a few reasons the table can be
 * empty and they call for different actions, so this re-runs the plan with the horizon lifted and
 * reports what the best pairing *would* have been — which turns a dead end into "raise this number
 * to 400, or pick a matching pet". Almost always the answer is the horizon, because minion XP is a
 * trickle and a pet is millions of XP.
 */
function emptyReason(): string {
  if (!tables || !state.pets) return "";
  const horizon = Math.max(1, Number(state.horizon) || 365);
  const unbounded = planRows({ maxDaysPerPet: Infinity });

  if (unbounded.length === 0) {
    return `<p class="dim pad">Nothing to plan here. Either no pet is listed at both ends of its ladder right
      now — the auction house is a snapshot, not a catalogue — or no minion on this route produces XP for a
      skill any listed pet levels off.</p>`;
  }

  const best = unbounded[0];
  return `<div class="warn">Every pairing is slower than the <strong>${num(horizon)}-day</strong> horizon, so
    none of them count as a plan. The quickest is the <strong>${escapeHtml(best.petName)}</strong> on a
    <strong>${escapeHtml(best.family)}</strong>, at <strong>${num(Math.round(best.daysPerPet))} days</strong> a pet${
      best.matched ? "" : ", and its skill does not even match"
    }. Raise the horizon to see it, or raise the tier and minion count to make it faster — this is minion XP
    being a trickle rather than anything being broken.</div>`;
}

function renderPlan(): void {
  const target = document.getElementById("pxplan");
  if (!target || !tables) return;

  if (!state.pets) {
    target.innerHTML = `<h3 class="gh-h">The plan</h3>
      <p class="dim pad">${PLAN_NOTE}</p>
      <div class="warn">This needs pet prices, which means reading the auction house — the button is in
        <strong>Best pet to level</strong> below. Everything else on this tab works without it.</div>`;
    return;
  }

  const rows = planRows();
  if (rows.length === 0) {
    target.innerHTML = `<h3 class="gh-h">The plan</h3>
      <p class="dim pad">${PLAN_NOTE}</p>
      ${routeTabsHtml()}
      ${emptyReason()}`;
    return;
  }

  const best = rows[0];
  const body = rows
    .slice(0, 25)
    .map((r) => {
      const brews = r.brewsPerDay > 0 ? `<div class="dim bz-path">${num(Math.round(r.brewsPerDay))} brews a day</div>` : "";
      // A pairing worth less than simply selling the output is greyed rather than dressed up. It is
      // still shown, because "this minion has no worthwhile pet plan" is an answer.
      const losing = r.beatsSelling ? "" : " task aside";
      return `<tr class="bz-open${losing}" data-pxplanopen="${escapeHtml(
        r.generator + ":" + r.petKey + ":" + r.petRarity,
      )}"${r.beatsSelling ? "" : ` title="${escapeHtml(
        `Selling everything this minion makes is ${Math.round(-r.advantagePerDay).toLocaleString("en-US")} coins a day better than this plan. The drops the brewing stand eats are worth more than the pet they level.`,
      )}"`}>
        <td>${escapeHtml(r.family)}<div class="dim bz-path">tier ${r.tier} · ${escapeHtml(title(r.skill))}${
          r.route === "brewing" ? " · brewed" : ""
        }</div></td>
        <td>${escapeHtml(r.petName)}<div class="dim bz-path">${escapeHtml(title(r.petRarity))}${
          r.matched ? "" : ` · <span class="gold">skill mismatch</span>`
        }</div>${brews}</td>
        <td class="num">${coins(Math.round(r.totalProfitPerDay))}</td>
        <td class="num${r.beatsSelling ? "" : " bleed on"}">${
          r.advantagePerDay >= 0 ? "+" : "−"
        }${coins(Math.abs(Math.round(r.advantagePerDay)))}</td>
        <td class="num">${coins(Math.round(r.petProfitPerDay))}</td>
        <td class="num">${coins(Math.round(r.itemProfitPerDay))}</td>
        <td class="num">${num(Math.round(r.petXpPerDay))}</td>
        <td class="num">${r.daysPerPet < 1 ? `${(r.daysPerPet * 24).toFixed(1)} hr` : `${r.daysPerPet.toFixed(1)} d`}</td>
      </tr>${
        state.openPlan === r.generator + ":" + r.petKey + ":" + r.petRarity
          ? `<tr class="mn-detail"><td colspan="8">${planDetail(r)}</td></tr>`
          : ""
      }`;
    })
    .join("");

  target.innerHTML = `
    <h3 class="gh-h">The plan</h3>
    <p class="dim pad">${PLAN_NOTE}</p>
    ${routeTabsHtml()}
    <div class="stats" style="grid-template-columns: repeat(3, 1fr)">
      <div class="stat">
        <div class="stat-label">Put down</div>
        <div class="stat-value gold">${escapeHtml(best.family)}</div>
        <div class="stat-sub">tier ${best.tier} · ${escapeHtml(title(best.skill))} · ${escapeHtml(state.count)} of them</div>
      </div>
      <div class="stat">
        <div class="stat-label">Level this pet</div>
        <div class="stat-value gold">${escapeHtml(best.petName)}</div>
        <div class="stat-sub">${escapeHtml(title(best.petRarity))} · one every ${
          best.daysPerPet < 1 ? `${(best.daysPerPet * 24).toFixed(1)} hours` : `${best.daysPerPet.toFixed(1)} days`
        }</div>
      </div>
      <div class="stat">
        <div class="stat-label">Profit a day</div>
        <div class="stat-value gold">${coins(Math.round(best.totalProfitPerDay))}</div>
        <div class="stat-sub">${coins(Math.round(best.petProfitPerDay))} pets · ${coins(
          Math.round(best.itemProfitPerDay),
        )} items</div>
      </div>
    </div>
    ${petShareNote(best)}
    <div class="panel scroll" style="margin-top:8px">
      <table class="bz">
        <thead><tr>
          <th>Minion</th><th>Pet</th>
          <th class="num" title="Everything this setup makes in a day: the pet margin plus whatever items were left to sell.">Profit/day</th>
          <th class="num" title="What the pet plan is worth OVER simply running the minion and selling the lot. This is what the plan is chosen on. Negative means the drops a brewing stand eats are worth more than the pet they level — the plan is worse than not having one.">vs selling</th>
          <th class="num" title="From buying the pet cheap, levelling it on this minion's XP, and selling it maxed.">Pets</th>
          <th class="num" title="From selling what the minion produced while it did it. For most real setups this is the larger half.">Items</th>
          <th class="num">Pet xp/day</th>
          <th class="num" title="How long one pet takes from the cheapest listing to max level.">Per pet</th>
        </tr></thead>
        <tbody>${body}</tbody>
      </table>
    </div>
    <p class="dim pad">Best pairing per minion, ${num(rows.length)} minions${
      rows.length > 25 ? ", showing the first 25" : ""
    } · click a row for the arithmetic</p>
    ${unplannableNote(rows)}
  `;
}

/**
 * Which half of the profit is actually doing the work, said out loud when it is lopsided.
 *
 * For almost every real setup the answer is "the items", by an order of magnitude — the published
 * minion XP rates are fractions of a point per drop, so a pet takes months. A section that printed
 * one profit figure without saying that would read as "level pets off minions for 1.3M a day",
 * which is not what the number means.
 */
function petShareNote(best: PetPlanRow): string {
  const share = best.totalProfitPerDay > 0 ? best.petProfitPerDay / best.totalProfitPerDay : 0;
  if (share >= 0.25) return "";
  return `<div class="warn">Almost all of this is the <strong>items</strong>, not the pet:
    ${coins(Math.round(best.itemProfitPerDay))} a day from selling what the minion makes against
    ${coins(Math.round(best.petProfitPerDay))} from the pet. Minion XP is a trickle — the published rates are
    fractions of a point a drop — so the pet is a slow bonus on top of a minion worth running anyway, not the
    reason to run it. Raising the tier or the minion count moves both halves; only a matching pet moves the
    pet half much.</div>`;
}

/** The row opened out: where each half of the day's profit came from. */
function planDetail(r: PetPlanRow): string {
  const lines = [
    `<div class="gh-sub"><strong>${num(Math.round(r.petXpPerDay))}</strong> pet XP a day ${
      r.matched
        ? `— the pet's own skill, so all of it counts.`
        : `— a ${escapeHtml(title(r.petRarity))} ${escapeHtml(r.petName)} is not a ${escapeHtml(
            title(r.skill),
          )} pet, so most of the XP is lost to the mismatch divisor.`
    }</div>`,
    `<div class="gh-sub">One pet needs its whole ladder, so this finishes <strong>${r.petsPerDay.toFixed(
      2,
    )}</strong> pets a day at ${coins(Math.round(r.petProfitPerDay / Math.max(r.petsPerDay, 1e-9)))} margin each.</div>`,
    `<div class="gh-sub">The minion goes on selling its output the whole time: <strong>${coins(
      Math.round(r.itemProfitPerDay),
    )}</strong> a day.</div>`,
  ];
  if (r.brewingCostPerDay > 0) {
    lines.push(
      `<div class="gh-sub">Brewing consumes <strong>${coins(
        Math.round(r.brewingCostPerDay),
      )}</strong> a day of drops. That is revenue not made rather than money lost, so the only question it
      raises is the next line.</div>`,
    );
  }
  lines.push(
    r.beatsSelling
      ? `<div class="gh-sub">Against simply running the minion and selling everything — ${coins(
          Math.round(r.sellOnlyPerDay),
        )} a day — this plan is <strong>${coins(Math.round(r.advantagePerDay))} better</strong>.</div>`
      : `<div class="gh-sub gold">Simply running the minion and selling everything makes ${coins(
          Math.round(r.sellOnlyPerDay),
        )} a day, which is <strong>${coins(
          Math.abs(Math.round(r.advantagePerDay)),
        )} more</strong> than this plan. Not worth doing.</div>`,
  );
  for (const c of r.caveats.slice(0, 6)) lines.push(`<div class="gh-sub dim">${escapeHtml(c)}</div>`);
  return lines.join("");
}

/**
 * Which routes the plan may use.
 *
 * Brewing wins on raw Pet XP by a wide margin and it wins for a reason worth seeing — an Alchemy
 * pet on a brewed route dodges the /12 that makes Alchemy XP nearly worthless to anything else.
 * But it is also the one route that is work rather than a by-product, so "collect only" is the
 * setting for a plan you can leave alone, and it is a different plan rather than the same table
 * with rows removed.
 */
const ROUTE_TABS: [State["routes"], string, string][] = [
  ["all", "All routes", "Every way a minion reaches a skill, brewing included."],
  [
    "collect",
    "Collect only",
    "No brewing stand. The XP that arrives simply by collecting a minion you were collecting anyway — " +
      "nothing to stand and do, and nothing given up to get it.",
  ],
  [
    "brew",
    "Brewing only",
    "Compact the drops into their enchanted form and brew them. Far more Pet XP per drop, at the cost of the " +
      "drops themselves and an evening at the stand — both of which are charged here.",
  ],
];

const WISDOM_NOTE =
  "Wisdom is per skill and the six are nothing like each other — an account deep in Slayers can be at 30 Combat " +
  "Wisdom and 0 Alchemy. It multiplies the Skill XP before anything else touches it, so it is the single input " +
  "here most worth getting right. <strong>These cannot be read from your profile.</strong> Wisdom comes from " +
  "equipped gear, enchantments, attributes, pets, accessories and whatever cookie or potion is running, and " +
  "Hypixel publishes the components rather than the total — computing it means reproducing the whole stat engine, " +
  "and a partial answer would understate a geared account by a hundred or more while looking authoritative. " +
  "Read the real figures off your own stats in the SkyBlock menu, or off SkyCrypt, and type them once; they are " +
  "remembered.";

const PLAN_NOTE =
  "Which minion to put down and which pet to sit on it, ranked on coins a day. Profit has two halves and " +
  "both are counted: the margin on pets bought cheap, levelled and resold, and the value of everything the " +
  "minion sold while it was doing it — which for the setups people actually run is the larger half. Pairings " +
  "respect the pet's own skill, because a pet keeps all of its skill's XP and a third of anything else, so " +
  "the best minion under the wrong pet loses to a worse minion under the right one.";

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
