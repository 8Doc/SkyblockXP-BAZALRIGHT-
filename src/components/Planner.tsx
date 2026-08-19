"use client";

import { useCallback, useEffect, useState } from "react";
import type { PlannerResult } from "@/lib/planner";
import { CATEGORIES, CATEGORY_LABELS, XP_PER_LEVEL, type Category } from "@/lib/types";
import { num } from "@/lib/format";
import { PlanView } from "./PlanView";
import { PackagesView } from "./PackagesView";
import { GrindView } from "./GrindView";
import { CategoryBrowser } from "./CategoryBrowser";
import { CheapestView } from "./CheapestView";

const DEFAULT_CATEGORIES: Category[] = [...CATEGORIES];

export function Planner() {
  const [username, setUsername] = useState("");
  const [profileId, setProfileId] = useState("");
  const [targetMode, setTargetMode] = useState<"xp" | "level">("xp");
  // Held as strings: coercing through Number() on every keystroke turns a cleared field into
  // "0" and fights the user mid-edit. Parse where the value is used instead.
  const [target, setTarget] = useState("500");
  const [targetLevel, setTargetLevel] = useState("300");
  const [minXp, setMinXp] = useState(5);
  const [budget, setBudget] = useState("");
  const [categories, setCategories] = useState<Category[]>(DEFAULT_CATEGORIES);
  const [strategy, setStrategy] = useState<"greedy" | "exact">("greedy");
  const [tab, setTab] = useState<"plan" | "packages" | "grind" | "browser" | "cheapest">("plan");
  const [packageSize, setPackageSize] = useState("10M");
  const [packageCount, setPackageCount] = useState("5");

  const [result, setResult] = useState<PlannerResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const currentLevel = result ? Math.floor(result.progress.xp / XP_PER_LEVEL) : 0;
  const targetXp =
    targetMode === "level" && result
      ? Math.max((Number(targetLevel) || 1) * XP_PER_LEVEL - result.progress.xp, 1)
      : Number(target) || 1;

  const run = useCallback(
    async (overrides?: { profileId?: string; refresh?: boolean }) => {
      if (!username.trim()) return;
      setLoading(true);
      setError(null);
      const params = new URLSearchParams({
        username: username.trim(),
        target: String(Math.max(Math.round(targetXp), 1)),
        minXp: String(minXp),
        categories: categories.join(","),
        strategy,
      });
      const profile = overrides?.profileId ?? profileId;
      if (profile) params.set("profile", profile);
      if (budget.trim()) params.set("budget", parseBudget(budget).toString());
      params.set("packageSize", String(parseBudget(packageSize) || 10_000_000));
      params.set("packages", String(Math.min(Math.max(Number(packageCount) || 1, 1), 20)));
      if (overrides?.refresh) params.set("refresh", "1");

      try {
        const res = await fetch(`/api/plan?${params}`);
        const body = await res.json();
        if (!res.ok) throw new Error(body.error ?? "Request failed");
        setResult(body as PlannerResult);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Request failed");
      } finally {
        setLoading(false);
      }
    },
    [username, targetXp, minXp, categories, strategy, profileId, budget, packageSize, packageCount],
  );

  // Re-solve on knob changes once we already have a player loaded — the filters are the
  // point of the tool, so they should feel live rather than needing a re-submit.
  useEffect(() => {
    if (!result) return;
    const t = setTimeout(() => void run(), 350);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, targetLevel, targetMode, minXp, budget, categories, strategy, profileId, packageSize, packageCount]);

  const toggle = (category: Category) =>
    setCategories((prev) => (prev.includes(category) ? prev.filter((c) => c !== category) : [...prev, category]));

  return (
    <div className="mx-auto max-w-5xl px-4 py-8">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">
          SkyBlock <span className="text-gold">XP Planner</span>
        </h1>
        <p className="mt-1 text-sm text-muted">
          The cheapest set of tasks that reaches your XP target — grouped by where you have to go, with the 1 XP filler
          filtered out.
        </p>
      </header>

      <form
        className="panel mb-5 space-y-4 p-4"
        onSubmit={(e) => {
          e.preventDefault();
          void run();
        }}
      >
        <div className="grid gap-3 sm:grid-cols-[1.4fr_1fr_1fr_auto]">
          <div>
            <label className="label" htmlFor="username">
              Minecraft username
            </label>
            <input
              id="username"
              className="field"
              placeholder="e.g. Refraction"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="off"
            />
          </div>

          <div>
            <label className="label" htmlFor="target">
              {targetMode === "xp" ? "XP target" : "Target level"}
            </label>
            <div className="flex gap-1">
              <input
                id="target"
                type="number"
                min={1}
                className="field"
                value={targetMode === "xp" ? target : targetLevel}
                onChange={(e) => (targetMode === "xp" ? setTarget(e.target.value) : setTargetLevel(e.target.value))}
              />
              <button
                type="button"
                className="chip border-line text-muted hover:border-aqua/60 hover:text-aqua"
                onClick={() => setTargetMode(targetMode === "xp" ? "level" : "xp")}
                title="Switch between an XP target and a target SkyBlock level"
              >
                {targetMode === "xp" ? "xp" : "lvl"}
              </button>
            </div>
          </div>

          <div>
            <label className="label" htmlFor="budget">
              Coin budget
            </label>
            <input
              id="budget"
              className="field"
              placeholder="optional · 50M"
              value={budget}
              onChange={(e) => setBudget(e.target.value)}
            />
          </div>

          <div className="flex items-end">
            <button
              type="submit"
              disabled={loading || !username.trim()}
              className="h-[34px] rounded bg-aqua px-4 text-sm font-medium text-ink disabled:opacity-40"
            >
              {loading ? "Solving…" : "Plan"}
            </button>
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-[2fr_1fr_0.7fr_1fr]">
          <div>
            <label className="label" htmlFor="minXp">
              Minimum XP per task — {minXp}
              <span className="ml-2 normal-case tracking-normal text-muted/70">hides the death-by-a-thousand-clicks tail</span>
            </label>
            <input
              id="minXp"
              type="range"
              min={0}
              max={30}
              value={minXp}
              onChange={(e) => setMinXp(Number(e.target.value))}
              className="w-full accent-aqua"
            />
          </div>

          <div>
            <label className="label" htmlFor="packageSize">
              Package size
            </label>
            <input
              id="packageSize"
              className="field"
              value={packageSize}
              onChange={(e) => setPackageSize(e.target.value)}
              placeholder="10M"
            />
          </div>

          <div>
            <label className="label" htmlFor="packageCount">
              Packages ahead
            </label>
            <input
              id="packageCount"
              type="number"
              min={1}
              max={20}
              className="field"
              value={packageCount}
              onChange={(e) => setPackageCount(e.target.value)}
            />
          </div>

          <div>
            <span className="label">Solver</span>
            <div className="flex gap-1">
              {(["greedy", "exact"] as const).map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setStrategy(s)}
                  className={`chip flex-1 ${
                    strategy === s ? "border-aqua/60 bg-aqua/10 text-aqua" : "border-line text-muted"
                  }`}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div>
          <span className="label">Categories</span>
          <div className="flex flex-wrap gap-1.5">
            {CATEGORIES.map((category) => {
              const on = categories.includes(category);
              return (
                <button
                  key={category}
                  type="button"
                  onClick={() => toggle(category)}
                  className={`chip ${on ? "border-aqua/50 bg-aqua/10 text-aqua" : "border-line text-muted"}`}
                >
                  {CATEGORY_LABELS[category]}
                </button>
              );
            })}
          </div>
        </div>
      </form>

      {error && <p className="panel mb-4 border-rose/50 px-3 py-2 text-sm text-rose">{error}</p>}

      {result && (
        <>
          <div className="mb-4 flex flex-wrap items-baseline gap-x-4 gap-y-1 text-sm">
            <span className="font-medium">{result.player.name}</span>
            <select
              className="field w-auto py-1 text-xs"
              value={result.profile.id}
              onChange={(e) => {
                setProfileId(e.target.value);
                void run({ profileId: e.target.value });
              }}
            >
              {result.profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                  {p.selected ? " (active)" : ""}
                </option>
              ))}
            </select>
            <span className="text-muted">
              Level <span className="text-slate-200">{currentLevel}</span> · {num(result.progress.xp)} XP
            </span>
            <span className="text-muted">
              {num(result.progress.modelledRemainingXp)} XP still available
            </span>
            <button
              type="button"
              className="chip border-line text-muted hover:border-aqua/60 hover:text-aqua"
              onClick={() => void run({ refresh: true })}
              disabled={loading}
              title="Re-pull the bazaar and re-sweep the auction house, ignoring the cache"
            >
              {loading ? "Refreshing…" : "Refresh prices"}
            </button>
            <span className="text-muted" title="How much of your earned XP this tool can account for. The rest is in categories not modelled yet.">
              models {Math.round((100 * result.progress.modelledEarnedXp) / Math.max(result.progress.xp, 1))}% of your
              earned XP
            </span>
            {result.bag.capacity > 0 && (
              <span className="text-muted" title="Accessory bag slots. Once full, each further accessory also costs the slot it sits in.">
                {num(result.bag.capacity - result.bag.used)} of {num(result.bag.capacity)} bag slots free
              </span>
            )}
            {result.bag.reportedMp !== null && (
              <span className="text-muted">
                {result.bag.computedMp} MP computed
                {result.bag.reportedMp !== result.bag.computedMp && (
                  <span className="text-gold/80"> · {result.bag.reportedMp} reported</span>
                )}
              </span>
            )}
          </div>

          <div className="mb-3 flex gap-1">
            {(["plan", "packages", "cheapest", "grind", "browser"] as const).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setTab(t)}
                className={`chip ${tab === t ? "border-aqua/60 bg-aqua/10 text-aqua" : "border-line text-muted"}`}
              >
                {t === "plan"
                  ? "Batch plan"
                  : t === "packages"
                    ? "Packages"
                    : t === "cheapest"
                      ? "Cheapest first"
                      : t === "grind"
                        ? "Grind order"
                        : "Category browser"}
              </button>
            ))}
          </div>

          {tab === "plan" && <PlanView plan={result.plan} currentXp={result.progress.xp} />}
          {tab === "packages" && <PackagesView packages={result.packages} />}
          {tab === "grind" && <GrindView result={result} />}
          {tab === "cheapest" && <CheapestView result={result} />}
          {tab === "browser" && <CategoryBrowser result={result} />}

          <footer className="mt-6 border-t border-line pt-3 text-xs text-muted">
            {num(result.sources.bazaarItems)} bazaar products
            {result.sources.binItems > 0 && (
              <> · {num(result.sources.binItems)} accessories priced from {num(result.sources.binListings)} BIN listings</>
            )}
            {" · task tables generated "}
            {new Date(result.sources.generatedAt).toLocaleDateString()}
            {result.bag.readable ? "" : " · talisman bag unreadable, accessory XP may be overstated"}
          </footer>
        </>
      )}

      {!result && !loading && (
        <p className="panel px-3 py-8 text-center text-sm text-muted">
          Enter a username to pull the profile, price every remaining task, and solve.
        </p>
      )}
    </div>
  );
}

/** Accepts "50M", "1.2b", "500k" or a plain number. */
function parseBudget(input: string): number {
  const match = /^([\d.]+)\s*([kmb])?$/i.exec(input.trim());
  if (!match) return 0;
  const value = Number(match[1]);
  const scale = { k: 1e3, m: 1e6, b: 1e9 }[match[2]?.toLowerCase() ?? ""] ?? 1;
  return Math.round(value * scale);
}
