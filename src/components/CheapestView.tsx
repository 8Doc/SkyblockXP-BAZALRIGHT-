"use client";

import { useState } from "react";
import type { PlannerResult } from "@/lib/planner";
import { CATEGORY_LABELS } from "@/lib/types";
import { num } from "@/lib/format";
import { TaskRow } from "./TaskRow";
import { TaskRunRow } from "./TaskRunRow";

/**
 * Query D: everything buyable in one list, cheapest per XP first.
 *
 * The category browser answers "I'm at the Abiphone anyway, what else"; this answers the
 * blunter question underneath it — of everything in the game, what is the next cheapest XP
 * available, wherever it happens to live.
 */
export function CheapestView({ result }: { result: PlannerResult }) {
  const [grouped, setGrouped] = useState(false);
  const { tasks, truncated, grouped: folded, groupedTruncated } = result.cheapest;
  const hidden = grouped ? groupedTruncated : truncated;

  return (
    <section className="space-y-2">
      <div className="panel flex flex-wrap items-center gap-2 px-3 py-2">
        <button
          type="button"
          onClick={() => setGrouped(!grouped)}
          className={`rounded border px-2 py-0.5 text-xs ${
            grouped ? "border-aqua bg-aqua/10 text-aqua" : "border-line text-muted hover:border-aqua hover:text-aqua"
          }`}
        >
          Group maxed
        </button>
        <span className="text-xs text-muted/70">
          {grouped
            ? "each thing folded into one purchase — every tier of an attribute, the best tier of a pet"
            : "one row per individual upgrade"}
        </span>
        <span className="ml-auto text-xs tabular-nums text-muted">
          {num(grouped ? folded.length : tasks.length)} shown
        </span>
      </div>

      <ul className="panel overflow-hidden">
        {grouped
          ? folded.map((run) => (
              <TaskRunRow key={run.key} run={run} tag={CATEGORY_LABELS[run.tasks[0].category]} />
            ))
          : tasks.map((task) => <TaskRow key={task.id} task={task} tag={CATEGORY_LABELS[task.category]} />)}
      </ul>

      {hidden > 0 && (
        <p className="px-3 text-xs text-muted">
          +{num(hidden)} more, all worse value than everything above. Narrow the categories or raise the XP floor to
          bring the tail into view.
        </p>
      )}

      {!(grouped ? folded.length : tasks.length) && (
        <p className="panel px-3 py-6 text-center text-sm text-muted">
          Nothing buyable. Every priced task is either done or below the XP floor.
        </p>
      )}
    </section>
  );
}
