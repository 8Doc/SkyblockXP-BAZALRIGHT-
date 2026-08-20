/**
 * Where the story objectives actually send you.
 *
 * The objective ids harvested off live profiles are bare slugs — OBJECTIVE_TALK_TO_FARMER — so
 * the app was rendering "Objective talk to farmer" and leaving the player to work out which
 * farmer, on which island, and where. The wiki's NPC infoboxes carry the real name, the island
 * and an x/y/z, which is everything needed to turn that into a directions line.
 *
 * Writes data/generated/npcs.json.
 */
import { writeFile, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WIKI = "https://hypixelskyblock.minecraft.wiki/api.php";
const UA = "skyblock-xp-planner/0.1 (data build script)";

/** "OBJECTIVE_TALK_TO_CHARLIE_NEW_3" -> "Charlie". The trailing number is a quest step. */
export function npcNameFrom(id) {
  const slug = id
    .replace(/^OBJECTIVE_TALK_TO_/, "")
    .replace(/_\d+$/, "")
    .replace(/_NEW$/, "")
    .replace(/^LUMBER_JACK$/, "LUMBERJACK");
  return slug
    .split("_")
    .filter(Boolean)
    .map((w) => w.charAt(0) + w.slice(1).toLowerCase())
    .join(" ");
}

/**
 * Objective slugs that don't name the NPC's page. The greenhouse one is the Carpenter at the
 * Foraging Camp; the slug describes the job, not the character.
 */
const PAGE_ALIASES = { "Greenhouse Carpenter": "Carpenter" };

/**
 * Objectives that name an NPC without saying "talk to". The slug carries the action, so these
 * can't be derived and are listed: the point is the same, telling the player where to go.
 */
const OBJECTIVE_NPCS = {
  OBJECTIVE_BETH_PULL_LEVER: "Beth",
  OBJECTIVE_MEET_BETH_AT_LAB: "Beth",
  OBJECTIVE_GIVE_SAM_WHEAT: "Sam",
  OBJECTIVE_GIVE_SAM_COMPOST: "Sam",
  OBJECTIVE_GIVE_PICKAXE_LAPIS_MINER: "Lapis Miner",
  OBJECTIVE_HELP_ELLE: "Elle",
};

const strip = (value) =>
  value
    ? value
        .replace(/\{\{[^}]*\|([^}|]*)\}\}/g, "$1")
        .replace(/\{\{|\}\}/g, "")
        .replace(/\[\[([^\]|]*\|)?([^\]]*)\]\]/g, "$2")
        .replace(/<[^>]+>/g, "")
        .replace(/'''/g, "")
        .trim()
    : null;

/** Infobox fields are one per line as "|key = value", so this needs no pattern at all. */
function field(text, name) {
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("|")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    if (trimmed.slice(1, eq).trim().toLowerCase() !== name) continue;
    return strip(trimmed.slice(eq + 1));
  }
  return null;
}

async function page(title) {
  const url = `${WIKI}?action=parse&page=${encodeURIComponent(title)}&format=json&prop=wikitext&redirects=1`;
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) return null;
  const body = await res.json();
  return body.error ? null : { title: body.parse.title, text: body.parse.wikitext["*"] };
}

const tasks = JSON.parse(await readFile(join(ROOT, "data", "generated", "tasks.json"), "utf8")).tasks;
const ids = tasks.map((t) => t.id).filter((id) => /^OBJECTIVE_TALK_TO_/.test(id));

// Abiphone contacts are the same problem in a different category: the row names a character and
// says nothing about which island they are on, and there are seventy of them.
let abiphoneNames = [];
try {
  const abiphone = JSON.parse(await readFile(join(ROOT, "data", "generated", "abiphone.json"), "utf8"));
  abiphoneNames = abiphone.contacts.map((c) => c.npc).filter(Boolean);
} catch {
  console.log("  (no abiphone.json — contacts will have no directions)");
}

const wanted = [...new Set([...ids.map(npcNameFrom), ...Object.values(OBJECTIVE_NPCS), ...abiphoneNames])].sort();

console.log(`resolving ${wanted.length} NPCs from ${ids.length} talk-to objectives and ${abiphoneNames.length} contacts…`);
const npcs = {};
let missing = 0;

for (const name of wanted) {
  const found = await page(PAGE_ALIASES[name] ?? name);
  if (!found) {
    console.log(`  ${name.padEnd(22)} (no page)`);
    missing++;
    continue;
  }
  const x = field(found.text, "x");
  const y = field(found.text, "y");
  const z = field(found.text, "z");
  const entry = {
    name: found.title,
    location: field(found.text, "location"),
    quest: field(found.text, "quests"),
    // Rounded: the infobox carries half-blocks, and nobody navigates to a half block.
    coords: x && z ? { x: Math.round(Number(x)), y: Math.round(Number(y ?? 0)), z: Math.round(Number(z)) } : null,
  };
  if (!entry.location && !entry.coords) {
    console.log(`  ${name.padEnd(22)} (page, but no location or coords)`);
    missing++;
  }
  npcs[name] = entry;
  const where = entry.coords ? `${entry.coords.x}, ${entry.coords.y}, ${entry.coords.z}` : "no coords";
  console.log(`  ${name.padEnd(22)} ${String(entry.name).padEnd(20)} ${String(entry.location ?? "-").padEnd(22)} ${where}`);
}

await writeFile(
  join(ROOT, "data", "generated", "npcs.json"),
  JSON.stringify({ generatedAt: new Date().toISOString(), source: WIKI, npcs, objectives: OBJECTIVE_NPCS }, null, 2) + "\n",
);
console.log(`\nwrote ${Object.keys(npcs).length} NPCs (${missing} incomplete) -> data/generated/npcs.json`);
