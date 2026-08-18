"use client";

import type { PlannerResult } from "@/lib/planner";
import { CATEGORY_LABELS } from "@/lib/types";
import { num } from "@/lib/format";
import { TaskRow } from "./TaskRow";

const BAND_LABEL: Record<string, string> = {
  quick: "Quick",
  short: "A session",
  long: "A long haul",
  marathon: "A marathon",
};

const BAND_BLURB: Record<string, string> = {
  quick: "Most players already have these. Usually a few minutes.",
  short: "The typical player has done about half of these.",
  long: "A minority have finished these — expect real time.",
  marathon: "Rare. These are the projects people plan around.",
};

/**
 * Free XP, ordered by how much work it looks like — the one ranking that ignores category
 * walls. Ordering comes from how many sampled players have already finished each task, which
 * is a proxy for effort rather than a measurement of it, so it's shown in coarse bands.
 */
export function GrindView({ result }: { result: PlannerResult }) {
  const { grind } = result;

  if (!grind.length) {
    return (
      <p className="panel px-3 py-8 text-center text-sm text-muted">
        No grind tasks left above the XP floor in the categories you have enabled.
      </p>
    );
  }

  const bands = ["quick", "short", "long", "marathon"] as const;

  return (
    <section className="space-y-3">
      <p className="max-w-[80ch] text-xs text-muted">
        Free XP, easiest first, across every category at once. Difficulty is estimated from how many real players have
        already finished each task — a proxy for effort, not a measurement of it — so it is grouped into bands rather
        than pretending to a precise ordering.
      </p>

      {bands.map((band) => {
        const tasks = grind.filter((t) => (t.effortBand ?? "marathon") === band);
        if (!tasks.length) return null;
        return (
          <div key={band} className="panel overflow-hidden">
            <div className="flex items-baseline gap-3 border-b border-line px-3 py-2">
              <span className="font-medium">{BAND_LABEL[band]}</span>
              <span className="flex-1 text-xs text-muted">{BAND_BLURB[band]}</span>
              <span className="text-sm tabular-nums text-gold">
                {num(tasks.reduce((s, t) => s + t.xp, 0))} xp
              </span>
            </div>
            <ul>
              {tasks.map((task) => (
                <li key={task.id} className="border-t border-line/40 first:border-t-0">
                  <div className="px-3 pt-1.5 text-[11px] uppercase tracking-wider text-muted/70">
                    {CATEGORY_LABELS[task.category]}
                  </div>
                  <ul className="-mt-1">
                    <TaskRow task={task} showBundle={false} />
                  </ul>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </section>
  );
}
