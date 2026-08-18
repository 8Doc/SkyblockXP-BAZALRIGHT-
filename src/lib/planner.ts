import "server-only";
import { gunzipSync } from "node:zlib";
import { accessoryBins, bazaar, garden, invalidatePrices, museum, profiles, resolveUuid, HypixelError } from "./hypixel";
import { coopProgress, type ProfileMember, type SkyblockProfile } from "./profile";
import { auctionNameIndex, type BagItem } from "./gameData";
import { bagCapacityFrom, bagItemsFrom, readNbt } from "./nbt";
import { petsFrom } from "./auctions";
import { buildCatalog } from "./catalog";
import { buildReport, type Report } from "./report";
import type { PriceBook } from "./resolve";
import type { ReportOptions } from "./report";
import { staticData } from "./staticData";
import type { Category } from "./types";

export type PlannerInput = {
  username: string;
  profileId?: string;
  targetXp: number;
  minXp: number;
  budget: number | null;
  categories: Category[];
  strategy: "greedy" | "exact";
  packageSize: number;
  packageCount: number;
  /** Ignore cached prices and re-pull them. */
  refresh?: boolean;
};

export type PlannerResult = Report & {
  player: { name: string; uuid: string };
  profiles: { id: string; name: string; selected: boolean; gameMode?: string }[];
  profile: { id: string; name: string };
  sources: {
    bazaarItems: number;
    binItems: number;
    binListings: number;
    binScannedAt: number | null;
    generatedAt: string;
  };
};

export async function runPlanner(input: PlannerInput): Promise<PlannerResult> {
  const { uuid, name } = await resolveUuid(input.username);
  const all = await profiles(uuid);

  const profile = pickProfile(all, input.profileId);
  const member = profile.members[uuid];
  if (!member) throw new HypixelError(`No member data for ${name} on profile ${profile.cute_name}`, 404);

  if (input.refresh) invalidatePrices();

  const data = staticData();
  // Museum, pets, accessories and travel scrolls all price off the same auction sweep.
  const wantsAuctions = ["accessory_bag", "museum", "pets", "fast_travel"].some((c) =>
    input.categories.includes(c as Category),
  );
  const [bz, bins, museumState, gardenState] = await Promise.all([
    bazaar(),
    wantsAuctions ? accessoryBins(auctionNameIndex(data)).catch(() => null) : Promise.resolve(null),
    museum(profile.profile_id, uuid),
    garden(profile.profile_id),
  ]);

  const book: PriceBook = { bazaar: bz, bins };
  const options: ReportOptions = {
    targetXp: input.targetXp,
    minXp: input.minXp,
    budget: input.budget,
    categories: new Set(input.categories),
    strategy: input.strategy,
    packageSize: input.packageSize,
    packageCount: input.packageCount,
  };

  const bag = readBag(member);
  const catalog = buildCatalog(
    member,
    data,
    bag,
    museumState,
    bins ? petsFrom(bins) : null,
    gardenState,
    coopProgress(profile),
  );
  const report = buildReport(catalog, book, options);

  return {
    ...report,
    player: { name, uuid },
    profiles: all.map((p) => ({
      id: p.profile_id,
      name: p.cute_name,
      selected: Boolean(p.selected),
      gameMode: p.game_mode,
    })),
    profile: { id: profile.profile_id, name: profile.cute_name },
    sources: {
      bazaarItems: Object.keys(bz).length,
      binItems: bins ? Object.keys(bins.prices).length : 0,
      binListings: bins?.listings ?? 0,
      binScannedAt: bins?.scannedAt ?? null,
      generatedAt: data.skills.generatedAt,
    },
  };
}

/**
 * Decode the talisman bag. Gzip is the one step that differs between Node and the browser —
 * everything after this is shared with the standalone build.
 */
function readBag(member: ProfileMember): { items: BagItem[] | null; capacity: number } {
  const data = member.inventory?.bag_contents?.talisman_bag?.data;
  // No stored bag is a real, readable answer: the player has no accessories bagged.
  if (!data) return { items: [], capacity: 0 };
  try {
    const root = readNbt(gunzipSync(Buffer.from(data, "base64")));
    return { items: bagItemsFrom(root), capacity: bagCapacityFrom(root) };
  } catch {
    // A bag we can't read is a bag we report as unknown, not one we pretend is empty.
    return { items: null, capacity: 0 };
  }
}

function pickProfile(all: SkyblockProfile[], wanted?: string): SkyblockProfile {
  if (wanted) {
    const match = all.find((p) => p.profile_id === wanted || p.cute_name.toLowerCase() === wanted.toLowerCase());
    if (match) return match;
  }
  return all.find((p) => p.selected) ?? all[0];
}
