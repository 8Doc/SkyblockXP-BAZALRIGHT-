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
 */
export function parseCooldowns(html) {
  return [...html.matchAll(/Cooldown:(?:&#160;|\s|<[^>]*>)*([\d.]+)\s*s/g)].map((m) => Number(m[1]));
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
        source: "Hypixel Wiki, one page per minion: the infobox for what it collects, the rendered stats table for per-tier cooldowns.",
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
