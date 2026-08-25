import { XP_PER_LEVEL, type ResolvedTask } from "./types";

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
    } else if (family === "bag_upgrade") {
      note = `+${ordered.length * 2} slots · buy these first and the rest of the package fits`;
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
    // Bag slots are interchangeable — each is +2 slots at the going rate — so a run of them is
    // a quantity to buy rather than a span of numbered things. "Upgrade Jacobus 10×" is the
    // instruction; "Accessory bag upgrade 14–23" makes you count them yourself.
    if (family === "bag_upgrade") name = `Upgrade Jacobus ${ordered.length}×`;
    else if (!sharedBase) name = `${ordered[0].name} +${ordered.length - 1} more`;
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
  // A range needs both ends named *and* every rung between them present. Task tables built by
  // harvesting live players can be missing a tier nobody sampled, and "levels 1–10" over eight
  // of them invents two purchases. Where either fails, say how many there are instead.
  const ranks = ordered.map(tierRank);
  const contiguous = ranks.every((rank, i) => i === 0 || rank === ranks[i - 1] + 1);
  const span =
    ordered.length === 1
      ? `${noun.replace(/s$/, "")} ${first.label}`
      : first.label && last.label && contiguous
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

/**
 * Categories whose tiers are one running count rather than a sequence of purchases.
 *
 * Collecting 2,500 Seeds passes tiers I-IV on the way to V, and the kills for a bestiary tier
 * are the same kills that earned the tiers below it — so the distance to the top of a span *is*
 * the distance for the whole span. Ten attribute levels are ten separate purchases and their
 * note counts them; a span of these would be counting the same seeds five times over.
 */
const CUMULATIVE: ReadonlySet<ResolvedTask["category"]> = new Set(["collections", "bestiary"]);

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
  // Best tier of each exclusive family already listed above. A pet's rarities are alternatives,
  // not a chain, so they need their own bookkeeping: listing Squid uncommon, rare and epic each
  // at full value describes one purchase three times over.
  const listed = new Map<string, ResolvedTask>();
  const out: ResolvedTask[] = [];

  for (const task of tasks) {
    if (task.exclusiveGroup) {
      const previous = listed.get(task.exclusiveGroup);
      if (!previous) {
        listed.set(task.exclusiveGroup, task);
        out.push(task);
        continue;
      }
      const upgraded = asUpgradeOver(task, previous);
      if (!upgraded) continue; // no better than what is already listed
      listed.set(task.exclusiveGroup, task);
      out.push(upgraded);
      continue;
    }

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

/**
 * One tier of a family read against the tier listed above it.
 *
 * Only the best copy counts, so the XP is the difference the upgrade makes, not the tier's
 * headline value — Squid rare after Squid uncommon is worth the three points between them. The
 * price stays the item's real price, because that is what you hand over; the lesser copy comes
 * off and sells, so the net is carried alongside rather than replacing it.
 */
function asUpgradeOver(task: ResolvedTask, previous: ResolvedTask): ResolvedTask | null {
  const gain = (task.groupLevel ?? 0) - (previous.groupLevel ?? 0);
  if (gain <= 0) return null;

  const gross = task.coins;
  // You sell what you replace, never what you build on. Recombobulating the Lumberjack Artifact
  // is a step that needs the Artifact in hand, so quoting it net of the Artifact's sale price
  // described selling the very thing being upgraded — 9.6M of Recombobulator reading as 6.4M.
  const buildsOn = task.requires.includes(previous.id) || task.bundle.includes(previous.id);
  const tradeIn = buildsOn || previous.coins === null ? 0 : Math.round(previous.coins * 0.99);
  const net = gross === null ? null : Math.max(gross - tradeIn, 0);

  return {
    ...task,
    xp: gain,
    bundleXp: gain,
    coins: gross,
    bundleCoins: gross,
    grossCoins: gross ?? undefined,
    netCoins: net ?? undefined,
    // Ranked on what it actually costs you once the old one is sold.
    efficiency: net !== null && gain > 0 ? net / gain : null,
    note: `${buildsOn ? "needs" : "upgrade from"} ${previous.name}${task.note ? ` · ${task.note}` : ""}`,
  };
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
      ? // A running count is already the whole span's answer, and it lives on the top tier.
        CUMULATIVE.has(task.category)
        ? task.note
        : material
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

/**
 * Where the level-ups land as you work down a list.
 *
 * A ranked list is read top to bottom and bought in that order, so the useful question at any
 * point is not "how much XP is this" but "what does this get me to". Returns, per row index, the
 * levels the running total crosses once that row is bought — more than one where a chunky row
 * spans a boundary.
 */
export function levelMarks(xpPerRow: number[], startingXp: number): Map<number, number[]> {
  const marks = new Map<number, number[]>();
  let total = startingXp;

  for (const [index, xp] of xpPerRow.entries()) {
    const before = Math.floor(total / XP_PER_LEVEL);
    total += xp;
    const after = Math.floor(total / XP_PER_LEVEL);
    if (after <= before) continue;
    const crossed: number[] = [];
    for (let level = before + 1; level <= after; level++) crossed.push(level);
    marks.set(index, crossed);
  }

  return marks;
}

/** A level boundary in a bought-in-order list, and what the next one costs from there. */
export type LevelDivider = {
  /** Row index the divider sits after — the purchase that earned the level. */
  index: number;
  level: number;
  /** Coins across the rows between this divider and the next, or null if this is the last. */
  costToNext: number | null;
};

/**
 * Level boundaries with the spend between them.
 *
 * At a boundary the question is whether the next level is worth carrying on for, which is a
 * question about the rows *below* the divider — so the figure runs from the row after it up to
 * and including the row that earns the next level. Two levels off one row means the second cost
 * nothing extra to reach.
 */
export function levelDividers(xp: number[], spend: (number | null)[], startingXp: number): LevelDivider[] {
  const marks = levelMarks(xp, startingXp);
  const flat = [...marks.entries()].flatMap(([index, levels]) => levels.map((level) => ({ index, level })));

  return flat.map((divider, position) => {
    const next = flat[position + 1];
    if (!next) return { ...divider, costToNext: null };
    let total = 0;
    for (let i = divider.index + 1; i <= next.index; i++) total += spend[i] ?? 0;
    return { ...divider, costToNext: total };
  });
}
