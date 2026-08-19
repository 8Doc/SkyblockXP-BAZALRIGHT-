"use client";

import type { TaskRun } from "@/lib/grouping";
import { coins, rate } from "@/lib/format";

/**
 * One line of a plan, where a "line" may be several tiers of the same thing folded together —
 * "Arthropod Resistance 1–6, 30× Voracious Spider Shard" rather than six near-identical rows.
 */
export function TaskRunRow({ run, tag }: { run: TaskRun; tag?: string }) {
  const merged = run.tasks.length > 1;
  const efficiency = run.coins !== null && run.xp > 0 ? run.coins / run.xp : null;

  return (
    <li className="flex items-baseline gap-3 border-t border-line/60 px-3 py-1.5 text-sm first:border-t-0">
      <span className="flex-1 truncate">
        {tag && <span className="mr-1.5 rounded border border-line px-1 text-[10px] uppercase tracking-wide text-muted/70">{tag}</span>}
        {run.name}
        {merged && <span className="ml-1.5 rounded border border-line px-1 text-[11px] text-muted">×{run.tasks.length}</span>}
        {run.note && <span className="ml-1.5 text-xs text-muted/70">{run.note}</span>}
      </span>

      <span className="w-14 shrink-0 text-right tabular-nums text-gold">{run.xp} xp</span>

      <span className="w-20 shrink-0 text-right tabular-nums">
        {run.coins === null ? <span className="text-muted/60">no price</span> : coins(run.coins)}
      </span>

      <span className="w-24 shrink-0 text-right tabular-nums text-xs text-muted">{rate(efficiency)}</span>
    </li>
  );
}
