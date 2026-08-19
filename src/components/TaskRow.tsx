"use client";

import type { ResolvedTask } from "@/lib/types";
import { coins, rate } from "@/lib/format";

/** Warmer as the grind gets longer. */
const EFFORT_COLOUR: Record<string, string> = {
  quick: "text-aqua/80",
  short: "text-slate-300",
  long: "text-gold/80",
  marathon: "text-rose/80",
};

function effortTitle(task: ResolvedTask): string {
  if (task.effort === undefined) return "No completion data — treated as the longest grind";
  return `${Math.round((1 - task.effort) * 100)}% of sampled players have done this`;
}

/**
 * One task line. When a task drags prerequisites along, the bundle is stated outright —
 * "Lily Pad Minion V (requires I-IV) — 5 XP for 46.2k total" — rather than quoting the
 * leaf price and letting the user discover the rest at the crafting bench.
 */
export function TaskRow({
  task,
  showBundle = true,
  tag,
}: {
  task: ResolvedTask;
  showBundle?: boolean;
  /** Where this row lives. Only worth showing once the list crosses categories. */
  tag?: string;
}) {
  const bundled = showBundle && task.bundle.length > 0;
  const unpriced = task.bundleCoins === null;

  return (
    <li className="flex items-baseline gap-3 border-t border-line/60 px-3 py-1.5 text-sm first:border-t-0">
      <span className="flex-1 truncate">
        {tag && <span className="mr-1.5 rounded border border-line px-1 text-[10px] uppercase tracking-wide text-muted/70">{tag}</span>}
        {bundled && task.bundleSpan ? task.bundleSpan : task.name}
        {bundled && <span className="ml-1.5 text-xs text-muted">+{task.bundle.length} prereq</span>}
        {(bundled && task.bundleNote ? task.bundleNote : task.note) && (
          <span className="ml-1.5 text-xs text-muted/70">{bundled && task.bundleNote ? task.bundleNote : task.note}</span>
        )}
      </span>

      <span className="w-14 shrink-0 text-right tabular-nums text-gold">
        {bundled ? task.bundleXp : task.xp} xp
      </span>

      <span className="w-20 shrink-0 text-right tabular-nums">
        {unpriced ? (
          task.cost.kind === "none" ? (
            <span className={EFFORT_COLOUR[task.effortBand ?? "marathon"]} title={effortTitle(task)}>
              {task.effortBand ?? "grind"}
            </span>
          ) : (
            <span className="text-muted/60">no price</span>
          )
        ) : (
          coins(bundled ? task.bundleCoins : task.coins)
        )}
      </span>

      <span className="w-24 shrink-0 text-right tabular-nums text-xs text-muted">{rate(task.efficiency)}</span>
    </li>
  );
}
