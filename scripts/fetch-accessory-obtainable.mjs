/**
 * Which accessories no player can ever hold.
 *
 * Some accessories in the items resource read as perfectly ordinary — the Talisman, Ring and
 * Artifact of Space are uncommon, rare and epic, and the Grizzly Paw is rare — and have only
 * ever existed in a former admin's inventory. Others were craftable once and are not any more.
 * Nothing in the API marks either kind, so a maxed player is told to go and buy a staff curio.
 *
 * Two sources, because neither is complete on its own:
 *
 *   the page      — `{{Admin only}}`, `{{Historical article}}` or `{{Unobtainable}}` at the top
 *                   of an accessory's own article says it outright.
 *   the register  — the newer community wiki keeps an `Admin-only` page listing item ids in
 *                   `{{Code|...}}` templates. It is the only place naming the Old Boot and the
 *                   Ring of Space, which have no article of their own on either wiki.
 *
 * This is deliberately conservative: an accessory is only recorded when one of those says so.
 * Being wrong here hides real XP, so silence means obtainable.
 */
import { writeFile, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FANDOM = "https://hypixel-skyblock.fandom.com/api.php";
/** The community wiki that carries the pages Fandom never got, and the admin register. */
const COMMUNITY = "https://hypixelskyblock.minecraft.wiki/api.php";
const UA = { "User-Agent": "skyblock-xp-planner/0.1 (data build script)" };

const accessories = JSON.parse(await readFile(join(ROOT, "data/generated/accessories.json"), "utf8")).accessories;

/** Why no player can hold this, in the wiki's own words. Only the page head is trusted. */
function unobtainableReason(text) {
  const head = (text ?? "").slice(0, 400);
  if (/\{\{\s*Admin only/i.test(head)) return "admin only";
  if (/\{\{\s*Historical article/i.test(head)) return "removed from the game";
  if (/\{\{\s*Unobtainable/i.test(head)) return "unobtainable";
  return null;
}

/** Every accessory id the community wiki's Admin-only register lists. */
async function readRegister() {
  const url = `${COMMUNITY}?action=query&prop=revisions&rvprop=content&rvslots=main&format=json&redirects=1&titles=Admin-only`;
  const body = await fetch(url, { headers: UA }).then((r) => r.json());
  const text = Object.values(body.query?.pages ?? {})[0]?.revisions?.[0]?.slots?.main?.["*"] ?? "";
  return new Set([...text.matchAll(/\{\{\s*Code\s*\|\s*([A-Z0-9_]+)\s*\}\}/g)].map((m) => m[1]));
}

/** Page head reasons, keyed by the id the infobox states, from one wiki. */
async function readPages(api, label) {
  const reasons = new Map();
  const titles = accessories.map((a) => a.name);
  for (let i = 0; i < titles.length; i += 50) {
    const batch = titles.slice(i, i + 50);
    const url = `${api}?action=query&prop=revisions&rvprop=content&rvslots=main&redirects=1&format=json&titles=${batch
      .map(encodeURIComponent)
      .join("|")}`;
    const body = await fetch(url, { headers: UA }).then((r) => r.json()).catch(() => null);
    for (const page of Object.values(body?.query?.pages ?? {})) {
      const text = page.revisions?.[0]?.slots?.main?.["*"];
      if (!text) continue;
      const reason = unobtainableReason(text);
      if (!reason) continue;
      // Key on the id the infobox states where it has one, since a redirect means the title we
      // asked for need not be the accessory we got.
      const stated = /\|\s*id\s*=\s*([A-Za-z0-9_]+)/.exec(text)?.[1]?.toUpperCase();
      const acc = accessories.find((a) => a.id === stated) ?? accessories.find((a) => a.name === page.title);
      if (acc) reasons.set(acc.id, reason);
    }
    process.stdout.write(`\r  ${label} ${Math.min(i + 50, titles.length)}/${titles.length}`);
  }
  process.stdout.write("\n");
  return reasons;
}

const register = await readRegister();
console.log(`  ${register.size} item ids on the admin-only register`);
const fandom = await readPages(FANDOM, "fandom   ");
const community = await readPages(COMMUNITY, "community");

const unobtainable = [];
for (const acc of accessories) {
  const reason = fandom.get(acc.id) ?? community.get(acc.id) ?? (register.has(acc.id) ? "admin only" : null);
  if (reason) unobtainable.push({ id: acc.id, name: acc.name, reason });
}
unobtainable.sort((a, b) => a.id.localeCompare(b.id));

await writeFile(
  join(ROOT, "data/generated/accessory_obtainable.json"),
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      source: "Hypixel SkyBlock Fandom wiki page heads, plus the community wiki's Admin-only register",
      note: "Accessories no player can hold: staff curios and things removed from the game. They read as ordinary accessories in the items resource, so nothing but the wiki says they are off limits.",
      consequence:
        "Listing one offers a maxed player a former admin's curio as missing XP, and inflates the bag's ceiling by magical power nobody can collect. Being wrong the other way hides real XP, so only an explicit statement counts and silence means obtainable.",
      unobtainable,
    },
    null,
    1,
  ) + "\n",
);
console.log(`  ${unobtainable.length} accessories nobody can hold`);
