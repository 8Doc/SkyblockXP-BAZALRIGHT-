"use client";

import { useState } from "react";
import type { PackagePlan } from "@/lib/types";
import { CATEGORY_LABELS } from "@/lib/types";
import { coins, num } from "@/lib/format";
import { groupTaskRuns } from "@/lib/grouping";
import { TaskRunRow } from "./TaskRunRow";

/**
 * Successive fixed-size shopping trips. Each card is a budget you could actually spend in one
 * sitting, and the rate column is the point: it climbs package by package as the cheap XP runs
 * out, which is the signal for when to stop buying.
 */
export function PackagesView({ packages: plan }: { packages: PackagePlan }) {
  const [open, setOpen] = useState<number | null>(1);
  const { packages, packageSize, exhausted, totalBleedXp, totalIdealXp } = plan;

  if (!packages.length) {
    return (
      <p className="panel px-3 py-8 text-center text-sm text-muted">
        Nothing affordable at {coins(packageSize)} per package. Lower the XP floor, enable more categories, or load
        accessory prices.
      </p>
    );
  }

  const best = packages[0].rate;
  const last = packages[packages.length - 1];

  return (
    <section className="space-y-3">
      <div className="panel grid grid-cols-2 gap-px overflow-hidden bg-line sm:grid-cols-4">
        <Stat label="Packages" value={String(packages.length)} sub={`${coins(packageSize)} each`} />
        <Stat label="XP total" value={num(last.cumulativeXp)} sub={`+${last.cumulativeLevels} levels`} tone="gold" />
        <Stat label="Coins total" value={coins(last.cumulativeCoins)} sub="across all packages" />
        <Stat
          label="Bled"
          value={totalBleedXp >= 1 ? `−${num(Math.round(totalBleedXp))} xp` : "none"}
          sub={totalIdealXp > 0 ? `${((100 * last.cumulativeXp) / totalIdealXp).toFixed(0)}% of ideal` : "—"}
          tone={totalBleedXp >= 1 ? "rose" : undefined}
        />
      </div>

      <p className="-mt-1 max-w-[78ch] text-xs text-muted">
        Bled = XP given up for convenience. The baseline buys strictly by coins per XP with no package walls and{" "}
        <em>no XP floor</em> — including the 1 XP chores this tool exists to hide. Raise the floor and this number
        climbs; that is the trade being made.
      </p>

      {exhausted && (
        <p className="panel border-gold/40 px-3 py-2 text-sm text-gold">
          The affordable pool ran out after {packages.length} package{packages.length === 1 ? "" : "s"} — there is
          nothing else with a live price to buy.
        </p>
      )}

      {packages.map((pkg) => {
        const decay = best > 0 ? pkg.rate / best : 1;
        return (
          <div key={pkg.index} className="panel overflow-hidden">
            <button
              type="button"
              onClick={() => setOpen(open === pkg.index ? null : pkg.index)}
              className="flex w-full items-baseline gap-3 px-3 py-2 text-left hover:bg-panel2"
            >
              <span className="flex h-[22px] w-[22px] shrink-0 items-center justify-center self-center rounded-full border border-line text-[11px] text-muted">
                {pkg.index}
              </span>
              <span className="flex-1 font-medium">
                {coins(pkg.coins)}
                <span className="ml-1.5 text-xs text-muted">of {coins(packageSize)}</span>
              </span>
              <span className="w-20 text-right text-sm tabular-nums text-gold">{num(pkg.xp)} xp</span>
              <span className="w-40 text-right text-sm tabular-nums">
                {coins(pkg.rate)}/xp
                {decay > 1.05 && <span className="ml-1.5 text-xs text-muted">{decay.toFixed(1)}× pkg 1</span>}
              </span>
              <span
                className={`w-20 text-right text-xs tabular-nums ${pkg.bleedXp >= 1 ? "text-rose" : "text-muted"}`}
                title="XP this package gave up versus spending the same coins in pure efficiency order"
              >
                {pkg.bleedXp >= 1 ? `−${num(Math.round(pkg.bleedXp))} xp` : "—"}
              </span>
              <span className="w-3 text-muted">{open === pkg.index ? "−" : "+"}</span>
            </button>

            {open === pkg.index && (
              <div className="border-t border-line bg-panel2/40">
                <p className="px-3 py-1.5 text-xs text-muted">
                  Running total: {coins(pkg.cumulativeCoins)} spent · {num(pkg.cumulativeXp)} XP · +
                  {pkg.cumulativeLevels} levels
                  {pkg.bleedXp >= 1 && (
                    <>
                      {" · "}buying by pure efficiency the same coins reach {num(Math.round(pkg.idealXp))} XP — this
                      plan bleeds <span className="text-rose">{num(Math.round(pkg.bleedXp))}</span>
                    </>
                  )}
                </p>
                {pkg.groups.map((group) => (
                  <div key={group.category} className="border-t border-line/60">
                    <div className="flex justify-between px-3 pb-0.5 pt-1.5 text-xs font-medium">
                      <span>{CATEGORY_LABELS[group.category]}</span>
                      <span className="text-muted">
                        {num(group.xp)} xp · {coins(group.coins)}
                      </span>
                    </div>
                    <ul>
                      {groupTaskRuns(group.tasks).map((run) => (
                        <TaskRunRow key={run.key} run={run} />
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </section>
  );
}

function Stat({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: "gold" | "rose";
}) {
  const colour = tone === "gold" ? "text-gold" : tone === "rose" ? "text-rose" : "text-slate-100";
  return (
    <div className="bg-panel px-3 py-2.5">
      <div className="text-[11px] uppercase tracking-wider text-muted">{label}</div>
      <div className={`text-xl tabular-nums ${colour}`}>{value}</div>
      {sub && <div className="text-xs text-muted">{sub}</div>}
    </div>
  );
}
