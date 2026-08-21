import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCatalog } from "../src/lib/catalog";
import { priceOf } from "../src/lib/resolve";
import { familyOf } from "../src/lib/gameData";
import { gameData } from "./gameDataFixture";
import type { ProfileMember } from "../src/lib/profile";
import { CATEGORIES, CATEGORY_LABELS } from "../src/lib/types";

const data = gameData();

const member = {} as ProfileMember;
const emptyBag = { items: [], capacity: 0 };
const museumRows = (owned: Set<string> | null) => {
  const catalog = buildCatalog(member, data, emptyBag, null, null, null, null, owned);
  return catalog.tasks.filter((task) => task.category === "museum");
};

/**
 * A donation you already hold is a walk to the museum. Pricing it at what one costs on the
 * auction house buried the free donations under the bought ones, when they are the cheapest
 * experience on a profile by a distance — 58 of a real profile's 636 open slots were free.
 */
test("a donation already in the player's inventory costs nothing", () => {
  const held = data.museum.donations.find((donation) => donation.tradeable)!;
  const before = museumRows(null).find((task) => task.id === `museum_${held.itemId}`)!;
  assert.equal(before.cost.kind, "auction", "an item you do not hold is still a purchase");

  const after = museumRows(new Set([held.itemId])).find((task) => task.id === `museum_${held.itemId}`)!;
  assert.equal(after.cost.kind, "owned", `${held.name} is in hand and should be free to donate`);
  assert.match(after.note ?? "", /already in your inventory/);
  // "none" would have been the obvious kind and was the wrong one: it means unpriced, so the
  // rows sorted to the bottom of six hundred and fell past the forty-row cut instead of to the
  // top at zero. Costing nothing has to be a price, not the absence of one.
  assert.equal(priceOf(after.cost, { bazaar: {}, bins: null }), 0, "a held donation must price at zero, not null");
});

/**
 * Holding one item must not discount the rest, and a profile that publishes no inventory at all
 * — which is a setting a player can switch off — has to price exactly as it did before.
 */
test("holding one item leaves every other donation priced", () => {
  const held = data.museum.donations.find((donation) => donation.tradeable)!;
  const rows = museumRows(new Set([held.itemId]));
  const free = rows.filter((task) => task.cost.kind === "owned");
  assert.equal(free.length, 1, `${free.length} rows went free on the strength of one held item`);

  const blind = museumRows(null);
  assert.equal(blind.filter((task) => task.cost.kind === "owned").length, 0);
  assert.equal(blind.length, rows.length, "the row count should not depend on what is held");
});

/** An armour set is free only once every piece of it is in hand. */
test("an armour set costs nothing only when all its pieces are held", () => {
  const set = data.museum.armorSets.find((entry) => entry.pieces.length > 1)!;
  const partial = museumRows(new Set([set.pieces[0]!])).find((task) => task.id === `museum_set_${set.setId}`)!;
  assert.notEqual(partial.cost.kind, "owned", "one piece is not a set");

  const whole = museumRows(new Set(set.pieces)).find((task) => task.id === `museum_set_${set.setId}`)!;
  assert.equal(whole.cost.kind, "owned", `${set.name} is complete and should be free to donate`);
  assert.equal(priceOf(whole.cost, { bazaar: {}, bins: null }), 0);
});

/**
 * An accessory costs what it is listed at. A full bag used to add half the next Jacobus upgrade
 * on top — six million a row on a real profile, which quoted a Large Fish Bowl listing at 9.8M
 * as 19.8M, and billed for a slot the bag upgrade task was already charging for. The slot is a
 * prerequisite now, so it is paid once and the price stays the price.
 */
test("a full accessory bag adds a prerequisite, not a markup", () => {
  const full = {
    accessory_bag_storage: { bag_upgrades_purchased: 13 },
  } as unknown as ProfileMember;
  const bag = { items: [], capacity: 0 };

  const catalog = buildCatalog(full, data, bag);
  const rows = catalog.tasks.filter((task) => task.category === "accessory_bag" && task.cost.kind === "auction");
  assert.ok(rows.length > 0, "expected accessories on offer");

  for (const row of rows) {
    const cost = row.cost as { kind: "auction"; surcharge?: number };
    assert.ok(
      cost.surcharge === undefined || cost.surcharge <= 0,
      `${row.name} is marked up by ${cost.surcharge} for a slot it should require instead`,
    );
  }

  const needsSlot = rows.filter((row) => row.requires.some((id) => id.startsWith("bag_upgrade_")));
  assert.ok(needsSlot.length > 0, "a bag with no free slots should make new accessories need one");
  assert.match(needsSlot[0]!.note ?? "", /bag is full/);
});

/** With room to spare, nothing is required and nothing is added. */
test("an accessory bag with room needs no upgrade first", () => {
  const roomy = {
    accessory_bag_storage: { bag_upgrades_purchased: 13 },
  } as unknown as ProfileMember;
  const catalog = buildCatalog(roomy, data, { items: [], capacity: 40 });
  const rows = catalog.tasks.filter((task) => task.category === "accessory_bag" && task.cost.kind === "auction");
  assert.equal(
    rows.filter((row) => row.requires.some((id) => id.startsWith("bag_upgrade_"))).length,
    0,
    "an accessory should not wait on a slot the bag already has",
  );
});

/**
 * Doug's shop at the Carnival. Its perks are not XP and are deliberately absent — they grant
 * fishing wisdom and mining fortune during their own events, Doug's page mentions SkyBlock XP
 * nowhere, and of the 1,056 distinct completed-task ids seen across five real profiles not one
 * is a Carnival id. What the shop does sell that pays XP is the masks, every one a museum
 * donation, and the mask bag, which is an accessory. Those are priced from the auction house
 * like anything else, so the token price rides along as the cheaper route to the same row.
 */
test("Doug's masks carry their token price alongside the auction one", () => {
  const catalog = buildCatalog({} as ProfileMember, data, { items: [], capacity: 40 });
  const shop = data.carnivalShop!;

  for (const item of shop.items) {
    const row = catalog.tasks.find(
      (task) => task.id === `museum_${item.id}` || task.id === `accessory_${item.id}`,
    );
    assert.ok(row, `${item.name} should be a museum donation or an accessory`);
    assert.match(
      row!.note ?? "",
      new RegExp(`${item.tokens.toLocaleString()} ${shop.currency} from ${shop.npc}`),
      `${item.name} should say what Doug charges`,
    );
  }

  // The Bee Mask is the case that makes the point: nine million on the auction house.
  const bee = catalog.tasks.find((task) => task.id === "museum_BEE_MASK")!;
  assert.equal(bee.cost.kind, "auction", "the mask is still bought at the market price by default");
  assert.ok(bee.xp > 0);
});

/**
 * Accessories nobody can buy get a category of their own, directly below the accessory bag.
 * They were never missing from the totals — they sat among the purchasable rows with no price,
 * where a list ordered by coins per XP has nowhere sensible to put them.
 */
test("accessories with no way to buy them are their own category", () => {
  const catalog = buildCatalog({} as ProfileMember, data, { items: [], capacity: 400 });
  const grind = catalog.tasks.filter((task) => task.category === "accessory_grind");
  const shop = catalog.tasks.filter((task) => task.category === "accessory_bag");

  assert.ok(grind.length > 0, "expected some accessories to be unbuyable");
  assert.ok(shop.length > grind.length, "most accessories should still be purchasable");

  // An unpriceable row may stay in the buy list only when its family can be bought through
  // some other member — the Rift's Bluetooth Ring shares a chain with the Bluertooth Ring, which
  // is on the auction house, so that family really is one you can buy your way to the top of.
  for (const task of shop.filter((row) => row.cost.kind === "unknown")) {
    const group = task.exclusiveGroup;
    assert.ok(group, `${task.name} has no price and no family to reach it through`);
    const buyable = shop.some((row) => row.exclusiveGroup === group && row.cost.kind !== "unknown");
    assert.ok(buyable, `${task.name} cannot be bought and belongs in the grind category`);
  }
});

/**
 * A family is one exclusive group, so it has to sit in one category: split across two, its
 * magical power is credited to both and the totals quietly gain a few hundred XP. Only the
 * Bluetooth Ring chain is mixed, and a family with any buyable member is one you can buy your
 * way to the top of, so it stays in the buy list.
 */
test("no accessory family is split across the two categories", () => {
  const catalog = buildCatalog({} as ProfileMember, data, { items: [], capacity: 400 });
  const categoryOf = new Map<string, Set<string>>();
  for (const task of catalog.tasks) {
    if (task.category !== "accessory_bag" && task.category !== "accessory_grind") continue;
    if (!task.exclusiveGroup) continue;
    if (!categoryOf.has(task.exclusiveGroup)) categoryOf.set(task.exclusiveGroup, new Set());
    categoryOf.get(task.exclusiveGroup)!.add(task.category);
  }
  const split = [...categoryOf.entries()].filter(([, seen]) => seen.size > 1).map(([group]) => group);
  assert.deepEqual(split, [], "these families are counted in both categories");
});

/** The new category sits directly below the accessory bag, which is where it was asked for. */
test("the grind-only category follows the accessory bag", () => {
  const bag = CATEGORIES.indexOf("accessory_bag");
  assert.equal(CATEGORIES[bag + 1], "accessory_grind");
  assert.equal(CATEGORY_LABELS.accessory_grind, "Accessory Bag — Grind Only");
});

/**
 * The six accessories that climb rarity in place, through their own mechanic rather than a
 * Recombobulator. They were the last of the gap between what this accounts for and the 2,121
 * the wiki publishes, and they are grind rows: no price, the mechanic as the note, and the
 * accessory itself as a prerequisite, because you cannot upgrade what you do not own.
 */
test("the accessories that climb in place are grind rows", () => {
  const catalog = buildCatalog({} as ProfileMember, data, { items: [], capacity: 400 });
  for (const climb of data.magicalPower.climbing!.items) {
    const row = catalog.tasks.find((task) => task.id === `accessory_climb_${climb.id}`);
    assert.ok(row, `${climb.id} should have a climb row`);
    assert.equal(row!.category, "accessory_grind");
    assert.equal(row!.cost.kind, "unknown", "a climb is not a purchase");
    assert.deepEqual(row!.requires, [`accessory_${climb.id}`], "the accessory comes first");
    assert.match(row!.note ?? "", new RegExp(climb.to.toLowerCase()));
    assert.equal(row!.xp, climb.forgone, `${climb.id} should be worth its stated forgone power`);
  }
});

/**
 * A climb sits outside its family's exclusive group on purpose: the group is already capped at
 * what the rarity ladder plus one Recombobulator reaches, and the climb is the step beyond it.
 * Inside the group it would compete with the purchase it depends on rather than add to it.
 */
test("a climb adds to its family rather than competing with it", () => {
  const catalog = buildCatalog({} as ProfileMember, data, { items: [], capacity: 400 });
  for (const climb of data.magicalPower.climbing!.items) {
    const row = catalog.tasks.find((task) => task.id === `accessory_climb_${climb.id}`)!;
    assert.equal(row.exclusiveGroup, undefined, `${climb.id}'s climb should not join the family group`);
  }
});

/**
 * Recombobulating is worth doing to whichever member of a family reaches highest, which is not
 * always the one in the bag: recombobulating a held Artifact of Power reaches epic, while buying
 * the Relic of Power and recombobulating that reaches mythic. Picking the held one regardless
 * left every such family four magical power short.
 */
test("recombobulation targets whichever family member reaches highest", () => {
  const catalog = buildCatalog({} as ProfileMember, data, { items: [], capacity: 400 });
  const relic = catalog.tasks.find((task) => task.id === "recombobulate_POWER_RELIC");
  assert.ok(relic, "the Relic of Power is the member worth recombobulating in its family");
  assert.ok(
    relic!.requires.includes("accessory_POWER_RELIC"),
    "recombobulating something you have yet to buy has to depend on buying it",
  );
});

/**
 * Thirteen accessories were missing from the catalogue for want of a rarity, because half these
 * infoboxes write it as a bare letter — "|rarity = c" — and the parser only understood full
 * words and the {{r|c}} template. Dante's Ring was one of them, which is why a player holding
 * one was told to go and buy Dante's Talisman.
 */
test("accessories whose rarity is written as a bare letter are catalogued", () => {
  const byId = new Map(data.accessories.accessories.map((a) => [a.id, a]));
  for (const id of ["DANTE_RING", "BLOOD_GOD_CREST", "BEASTMASTER_CREST_COMMON", "MASTER_SKULL_TIER_1"]) {
    assert.ok(byId.has(id), `${id} should be in the catalogue`);
  }
  assert.equal(
    familyOf(data, byId.get("DANTE_RING")!.name, "DANTE_RING"),
    familyOf(data, byId.get("DANTE_TALISMAN")!.name, "DANTE_TALISMAN"),
    "the Dante line is one family",
  );
});

/**
 * The anniversary hats do not stack. The wiki's tally of the maximum lists exactly one across
 * every colour and both editions, noting that it has other versions — and a player with a maxed
 * accessory bag was being offered two more.
 */
test("every Hat of Celebration is one family", () => {
  const hats = data.accessories.accessories.filter((a) => /Hat of Celebration/.test(a.name));
  assert.ok(hats.length >= 3, "expected several hats");
  const families = new Set(hats.map((hat) => familyOf(data, hat.name, hat.id)));
  assert.equal(families.size, 1, `the hats split into ${[...families].join(", ")}`);
});
