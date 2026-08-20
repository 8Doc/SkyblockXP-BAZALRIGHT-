import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCatalog } from "../src/lib/catalog";
import { gameData } from "./gameDataFixture";

const data = gameData();

const catalog = buildCatalog({ collection: {}, player_data: {} } as never, data, { items: null, capacity: 0 }, null, null, null, null);
const byId = new Map(catalog.tasks.map((t) => [t.id, t]));

/**
 * The ids are bare slugs harvested off live profiles, so "Objective talk to farmer" left the
 * player to work out which farmer, on which island, and where.
 */
test("a talk-to objective names the NPC and says where they are", () => {
  // Hattie rather than the Farmer: the Farmer is one of the two characters two objectives share,
  // so that name carries a disambiguating number and is the wrong example of a clean one.
  const task = byId.get("OBJECTIVE_TALK_TO_HATTIE_2")!;
  assert.equal(task.name, "Talk to Hattie", "the slug says HATTIE_2; the character has a name");
  assert.match(task.note ?? "", /^[A-Za-z' ]+ \u00b7 -?\d+, -?\d+, -?\d+$/, `got ${task.note}`);
});

test("a number in the id is not a position in a sequence", () => {
  // The table carries INCREASE_FARMING_SKILL_5, and TALK_TO_DAVID_7 with no David 1 through 6
  // anywhere — the number is part of the id. Reading it as a step invented six errands.
  assert.equal(byId.get("OBJECTIVE_TALK_TO_CHARLIE_NEW_3")!.name, "Talk to Charlie");
  assert.equal(byId.get("OBJECTIVE_TALK_TO_DAVID_7")!.name, "Talk to David Hunterborough");
});

test("two objectives at the same NPC are told apart, and only those", () => {
  // These two are the table's only pair sharing a character. Both render the same name and the
  // same coordinates, so undecorated the one you have finished is indistinguishable from the one
  // you have not — but every other talk-to objective is unique and keeps a clean name.
  const first = byId.get("OBJECTIVE_TALK_TO_FARMER")!;
  const second = byId.get("OBJECTIVE_TALK_TO_FARMER_2")!;
  assert.equal(first.name, "Talk to Farmer Rigby (1)");
  assert.equal(second.name, "Talk to Farmer Rigby (2)");
  assert.equal(first.note, second.note, "same NPC, so the directions are identical");

  const talkTo = [...byId.values()].filter((t) => t.id.startsWith("OBJECTIVE_TALK_TO_"));
  const names = talkTo.map((t) => t.name);
  assert.equal(new Set(names).size, names.length, "no two talk-to objectives may render alike");
  // Numbered only where the plain name would collide — asserted as the rule rather than a count,
  // since the table has two such pairs today and may have three tomorrow.
  const plainName = (t: { name: string }) => t.name.replace(/ \(\d+\)$/, "");
  const shared = new Set(
    talkTo.map(plainName).filter((n, i, all) => all.indexOf(n) !== i),
  );
  for (const t of talkTo) {
    const numbered = /\(\d+\)$/.test(t.name);
    assert.equal(numbered, shared.has(plainName(t)), `${t.id} numbering should follow whether the name collides`);
  }
});

test("objectives that name an NPC without saying 'talk to' get directions too", () => {
  const sam = byId.get("OBJECTIVE_GIVE_SAM_WHEAT")!;
  assert.equal(sam.name, "Give Sam wheat", "the slug flattened the name to lower case");
  assert.match(sam.note ?? "", /Private Island · /);
});

test("an objective with nowhere to send you keeps its plain note", () => {
  const task = byId.get("OBJECTIVE_MINE_COAL")!;
  assert.equal(task.name, "Mine coal");
  assert.equal(task.note, "story objectives", "no invented coordinates");
});

test("every talk-to objective resolves to a real NPC with coordinates", () => {
  const talk = catalog.tasks.filter((t) => t.id.startsWith("OBJECTIVE_TALK_TO_"));
  assert.ok(talk.length > 20, `only ${talk.length} talk-to objectives`);
  const undirected = talk.filter((t) => !/· -?\d+, -?\d+, -?\d+$/.test(t.note ?? ""));
  assert.deepEqual(undirected.map((t) => t.id), [], "these would still read as a bare slug");
});
