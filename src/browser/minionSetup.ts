import type { Basis } from "../lib/minionProfit";
import type { Trust } from "../lib/priceVariance";

/**
 * The wall of minions, described once.
 *
 * Raw profits and Pet profits are two questions about the same minions, and each used to keep its
 * own copy of the answer: its own tier, its own count, its own fuel and upgrades, under its own
 * localStorage keys. So the two tabs drifted apart the moment anybody touched one of them — a
 * Tarantula Minion read 5.8M a day on one tab and 4.6M on the other, and the whole difference was
 * that one was set to tier XII and the other to tier XI. Nothing in either tab said so.
 *
 * Worse, Pet profits only had five of the controls. The chest, the compactor, the hopper and the
 * claim interval were hardcoded there, so even with the five it did have set identically the two
 * tabs could not be made to agree.
 *
 * One setup, one set of keys. Each tab reads it when it mounts and writes through it when a
 * control changes, so switching between them carries the wall across intact.
 */

export type MinionSetupState = {
  count: string;
  tier: number;
  fuel: string;
  /** As typed. `slot2` is only reached when no compactor is fitted — see `slotIds`. */
  upgrades: [string, string];
  chest: string;
  compactor: string;
  hopper: string;
  /** Hours between visits, as typed. "8", "24", "168". */
  claim: string;
  basis: Basis;
  trust: Trust;
};

/** Eight hours: a night, which is when a minion is doing the work you are not. */
export const DEFAULT_CLAIM = "8";

const KEYS = {
  count: "sbxp:mpcount",
  tier: "sbxp:mptier",
  fuel: "sbxp:mpfuel",
  up0: "sbxp:mpup0",
  up1: "sbxp:mpup1",
  chest: "sbxp:mpchest",
  compactor: "sbxp:mpcomp",
  hopper: "sbxp:mphopper",
  claim: "sbxp:mpclaim",
  basis: "sbxp:mpbasis",
  trust: "sbxp:mptrust",
} as const;

export function readSetup(): MinionSetupState {
  return {
    count: localStorage.getItem(KEYS.count) ?? "5",
    tier: Number(localStorage.getItem(KEYS.tier) ?? 12),
    fuel: localStorage.getItem(KEYS.fuel) ?? "NONE",
    upgrades: [localStorage.getItem(KEYS.up0) ?? "NONE", localStorage.getItem(KEYS.up1) ?? "NONE"],
    chest: localStorage.getItem(KEYS.chest) ?? "NONE",
    compactor: localStorage.getItem(KEYS.compactor) ?? "SUPER_COMPACTOR_3000",
    hopper: localStorage.getItem(KEYS.hopper) ?? "NONE",
    claim: localStorage.getItem(KEYS.claim) ?? DEFAULT_CLAIM,
    basis: (localStorage.getItem(KEYS.basis) as Basis) ?? "instasell",
    trust: (localStorage.getItem(KEYS.trust) as Trust) ?? "guarded",
  };
}

/** Persist one field, so the other tab picks it up the next time it mounts. */
export function writeSetup<K extends keyof MinionSetupState>(field: K, value: MinionSetupState[K]): void {
  try {
    if (field === "upgrades") {
      const [first, second] = value as [string, string];
      localStorage.setItem(KEYS.up0, first);
      localStorage.setItem(KEYS.up1, second);
      return;
    }
    localStorage.setItem(KEYS[field as Exclude<keyof MinionSetupState, "upgrades">], String(value));
  } catch {
    // A browser refusing storage costs the setting on reload and nothing this session.
  }
}

/** How many of the one minion are down. Never zero: a wall of none is a question with no answer. */
export function placedCount(setup: MinionSetupState): number {
  return Math.max(1, Number(setup.count.replace(/[^0-9]/g, "")) || 1);
}

/**
 * What is actually in the two upgrade slots, as ids.
 *
 * A compactor is a Minion Upgrade and does take one of the two slots, so choosing one spends the
 * second slot whatever the second dropdown last held. Enforcing it here rather than in each tab's
 * controls means a value left in storage from before a compactor was picked cannot quietly buy the
 * setup a Flycatcher it does not have — on either tab.
 */
export function slotIds(setup: MinionSetupState, compactors: { id: string; kind: string }[]): [string, string] {
  // Judged on the compactor's own kind rather than on its id, so an id that is not in the table
  // reads as no compactor — the same fallback resolving it would give — instead of silently
  // spending the second slot on a compactor that does not exist.
  const fitted = compactors.find((c) => c.id === setup.compactor)?.kind ?? "none";
  return fitted === "none" ? [setup.upgrades[0], setup.upgrades[1]] : [setup.upgrades[0], "NONE"];
}
