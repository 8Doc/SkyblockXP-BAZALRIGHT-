import type { ResolvedTask } from "./types";

/**
 * Collapses consecutive tiers of the same thing into one line.
 *
 * The solver picks tiers individually — it has to, since each is separately priced and the
 * cheapest cut-off might land anywhere in the chain. But a plan that reads
 *
 *     Arthropod Resistance 1    1 xp   9.5k
 *     Arthropod Resistance 2    1 xp    28k
 *     ... four more ...
 *
 * is six lines describing one trip to one place. As a shopping list it wants to say "levels 1-6,
 * 30 shards, 66k" on a single row. This is presentation only: the underlying tasks, their
 * prices and the solver's choices are untouched.
 */

export type TaskRun = {
  /** Stable key for rendering. */
  key: string;
  /** "Arthropod Resistance 1-6", or just the task name when nothing merged. */
  name: string;
  /** The tasks folded into this row, in tier order. */
  tasks: ResolvedTask[];
  xp: number;
  /** Summed cost, or null if any member is unpriced. */
  coins: number | null;
  /** Combined materials where every tier wants the same thing — "30x Voracious Spider Shard". */
  note?: string;
};

/** Tier suffix on a task id: attribute_X_6, minion_GRAVEL_11, DRAGON_ESSENCE_Y_3. */
const TIER_SUFFIX = /_(\d+)$/;

/** The chain a task belongs to — its id with the tier stripped. */
function familyOf(task: ResolvedTask): string | null {
  const match = TIER_SUFFIX.exec(task.id);
  return match ? task.id.slice(0, match.index) : null;
}

const tierOf = (task: ResolvedTask): number => Number(TIER_SUFFIX.exec(task.id)?.[1] ?? 0);

/** "Arthropod Resistance 6" -> { base: "Arthropod Resistance", label: "6" } */
function splitName(name: string): { base: string; label: string } {
  const at = name.lastIndexOf(" ");
  return at < 0 ? { base: name, label: "" } : { base: name.slice(0, at), label: name.slice(at + 1) };
}

/** "3x Voracious Spider Shard" -> { qty: 3, material: "Voracious Spider Shard" } */
function splitNote(note: string | undefined): { qty: number; material: string } | null {
  const match = /^(\d+)[x×]\s*(.+)$/.exec(note ?? "");
  return match ? { qty: Number(match[1]), material: match[2].trim() } : null;
}

/**
 * Merge runs of the same chain. Order is preserved: a run takes the position of its first
 * member, so the cheapest-first ordering the solver produced still reads correctly.
 */
export function groupTaskRuns(tasks: ResolvedTask[]): TaskRun[] {
  const runs: TaskRun[] = [];
  const byFamily = new Map<string, ResolvedTask[]>();

  for (const task of tasks) {
    const family = familyOf(task);
    if (family === null) continue;
    const list = byFamily.get(family);
    if (list) list.push(task);
    else byFamily.set(family, [task]);
  }

  const emitted = new Set<string>();

  for (const task of tasks) {
    const family = familyOf(task);
    const members = family === null ? null : byFamily.get(family);

    // Alone in its family, or not tiered at all: render as itself.
    if (!family || !members || members.length < 2) {
      runs.push({
        key: task.id,
        name: task.name,
        tasks: [task],
        xp: task.xp,
        coins: task.coins,
        note: task.note,
      });
      continue;
    }

    if (emitted.has(family)) continue;
    emitted.add(family);

    const ordered = [...members].sort((a, b) => tierOf(a) - tierOf(b));
    const first = splitName(ordered[0].name);
    const last = splitName(ordered[ordered.length - 1].name);

    const coins = ordered.some((t) => t.coins === null)
      ? null
      : ordered.reduce((sum, t) => sum + (t.coins ?? 0), 0);

    // If every tier buys the same material, the run can state the total to buy.
    let note: string | undefined;
    const parts = ordered.map((t) => splitNote(t.note));
    if (parts.every((p) => p && p.material === parts[0]!.material)) {
      const total = parts.reduce((sum, p) => sum + p!.qty, 0);
      note = `${ordered.length} levels · ${total}× ${parts[0]!.material}`;
    } else {
      note = `${ordered.length} levels`;
    }

    // A dash range may only be used when the tiers really are consecutive. They often aren't:
    // the task table is built from ids harvested off live players, so a perk nobody sampled had
    // at tier 3 simply has no tier 3, and writing "1–5" over tiers 1 and 5 would invent three
    // purchases that aren't in the plan.
    const tiers = ordered.map(tierOf);
    const contiguous = tiers.every((tier, i) => i === 0 || tier === tiers[i - 1] + 1);
    const labels = ordered.map((t) => splitName(t.name).label);
    const sharedBase = first.base === last.base && labels.every(Boolean);

    let name: string;
    if (!sharedBase) name = `${ordered[0].name} +${ordered.length - 1} more`;
    else if (contiguous) name = `${first.base} ${first.label}–${last.label}`;
    else name = `${first.base} ${labels.join(", ")}`;

    runs.push({
      key: family,
      name,
      tasks: ordered,
      xp: ordered.reduce((sum, t) => sum + t.xp, 0),
      coins,
      note,
    });
  }

  return runs;
}

/**
 * Collapse everything that is really one decision into one row.
 *
 * Three shapes turn up, and they don't combine the same way:
 *
 *   tiers you buy through   Attribute levels, minion tiers, museum tool marks. Each one is a
 *                           separate purchase and they all count, so the row is their sum —
 *                           "max Arthropod Resistance" is all ten levels and all 96 shards.
 *
 *   tiers that replace      Pets and accessory families. Only the best copy counts, so buying
 *                           the epic after the rare wastes the rare. The row is the best member
 *                           alone: its price, and the XP it adds over what's already owned.
 *
 *   one-offs                Everything else, unchanged.
 *
 * Getting the second one wrong is the expensive mistake — summing a pet's tiers would quote
 * uncommon + rare + epic for a pet you'd buy once.
 *
 * Cheapest per XP first. Rows with no price sort last rather than being dropped, since "you
 * can't buy this one" is a real answer to the question being asked.
 */
export function groupToMax(tasks: ResolvedTask[]): TaskRun[] {
  const groups = new Map<string, { rule: "sum" | "best"; members: ResolvedTask[] }>();
  const order: string[] = [];

  for (const task of tasks) {
    // Replacing beats stacking: if a task declares an exclusive group, that's the rule, whatever
    // its name looks like.
    const key = task.exclusiveGroup ?? tierFamily(task);
    if (key === null) {
      order.push(task.id);
      groups.set(task.id, { rule: "sum", members: [task] });
      continue;
    }
    const held = groups.get(key);
    if (held) held.members.push(task);
    else {
      order.push(key);
      groups.set(key, { rule: task.exclusiveGroup ? "best" : "sum", members: [task] });
    }
  }

  const runs: TaskRun[] = [];
  for (const key of order) {
    const { rule, members } = groups.get(key)!;
    runs.push(rule === "best" ? bestOf(key, members) : sumOf(key, members));
  }

  return runs.sort((a, b) => {
    if (a.coins === null || !a.xp) return b.coins === null || !b.xp ? 0 : 1;
    if (b.coins === null || !b.xp) return -1;
    return a.coins / a.xp - b.coins / b.xp;
  });
}

/** Every tier bought, summed: the cost of finishing the whole line. */
function sumOf(key: string, members: ResolvedTask[]): TaskRun {
  const ordered = [...members].sort((a, b) => tierRank(a) - tierRank(b));
  const first = splitTier(ordered[0].name);
  const last = splitTier(ordered[ordered.length - 1].name);

  // Nothing to collapse and no tier to strip: a one-off keeps exactly what it had.
  if (ordered.length === 1 && !first.label) {
    const only = ordered[0];
    return { key, name: only.name, tasks: ordered, xp: only.xp, coins: only.coins, note: only.note };
  }

  // One level left of ten still belongs to its attribute, so it's named for the attribute and
  // says which level — not "Essence of Ice 10", which reads like a thing rather than a step.
  const noun = TIER_NOUN[ordered[0].category] ?? "tiers";
  // A range needs both ends to be named. Some lines are numbered only in their ids — the museum
  // drills are MITHRIL_DRILL_1 and _2 but read "SX-R226" and "SX-R326" — and "tiers –" is worse
  // than saying how many there are.
  const span =
    ordered.length === 1
      ? `${noun.replace(/s$/, "")} ${first.label}`
      : first.label && last.label
        ? `${noun} ${first.label}–${last.label}`
        : `${ordered.length} ${noun}`;
  const material = totalMaterial(ordered);

  return {
    key,
    name: first.base,
    tasks: ordered,
    xp: ordered.reduce((sum, t) => sum + t.xp, 0),
    coins: ordered.some((t) => t.coins === null) ? null : ordered.reduce((sum, t) => sum + (t.coins ?? 0), 0),
    note: material ? `${span} · ${material}` : span,
  };
}

/**
 * Only the best member counts, so that's the only one worth buying. The row keeps the winner's
 * own name — the actionable thing is "buy Bee (epic)", not "buy some Bee" — and is credited with
 * what the family gains over what the player already has, not with the winner's headline XP.
 */
function bestOf(key: string, members: ResolvedTask[]): TaskRun {
  const winner = members.reduce((best, t) => ((t.groupLevel ?? 0) > (best.groupLevel ?? 0) ? t : best));
  const gain = Math.max((winner.groupLevel ?? 0) - (winner.groupBase ?? 0), winner.xp);
  const others = members.length - 1;

  return {
    key,
    name: winner.name,
    tasks: [winner],
    xp: gain,
    coins: winner.coins,
    note: others > 0 ? `best of ${members.length} tiers${winner.note ? ` · ${winner.note}` : ""}` : winner.note,
  };
}

/** Wording for a tier range, so attributes don't talk about "tiers" and minions about "levels". */
const TIER_NOUN: Partial<Record<ResolvedTask["category"], string>> = {
  attributes: "levels",
  essence_shop: "levels",
  skills: "levels",
};

/** A trailing tier marker: "Mk. III", "III", "7". */
const NAME_TIER = /\s+(?:Mk\.\s*)?([IVXL]+|\d+)$/;
const ROMAN: Record<string, number> = {
  I: 1, II: 2, III: 3, IV: 4, V: 5, VI: 6, VII: 7, VIII: 8, IX: 9, X: 10,
  XI: 11, XII: 12, XIII: 13, XIV: 14, XV: 15, XX: 20,
};

/** "Cactus Knife Mk. III" -> { base: "Cactus Knife", label: "III" } */
function splitTier(name: string): { base: string; label: string } {
  const match = NAME_TIER.exec(name);
  return match ? { base: name.slice(0, match.index), label: match[1] } : { base: name, label: "" };
}

/**
 * Which line a task belongs to, or null if it stands alone.
 *
 * Read off the *name*, not the id. Museum is why: its tool marks are CACTUS_KNIFE,
 * CACTUS_KNIFE_2, CACTUS_KNIFE_3, so an id rule puts Mk. I in a family of its own and leaves
 * II and III to pair up without it. The names are consistent where the ids aren't.
 */
function tierFamily(task: ResolvedTask): string | null {
  const { base, label } = splitTier(task.name);
  if (label) return `${task.category}|${base}`;
  // No tier in the name — fall back to the id, which is how anything named without a marker
  // still groups.
  const match = TIER_SUFFIX.exec(task.id);
  return match ? task.id.slice(0, match.index) : null;
}

function tierRank(task: ResolvedTask): number {
  const { label } = splitTier(task.name);
  if (!label) return Number(TIER_SUFFIX.exec(task.id)?.[1] ?? 0);
  return /^\d+$/.test(label) ? Number(label) : (ROMAN[label] ?? 0);
}

/** "66× Voracious Spider Shard" when every tier wants the same thing, else nothing. */
function totalMaterial(tasks: ResolvedTask[]): string | null {
  const parts = tasks.map((t) => splitNote(t.note));
  if (!parts.every((p) => p && p.material === parts[0]!.material)) return null;
  return `${parts.reduce((sum, p) => sum + p!.qty, 0)}× ${parts[0]!.material}`;
}

/**
 * Make a ranked list read as a sequence rather than a menu.
 *
 * Every tier of a chain is its own task, and each one drags the tiers below it, so a ranked list
 * shows the same purchase over and over from the same starting point:
 *
 *     Extreme Pressure 2–6   5 levels · 16× Lumisquid Shard
 *     Extreme Pressure 2–7   6 levels · 21× Lumisquid Shard
 *     Extreme Pressure 2–8   7 levels · 27× Lumisquid Shard
 *
 * Those are three ways to describe one decision, and rows two and three re-sell the levels row
 * one already bought. Read top to bottom — which is how a shopping list is read — the totals are
 * nonsense.
 *
 * So each row is trimmed to what its chain hasn't already covered further up the list: 2–6, then
 * 7, then 8. A row left with nothing to add disappears. Costs, XP and shard counts are recomputed
 * over the trimmed span, so the numbers describe the row actually shown.
 */
export function progressive(tasks: ResolvedTask[], byId: Map<string, ResolvedTask>): ResolvedTask[] {
  const covered = new Set<string>();
  const out: ResolvedTask[] = [];

  for (const task of tasks) {
    const steps = [...task.bundle, task.id];
    const remaining = steps.filter((id) => !covered.has(id));
    // Wholly contained in something already listed: it adds nothing a reader hasn't seen.
    if (!remaining.includes(task.id)) continue;
    for (const id of remaining) covered.add(id);
    // Untouched — either nothing above it shared the chain, or it never had prerequisites.
    if (remaining.length === steps.length) {
      out.push(task);
      continue;
    }
    out.push(trimTo(task, remaining, byId));
  }

  return out;
}

/** Re-price a row against only the steps it still contributes. */
function trimTo(task: ResolvedTask, remaining: string[], byId: Map<string, ResolvedTask>): ResolvedTask {
  const members = remaining.map((id) => byId.get(id)).filter((t): t is ResolvedTask => Boolean(t));
  if (!members.length) return task;

  const coins = members.some((m) => m.coins === null) ? null : members.reduce((sum, m) => sum + (m.coins ?? 0), 0);
  const xp = members.reduce((sum, m) => sum + m.xp, 0);
  const first = splitTier(members[0].name);
  const last = splitTier(members[members.length - 1].name);
  const material = totalMaterial(members);

  const span =
    members.length > 1 && first.base === last.base && first.label && last.label
      ? `${first.base} ${first.label}–${last.label}`
      : undefined;
  const noun = TIER_NOUN[task.category] ?? "tiers";
  const note =
    members.length > 1
      ? material
        ? `${members.length} ${noun} · ${material}`
        : `${members.length} ${noun}`
      : members[0].note;

  return {
    ...task,
    // The row now *is* its remaining steps, so the bundle figures and the plain ones agree.
    bundle: remaining.filter((id) => id !== task.id),
    coins,
    bundleCoins: coins,
    bundleXp: xp,
    efficiency: coins !== null && xp > 0 ? coins / xp : null,
    bundleSpan: span,
    bundleNote: members.length > 1 ? note : undefined,
    note: members.length > 1 ? task.note : members[0].note,
    name: members.length === 1 ? members[0].name : task.name,
  };
}
