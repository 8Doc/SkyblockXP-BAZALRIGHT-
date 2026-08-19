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
  const task = byId.get("OBJECTIVE_TALK_TO_FARMER")!;
  assert.equal(task.name, "Talk to Farmer Rigby", "the slug says FARMER; the character has a name");
  assert.match(task.note ?? "", /^Farm · -?\d+, -?\d+, -?\d+$/, `got ${task.note}`);
});

test("the trailing number on an objective is a quest step, not part of the name", () => {
  assert.equal(byId.get("OBJECTIVE_TALK_TO_CHARLIE_NEW_3")!.name, "Talk to Charlie");
  assert.equal(byId.get("OBJECTIVE_TALK_TO_DAVID_7")!.name, "Talk to David Hunterborough");
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
