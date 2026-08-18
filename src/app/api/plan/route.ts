import { NextResponse } from "next/server";
import { runPlanner } from "@/lib/planner";
import { HypixelError } from "@/lib/hypixel";
import { CATEGORIES, type Category } from "@/lib/types";

export const dynamic = "force-dynamic";
export const maxDuration = 60; // a cold auction sweep is ~49 pages

const VALID = new Set<string>(CATEGORIES);

function int(value: string | null, fallback: number, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.round(n), min), max);
}

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const username = params.get("username")?.trim();
  if (!username) return NextResponse.json({ error: "username is required" }, { status: 400 });

  const requested = (params.get("categories") ?? "").split(",").filter((c) => VALID.has(c)) as Category[];
  const budgetRaw = params.get("budget");
  const budget = budgetRaw && Number.isFinite(Number(budgetRaw)) ? Math.max(Number(budgetRaw), 0) : null;

  try {
    const result = await runPlanner({
      username,
      profileId: params.get("profile") ?? undefined,
      targetXp: int(params.get("target"), 500, 1, 100_000),
      minXp: int(params.get("minXp"), 5, 0, 100),
      budget,
      categories: requested.length ? requested : [...CATEGORIES],
      strategy: params.get("strategy") === "exact" ? "exact" : "greedy",
      packageSize: Math.max(Number(params.get("packageSize")) || 10_000_000, 1),
      packageCount: int(params.get("packages"), 5, 1, 20),
      refresh: params.get("refresh") === "1",
    });
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof HypixelError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error(error);
    return NextResponse.json({ error: "Something went wrong building the plan" }, { status: 500 });
  }
}
