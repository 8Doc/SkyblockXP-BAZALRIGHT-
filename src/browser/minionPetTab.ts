import { coins, num } from "../lib/format";
import type { Fuel, MinionData, MinionProduction, Modifiers, Upgrade } from "../lib/minions";
import type { DropTable, Recipe } from "../lib/minionProfit";
import { monthsForBasis, readMonths } from "./monthStore";
import {
  placedCount,
  readSetup,
  slotIds,
  writeSetup,
  type MinionSetupState,
} from "./minionSetup";
import type { CraftCost, MinionRecipes } from "../lib/minionCraft";
import {
  craftCellHtml,
  craftFor as craftOf,
  createCraftCache,
  type CraftCellContext,
} from "./craftCell";
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
  planPetProfit,
  KEEP_RARITIES,
  type PetBinIndex,
  type PetLevelTable,
  type PetProfitRow,
} from "../lib/petLevelling";
import type { AuctionRecord } from "../lib/auctions";
import { NOT_COUNTED, type DetectedWisdom } from "../lib/wisdom";
import { bestPerMinion, planPetPairs, type PetPlanRow } from "../lib/petPlan";
import {
  planProfit,
  type Compactor,
  type ExtrasTable,
  type Hopper,
  type ItemPrices,
  type StorageChest,
  type StorageTables,
} from "../lib/minionProfit";
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
  craft: MinionRecipes;
  recipes: Recipe[];
  names: Record<string, string>;
  npcPrices: Record<string, { sell?: number; buy?: number }>;
  storage: StorageTables;
  skillXp: SkillXpTables;
  petXpRules: PetXpRules;
  petLevels: PetLevelTable;
  /** Which skill each pet levels off — the field the whole pairing turns on. */
  petCatalogue: { key: string; name: string; skill: SkillKey | null; rarities: string[] }[];
};

/* ----------------------------------------------------------------- state */

type State = {
  /** Wisdom per skill, as typed. Keyed by SkillKey; missing reads as zero. */
  wisdom: Record<string, string>;
  taming: string;
  petSkill: SkillKey | "ANY";
  /**
   * The wall, shared with Raw profits rather than kept twice.
   *
   * Both tabs describe the same minions, and holding two copies of "tier, count, fuel, upgrades"
   * meant the tabs silently disagreed the moment one of them was touched — a Tarantula Minion at
   * tier XII on one and tier XI on the other, with nothing on either page saying so. Re-read on
   * mount, so switching sub-tabs carries the setup across.
   */
  setup: MinionSetupState;
  showRoutes: boolean;
  /** How long a pet may take before the pairing stops counting as a plan. */
  horizon: string;
  /** Ignore the horizon entirely, however long a pet takes. */
  noHorizon: boolean;
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
  /** Which plan row is opened out. */
  openPlan: string | null;
  /** Column order for each of the tab's three tables, keyed by table. */
  sorts: Record<string, { column: string; descending: boolean }>;
};

const state: State = {
  wisdom: readWisdom(),
  taming: localStorage.getItem("sbxp:pxtaming") ?? "0",
  petSkill: (localStorage.getItem("sbxp:pxpetskill") as SkillKey | "ANY") ?? "ANY",
  setup: readSetup(),
  showRoutes: localStorage.getItem("sbxp:pxroutes") === "1",
  horizon: localStorage.getItem("sbxp:pxhorizon") ?? "365",
  noHorizon: localStorage.getItem("sbxp:pxnohorizon") === "1",
  hideLosers: localStorage.getItem("sbxp:pxhideloss") === "1",
  market: new Map(),
  detected: null,
  pets: null,
  scanning: false,
  scanned: 0,
  scanTotal: 0,
  scanError: "",
  openPlan: null,
  sorts: readSorts(),
};

/**
 * Column order per table, remembered.
 *
 * Three tables on one tab, each answering a different question, so one shared setting would mean
 * sorting the pet market by "actions a day". Keyed by table id instead. The defaults are the figure
 * each table is *about*: the plan on what pet-levelling adds, the routes on Pet XP, the market on
 * coins per XP.
 */
const DEFAULT_SORTS: Record<string, { column: string; descending: boolean }> = {
  plan: { column: "advantage", descending: true },
  routes: { column: "petxp", descending: true },
};

function readSorts(): Record<string, { column: string; descending: boolean }> {
  try {
    const raw = localStorage.getItem("sbxp:pxsorts");
    return raw ? { ...DEFAULT_SORTS, ...(JSON.parse(raw) as Record<string, { column: string; descending: boolean }>) } : { ...DEFAULT_SORTS };
  } catch {
    return { ...DEFAULT_SORTS };
  }
}

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
 * Boxes the player has typed into are left alone. A detected figure is a floor — it counts worn
 * gear, the best tool carried per skill, accessories, attributes, slayer tiers and a Booster
 * Cookie, but not a mayor's perk, Heart of the Mountain, Essence Shop perks or potions — so
 * somebody who has read their real number off the stats menu knows better than this does, and
 * having it overwritten on the next profile load would be maddening.
 */
export function setDetectedWisdom(detected: DetectedWisdom): void {
  state.detected = detected;

  const auto = readAutofilled();
  let changed = false;

  for (const skill of WISDOM_SKILLS) {
    const value = detected.total[skill];
    if (!(value !== undefined && value > 0)) continue;

    // Overwrite a box that is empty, or one a previous detection filled. Leave a box the player
    // typed into. Distinguishing the two matters more than it looks: the detection has already
    // been improved once — a cookie is +25 on every skill and was being missed — and without this,
    // everyone who had loaded a profile under the old version would keep the old numbers forever,
    // because their own tab could not tell its own past output from their considered opinion.
    const current = state.wisdom[skill];
    const isTyped = current !== undefined && current !== "" && Number(current) > 0 && !auto.has(skill);
    if (isTyped) continue;

    const next = trimNumber(value);
    if (current !== next) changed = true;
    state.wisdom[skill] = next;
    auto.add(skill);
  }

  if (changed) {
    try {
      localStorage.setItem("sbxp:pxwisdomby", JSON.stringify(state.wisdom));
      localStorage.setItem(AUTOFILLED_KEY, JSON.stringify([...auto]));
    } catch {
      // In memory is enough for this session.
    }
  }
  if (host) render();
}

/** Which boxes this tab filled in itself, as opposed to which the player typed. */
const AUTOFILLED_KEY = "sbxp:pxwisdomauto";

function readAutofilled(): Set<string> {
  try {
    const raw = localStorage.getItem(AUTOFILLED_KEY);
    if (raw) return new Set(JSON.parse(raw) as string[]);
    // No record means the values on hand predate this bookkeeping. They came from the first version
    // of the detection rather than from a person, so they are treated as replaceable — the
    // alternative is stranding every early user on numbers that were known to be short.
    return new Set(WISDOM_SKILLS);
  } catch {
    return new Set(WISDOM_SKILLS);
  }
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

/**
 * The upgrade list minus the compactors, which have their own control.
 *
 * A compactor is a Minion Upgrade and genuinely occupies a slot, so it belongs in this list on the
 * game's own terms — but leaving it here lets the same decision be made in two places, and "Super
 * Compactor in slot one, no compactor in the compactor box" is a setup nobody meant.
 */
function plainUpgrades(): Upgrade[] {
  const compactors = new Set(tables!.storage.compactors.map((c) => c.id));
  return tables!.modifiers.upgrades.filter((u) => !compactors.has(u.id));
}

/** What is actually in the two slots, resolved. The compactor takes the second one when fitted. */
function slotUpgrades(): [Upgrade, Upgrade] {
  const [first, second] = slotIds(state.setup, tables!.storage.compactors);
  return [upgradeById(first), upgradeById(second)];
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
      tier: state.setup.tier,
      fuel: fuelById(state.setup.fuel),
      upgrades: slotUpgrades(),
      count: placedCount(state.setup),
    },
    dropIdFor,
    names: tables.names,
    recipes: tables.recipes,
    // The same ceiling the planner budgets for, because it is what decides which brewing form of a
    // drop is worth planning at all — not just how many of them you end up doing.
    maxBrewsPerDay: BUDGET.maxBrewsPerDay,
  });
}

/**
 * The pets worth levelling, restricted to the top of each one's own rarity ladder.
 *
 * Every rarity is its own trade, and the low ones win on coins per point of Pet XP for a reason
 * that is not a reason to buy them: a Common needs 5.6M Pet XP where a Legendary needs 25.4M, so
 * the Common always prices better per point while being worth a fraction of the coins and having a
 * sell side one listing deep. Nobody levels a Common to sell. Keeping the top two rungs — the max
 * and one below — leaves the trades people actually make, and the second rung matters because the
 * top one is often the thin one.
 */
function petRows(): PetProfitRow[] {
  if (!tables || !state.pets) return [];
  return planPetProfit({
    index: state.pets,
    levels: tables.petLevels,
    minProfit: 0,
    ladders: petLadders(),
    keepRarities: KEEP_RARITIES,
  });
}

let ladderCache: Record<string, string[]> | null = null;

function petLadders(): Record<string, string[]> {
  if (ladderCache) return ladderCache;
  const out: Record<string, string[]> = {};
  for (const pet of tables?.petCatalogue ?? []) out[pet.key] = pet.rarities;
  ladderCache = out;
  return out;
}

/* -------------------------------------------------------------- rendering */

export function mountMinionPet(container: HTMLElement, data: Tables): void {
  host = container;
  tables = data;
  nameCache = null;
  ladderCache = null;
  // The other tab may have moved the wall since this one last rendered.
  state.setup = readSetup();
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

      if (target.closest("#pxnohorizon")) {
        state.noHorizon = !state.noHorizon;
        localStorage.setItem("sbxp:pxnohorizon", state.noHorizon ? "1" : "0");
        // A full render rather than renderPlan, because the days box above is disabled by this and
        // a chip that greys a control it does not repaint is a control that lies.
        return render();
      }

      if (target.closest("#pxhideloss")) {
        state.hideLosers = !state.hideLosers;
        localStorage.setItem("sbxp:pxhideloss", state.hideLosers ? "1" : "0");
        return renderPlan();
      }

      const sort = target.closest<HTMLElement>("[data-pxsort]");
      if (sort) {
        const [table, id] = sort.dataset.pxsort!.split(":");
        const current = state.sorts[table] ?? DEFAULT_SORTS[table];
        // Clicking the active column reverses it; a new one starts descending, because "most of
        // this" is what someone means by clicking a column of numbers.
        state.sorts[table] =
          current?.column === id ? { column: id, descending: !current.descending } : { column: id, descending: true };
        try {
          localStorage.setItem("sbxp:pxsorts", JSON.stringify(state.sorts));
        } catch {
          // In memory is enough for this session.
        }
        if (table === "routes") return renderSkills();
        return renderPlan();
      }

      const planRow = target.closest<HTMLElement>("[data-pxplanopen]");
      if (planRow) {
        const key = planRow.dataset.pxplanopen!;
        state.openPlan = state.openPlan === key ? null : key;
        return renderPlan();
      }
    });

    container.addEventListener("change", (event) => {
      const el = event.target as HTMLSelectElement;
      const map: Record<string, (v: string) => void> = {
        pxpetskill: (v) => ((state.petSkill = v as SkillKey | "ANY"), localStorage.setItem("sbxp:pxpetskill", v)),
        pxtier: (v) => ((state.setup.tier = Number(v)), writeSetup("tier", state.setup.tier)),
        pxfuel: (v) => ((state.setup.fuel = v), writeSetup("fuel", v)),
        pxup0: (v) => ((state.setup.upgrades[0] = v), writeSetup("upgrades", state.setup.upgrades)),
        pxcomp: (v) => ((state.setup.compactor = v), writeSetup("compactor", v)),
        pxchest: (v) => ((state.setup.chest = v), writeSetup("chest", v)),
        pxhopper: (v) => ((state.setup.hopper = v), writeSetup("hopper", v)),
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
        // Typing into a box makes it yours, and a later profile load will not touch it again.
        try {
          const auto = readAutofilled();
          auto.delete(wisdomSkill);
          localStorage.setItem(AUTOFILLED_KEY, JSON.stringify([...auto]));
        } catch {
          // Storage blocked: the edit still stands for this session.
        }
        renderPlan();
        renderSkills();
        renderPets();
        return;
      }
      if (el.id === "pxtaming") {
        state.taming = el.value;
        localStorage.setItem("sbxp:pxtaming", el.value);
      } else if (el.id === "pxcount") {
        state.setup.count = el.value;
        writeSetup("count", el.value);
      } else if (el.id === "pxclaim") {
        state.setup.claim = el.value;
        writeSetup("claim", el.value);
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
 * What the plan is allowed to ask of you.
 *
 * This was three chips — set and forget, a few minutes, grinding — and they were three answers to a
 * question the tab does not really have. Every one of them re-planned the whole table, so reading
 * the page meant comparing three tables in your head rather than reading one; and the ranking is on
 * `advantagePerDay` anyway, which already declines to recommend a plan whose brewing eats more than
 * the pet is worth. A budget that never binds costs nothing to remove, and the two that did bind
 * were hiding rows rather than changing which row won.
 *
 * So the ceiling is fixed and generous: everything is on the table, and the ranking decides. The
 * brew cap stays because it is not economic — past a few hundred brews a day the route is a second
 * job and the coins beside it are a fiction — but it is a guard rail now, not a control.
 *
 * Alchemy needs `brewing` on: it is reached no other way, and the whole route would vanish.
 */
const BUDGET = {
  maxBrewsPerDay: 200,
} as const;

/** "four collections a day", "one collection every 3 days" — the visiting half of what a plan costs. */
function collectionPhrase(): string {
  const perDay = claimsPerDay();
  if (perDay >= 1) {
    const rounded = Math.round(perDay * 10) / 10;
    return rounded === 1 ? "one collection a day" : `${num(rounded)} collections a day`;
  }
  const days = 1 / perDay;
  return `one collection every ${days < 1.5 ? `${days.toFixed(1)} days` : `${Math.round(days)} days`}`;
}

function render(): void {
  if (!host || !tables) return;

  const tiers = Array.from({ length: 12 }, (_, i) => i + 1)
    .map((t) => `<option value="${t}"${state.setup.tier === t ? " selected" : ""}>Tier ${t}</option>`)
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
          <input id="pxcount" value="${escapeHtml(state.setup.count)}" inputmode="numeric" autocomplete="off">
        </label>
        <label>Tier <select id="pxtier">${tiers}</select></label>
        <label>Fuel <select id="pxfuel">${optionList(tables.modifiers.fuels, state.setup.fuel)}</select></label>
        <label>Upgrade <select id="pxup0">${optionList(plainUpgrades(), state.setup.upgrades[0])}</select></label>
        <label title="A compactor is a Minion Upgrade and takes the second slot. It is the single biggest thing on this row: packing 160 drops into one multiplies the storage by the same amount, which is the difference between a minion that stands full and one that runs all week.">Compactor
          <select id="pxcomp">${optionList(tables.storage.compactors, state.setup.compactor)}</select>
        </label>
      </div>

      <div class="row">
        <label title="Extra storage placed beside the minion. It does not change what the minion makes, only how long it runs before it stops.">Storage chest
          <select id="pxchest">${optionList(tables.storage.chests, state.setup.chest)}</select>
        </label>
        <label title="A hopper sells the overflow to a shopkeeper once the minion and its chest are both full, at its own share of shop price.">Automated shipping
          <select id="pxhopper">${optionList(tables.storage.hoppers, state.setup.hopper)}</select>
        </label>
        <label title="Hours between visits. This is the other half of the effort budget and the one nobody counts: past the point storage fills, a minion earns nothing until someone empties it. Shared with the Raw profits tab, which is why the two tabs agree on what the minion sells.">Claim every (hours)
          <input id="pxclaim" value="${escapeHtml(state.setup.claim)}" inputmode="numeric" autocomplete="off">
        </label>
        <label title="Pairings where one pet would take longer than this are not plans and are left out. Without it the table recommends a pet that finishes in twenty-three thousand days, because the coins from selling the minion's output dwarf the pet margin.">Pet within (days)
          <input id="pxhorizon" value="${
            state.noHorizon ? "no limit" : escapeHtml(state.horizon)
          }" inputmode="numeric" autocomplete="off"${state.noHorizon ? " disabled" : ""}>
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
/**
 * Every pairing the plan was chosen from, kept so a row can be opened out.
 *
 * `planRows` reduces the pairings to one per minion, and that reduction is the whole point of the
 * table — but it throws away the runners-up, which are exactly what somebody wants when they click
 * a row and ask "what else could I put on this?". Rather than run the solve a second time to get
 * them back, the last full list is kept here and read by the row detail.
 *
 * Written on every `planRows` call and read only while that same render is on screen, so it cannot
 * go stale in any way a reader could see: a change to any control re-plans before it repaints.
 */
let lastPairs: PetPlanRow[] = [];

/**
 * How long a pet may take before the pairing stops counting as a plan.
 *
 * The horizon exists because minion XP is a trickle and the item half of the profit dwarfs the pet
 * half, so without one the table cheerfully recommends a pet that finishes in twenty-three thousand
 * days. But it hides more than the silly rows: a brewing plan's *second* pet is levelled off the
 * collection stream, which is far slower than the brewing one, so the horizon routinely deletes the
 * Alchemy plan's Farming half and leaves the row understating itself. Sugar Cane at five minions is
 * the worked example — +26k a day with the second pet cut, +49k with it.
 *
 * So it is a control rather than a rule, and this is the off switch.
 */
function horizonDays(): number {
  return state.noHorizon ? Infinity : Math.max(1, Number(state.horizon) || 365);
}

/** Hours between visits, from the shared setup. A quarter of an hour is the floor, as on that tab. */
function claimHours(): number {
  return Math.max(0.25, Number(state.setup.claim) || 8);
}

/**
 * Collections a day, which is half of what this tab counts as an action.
 *
 * Derived from the claim interval rather than fixed at four. A wall claimed once a day is one
 * action and a wall claimed every six hours is four, and quoting four either way both overstated
 * the work for the patient setup and understated it for the attentive one.
 */
function claimsPerDay(): number {
  return 24 / claimHours();
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

function planRows(over: { maxDaysPerPet?: number } = {}): PetPlanRow[] {
  if (!tables || !state.pets) return [];

  const prices = priceBook();
  const setup = {
    tier: state.setup.tier,
    fuel: fuelById(state.setup.fuel),
    upgrades: slotUpgrades(),
    count: placedCount(state.setup),
  };

  /**
   * What each minion earns selling its output — the same call the Raw profits tab makes.
   *
   * Every input comes from the shared setup, including the four this tab used to hardcode: the
   * chest, the hopper, the compactor and the claim interval. Hardcoding them is what made "Just
   * selling" disagree with the tab beside it in ways no control could reconcile, and passing an
   * empty month with `trust: "live"` meant the anomaly guard was simply off here, so a spiking
   * bazaar quote inflated this figure while Raw profits declined to believe the same number.
   *
   * The months come from whatever Raw profits last fetched. Nothing here fetches them, so a
   * session that has never opened that tab guards nothing — which is what the caveat says.
   */
  const months = readMonths().months;
  const profit = planProfit({
    data: tables.production,
    storage: tables.storage,
    drops: tables.drops,
    extras: tables.extras,
    recipes: tables.recipes,
    prices,
    variance: monthsForBasis(months, state.setup.basis),
    names: tables.names,
    basis: state.setup.basis,
    trust: state.setup.trust,
    setup: {
      ...setup,
      chest: chestById(state.setup.chest),
      hopper: hopperById(state.setup.hopper),
      compactor: compactorById(state.setup.compactor),
      claimHours: claimHours(),
    },
  });

  const itemCoinsPerHour = new Map(profit.map((r) => [r.generator, r.netPerHour]));
  const dropValue = new Map(profit.map((r) => [r.generator, r.unitValue]));

  const pairs = planPetPairs({
    xpRows: xpRows(),
    pets: petRows(),
    catalogue: tables.petCatalogue,
    rules: tables.petXpRules,
    player: player(),
    itemCoinsPerHour,
    dropValue,
    maxBrewsPerDay: BUDGET.maxBrewsPerDay,
    claimsPerDay: claimsPerDay(),
    maxDaysPerPet: over.maxDaysPerPet ?? horizonDays(),
    minProfitPerDay: 0,
  });
  // Only the real plan's pairings are worth keeping — `emptyReason` re-runs this with the horizon
  // lifted to explain an empty table, and those runners-up describe a plan nobody is being offered.
  if (over.maxDaysPerPet === undefined) lastPairs = pairs;

  const planned = bestPerMinion(pairs);
  return state.hideLosers ? planned.filter((r) => r.beatsSelling) : planned;
}

/**
 * The minions this section cannot plan, and why — because their absence is misleading.
 *
 * Only Farming and Mining have a Minion XP column, and the item infoboxes fill in about forty more
 * items; everything else is genuinely unmeasured. A minion whose entire output is unmeasured cannot
 * be planned at all, and left silent that reads as a verdict on the minion rather than as a gap in
 * the sources.
 *
 * The list is much shorter than it was, and the reason is worth knowing: a minion is rated if *any*
 * of its drops is. A Revenant Minion drops diamonds a fifth of the time beside flesh nobody has
 * measured, a Tarantula Minion drops iron beside its string, a Voidling Minion is mostly obsidian.
 * Reading `collects` alone and stopping put all four slayer minions in here at zero; counting every
 * drop takes them out.
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
    no minion XP rate has ever been published for anything they drop: ${escapeHtml(shown)}${
      missing.length > 12 ? `, and ${num(missing.length - 12)} more` : ""
    }. That is a gap in the wiki rather than a verdict. What is missing is only the XP half; the
    <strong>Raw profits</strong> tab prices exactly what those minions sell, which is where most of a
    minion wall's money comes from anyway.</div>`;
}

/**
 * What is left of the chip strip once the three effort modes are one.
 *
 * Only the loss filter survives, because it is the one chip that was ever a *view* of a single
 * plan rather than a different plan. It stays on the strip rather than moving into the controls
 * panel above: it changes what the table shows, and it belongs beside the table it changes.
 */
function planTabsHtml(): string {
  return `<div class="tabs">
    <button class="chip${state.noHorizon ? " on" : ""}" id="pxnohorizon"
      title="Plan every pairing however long a pet takes, ignoring the days box. Worth turning on to see a brewing plan's second pet: it levels off the collection rather than the brewing, which is much slower, so the limit often cuts it and the row then understates what the minion makes.">No time limit on pets</button>
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
  const placed = placedCount(state.setup);
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

/* ------------------------------------------------------------- sorting */

/**
 * One column of a sortable table.
 *
 * `value` is kept apart from `render` deliberately: the rendered cell is a string with a suffix and
 * a colour on it, and sorting that lexically puts "9.7k" above "48k". Every sortable column here is
 * a number underneath even where it prints as a word.
 */
type SortColumn<T> = {
  id: string;
  label: string;
  title?: string;
  /** Left-aligned text columns sort on a string; everything else on a number. */
  text?: boolean;
  value: (row: T) => number | string;
  render: (row: T) => string;
};

function headerHtml<T>(table: string, columns: SortColumn<T>[]): string {
  const sort = state.sorts[table] ?? DEFAULT_SORTS[table];
  return columns
    .map((c) => {
      const on = sort?.column === c.id;
      const arrow = on ? (sort.descending ? " ↓" : " ↑") : "";
      const title = `${c.title ?? c.label}

Click to sort by this column; click again to reverse it.`;
      return `<th class="${c.text ? "" : "num"}${on ? " on" : ""}" data-pxsort="${table}:${c.id}" title="${escapeHtml(
        title,
      )}">${escapeHtml(c.label)}${arrow}</th>`;
    })
    .join("");
}

/**
 * The rows in the order the header asks for.
 *
 * Infinity is a real answer in more than one column here — "never fills", a pet that takes forever —
 * so it is pushed to one end rather than allowed to poison the comparison. The tiebreak is the
 * first column's text, so rows worth the same amount do not swap places every time prices tick.
 */
function sortRows<T>(table: string, rows: T[], columns: SortColumn<T>[]): T[] {
  const sort = state.sorts[table] ?? DEFAULT_SORTS[table];
  const column = columns.find((c) => c.id === sort?.column);
  if (!column) return rows;

  const sign = sort.descending ? -1 : 1;
  const first = columns[0];
  return [...rows].sort((a, b) => {
    const av = column.value(a);
    const bv = column.value(b);
    let diff: number;
    if (typeof av === "string" || typeof bv === "string") {
      diff = String(av).localeCompare(String(bv));
    } else {
      const fix = (n: number) => (Number.isFinite(n) ? n : n > 0 ? Number.MAX_VALUE : -Number.MAX_VALUE);
      diff = fix(av) - fix(bv);
    }
    if (diff !== 0) return sign * diff;
    return String(first.value(a)).localeCompare(String(first.value(b)));
  });
}

const PLAN_COLUMNS: SortColumn<PetPlanRow>[] = [
  {
    id: "minion",
    label: "Minion",
    text: true,
    value: (r) => r.family,
    render: (r) =>
      `${escapeHtml(r.family)}<div class="dim bz-path">tier ${r.tier} · ${escapeHtml(title(r.skill))}${
        r.route === "brewing" ? " · brewed" : ""
      }</div>`,
  },
  {
    id: "pet",
    label: "Pet",
    text: true,
    value: (r) => r.petName,
    // Two pets on a brewing row, because the drops pay into two skills and one pet cannot take
    // both. Shown stacked rather than merged: they are levelled at different rates off different
    // streams, and a reader has to buy both.
    render: (r) =>
      `${escapeHtml(r.petName)}<div class="dim bz-path">${escapeHtml(title(r.petRarity))}${
        r.matched ? "" : ` · <span class="gold">skill mismatch</span>`
      }${r.petLiquidity === "slow" ? ` · <span class="gold">slow to sell</span>` : ""}${
        r.partner ? " · while brewing" : ""
      }</div>${
        r.partner
          ? `<div class="px-partner">${escapeHtml(r.partner.petName)}<div class="dim bz-path">${escapeHtml(
              title(r.partner.petRarity),
            )}${
              r.partner.matched ? "" : ` · <span class="gold">skill mismatch</span>`
            } · while collecting ${escapeHtml(title(r.baseSkill ?? ""))}</div></div>`
          : ""
      }${r.brewsPerDay > 0 ? `<div class="dim bz-path">${num(Math.round(r.brewsPerDay))} brews a day</div>` : ""}`,
  },
  {
    id: "advantage",
    label: "Pets add",
    title:
      "What the pet plan is worth OVER simply running the minion and selling the lot. This is what the table is " +
      "ranked and chosen on, because it is the only part pet-levelling is responsible for. Negative means the " +
      "plan is worse than not having one.",
    value: (r) => r.advantagePerDay,
    render: (r) =>
      `<span class="${r.beatsSelling ? "gold" : "bleed on"}">${r.advantagePerDay >= 0 ? "+" : "−"}${coins(
        Math.abs(Math.round(r.advantagePerDay)),
      )}</span>`,
  },
  {
    id: "total",
    label: "Total/day",
    title: "Everything this setup makes in a day: the pet margin plus whatever items were left to sell.",
    value: (r) => r.totalProfitPerDay,
    render: (r) => coins(Math.round(r.totalProfitPerDay)),
  },
  {
    id: "selling",
    label: "Just selling",
    title:
      "From selling what the minion produced — what it would earn with no pet on it at all. This is the Raw profits " +
      "tab's own figure over a day, on the same setup: the two tabs share one wall, so the tier, count, fuel, " +
      "upgrade, compactor, chest, hopper, claim interval, market and price guard are all the same on both, and the " +
      "two numbers agree to the coin.",
    value: (r) => r.sellOnlyPerDay,
    render: (r) => `<span class="dim">${coins(Math.round(r.sellOnlyPerDay))}</span>`,
  },
  {
    id: "perpet",
    label: "Per pet",
    title: "How long one pet takes from the cheapest listing to max level, at this minion's rate.",
    value: (r) => r.daysPerPet,
    render: (r) => (r.daysPerPet < 1 ? `${(r.daysPerPet * 24).toFixed(1)} hr` : `${Math.round(r.daysPerPet)} d`),
  },
  {
    id: "craft",
    label: "Craft cost",
    title:
      "What the materials for this wall cost to buy, cumulative from Tier I — every upgrade behind the tier, not " +
      "just the last one, with a nested minion written out as its own materials. This is what the plan costs before " +
      "it earns anything, and it is the same figure the Raw profits tab quotes. Hover for the full bill.",
    value: (r) => craftFor(r)?.coins ?? -1,
    render: craftCell,
  },
  {
    id: "actions",
    label: "Actions/day",
    title: "Things you have to actually do in a day: collections plus brews. The constraint this tab is built around.",
    value: (r) => r.actionsPerDay,
    render: (r) => num(Math.round(r.actionsPerDay)),
  },
];

/** This render's craft bills. Prices and the minion count both move under it, so it lives one paint. */
let craftCache = createCraftCache();

function craftContext(): CraftCellContext {
  return {
    recipes: tables!.craft,
    market: state.market,
    npcPrices: tables!.npcPrices,
    placed: placedCount(state.setup),
  };
}

function craftFor(r: PetPlanRow): CraftCost | null {
  return craftOf(craftCache, craftContext(), r.generator, r.tier);
}

function craftCell(r: PetPlanRow): string {
  return craftCellHtml(craftFor(r), r.family, placedCount(state.setup));
}

function renderPlan(): void {
  const target = document.getElementById("pxplan");
  if (!target || !tables) return;
  craftCache = createCraftCache();

  if (!state.pets) {
    target.innerHTML = `${planTabsHtml()}
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
      ${planTabsHtml()}
      ${emptyReason()}`;
    return;
  }

  // `best` is the headline and stays the best PLAN whatever the table is sorted by — re-sorting a
  // table to inspect it should not silently change what the cards recommend.
  const best = rows[0];
  const shown = sortRows("plan", rows, PLAN_COLUMNS).slice(0, 25);
  const body = shown
    .map((r) => {
      const key = r.generator + ":" + r.petKey + ":" + r.petRarity;
      // A pairing worth less than simply selling the output is greyed rather than dressed up. It is
      // still shown, because "this minion has no worthwhile pet plan" is an answer.
      const losing = r.beatsSelling ? "" : " bz-faded";
      const why = r.beatsSelling
        ? ""
        : ` title="${escapeHtml(
            `Selling everything this minion makes is ${Math.round(-r.advantagePerDay).toLocaleString("en-US")} coins a day better than this plan. The drops the brewing stand eats are worth more than the pet they level.`,
          )}"`;
      const cells = PLAN_COLUMNS.map(
        (c, i) => `<td class="${i < 2 ? "" : "num"}">${c.render(r)}</td>`,
      ).join("");
      return `<tr class="bz-open${losing}" data-pxplanopen="${escapeHtml(key)}"${why}>${cells}</tr>${
        state.openPlan === key ? `<tr class="mn-detail"><td colspan="${PLAN_COLUMNS.length}">${planDetail(r)}</td></tr>` : ""
      }`;
    })
    .join("");

  target.innerHTML = `
    ${planTabsHtml()}
    <div class="stats" style="grid-template-columns: repeat(4, 1fr)">
      <div class="stat">
        <div class="stat-label">Put down</div>
        <div class="stat-value gold">${escapeHtml(best.family)}</div>
        <div class="stat-sub">${escapeHtml(state.setup.count)} of them at tier ${best.tier}</div>
      </div>
      <div class="stat">
        <div class="stat-label">Level ${best.partner ? "these pets" : "this pet"}</div>
        <div class="stat-value gold">${escapeHtml(best.petName)}${
          best.partner ? `<span class="stat-sub"> and ${escapeHtml(best.partner.petName)}</span>` : ""
        }</div>
        <div class="stat-sub">buy ${escapeHtml(title(best.petRarity))} at ${coins(best.buyPrice)} · one every ${
          best.daysPerPet < 1 ? `${(best.daysPerPet * 24).toFixed(1)} hours` : `${Math.round(best.daysPerPet)} days`
        }${
          best.partner
            ? ` · swap to the ${escapeHtml(best.partner.petName)} when you collect, one every ${
                best.partner.daysPerPet < 1
                  ? `${(best.partner.daysPerPet * 24).toFixed(1)} hours`
                  : `${Math.round(best.partner.daysPerPet)} days`
              }`
            : ""
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
        <div class="stat-value">${escapeHtml(collectionPhrase())}</div>
        <div class="stat-sub">${
          best.brewsPerDay > 0 ? `and ${num(Math.round(best.brewsPerDay))} brews` : "and nothing else"
        }</div>
      </div>
    </div>
    ${petShareNote(best)}
    <div class="panel scroll" style="margin-top:8px">
      <table class="bz">
        <thead><tr>${headerHtml("plan", PLAN_COLUMNS)}</tr></thead>
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
  if (r.partner) {
    lines.push(
      `<div class="gh-sub">The same drops pay twice. Collecting them is
      <strong>${escapeHtml(title(r.baseSkill ?? ""))}</strong> XP — <strong>${num(
        Math.round(r.partner.petXpPerDay),
      )}</strong> pet XP a day onto a <strong>${escapeHtml(r.partner.petName)}</strong>, one every ${
        r.partner.daysPerPet < 1
          ? `${(r.partner.daysPerPet * 24).toFixed(1)} hours`
          : `${num(Math.round(r.partner.daysPerPet))} days`
      }, worth <strong>${coins(Math.round(r.partner.profitPerDay))}</strong> a day on top. Only one pet is out at a
      time, so this is the two swapped — the ${escapeHtml(r.petName)} while you brew, the ${escapeHtml(
        r.partner.petName,
      )} while you collect — not two levelled at once.</div>`,
    );
  }
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
  return lines.join("") + petChoices(r);
}

/** How many runners-up an opened row offers. Five is the ask, and a sixth row is a list, not a hint. */
const PET_CHOICES = 5;

/**
 * The other pets worth putting on this minion, under the row that recommends one.
 *
 * This is what used to be a forty-row market table further down the page, and it was in the wrong
 * place: that table ranked every pet on the auction house against a rate the reader had to go and
 * find for themselves, so the pet it put at the top was frequently one this minion cannot level in
 * a lifetime. Ranked per minion instead, the question it answers is the one actually being asked —
 * "I am running this minion; what should I sit on it?" — and the answer is already computed,
 * because the plan chose its winner out of exactly this list.
 *
 * Compact on purpose. Everything here is a comparison against the row above, so it carries the
 * figures that differ between candidates — what the pet adds, how long one takes, whether its skill
 * matches and whether anybody is buying — and none of the arithmetic the detail above already gave.
 */
function petChoices(r: PetPlanRow): string {
  const forThisMinion = lastPairs.filter((p) => p.generator === r.generator);
  const skills = relevantSkills(r, forThisMinion);

  // One table per skill the minion feeds. Alchemy minions feed two — the brew and the collection —
  // and a single merged list would silently drop whichever skill had the weaker pets, which is the
  // exact thing that made the pairing wrong before.
  const blocks = skills
    .map((skill) => {
      const top = forThisMinion
        .filter((p) => p.skill === skill)
        .sort((a, b) => b.advantagePerDay - a.advantagePerDay)
        .slice(0, PET_CHOICES);
      if (top.length === 0) return "";

      const rows = top
        .map((p) => {
          const chosen = p.petKey === r.petKey && p.petRarity === r.petRarity && p.skill === r.skill;
          return `<tr class="${chosen ? "gold" : ""}${p.beatsSelling ? "" : " bz-faded"}">
            <td>${escapeHtml(p.petName)}<span class="dim"> ${escapeHtml(title(p.petRarity))}</span>${
              chosen ? `<span class="tag">chosen</span>` : ""
            }</td>
            <td class="num">${coins(p.buyPrice)}</td>
            <td class="num"><span class="${p.beatsSelling ? "gold" : "bleed on"}">${
              p.advantagePerDay >= 0 ? "+" : "−"
            }${coins(Math.abs(Math.round(p.advantagePerDay)))}</span></td>
            <td class="num">${p.daysPerPet < 1 ? `${(p.daysPerPet * 24).toFixed(1)} hr` : `${Math.round(p.daysPerPet)} d`}</td>
            <td class="num">${
              p.matched ? `<span class="dim">matches</span>` : `<span class="gold">mismatch</span>`
            }${p.petLiquidity === "ok" ? "" : ` <span class="gold" title="Few listings, or listings that have sat for days. The sell price is one person's asking price rather than a market.">thin</span>`}</td>
          </tr>`;
        })
        .join("");

      // Named after everything the route pays into, not just its largest share: a Tarantula Minion
      // heading "Combat" while half its XP is Mining reads as a mistake in the table rather than as
      // the two-skill minion it is.
      const feeds = top[0].feeds.length > 0 ? top[0].feeds : [skill];
      return `<div class="px-choices">
        <div class="gh-sub"><strong>${escapeHtml(feeds.map(title).join(" + "))}</strong> — best ${
          top.length === 1 ? "pet" : `${top.length} pets`
        } for what this minion feeds${skills.length > 1 ? (skill === "ALCHEMY" ? ", from brewing" : ", from collecting") : ""}</div>
        <table class="bz compact">
          <thead><tr>
            <th>Pet</th><th class="num">Buy at</th><th class="num">Adds</th><th class="num">Per pet</th><th class="num">Skill</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
    })
    .filter(Boolean)
    .join("");

  if (!blocks) return "";
  return `<div class="px-choicewrap">${blocks}</div>`;
}

/**
 * Which skills a minion's output can level a pet in — every one of them, not only the winner's.
 *
 * This used to read the recommended row alone, and that quietly deleted the minion's other plan.
 * A Sugar Cane Minion has two: collect it and level a Farming pet, or brew what you collect and
 * level an Alchemy pet. The direct one usually wins on coins because brewing eats the drops, and
 * the moment it did, the whole brewing option vanished from the page — the double action was
 * computed, ranked, and then never rendered. Reading the skills off the pairings that exist for
 * this minion rather than off the row that won puts both back, in the order they earn.
 */
function relevantSkills(r: PetPlanRow, pairs: PetPlanRow[]): SkillKey[] {
  const best = new Map<SkillKey, number>();
  for (const p of pairs) best.set(p.skill, Math.max(best.get(p.skill) ?? -Infinity, p.advantagePerDay));
  if (!best.has(r.skill)) best.set(r.skill, r.advantagePerDay);
  if (r.route === "brewing" && r.baseSkill && !best.has(r.baseSkill)) best.set(r.baseSkill, -Infinity);
  return [...best.entries()].sort((a, b) => b[1] - a[1]).map(([skill]) => skill);
}

const INTENT =
  "The best money from minion pet-levelling. This finds the minion and the pet that pay the most — counting " +
  "both the pet margin and everything the minion sells while it levels — and opening a row shows the other " +
  "pets worth sitting on it. Everything below the answer is optional.";

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
    held: "the best tool you are carrying for each skill",
    accessories: "your accessory bag",
    attributes: "attribute shards",
    slayers: "slayer tiers",
    cookie: "a Booster Cookie (+25 to every skill)",
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


    return `<div class="stat">
      <div class="stat-label">${escapeHtml(title(skill))}</div>
      <div class="stat-value${known ? " gold" : ""}">${value}</div>
      <div class="stat-sub">${escapeHtml(sub)}</div>
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

const ROUTE_COLUMNS: SortColumn<MinionXpRow>[] = [
  {
    id: "minion",
    label: "Minion",
    text: true,
    value: (r) => r.family,
    render: (r) => {
      // Every drop that pays, not just the biggest. A Voidling row reading "Obsidian" alone hides
      // that the quartz counts too, and a Tarantula row reading "Spider Eye" hides half its XP.
      const drops = r.contributions.length > 1 ? r.contributions.map((c) => c.itemName).join(" + ") : r.itemName;
      return `${escapeHtml(r.family)}<div class="dim bz-path">${escapeHtml(drops)}${
        r.route === "brewing" ? " · brewed" : ""
      }</div>`;
    },
  },
  {
    id: "skill",
    label: "Skill",
    text: true,
    title:
      "The skill the route's XP arrives in. Two of them where the minion's drops are not all the same skill — one " +
      "pet takes both, the matching share at full rate and the rest at a third.",
    value: (r) => r.skill,
    render: (r) => escapeHtml([...new Set(r.contributions.map((c) => c.skill))].map(title).join(" + ") || title(r.skill)),
  },
  {
    id: "xpperitem",
    label: "XP/item",
    title:
      "Skill XP one drop is worth on this route. For a brewing row this is the brew's yield divided by the drops " +
      "one brewing ingredient costs — Enchanted Sugar Cane is 25,600 sugar cane, so its 15,000 XP is well under " +
      "one XP a drop.",
    value: (r) => r.xpPerItem,
    render: (r) => (r.xpPerItem >= 1 ? r.xpPerItem.toFixed(1) : r.xpPerItem.toFixed(3)),
  },
  { id: "skillxp", label: "Skill xp/hr", value: (r) => r.skillXpPerHour, render: (r) => num(Math.round(r.skillXpPerHour)) },
  { id: "petxp", label: "Pet xp/hr", value: (r) => r.petXpPerHour, render: (r) => num(Math.round(r.petXpPerHour)) },
];

function routesTable(all: MinionXpRow[]): string {
  const usable = all.filter((r) => r.petXpPerHour > 0 || r.skillXpPerHour > 0);
  if (usable.length === 0) return `<p class="dim pad">No minion has a published XP rate at this setup.</p>`;

  const body = sortRows("routes", usable, ROUTE_COLUMNS)
    .slice(0, 60)
    .map((r) => `<tr>${ROUTE_COLUMNS.map((c, i) => `<td class="${i < 2 ? "" : "num"}">${c.render(r)}</td>`).join("")}</tr>`)
    .join("");

  return `<div class="panel scroll" style="margin-top:8px">
    <table class="bz">
      <thead><tr>${headerHtml("routes", ROUTE_COLUMNS)}</tr></thead>
      <tbody>${body}</tbody>
    </table>
  </div>`;
}

/* ----------------------------------------------------------- the pet half */

/**
 * What is left of the pet half once its table moved into the plan.
 *
 * There used to be a forty-row market list here, ranking every pet on the auction house on coins
 * per point of Pet XP. It was the wrong shape for the question: it ranked pets against a rate the
 * reader had to go and find in another table, so its top row was routinely a pet no minion on the
 * page can level this side of a year. Those rankings now sit under the minion they belong to, five
 * at a time, where the rate is already known — see `petChoices`.
 *
 * What genuinely belongs to the whole tab rather than to one row is the sweep itself: whether it
 * has run, how it is going, and how to run it again. That is all this renders now.
 */
function renderPets(): void {
  const target = document.getElementById("pxpets");
  if (!target) return;

  if (state.scanning) {
    const pct = state.scanTotal ? Math.round((state.scanned / state.scanTotal) * 100) : 0;
    target.innerHTML = `<div class="busy">Sweeping the auction house — page ${num(state.scanned)} of ${num(
      state.scanTotal || 1,
    )} (${pct}%)</div>`;
    return;
  }

  if (!state.pets) {
    target.innerHTML = `<p class="dim pad">${PET_NOTE}</p>
      ${state.scanError ? `<div class="error">${escapeHtml(state.scanError)}</div>` : ""}
      <div class="tabs"><button class="chip" id="pxscan">Read the auction house</button></div>`;
    return;
  }

  const priced = petRows().length;
  const scanned = new Date(state.pets.scannedAt).toLocaleTimeString();
  target.innerHTML = `
    <p class="dim pad">${num(priced)} pets priced at both ends of their ladder ·
      ${num(state.pets.listings)} pet listings read from ${num(state.pets.pages)} pages at ${escapeHtml(scanned)} ·
      open any row in the plan for the best pets to put on that minion</p>
    <div class="tabs"><button class="chip" id="pxscan">Read the auction house again</button></div>
  `;
}

const PET_NOTE =
  "Buy a pet cheap, level it, sell it dear. Both ends are the cheapest listing right now: the buy side is a " +
  "price you can pay, the sell side is a price you would have to undercut. Reading the whole auction house is " +
  "about a hundred megabytes, so it happens on the button rather than on arrival, and the result is cached for " +
  "ten minutes.";

function title(key: string): string {
  return key.charAt(0) + key.slice(1).toLowerCase();
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
