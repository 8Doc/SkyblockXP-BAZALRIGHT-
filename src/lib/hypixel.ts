import "server-only";
import type { BazaarProduct, BinIndex, MuseumState, ProfileMember, SkyblockProfile } from "./profile";
import { absorbAuctionPage, createBinIndex, type AuctionRecord } from "./auctions";

export type { BazaarProduct, BinIndex, MuseumState, ProfileMember, SkyblockProfile };

/**
 * Hypixel + Mojang access. Everything goes through one TTL cache with in-flight
 * de-duplication, so a burst of page loads costs one upstream request.
 *
 * Budget: 300 requests / 5 min. A bazaar refresh is 1, a profile fetch is 1, and a
 * full auction sweep is ~49 — so the auction TTL is the only one worth being careful
 * about, and it is both the longest and lazily triggered.
 */

const API = "https://api.hypixel.net/v2";

const TTL = {
  bazaar: 60_000, // README: 60s is plenty, these don't move fast enough to change a ranking
  profiles: 5 * 60_000,
  auctions: 10 * 60_000,
  mojang: 24 * 60 * 60_000,
};

type Entry<T> = { value: T; expires: number };
const cache = new Map<string, Entry<unknown>>();
const inflight = new Map<string, Promise<unknown>>();

async function memo<T>(key: string, ttl: number, fn: () => Promise<T>): Promise<T> {
  const hit = cache.get(key) as Entry<T> | undefined;
  if (hit && hit.expires > Date.now()) return hit.value;

  const running = inflight.get(key) as Promise<T> | undefined;
  if (running) return running;

  const p = (async () => {
    try {
      const value = await fn();
      cache.set(key, { value, expires: Date.now() + ttl });
      return value;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, p);
  return p;
}

/** Drop cached price feeds so the next call re-fetches. Profiles are left alone. */
export function invalidatePrices(): void {
  cache.delete("bazaar");
  cache.delete("auctions:accessories");
}

export class HypixelError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

function apiKey(): string {
  const key = process.env.HYPIXEL_API_KEY;
  if (!key) throw new HypixelError("HYPIXEL_API_KEY is not set (see .env.example)", 500);
  return key;
}

async function get<T>(path: string, auth = true): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    headers: auth ? { "API-Key": apiKey() } : {},
    cache: "no-store",
  });
  if (res.status === 429) throw new HypixelError("Hypixel rate limit hit — try again shortly", 429);
  if (!res.ok) throw new HypixelError(`Hypixel ${path} returned ${res.status}`, res.status);
  const body = (await res.json()) as T & { success?: boolean; cause?: string };
  if (body.success === false) throw new HypixelError(body.cause ?? "Hypixel request failed", 502);
  return body;
}

/* ------------------------------------------------------------------ mojang */

export async function resolveUuid(username: string): Promise<{ uuid: string; name: string }> {
  const clean = username.trim();
  if (/^[0-9a-f]{32}$/i.test(clean.replace(/-/g, ""))) {
    return { uuid: clean.replace(/-/g, "").toLowerCase(), name: clean };
  }
  if (!/^\w{1,16}$/.test(clean)) throw new HypixelError(`"${username}" is not a valid username`, 400);

  return memo(`mojang:${clean.toLowerCase()}`, TTL.mojang, async () => {
    const res = await fetch(`https://api.minecraftservices.com/minecraft/profile/lookup/name/${clean}`, {
      cache: "no-store",
    });
    if (res.status === 404) throw new HypixelError(`No Minecraft account named "${clean}"`, 404);
    if (!res.ok) throw new HypixelError(`Mojang lookup failed (${res.status})`, res.status);
    const body = (await res.json()) as { id: string; name: string };
    return { uuid: body.id.replace(/-/g, "").toLowerCase(), name: body.name };
  });
}

/* ------------------------------------------------------------------ bazaar */

export async function bazaar(): Promise<Record<string, BazaarProduct>> {
  return memo("bazaar", TTL.bazaar, async () => {
    const body = await get<{ products: Record<string, BazaarProduct> }>("/skyblock/bazaar", false);
    return body.products;
  });
}

/* ---------------------------------------------------------------- profiles */

export async function profiles(uuid: string): Promise<SkyblockProfile[]> {
  return memo(`profiles:${uuid}`, TTL.profiles, async () => {
    const body = await get<{ profiles: SkyblockProfile[] | null }>(`/skyblock/profiles?uuid=${uuid}`);
    if (!body.profiles?.length) throw new HypixelError("That account has no SkyBlock profiles", 404);
    return body.profiles;
  });
}

/* ------------------------------------------------------------------ museum */

/**
 * Which items a profile has already donated. Undocumented but public: /skyblock/museum takes a
 * profile id and returns each member's donated item ids, which is the completion half of the
 * museum category (the XP half comes from the items resource).
 */
export async function museum(profileId: string, uuid: string): Promise<MuseumState | null> {
  return memo(`museum:${profileId}:${uuid}`, TTL.profiles, async () => {
    try {
      const body = await get<{ members?: Record<string, { items?: Record<string, unknown>; value?: number }> }>(
        `/skyblock/museum?profile=${profileId}`,
      );
      const member = body.members?.[uuid];
      if (!member) return null;
      return { donatedItemIds: new Set(Object.keys(member.items ?? {})), value: member.value ?? 0 };
    } catch {
      // Museum data is opt-in per player; a refusal just means we can't mark donations done.
      return null;
    }
  });
}

/* ---------------------------------------------------------------- auctions */

/**
 * Lowest BIN per accessory. The auction endpoint doesn't carry SkyBlock item ids — they're
 * buried in gzipped NBT on every listing — but accessories are exactly the case where we can
 * skip that: filter to category "accessories" (~14% of listings) and suffix-match the display
 * name against the items resource, since a reforge only ever prepends a word.
 */
export async function accessoryBins(nameToId: Map<string, string>): Promise<BinIndex> {
  return memo("auctions:accessories", TTL.auctions, async () => {
    const first = await get<{ totalPages: number; auctions: AuctionRecord[] }>("/skyblock/auctions?page=0", false);
    const pages = first.totalPages;
    const index = createBinIndex();
    absorbAuctionPage(index, first.auctions, nameToId);

    // 8 at a time: fast enough to finish in a few seconds, gentle enough on the rate limit.
    const rest = Array.from({ length: pages - 1 }, (_, i) => i + 1);
    const CONCURRENCY = 8;
    for (let i = 0; i < rest.length; i += CONCURRENCY) {
      const batch = await Promise.all(
        rest.slice(i, i + CONCURRENCY).map((p) =>
          get<{ auctions: AuctionRecord[] }>(`/skyblock/auctions?page=${p}`, false).catch(() => ({
            auctions: [] as AuctionRecord[],
          })),
        ),
      );
      for (const page of batch) absorbAuctionPage(index, page.auctions, nameToId);
    }

    return index;
  });
}
