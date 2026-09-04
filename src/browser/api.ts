import type { BazaarProduct, BinIndex, GardenState, MuseumState, ProfileMember, SkyblockProfile } from "../lib/profile";
import { absorbAuctionPage, createBinIndex, type AuctionRecord } from "../lib/auctions";
import { bagCapacityFrom, bagItemsFrom, itemIdsFrom, readNbt } from "../lib/nbt";
import type { BagItem } from "../lib/gameData";

/**
 * Talking to Hypixel straight from the page, with no server in between.
 *
 * This works because Hypixel's CORS policy is fully open — the preflight explicitly allows the
 * API-Key header — so a file:// page can call it directly. Mojang does *not* send CORS headers,
 * which is why the name lookup goes through a mirror that does.
 */

const API = "https://api.hypixel.net/v2";

export class ApiError extends Error {}

/* ------------------------------------------------------------------- cache */

/**
 * Derived results are cached in localStorage, so reopening the file doesn't re-download
 * anything. Only the small distilled outputs are stored — never the raw 100MB of auction pages.
 */
const CACHE_PREFIX = "sbxp:";

function cacheGet<T>(key: string, maxAgeMs: number): T | null {
  try {
    const raw = localStorage.getItem(CACHE_PREFIX + key);
    if (!raw) return null;
    const entry = JSON.parse(raw) as { at: number; value: T };
    if (Date.now() - entry.at > maxAgeMs) return null;
    return entry.value;
  } catch {
    return null;
  }
}

function cacheSet(key: string, value: unknown): void {
  try {
    localStorage.setItem(CACHE_PREFIX + key, JSON.stringify({ at: Date.now(), value }));
  } catch {
    // Storage full or blocked (some browsers block it on file://). Caching is a nicety.
  }
}

export function cacheAge(key: string): number | null {
  try {
    const raw = localStorage.getItem(CACHE_PREFIX + key);
    if (!raw) return null;
    return Date.now() - (JSON.parse(raw) as { at: number }).at;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ hypixel */

async function hypixel<T>(path: string, key?: string): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API}${path}`, { headers: key ? { "API-Key": key } : {} });
  } catch {
    // A network-level failure here is almost always the browser blocking the request.
    throw new ApiError("Could not reach the Hypixel API. Check your connection.");
  }

  if (response.status === 403) throw new ApiError("Hypixel rejected the API key. Check the key field.");
  if (response.status === 429) throw new ApiError("Hypixel rate limit reached — wait a minute and retry.");
  if (!response.ok) throw new ApiError(`Hypixel returned ${response.status} for ${path}`);

  const body = (await response.json()) as T & { success?: boolean; cause?: string };
  if (body.success === false) throw new ApiError(body.cause ?? "Hypixel rejected the request");
  return body;
}

/* ------------------------------------------------------------ name -> uuid */

/**
 * Mojang's own endpoints send no Access-Control-Allow-Origin, so the browser blocks them.
 * These two mirrors both allow any origin; try one, fall back to the other.
 */
export async function resolveUuid(input: string): Promise<{ uuid: string; name: string }> {
  const clean = input.trim();
  const bare = clean.replace(/-/g, "");
  if (/^[0-9a-f]{32}$/i.test(bare)) return { uuid: bare.toLowerCase(), name: clean };
  if (!/^\w{1,16}$/.test(clean)) throw new ApiError(`"${input}" is not a valid username`);

  const cached = cacheGet<{ uuid: string; name: string }>(`uuid:${clean.toLowerCase()}`, 7 * 24 * 3600_000);
  if (cached) return cached;

  const attempts: (() => Promise<{ uuid: string; name: string }>)[] = [
    async () => {
      const r = await fetch(`https://api.ashcon.app/mojang/v2/user/${encodeURIComponent(clean)}`);
      if (r.status === 404) throw new ApiError(`No Minecraft account named "${clean}"`);
      if (!r.ok) throw new ApiError(`Name lookup failed (${r.status})`);
      const body = (await r.json()) as { uuid: string; username: string };
      return { uuid: body.uuid.replace(/-/g, "").toLowerCase(), name: body.username };
    },
    async () => {
      const r = await fetch(`https://playerdb.co/api/player/minecraft/${encodeURIComponent(clean)}`);
      if (!r.ok) throw new ApiError(`Name lookup failed (${r.status})`);
      const body = (await r.json()) as { data?: { player?: { id: string; username: string } } };
      const player = body.data?.player;
      if (!player) throw new ApiError(`No Minecraft account named "${clean}"`);
      return { uuid: player.id.replace(/-/g, "").toLowerCase(), name: player.username };
    },
  ];

  let lastError: unknown = null;
  for (const attempt of attempts) {
    try {
      const result = await attempt();
      cacheSet(`uuid:${clean.toLowerCase()}`, result);
      return result;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof ApiError ? lastError : new ApiError(`Could not look up "${clean}"`);
}

/* ---------------------------------------------------------------- profiles */

export async function fetchProfiles(uuid: string, key: string): Promise<SkyblockProfile[]> {
  const body = await hypixel<{ profiles: SkyblockProfile[] | null }>(`/skyblock/profiles?uuid=${uuid}`, key);
  if (!body.profiles?.length) throw new ApiError("That account has no SkyBlock profiles");
  return body.profiles;
}

/* ------------------------------------------------------------------ museum */

/** Which items this profile has already donated. Undocumented endpoint, same open CORS. */
export async function fetchMuseum(profileId: string, uuid: string, key: string): Promise<MuseumState | null> {
  try {
    const body = await hypixel<{
      members?: Record<
        string,
        { items?: Record<string, unknown>; special?: { items?: { data?: string } }[]; value?: number }
      >;
    }>(`/skyblock/museum?profile=${profileId}`, key);
    const member = body.members?.[uuid];
    if (!member) return null;

    // Special donations are stored as gzipped item blobs rather than keyed by id, so they have
    // to be decoded to be counted at all.
    const special = new Set<string>();
    for (const entry of member.special ?? []) {
      if (!entry?.items?.data) continue;
      try {
        for (const id of await itemIdsIn(entry.items.data)) special.add(id);
      } catch {
        // One unreadable blob shouldn't cost the whole museum.
      }
    }

    return {
      donatedItemIds: new Set(Object.keys(member.items ?? {})),
      specialItemIds: special,
      value: member.value ?? 0,
    };
  } catch {
    // Museum data is opt-in per player; a refusal just means donations stay unmarked.
    return null;
  }
}

/** The garden belongs to the co-op, not to one member, so it has its own endpoint. */
export async function fetchGarden(profileId: string, key: string): Promise<GardenState | null> {
  try {
    const body = await hypixel<{
      garden?: {
        unlocked_plots_ids?: string[];
        crop_upgrade_levels?: Record<string, number>;
        composter_data?: { upgrades?: Record<string, number> };
      };
    }>(`/skyblock/garden?profile=${profileId}`, key);
    if (!body.garden) return null;
    return {
      unlockedPlots: body.garden.unlocked_plots_ids?.length ?? 0,
      cropUpgrades: body.garden.crop_upgrade_levels ?? {},
      composterUpgrades: body.garden.composter_data?.upgrades ?? {},
    };
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ bazaar */

export async function fetchBazaar(force = false): Promise<Record<string, BazaarProduct>> {
  const cached = force ? null : cacheGet<Record<string, BazaarProduct>>("bazaar", 60_000);
  if (cached) return cached;
  const body = await hypixel<{ products: Record<string, BazaarProduct> }>("/skyblock/bazaar");
  // Only the prices we actually price against — the full payload is 3.5MB and won't fit.
  // Keep only what something actually prices against, and only the price fields — the raw
  // payload is 3.5MB of order books that would blow the localStorage quota. Minion recipes pull
  // from the whole catalogue, so this can't be a short prefix list any more; dropping
  // quick_status alone takes it to a few hundred KB.
  const trimmed: Record<string, BazaarProduct> = {};
  for (const [id, product] of Object.entries(body.products)) {
    if (!product.quick_status) continue;
    trimmed[id] = { quick_status: product.quick_status };
  }
  cacheSet("bazaar", trimmed);
  return trimmed;
}

/* ---------------------------------------------------------------- auctions */

/**
 * The full auction house is ~49 pages and about 100MB on the wire. We stream it a batch at a
 * time, keep only the accessory prices, and cache that small result — so this is a once-per-ten-
 * minutes cost, not a per-plan one.
 */
export async function fetchAccessoryBins(
  nameToId: Map<string, string>,
  onProgress: (done: number, total: number) => void,
  force = false,
): Promise<BinIndex> {
  const cached = force ? null : cacheGet<BinIndex>("bins", 10 * 60_000);
  if (cached) return cached;

  const first = await hypixel<{ totalPages: number; auctions: AuctionRecord[] }>("/skyblock/auctions?page=0");
  const index = createBinIndex();
  absorbAuctionPage(index, first.auctions, nameToId);
  const total = first.totalPages;
  onProgress(1, total);

  const CONCURRENCY = 6;
  const rest = Array.from({ length: total - 1 }, (_, i) => i + 1);
  for (let i = 0; i < rest.length; i += CONCURRENCY) {
    const batch = await Promise.all(
      rest.slice(i, i + CONCURRENCY).map((page) =>
        hypixel<{ auctions: AuctionRecord[] }>(`/skyblock/auctions?page=${page}`).catch(() => ({
          auctions: [] as AuctionRecord[],
        })),
      ),
    );
    for (const page of batch) absorbAuctionPage(index, page.auctions, nameToId);
    onProgress(Math.min(i + 1 + CONCURRENCY, total), total);
  }

  cacheSet("bins", index);
  return index;
}

/* -------------------------------------------------------------- bag decode */

function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * The raw lore text of a gzipped inventory blob.
 *
 * Wisdom is stated in item lore and nowhere else in a profile, so reading it means reaching the
 * strings rather than the item ids. Walking the NBT properly would mean threading a lore accessor
 * through `bagItemsFrom`; the decompressed blob is already a UTF-8 string containing every lore
 * line, and a scan over it finds exactly the same lines. That is enough for summing a stat, and it
 * costs one function instead of a new shape through three.
 *
 * The one thing it must get right is the encoding: these are UTF-8 bytes carrying section signs,
 * and decoding them as latin1 turns `§3+1` into mojibake that no pattern matches.
 */
export async function readLore(data: string | undefined): Promise<string> {
  if (!data) return "";
  try {
    const stream = new Blob([base64ToBytes(data)]).stream().pipeThrough(new DecompressionStream("gzip"));
    const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
    return new TextDecoder("utf-8").decode(bytes);
  } catch {
    // An unreadable blob costs that blob's wisdom and nothing else.
    return "";
  }
}

/**
 * Decode the talisman bag. Gzip is the only step Node and the browser do differently — the
 * browser has DecompressionStream, Node has zlib, and the NBT walk after it is shared.
 */
export async function readBag(data: string | undefined): Promise<{ items: BagItem[] | null; capacity: number }> {
  // No stored bag is a real, readable answer: the player has no accessories bagged.
  if (!data) return { items: [], capacity: 0 };
  try {
    const stream = new Blob([base64ToBytes(data)]).stream().pipeThrough(new DecompressionStream("gzip"));
    const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
    const root = readNbt(bytes);
    return { items: bagItemsFrom(root), capacity: bagCapacityFrom(root) };
  } catch {
    // A bag we can't read is a bag we report as unknown, not one we pretend is empty.
    return { items: null, capacity: 0 };
  }
}

/**
 * Every item id the player is holding, across the inventory, ender chest, backpacks, wardrobe,
 * vault, equipment and the bags. A museum donation costs nothing when the item is already in
 * hand — the auction price is what it would cost to go and buy one, which is the wrong number
 * for something sitting in your ender chest.
 *
 * Inventories are the one part of a profile a player can switch off in their API settings. An
 * empty set is then indistinguishable from an empty inventory, so this returns null when the
 * profile publishes nothing at all and the caller prices as before rather than guessing.
 */
export async function readOwnedItems(member: ProfileMember): Promise<Set<string> | null> {
  const inventory = member.inventory;
  if (!inventory) return null;

  const blobs: (string | undefined)[] = [
    inventory.inv_contents?.data,
    inventory.inv_armor?.data,
    inventory.ender_chest_contents?.data,
    inventory.wardrobe_contents?.data,
    inventory.personal_vault_contents?.data,
    inventory.equipment_contents?.data,
    ...Object.values(inventory.backpack_contents ?? {}).map((page) => page?.data),
    ...Object.values(inventory.bag_contents ?? {}).map((bag) => bag?.data),
  ];

  const present = blobs.filter((data): data is string => Boolean(data));
  if (present.length === 0) return null;

  const owned = new Set<string>();
  for (const data of present) {
    try {
      for (const id of await itemIdsIn(data)) owned.add(id);
    } catch {
      // One unreadable blob shouldn't cost the rest of the inventory.
    }
  }
  return owned;
}

/** Item ids inside a gzipped NBT blob — the same decode readBag does, without the bag parts. */
async function itemIdsIn(data: string): Promise<string[]> {
  const stream = new Blob([base64ToBytes(data)]).stream().pipeThrough(new DecompressionStream("gzip"));
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  return itemIdsFrom(readNbt(bytes));
}

/* --------------------------------------------------------- reference prices */

const REFERENCE_FEED = "https://raw.githubusercontent.com/SkyHelperBot/Prices/main/pricesV2.json";

/**
 * A price per item id for things the auction house isn't listing.
 *
 * Most museum donations aren't on the auction house at any given moment, so pricing them from
 * listings alone drops them out of every ranking entirely — which is why the museum's "cheapest
 * per XP" was missing its cheap half. This is SkyHelper's public price feed: a static JSON file
 * on GitHub, no key and no rate limit, updated by the bot that publishes it.
 *
 * It is a reference, not an offer, so callers only fall back to it and rows priced from it are
 * marked. A failure here is not fatal: the app simply goes back to listing-only prices.
 */
export async function fetchReferencePrices(force = false): Promise<Record<string, number>> {
  const cached = force ? null : cacheGet<Record<string, number>>("reference", 6 * 3600_000);
  if (cached) return cached;
  try {
    const res = await fetch(REFERENCE_FEED);
    if (!res.ok) return {};
    const body = (await res.json()) as Record<string, number>;
    const trimmed: Record<string, number> = {};
    for (const [id, price] of Object.entries(body)) {
      if (typeof price === "number" && price > 0) trimmed[id] = Math.round(price);
    }
    cacheSet("reference", trimmed);
    return trimmed;
  } catch {
    return {};
  }
}
