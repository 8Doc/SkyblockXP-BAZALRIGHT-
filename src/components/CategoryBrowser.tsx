"use client";

import { useState } from "react";
import type { PlannerResult } from "@/lib/planner";
import { CATEGORY_LABELS } from "@/lib/types";
import { coins, num } from "@/lib/format";
import { TaskRow } from "./TaskRow";
import { TaskRunRow } from "./TaskRunRow";

/** Query B: every category as its own panel — the "I'm here anyway, what else" view. */
export function CategoryBrowser({ result }: { result: PlannerResult }) {
  const [open, setOpen] = useState<string | null>(null);
  // Categories currently showing one row per thing instead of one per tier. Kept per category
  // rather than as a single flag so opening a different panel doesn't silently change this one.
  const [grouped, setGrouped] = useState<Set<string>>(new Set());

  const toggleGrouped = (category: string) =>
    setGrouped((current) => {
      const next = new Set(current);
      if (!next.delete(category)) next.add(category);
      return next;
    });

  return (
    <section className="space-y-2">
      {result.browser.map(({ category, summary, tasks, truncated, maxed, maxedTruncated }) => {
        const isGrouped = maxed !== undefined && grouped.has(category);
        return (
        <div key={category} className="panel overflow-hidden">
          <button
            type="button"
            onClick={() => setOpen(open === category ? null : category)}
            className="flex w-full items-baseline gap-3 px-3 py-2 text-left hover:bg-panel2"
          >
            <span className="flex-1 font-medium">{CATEGORY_LABELS[category]}</span>
            <span className="text-sm tabular-nums text-muted">{num(summary.remainingTasks)} left</span>
            <span className="w-20 text-right text-sm tabular-nums text-gold">{num(summary.remainingXp)} xp</span>
            <span className="w-40 text-right text-sm tabular-nums">
              {summary.pricedXp > 0 ? (
                <>
                  {coins(summary.pricedCoins)}
                  <span className="text-xs text-muted"> buys {num(summary.pricedXp)} xp</span>
                </>
              ) : (
                <span className="text-muted/60">grind only</span>
              )}
            </span>
            <span className="w-3 text-muted">{open === category ? "−" : "+"}</span>
          </button>

          {open === category && (
            <div className="border-t border-line bg-panel2/40">
              {summary.pricedXp > 0 && summary.pricedXp < summary.remainingXp && (
                <p className="px-3 py-1.5 text-xs text-muted">
                  {num(summary.pricedXp)} of {num(summary.remainingXp)} remaining XP has a live price.
                </p>
              )}
              {maxed !== undefined && (
                <div className="px-3 pb-1 pt-1.5">
                  <button
                    type="button"
                    onClick={() => toggleGrouped(category)}
                    className={`rounded border px-2 py-0.5 text-xs ${
                      isGrouped ? "border-aqua bg-aqua/10 text-aqua" : "border-line text-muted hover:border-aqua hover:text-aqua"
                    }`}
                  >
                    Group maxed
                  </button>
                  <span className="ml-2 text-xs text-muted/70">
                    {isGrouped
                      ? "one row per attribute — everything it takes to max it"
                      : "one row per shard level"}
                  </span>
                </div>
              )}

              <ul>
                {isGrouped
                  ? maxed!.map((run) => <TaskRunRow key={run.key} run={run} />)
                  : tasks.map((task) => <TaskRow key={task.id} task={task} />)}
              </ul>
              {(isGrouped ? (maxedTruncated ?? 0) : truncated) > 0 && (
                <p className="px-3 py-1.5 text-xs text-muted">
                  +{num(isGrouped ? (maxedTruncated ?? 0) : truncated)} more above the XP floor
                </p>
              )}
            </div>
          )}
        </div>
        );
      })}

      {result.unmodelled.length > 0 && (
        <div className="panel px-3 py-3">
          <h3 className="text-sm font-medium">Not modelled yet</h3>
          <p className="mt-1 text-xs text-muted">
            These categories exist in the game and are missing here. Listed so the totals above read as coverage, not as
            the whole game.
          </p>
          <ul className="mt-2 space-y-1.5">
            {result.unmodelled.map((entry) => (
              <li key={entry.category} className="text-xs">
                <span className="text-slate-300">{CATEGORY_LABELS[entry.category]}</span>
                {entry.totalXp && (
                  <span className="ml-1.5 tabular-nums text-gold/70">
                    {entry.earnedXp !== undefined ? `${num(entry.earnedXp)} of ` : "~"}
                    {num(entry.totalXp)} xp
                  </span>
                )}
                <span className="ml-1.5 text-muted">{entry.note}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
