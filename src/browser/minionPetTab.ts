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
import { NOT_COUNTED, type DetectedWisdom } from "../lib/wisdom";
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
  /** How much work the plan may ask of you. The tab's primary control. */
  effort: EffortId;
  /** Hide pairings that make less than simply selling the output. */
  hideLosers: boolean;
  /** A live bazaar read, so the plan can price what the minion sells alongside the pet. */
  market: Map<string, ReturnType<typeof normalise>>;
  /** What the loaded profile could be made to admit about its Wisdom, if one has been loaded. */
  detected: DetectedWisdom | null;

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
  effort: (localStorage.getItem("sbxp:pxeffort") as EffortId) ?? "passive",
  hideLosers: localStorage.getItem("sbxp:pxhideloss") === "1",
  market: new Map(),
  detected: null,
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

/* ------------------------------------------------------------ the profile */

/**
 * Take the Wisdom the planner managed to read off a loaded profile.
 *
 * Called on every profile load rather than fetched here, for the same reason the collection totals
 * are handed over rather than re-requested: the planner already asked for the profile, and a second
 * API key box on this tab would be a poor trade for data sitting in memory.
 *
 * Boxes the player has typed into are left alone. A detected figure is a floor — gear, attributes
 * and slayers, but no cookie, no potions, nothing in your hand — so somebody who has looked up
 * their real number knows better than this does, and having it overwritten on the next profile
 * load would be maddening.
 */
export function setDetectedWisdom(detected: DetectedWisdom): void {
  state.detected = detected;

  let filled = false;
  for (const skill of WISDOM_SKILLS) {
    const value = detected.total[skill];
    if (!(value !== undefined && value > 0)) continue;
    const typed = state.wisdom[skill];
    if (typed !== undefined && typed !== "" && Number(typed) > 0) continue;
    state.wisdom[skill] = trimNumber(value);
    filled = true;
  }

  if (filled) {
    try {
      localStorage.setItem("sbxp:pxwisdomby", JSON.stringify(state.wisdom));
    } catch {
      // In memory is enough for this session.
    }
  }
  if (host) render();
}

/** "17.24" rather than "17.240000000000002", and "5" rather than "5.0". */
function trimNumber(value: number): string {
  return String(Math.round(value * 100) / 100);
}

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
      lastUpdated?: number;
      auctions: AuctionRecord[];
    };
    // Ages are measured against the auction house's own clock rather than this browser's, since
    // the two can differ by more than the thresholds care about.
    const readAt = first.lastUpdated ?? Date.now();
    absorbPetPage(index, first.auctions, tables.petLevels, readAt);
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
      for (const page of pages) absorbPetPage(index, page.auctions, tables.petLevels, readAt);
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

      const effort = target.closest<HTMLElement>("[data-pxeffort]");
      if (effort) {
        state.effort = effort.dataset.pxeffort as EffortId;
        localStorage.setItem("sbxp:pxeffort", state.effort);
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

/**
 * How much you are actually willing to do.
 *
 * The tab exists to answer one question — the best money from minion pet-levelling *without doing
 * anything excessive* — and that is a constrained optimisation whose constraint was previously
 * spread across two numeric boxes nobody would think to set. Effort is that constraint made into
 * one control, and it is the first thing on the page.
 *
 * Each level fixes three things that have to agree: how often you empty the minions, how many brews
 * you will stand and do, and whether brewing is on the table at all. They agree because they are
 * the same decision — someone who visits once a day is not the same person who will do two hundred
 * brews, and offering those independently produced setups nobody would run.
 *
 * `passive` is the default deliberately. It is the question as asked.
 */
type EffortId = "passive" | "light" | "grind";

type Effort = {
  id: EffortId;
  label: string;
  /** What it asks of you, in a phrase, for the chip and the row. */
  cost: string;
  claimsPerDay: number;
  maxBrewsPerDay: number;
  /** False means brewing routes are not even considered. */
  brewing: boolean;
  help: string;
};

const EFFORTS: Effort[] = [
  {
    id: "passive",
    label: "Set and forget",
    cost: "one collection a day",
    claimsPerDay: 1,
    maxBrewsPerDay: 0,
    brewing: false,
    help:
      "Empty the minions once a day and nothing else. No brewing stand, no second trip. This is the " +
      "honest answer to 'what can I make without doing anything', and it is the default because it is " +
      "the question most people are actually asking.",
  },
  {
    id: "light",
    label: "A few minutes a day",
    cost: "two collections and up to 20 brews",
    claimsPerDay: 2,
    maxBrewsPerDay: 20,
    brewing: true,
    help:
      "Two collections and a short spell at a brewing stand. Enough brewing to matter, little enough " +
      "that it is still a game rather than a shift.",
  },
  {
    id: "grind",
    label: "I do not mind grinding",
    cost: "four collections and up to 200 brews",
    claimsPerDay: 4,
    maxBrewsPerDay: 200,
    brewing: true,
    help:
      "Everything on the table. Worth looking at to see what you are giving up by not grinding — " +
      "often much less than it appears, because the drops a stand eats were worth selling.",
  },
];

function effortOf(id: EffortId): Effort {
  return EFFORTS.find((e) => e.id === id) ?? EFFORTS[0];
}

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
    <p class="sub dim">${INTENT}</p>

    <div class="panel pad controls px-controls">
      <div class="row">
        ${WISDOM_SKILLS.map(
          (skill) => `<label style="flex:1 1 96px" title="${escapeHtml(
            `${title(skill)} Wisdom. It multiplies ${title(skill)} XP by 1 + Wisdom/100 before anything else touches it. ${
              WISDOM_HELP[skill] ?? ""
            }`,
          )}">${escapeHtml(title(skill))} wisdom
            <input data-pxwisdom="${skill}" value="${escapeHtml(state.wisdom[skill] ?? "")}" placeholder="0" inputmode="decimal" autocomplete="off">
          </label>`,
        ).join("")}
        <label style="flex:1 1 96px" title="Your Taming level, 0 to 60. Each level is one level of Zoologist, which is +1% Pet XP — so Taming 60 is a flat x1.60 on everything below.">Taming level
          <input id="pxtaming" value="${escapeHtml(state.taming)}" placeholder="0" inputmode="numeric" autocomplete="off">
        </label>
      </div>

      <div class="row">
        <label title="How many of the one minion are placed. Production scales straight off this, so it moves both halves of the profit and it is usually the fastest thing to change.">Minions
          <input id="pxcount" value="${escapeHtml(state.count)}" inputmode="numeric" autocomplete="off">
        </label>
        <label>Tier <select id="pxtier">${tiers}</select></label>
        <label>Fuel <select id="pxfuel">${optionList(tables.modifiers.fuels, state.fuel)}</select></label>
        <label>Upgrade 1 <select id="pxup0">${optionList(tables.modifiers.upgrades, state.upgrades[0])}</select></label>
        <label>Upgrade 2 <select id="pxup1">${optionList(tables.modifiers.upgrades, state.upgrades[1])}</select></label>
        <label title="Pairings where one pet would take longer than this are not plans and are left out. Without it the table recommends a pet that finishes in twenty-three thousand days, because the coins from selling the minion's output dwarf the pet margin.">Pet within (days)
          <input id="pxhorizon" value="${escapeHtml(state.horizon)}" inputmode="numeric" autocomplete="off">
        </label>
      </div>

      <p class="sub dim">${detectedNote()}</p>
    </div>

    <div id="pxplan"></div>

    <details class="pxfold">
      <summary>Show the workings <span class="dim">— XP by skill, every pet on the market, and how the chain multiplies</span></summary>
      <div class="panel pad controls">
        <div class="row">
          <label title="The skill the pet you are levelling belongs to. Only affects the cards below — the plan above pairs each minion with its own best pet automatically.">Pet's skill
            <select id="pxpetskill">${petSkills}</select>
          </label>
        </div>
        <p class="sub dim">${chainNote()}</p>
      </div>
      <div id="pxskills"></div>
      <div id="pxpets"></div>
    </details>
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

  const effort = effortOf(state.effort);
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
      claimHours: 24 / effort.claimsPerDay,
    },
  });

  const itemCoinsPerHour = new Map(profit.map((r) => [r.generator, r.netPerHour]));
  const dropValue = new Map(profit.map((r) => [r.generator, r.unitValue]));

  // Effort is applied before pairing rather than after, so a lower setting genuinely re-plans:
  // each minion picks the best pet for the XP it makes within that budget, rather than showing
  // whatever was left once the expensive rows were struck out.
  const allowed = xpRows().filter((r) => effort.brewing || r.route === "direct");

  const planned = bestPerMinion(
    planPetPairs({
      xpRows: allowed,
      pets: petRows(),
      catalogue: tables.petCatalogue,
      rules: tables.petXpRules,
      player: player(),
      itemCoinsPerHour,
      dropValue,
      maxBrewsPerDay: effort.maxBrewsPerDay,
      claimsPerDay: effort.claimsPerDay,
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

/**
 * The effort chips, which are the tab's main control and sit above the answer.
 *
 * Labelled by what they cost you rather than by what they enable, because the decision being made
 * is "how much am I prepared to do", not "which routes should the solver consider".
 */
function effortTabsHtml(): string {
  return `<div class="tabs">
    <span class="dim" style="align-self:center;font-size:12px;margin-right:4px">Willing to do:</span>
    ${EFFORTS.map(
      (e) =>
        `<button class="chip${state.effort === e.id ? " on" : ""}" data-pxeffort="${e.id}" title="${escapeHtml(
          `${e.help} Costs you ${e.cost}.`,
        )}">${escapeHtml(e.label)}</button>`,
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

  // Do the arithmetic rather than gesturing at it. Production scales with the minion count, so the
  // count that would bring the quickest pairing inside the horizon is a division — and "you would
  // need about 60 of them" is a far more useful sentence than "raise the minion count".
  const placed = Math.max(1, Number(state.count.replace(/[^0-9]/g, "")) || 1);
  const needed = Math.ceil((placed * best.daysPerPet) / horizon);

  return `<div class="warn">Nothing here is a plan at this setup. The quickest pairing is the
    <strong>${escapeHtml(best.petName)}</strong> on a <strong>${escapeHtml(best.family)}</strong>, and even that
    takes <strong>${num(Math.round(best.daysPerPet))} days</strong> a pet against your
    ${num(horizon)}-day horizon${best.matched ? "" : ", and its skill does not even match"}.
    <br><br>
    This is minion XP being a trickle rather than anything being broken — the published rates are fractions
    of a point a drop. Three things move it, in order of how much: you have
    <strong>${num(placed)}</strong> minion${placed === 1 ? "" : "s"} down and would need about
    <strong>${num(needed)}</strong> to finish a pet inside the horizon; Wisdom multiplies the XP directly, and
    ${
      Object.values(state.wisdom).some((v) => Number(v) > 0)
        ? "yours is filled in"
        : "<strong>every Wisdom box is still zero</strong>"
    }; and a matching pet is worth three times a mismatched one. All three are in the boxes above.</div>`;
}

function renderPlan(): void {
  const target = document.getElementById("pxplan");
  if (!target || !tables) return;

  if (!state.pets) {
    target.innerHTML = `${effortTabsHtml()}
      <div class="panel pad">
        <p>Pet prices come from the auction house, and nothing here can be answered without them.
          It is about a hundred megabytes and takes a minute; the result is cached.</p>
        <div class="tabs"><button class="chip" id="pxscan">Read the auction house</button></div>
      </div>`;
    return;
  }

  const rows = planRows();
  if (rows.length === 0) {
    target.innerHTML = `<h3 class="gh-h">The plan</h3>
      <p class="dim pad">${PLAN_NOTE}</p>
      ${effortTabsHtml()}
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
      const losing = r.beatsSelling ? "" : " bz-faded";
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
        }${r.petLiquidity === "slow" ? ` · <span class="gold">slow to sell</span>` : ""}</div>${brews}</td>
        <td class="num${r.beatsSelling ? " gold" : " bleed on"}">${
          r.advantagePerDay >= 0 ? "+" : "−"
        }${coins(Math.abs(Math.round(r.advantagePerDay)))}</td>
        <td class="num">${coins(Math.round(r.totalProfitPerDay))}</td>
        <td class="num dim">${coins(Math.round(r.sellOnlyPerDay))}</td>
        <td class="num">${r.daysPerPet < 1 ? `${(r.daysPerPet * 24).toFixed(1)} hr` : `${Math.round(r.daysPerPet)} d`}</td>
        <td class="num">${num(Math.round(r.actionsPerDay))}</td>
      </tr>${
        state.openPlan === r.generator + ":" + r.petKey + ":" + r.petRarity
          ? `<tr class="mn-detail"><td colspan="7">${planDetail(r)}</td></tr>`
          : ""
      }`;
    })
    .join("");

  target.innerHTML = `
    ${effortTabsHtml()}
    <div class="stats" style="grid-template-columns: repeat(4, 1fr)">
      <div class="stat">
        <div class="stat-label">Put down</div>
        <div class="stat-value gold">${escapeHtml(best.family)}</div>
        <div class="stat-sub">${escapeHtml(state.count)} of them at tier ${best.tier}</div>
      </div>
      <div class="stat">
        <div class="stat-label">Level this pet</div>
        <div class="stat-value gold">${escapeHtml(best.petName)}</div>
        <div class="stat-sub">buy ${escapeHtml(title(best.petRarity))} at ${coins(best.buyPrice)} · one every ${
          best.daysPerPet < 1 ? `${(best.daysPerPet * 24).toFixed(1)} hours` : `${Math.round(best.daysPerPet)} days`
        }</div>
      </div>
      <div class="stat">
        <div class="stat-label">Pets add</div>
        <div class="stat-value gold">${best.advantagePerDay >= 0 ? "+" : "−"}${coins(
          Math.abs(Math.round(best.advantagePerDay)),
        )}<span class="stat-sub">/day</span></div>
        <div class="stat-sub">on top of ${coins(Math.round(best.sellOnlyPerDay))} from selling the output —
          ${coins(Math.round(best.totalProfitPerDay))} altogether</div>
      </div>
      <div class="stat">
        <div class="stat-label">Costs you</div>
        <div class="stat-value">${escapeHtml(effortOf(state.effort).cost.split(" and ")[0])}</div>
        <div class="stat-sub">${
          best.brewsPerDay > 0 ? `and ${num(Math.round(best.brewsPerDay))} brews` : "and nothing else"
        }</div>
      </div>
    </div>
    ${petShareNote(best)}
    <div class="panel scroll" style="margin-top:8px">
      <table class="bz">
        <thead><tr>
          <th>Minion</th><th>Pet</th>
          <th class="num" title="What the pet plan is worth OVER simply running the minion and selling the lot. This is what the table is ranked and chosen on, because it is the only part pet-levelling is responsible for. Negative means the plan is worse than not having one.">Pets add</th>
          <th class="num" title="Everything this setup makes in a day: the pet margin plus whatever items were left to sell. Mostly the items, on almost every row.">Total/day</th>
          <th class="num" title="From selling what the minion produced. This is what the minion would earn with no pet on it at all.">Just selling</th>
          <th class="num" title="How long one pet takes from the cheapest listing to max level, at this minion's rate.">Per pet</th>
          <th class="num" title="Things you have to actually do in a day: collections plus brews. The constraint this whole tab is built around.">Actions/day</th>
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
 * The honest headline, when the honest headline is unflattering.
 *
 * With the table ranked on what pet-levelling *adds*, the cards no longer overstate anything — but
 * they also do not say the thing a reader most needs to hear, which is how small that addition is
 * next to simply running the minion. At published rates a pet takes months, so the answer to "best
 * money from minion pet-levelling" is usually "the levelling is a rounding error; the minion is the
 * money". Saying it once, here, is cheaper than letting somebody work it out after buying a pet.
 */
function petShareNote(best: PetPlanRow): string {
  const share = best.totalProfitPerDay > 0 ? best.advantagePerDay / best.totalProfitPerDay : 0;
  if (share >= 0.25) return "";
  return `<div class="warn">Worth knowing before you buy anything: pet-levelling is
    <strong>${(share * 100).toFixed(1)}%</strong> of this plan. The minion earns
    ${coins(Math.round(best.sellOnlyPerDay))} a day selling its output whether or not a pet is out, and the
    pet adds ${coins(Math.round(best.advantagePerDay))} on top over
    ${best.daysPerPet < 1 ? "less than a day" : `${num(Math.round(best.daysPerPet))} days`} per pet. The
    published minion XP rates are fractions of a point a drop, so this is a slow bonus on a minion worth
    running anyway — not a reason to run one. More minions and a higher tier move both halves; a
    <em>matching</em> pet is the only thing that moves the pet half much.</div>`;
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


const INTENT =
  "The best money from minion pet-levelling without doing anything excessive. Pick how much you are willing to " +
  "do and this finds the minion and the pet that pay the most inside that budget — counting both the pet margin " +
  "and everything the minion sells while it levels. Everything below the answer is optional.";

/**
 * What the profile gave up, and what it could not.
 *
 * Replaces the flat "these cannot be read" note once a profile is loaded, because that sentence
 * stopped being true — most of a geared account's Wisdom *is* readable. What stays true is that it
 * is a floor, so the wording moves from "cannot" to "here is what was found and here is what was
 * not", which is the honest version of the same warning.
 */
function detectedNote(): string {
  const d = state.detected;
  if (!d) return WISDOM_NOTE;

  const shown = WISDOM_SKILLS.filter((s) => (d.total[s] ?? 0) > 0);
  if (shown.length === 0) {
    return (
      `<strong>Your profile is loaded and carries no Wisdom this page can read.</strong> ` +
      `That is possible on a fresh account. ${NOT_COUNTED} ` +
      `Read your real figures off the SkyBlock menu or SkyCrypt and type them in.`
    );
  }

  const where: Record<string, string> = {
    gear: "equipped armour and equipment",
    accessories: "your accessory bag",
    attributes: "attribute shards",
    slayers: "slayer tiers",
  };
  const parts = shown.map((s) => `<strong>${escapeHtml(title(s))} ${trimNumber(d.total[s] ?? 0)}</strong>`).join(", ");

  return (
    `Filled in from your profile — ${parts} — read from ${d.found.map((f) => where[f]).join(", ")}. ` +
    `${NOT_COUNTED} Anything you type wins and is kept.`
  );
}

const WISDOM_NOTE =
  '<strong>Wisdom multiplies the XP before anything else touches it</strong>, so these six are the inputs most ' +
  'worth getting right — and they cannot be read from your profile, because Hypixel publishes the components ' +
  '(gear, enchants, attributes, pets, accessories, cookies) rather than the total. Read them off your own stats ' +
  'in the SkyBlock menu or off SkyCrypt and type them once; they are remembered. ' +
  '<span title="A geared account runs 170-240 per skill, and the largest sources are whatever you have equipped. ' +
  'Reading only the parts this page can see would find about 2 of that while looking authoritative, and would ' +
  'halve every figure below without saying so." class="gold">Why not automatic?</span>';

const PLAN_NOTE =
  "Ranked on what pet-levelling adds, not on the total — the total is mostly the minion selling its output, " +
  "which it would do with no pet on it. Pairings respect the pet's own skill, and pets nobody is actually " +
  "buying are left out.";

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
        <td class="num">${marketCell(r)}</td>
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
          <th class="num" title="How many copies are listed at max level and how long they have sat. A lowest BIN is a number whatever is behind it, and for many pets there is one listing behind it — one person's asking price rather than a market. Across the whole auction house the median max-level pet listing is 28 hours old.">Market</th>
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

/** How deep the market is behind a pet's sell price, in a couple of words. */
function marketCell(r: PetProfitRow): string {
  const age = r.meanAgeHours >= 48 ? `${Math.round(r.meanAgeHours / 24)}d` : `${Math.round(r.meanAgeHours)}h`;
  const label = `${num(r.listings)} listed · ${age}`;
  if (r.liquidity === "ok") return `<span class="dim">${label}</span>`;
  const why =
    r.liquidity === "thin"
      ? "One or two listings is one person's asking price, not a market you can sell into."
      : "These have sat unsold for days. The price is real and nobody is paying it.";
  return `<span class="gold" title="${escapeHtml(why)}">${label}</span>`;
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
