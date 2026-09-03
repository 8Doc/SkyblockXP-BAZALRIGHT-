/**
 * What a minion actually produces, per tier.
 *
 * `minions.json` comes from Hypixel's own item resource and knows every minion's tiers and the
 * SkyBlock XP each one is worth. It does not know the one thing a production calculator needs:
 * how fast a tier acts and how much it drops when it does. Neither does any other Hypixel
 * endpoint — the item resource carries `generator` and `generator_tier` and nothing else — so
 * this comes off the community wiki, a page per minion.
 *
 * **The factor of two that decides every answer.** A minion's stats table quotes a cooldown, and
 * that is the time between *actions*, not between drops. The Minions page states the rule
 * outright and works the example: "if a Tier I Cobblestone Minion does an action every 14
 * seconds, the minion will generate 1 Cobblestone every 28 seconds and not 14 seconds" — a
 * minion generates on one action and harvests on the next. Reading the cooldown as the drop
 * interval doubles every rate on the page, which would look entirely plausible.
 *
 * Two requests per minion, because the two halves live in different places: the infobox is
 * wikitext (`collects`, `collection`) and the per-tier cooldowns only exist once the stats
 * template has been expanded, which needs the rendered HTML.
 */

import { writeFile, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WIKI = "https://hypixelskyblock.minecraft.wiki/api.php";
const OUT = join(ROOT, "data", "generated", "minion-production.json");

/** Requests at a time. The wiki is a volunteer host; this is a build step, not a hot path. */
const WIDTH = 4;

async function wiki(params) {
  const url = `${WIKI}?${new URLSearchParams({ format: "json", ...params })}`;
  // 122 requests in a burst earns a 429, and losing one costs that minion its entire row. Back
  // off and try again rather than shipping a table with a hole in it.
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(url);
    if (response.ok) return response.json();
    if (response.status !== 429 || attempt >= 3) throw new Error(`${response.status} for ${params.page}`);
    await new Promise((done) => setTimeout(done, 2_000 * (attempt + 1)));
  }
}

/* ------------------------------------------------------------------ parsing */

/**
 * `|collects = 4 Acacia Log` → four of it a harvest. A bare `|collects = Cobblestone` is one.
 *
 * The amount is per *harvest*, not per action, and the two differ by the factor of two above.
 *
 * Four shapes appear and the first cut only handled one, which silently dropped some of the best
 * collection minions on the page:
 *
 *   4 Acacia Log      a plain count
 *   1x Flower         an "x" suffix
 *   * 2-5 String      a list bullet and a range — Tarantula, and the range is the drop
 *   *0.4 Nether Quartz  a fraction, already an expectation per harvest
 *
 * A range is averaged, because that is what it is worth over a grind, and both ends are kept so
 * the caller can say so rather than presenting a midpoint as a fact.
 */
export function parseCollects(wikitext) {
  const line = /\|\s*collects\s*=\s*([^\n|]+)/.exec(wikitext);
  if (!line) return null;
  const raw = line[1]
    .replace(/\{\{Item\|([^}|]+)[^}]*\}\}/g, "$1")
    .replace(/\[\[([^\]|]*)\|?([^\]]*)\]\]/g, (_, a, b) => b || a)
    // A leading bullet is list markup, not part of the figure.
    .replace(/^\s*\*+\s*/, "")
    .trim();

  const range = /^([\d.,]+)\s*-\s*([\d.,]+)\s*x?\s+(.+)$/.exec(raw);
  if (range) {
    const low = Number(range[1].replace(/,/g, ""));
    const high = Number(range[2].replace(/,/g, ""));
    return { amount: (low + high) / 2, low, high, item: range[3].trim() };
  }

  const counted = /^([\d.,]+)\s*x?\s+(.+)$/.exec(raw);
  if (counted) return { amount: Number(counted[1].replace(/,/g, "")), item: counted[2].trim() };

  // "1x Flower" with no space before the name.
  const tight = /^([\d.,]+)x(.+)$/.exec(raw);
  if (tight) return { amount: Number(tight[1].replace(/,/g, "")), item: tight[2].trim() };

  return { amount: 1, item: raw };
}

/**
 * `|collection = Acacia Log 1` → the collection this minion feeds, minus the unlock tier.
 *
 * The trailing number is the tier at which the *recipe* unlocks, which is not what we want —
 * the collection name is. `Cobblestone I` uses a roman numeral and `Acacia Log 1` an arabic one,
 * so both are stripped.
 */
export function parseCollection(wikitext) {
  const line = /\|\s*collection\s*=\s*([^\n|]+)/.exec(wikitext);
  if (!line) return null;
  const raw = line[1].replace(/\{\{[^}]*\|([^}|]+)[^}]*\}\}/g, "$1").replace(/\[\[([^\]|]*)\|?([^\]]*)\]\]/g, (_, a, b) => b || a).trim();
  return raw.replace(/\s+(?:[IVXLC]+|\d+)$/, "").trim() || null;
}

/**
 * Per-tier cooldowns out of the rendered stats table.
 *
 * The markup is `Cooldown:&#160;<span class="...">48s</span>`, one per tier row in order, so the
 * nth match is tier n. Fragile in the way all scraping is; the cross-checks in the test guard the
 * shape — twelve tiers, monotonically non-increasing, all positive.
 *
 * The wiki has since relabelled this to the game's own wording, `Time Between Action:`, which is
 * the better name — a cooldown sounds like a wait between drops and it is a wait between actions,
 * which is the factor of two this whole file is about. Both spellings are read, because the old
 * one is what the committed table was scraped from and a parser that silently returns nothing is
 * worse than one that reads two labels.
 */
const ACTION_LABEL = /(?:Cooldown|Time Between Action):(?:&#160;|&amp;[0-9a-fk-or]|&[0-9a-fk-or]|\s|<[^>]*>|\/)*([\d.]+)\s*s/g;

export function parseCooldowns(html) {
  return [...html.matchAll(ACTION_LABEL)].map((m) => Number(m[1]));
}

/**
 * Per-tier storage, out of the same rendered page and in the same order.
 *
 * A rate on its own answers "how much an hour" and cannot answer the question a player standing
 * in front of five minions actually has: *how long can I leave these alone before it stops?*
 * Storage is the other half of that, and Hypixel's item resource does not carry it either — it
 * lives in the minetip tooltip the wiki renders beside every tier, as `Max Storage: &e64`.
 *
 * The figure is in items, and it is the minion's own inventory before any Minion Storage chest
 * is stood next to it. Every minion in the game shares one ladder — 64, 192, 192, 384, 384, 576,
 * 576, 768, 768, 960, 960, 960 — but it is scraped per minion rather than assumed, because that
 * ladder is the sort of thing an update changes for one family and nothing else.
 *
 * Both this and the cooldowns match far more tooltips than there are tiers: the crafting tables
 * further down the page show lower-tier minions as ingredients, and each of those carries its own
 * tooltip. The tier ladder is the leading run, so the caller trims to the tier count it already
 * knows from Hypixel rather than trusting the match count.
 */
const STORAGE_LABEL = /Max Storage:(?:&#160;|&amp;[0-9a-fk-or]|&[0-9a-fk-or]|\s|<[^>]*>|\/)*([\d,]+)/g;

export function parseStorage(html) {
  return [...html.matchAll(STORAGE_LABEL)].map((m) => Number(m[1].replace(/,/g, "")));
}


/* -------------------------------------------------------------------- fetch */

async function forMinion(family) {
  const [text, rendered] = await Promise.all([
    wiki({ action: "parse", page: family, prop: "wikitext" }),
    wiki({ action: "parse", page: family, prop: "text" }),
  ]);
  if (!text.parse || !rendered.parse) return { missing: true };

  return {
    collects: parseCollects(text.parse.wikitext["*"]),
    collection: parseCollection(text.parse.wikitext["*"]),
    cooldowns: parseCooldowns(rendered.parse.text["*"]),
    storage: parseStorage(rendered.parse.text["*"]),
  };
}

async function main() {
  const minions = JSON.parse(await readFile(join(ROOT, "data", "generated", "minions.json"), "utf8")).minions;
  const collections = JSON.parse(await readFile(join(ROOT, "data", "generated", "collections.json"), "utf8")).collections;
  const collectionByName = new Map(collections.map((c) => [c.name.toLowerCase(), c.itemId]));

  const out = [];
  const problems = [];

  for (let i = 0; i < minions.length; i += WIDTH) {
    const batch = minions.slice(i, i + WIDTH);
    const results = await Promise.all(batch.map((m) => forMinion(m.family).catch((e) => ({ error: String(e) }))));

    batch.forEach((m, at) => {
      const r = results[at];
      if (r.missing || r.error) {
        problems.push(`${m.family}: ${r.error ?? "no wiki page"}`);
        return;
      }
      if (!r.collects || r.cooldowns.length === 0) {
        problems.push(`${m.family}: ${!r.collects ? "no collects line" : "no cooldowns in the stats table"}`);
        return;
      }

      // The collection the drop feeds, resolved by name against the real collection table. A
      // minion whose drop is not a collection item at all is kept with a null: several produce
      // things nothing collects, and dropping them would quietly shorten the list.
      const collectionId =
        collectionByName.get((r.collection ?? "").toLowerCase()) ?? collectionByName.get(r.collects.item.toLowerCase()) ?? null;

      out.push({
        generator: m.generator,
        family: m.family,
        maxTier: m.maxTier,
        collects: r.collects,
        collection: r.collection,
        collectionId,
        // One cooldown per tier, in tier order. Trimmed to the tiers Hypixel actually publishes,
        // since the wiki occasionally lists a tier XII the item resource has not seen.
        cooldowns: r.cooldowns.slice(0, m.maxTier),
        // Same trim as the cooldowns, and empty where the tooltip did not carry a figure — an
        // absent storage is a minion whose fill time cannot be quoted, not one that never fills.
        storage: r.storage.slice(0, m.maxTier),
      });
    });
    process.stdout.write(`\r  ${Math.min(i + WIDTH, minions.length)}/${minions.length}`);
  }

  process.stdout.write("\n");
  out.sort((a, b) => a.family.localeCompare(b.family));

  const unmatched = out.filter((m) => m.collectionId === null);
  const short = out.filter((m) => m.cooldowns.length < m.maxTier);

  await writeFile(
    OUT,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        source:
          "Hypixel Wiki, one page per minion: the infobox for what it collects, the rendered stats table for " +
          "per-tier cooldowns, and the minetip tooltip beside each tier for its max storage.",
        note:
          "A cooldown is the time between ACTIONS. A minion generates on one action and harvests on the next, so a drop " +
          "lands every 2 x cooldown. The Minions page states this and works the example: a 14s Cobblestone Minion I " +
          "drops 1 Cobblestone every 28 seconds.",
        actionsPerHarvest: 2,
        minions: out,
      },
      null,
      1,
    ) + "\n",
  );

  console.log(`-> ${out.length} of ${minions.length} minions`);
  if (unmatched.length) console.log(`   ${unmatched.length} whose drop is not a collection: ${unmatched.map((m) => m.family).join(", ")}`);
  if (short.length) console.log(`   ${short.length} with fewer cooldowns than tiers: ${short.map((m) => `${m.family} (${m.cooldowns.length}/${m.maxTier})`).join(", ")}`);
  if (problems.length) console.log(`   ${problems.length} skipped:\n     ${problems.join("\n     ")}`);
}

if (process.argv[1]?.endsWith("fetch-minion-production.mjs")) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
