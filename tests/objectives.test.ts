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

test("the trailing number names the step rather than joining the NPC's name", () => {
  assert.equal(byId.get("OBJECTIVE_TALK_TO_CHARLIE_NEW_3")!.name, "Talk to Charlie (step 3)");
  assert.equal(byId.get("OBJECTIVE_TALK_TO_DAVID_7")!.name, "Talk to David Hunterborough (step 7)");
});

test("two steps at the same NPC are told apart", () => {
  // Both carry the same name and the same coordinates, so without the step the row you have
  // already finished is indistinguishable from the one you have not — which reads as the app
  // failing to notice you did it.
  const first = byId.get("OBJECTIVE_TALK_TO_FARMER")!;
  const second = byId.get("OBJECTIVE_TALK_TO_FARMER_2")!;
  assert.equal(first.name, "Talk to Farmer Rigby");
  assert.equal(second.name, "Talk to Farmer Rigby (step 2)");
  assert.equal(first.note, second.note, "same NPC, so the directions are identical");
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
