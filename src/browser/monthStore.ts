import type { Basis } from "../lib/minionProfit";
import type { Variance } from "../lib/priceVariance";

/**
 * A month of bazaar history, shared between every tab that prices a minion's output.
 *
 * It lives here rather than inside the tab that fetches it for two reasons, and the second one is
 * the bug that prompted it.
 *
 * **One sweep, not two.** Coflnet's history is a request per item and the tabs want the same
 * items. Raw profits fetches them; Pet profits reads what Raw profits left behind. A tab that has
 * never been opened simply has no month, which is the honest state and not an error.
 *
 * **One verdict.** Pet profits used to pass an empty map and `trust: "live"`, so the "Just
 * selling" column it prints was the raw quote with no guard on it at all, while the Raw profits
 * tab beside it guarded the same item by default. The same minion then earned two different
 * amounts on two tabs — and the unguarded one was the larger, because the whole point of the guard
 * is to stop believing a spike.
 */

/**
 * Both sides of one item's month, because the two bazaar bases quote different books.
 *
 * The guard compares today's quote against the month of *that same quote*. Instaselling reads the
 * top buy order and Coflnet's `sell`; standing a sell offer reads the top sell offer and Coflnet's
 * `buy`. Judging an ask against a month of bids puts every item several sigma out — the bid-ask
 * spread alone is usually wider than a month's own movement — so the guard fired on everything and
 * substituted the *bid* median, which is why "Sell offer" and "Instasell" came back the same
 * number. Both come out of one response, so keeping both costs no extra requests.
 */
export type Months = { sell: Variance | null; buy: Variance | null };

export type MonthStore = { fetchedAt: number; variance: Record<string, Months> };

/**
 * Bumped whenever the stored shape changes.
 *
 * A stale entry is fresh enough to suppress a refetch for six hours, so a changed shape without a
 * changed key leaves everybody who has used the tab reading a cache that no longer means what it
 * says. Retiring the old key costs one round of requests, which is cheaper than a cache that lies.
 */
export const HISTORY_KEY = "sbxp:mpmonths3";

export function readMonths(): { months: Map<string, Months>; fetchedAt: number } {
  try {
    const store = JSON.parse(localStorage.getItem(HISTORY_KEY) ?? "null") as MonthStore | null;
    if (!store?.variance) return { months: new Map(), fetchedAt: 0 };
    return { months: new Map(Object.entries(store.variance)), fetchedAt: store.fetchedAt };
  } catch {
    return { months: new Map(), fetchedAt: 0 };
  }
}

export function writeMonths(store: MonthStore): void {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(store));
  } catch {
    // In memory is enough for this session; losing it on reload costs one round of requests.
  }
}

/** The month that matches what is being quoted, or null where Coflnet has no series for it. */
export function monthFor(months: Map<string, Months>, id: string | null, basis: Basis): Variance | null {
  if (!id) return null;
  const found = months.get(id);
  if (!found) return null;
  return basis === "order" ? found.buy : found.sell;
}

/** Every item's month on the side one basis quotes, which is the shape `planProfit` guards on. */
export function monthsForBasis(months: Map<string, Months>, basis: Basis): Map<string, Variance> {
  const out = new Map<string, Variance>();
  for (const id of months.keys()) {
    const month = monthFor(months, id, basis);
    if (month) out.set(id, month);
  }
  return out;
}
