"use client";

import { useState } from "react";
import type { Plan } from "@/lib/types";
import { CATEGORY_LABELS, XP_PER_LEVEL } from "@/lib/types";
import { coins, num } from "@/lib/format";
import { TaskRow } from "./TaskRow";

/** Query C: the plan, regrouped by category so it's one trip per interface. */
export function PlanView({ plan, currentXp }: { plan: Plan; currentXp: number }) {
  const [open, setOpen] = useState<string | null>(plan.groups[0]?.category ?? null);

  return (
    <section className="space-y-3">
      <div className="panel grid grid-cols-2 gap-px overflow-hidden bg-line sm:grid-cols-4">
        <Stat label="XP gained" value={num(plan.reachedXp)} sub={`target ${num(plan.targetXp)}`} tone="gold" />
        <Stat
          label="Levels gained"
          value={`+${plan.levelsGained}`}
          sub={`${Math.floor(currentXp / XP_PER_LEVEL)} → ${Math.floor((currentXp + plan.reachedXp) / XP_PER_LEVEL)}`}
        />
        <Stat label="Coins spent" value={coins(plan.coins)} sub={plan.reachedXp ? `${coins(plan.coins / plan.reachedXp)}/xp` : "—"} />
        <Stat label="Trips" value={String(plan.groups.length)} sub={`${plan.groups.reduce((s, g) => s + g.tasks.length, 0)} tasks`} />
      </div>

      {plan.short && (
        <p className="panel border-gold/40 px-3 py-2 text-sm text-gold">
          The priced task pool tops out at {num(plan.reachedXp)} XP — short of {num(plan.targetXp)}. Lower the minimum XP
          filter, enable more categories, or raise the budget.
        </p>
      )}

      {plan.groups.map((group) => (
        <div key={group.category} className="panel overflow-hidden">
          <button
            type="button"
            onClick={() => setOpen(open === group.category ? null : group.category)}
            className="flex w-full items-baseline gap-3 px-3 py-2 text-left hover:bg-panel2"
          >
            <span className="flex-1 font-medium">{CATEGORY_LABELS[group.category]}</span>
            <span className="text-sm tabular-nums text-muted">{group.tasks.length} tasks</span>
            <span className="w-16 text-right text-sm tabular-nums text-gold">{num(group.xp)} xp</span>
            <span className="w-20 text-right text-sm tabular-nums">{coins(group.coins)}</span>
            <span className="w-3 text-muted">{open === group.category ? "−" : "+"}</span>
          </button>
          {open === group.category && (
            <ul className="border-t border-line bg-panel2/40">
              {group.tasks.map((task) => (
                <TaskRow key={task.id} task={task} showBundle={false} />
              ))}
            </ul>
          )}
        </div>
      ))}

      {!plan.groups.length && (
        <p className="panel px-3 py-6 text-center text-sm text-muted">
          Nothing eligible. Every priced task is either done, below the XP floor, or outside the budget.
        </p>
      )}
    </section>
  );
}

function Stat({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "gold" }) {
  return (
    <div className="bg-panel px-3 py-2.5">
      <div className="text-[11px] uppercase tracking-wider text-muted">{label}</div>
      <div className={`text-xl tabular-nums ${tone === "gold" ? "text-gold" : "text-slate-100"}`}>{value}</div>
      {sub && <div className="text-xs text-muted">{sub}</div>}
    </div>
  );
}
