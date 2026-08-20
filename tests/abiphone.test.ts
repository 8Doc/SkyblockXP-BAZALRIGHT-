import { test } from "node:test";
import assert from "node:assert/strict";
import abiphone from "../data/generated/abiphone.json";
import tasks from "../data/generated/tasks.json";

/**
 * Contacts are 10 XP each and most are one item handed to an NPC, which makes them among the
 * cheapest XP in the game. They were previously priced `none` and filed as grind, so none of
 * them could rank — the symptom was a "cheapest per XP" list that started an order of
 * magnitude above the real floor.
 */
test("every contact joins a harvested task id", () => {
  const known = new Set(tasks.tasks.filter((t) => t.category === "abiphone").map((t) => t.id));
  const missing = abiphone.contacts.filter((c) => !known.has(c.taskId));
  assert.deepEqual(
    missing.map((c) => `${c.npc} -> ${c.taskId}`),
    [],
    "a contact pointing at an id no profile reports would price nothing",
  );
});

/**
 * The profile names some contacts by role rather than by person, and the wiki has rows for
 * NPCs no sampled profile has ever completed. Those rows are recorded rather than dropped, so
 * the gap is countable instead of invisible.
 */
test("wiki rows with no task id are recorded, not silently dropped", () => {
  assert.equal(abiphone.totals.unmatched, abiphone.unmatched.length);
  for (const row of abiphone.unmatched) assert.ok(row.npc, "an unmatched row still names its NPC");
});

test("a role-matched contact points at the role's id", () => {
  const kat = abiphone.contacts.find((c) => c.npc === "Kat");
  assert.equal(kat?.taskId, "ABIPHONE_pet_sitter");
  const maddox = abiphone.contacts.find((c) => c.npc === "Maddox the Slayer");
  assert.equal(maddox?.taskId, "ABIPHONE_slayer", "matched by word subset rather than by name");
});

test("no two contacts claim the same task id", () => {
  const ids = abiphone.contacts.map((c) => c.taskId);
  assert.equal(new Set(ids).size, ids.length);
});

/** The four shapes the requirement column comes in, one example each. */
test("requirements parse into the cost they describe", () => {
  const of = (npc: string) => abiphone.contacts.find((c) => c.npc === npc);

  assert.deepEqual(of("Agatha")?.cost, { kind: "npc", coins: 0 }, "'No requirement.' is free");
  assert.deepEqual(of("Blacksmith")?.cost, { kind: "npc", coins: 32_000_000 }, "'Paying N coins.'");
  assert.deepEqual(
    of("Oringo")?.cost,
    { kind: "bazaar", items: [{ id: "SILENT_PEARL", qty: 64 }] },
    "'Giving 64x Silent Pearl.'",
  );
  assert.equal(of("Dusk")?.cost.kind, "none", "slaying a runic Enderman is not a purchase");
});

/**
 * A requirement with a non-purchase half has to say so. Walter's item is buyable; Walter is
 * not, until the Sulphur collection is there too, and a price with no caveat reads as one click.
 */
test("a requirement that is only half a purchase carries its caveat", () => {
  const walter = abiphone.contacts.find((c) => c.npc === "Walter");
  assert.equal(walter?.cost.kind, "bazaar");
  assert.match(walter?.caveat ?? "", /Sulphur/i);
});

/** Anything unpriced must say what it couldn't reduce, rather than silently reading as free. */
test("unpriced contacts name what stopped them", () => {
  for (const c of abiphone.contacts) {
    if (c.cost.kind !== "unknown") continue;
    assert.ok((c.cost as { note?: string }).note, `${c.npc} is unknown with no note`);
  }
});

test("the totals agree with the contacts they count", () => {
  const t = abiphone.totals;
  assert.equal(t.contacts, abiphone.contacts.length);
  const counted = t.free + t.coins + t.items + t.essence + t.unknown + t.quest;
  assert.equal(counted, abiphone.contacts.length, "every contact lands in exactly one bucket");
});
