import { test } from "node:test";
import assert from "node:assert/strict";
import { bagItemsFrom, readNbt } from "../src/lib/nbt";

/**
 * Byte-level tests for the NBT reader. This used to be prismarine-nbt; it's first-party now so
 * the same decode can run in the browser, which means it needs its own coverage. The parser was
 * verified against prismarine-nbt on a real 138-item talisman bag before the swap.
 */

/* --------------------------------------------------------------- byte builder */

class Writer {
  private bytes: number[] = [];

  u8(value: number) {
    this.bytes.push(value & 0xff);
    return this;
  }

  i16(value: number) {
    return this.u8(value >> 8).u8(value);
  }

  i32(value: number) {
    return this.u8(value >> 24).u8(value >> 16).u8(value >> 8).u8(value);
  }

  str(value: string) {
    const encoded = new TextEncoder().encode(value);
    this.i16(encoded.length);
    for (const byte of encoded) this.u8(byte);
    return this;
  }

  /** A named tag: type, name, then the caller writes the payload. */
  tag(type: number, name: string) {
    return this.u8(type).str(name);
  }

  end() {
    return this.u8(0);
  }

  done(): Uint8Array {
    return new Uint8Array(this.bytes);
  }
}

/** Root compound wrapper — every NBT document starts with one. */
function document(build: (w: Writer) => void): Uint8Array {
  const w = new Writer().u8(10).str("");
  build(w);
  return w.end().done();
}

/* --------------------------------------------------------------------- tests */

test("reads the scalar tag types", () => {
  const bytes = document((w) => {
    w.tag(1, "byte").u8(7);
    w.tag(2, "short").i16(-300);
    w.tag(3, "int").i32(70000);
    w.tag(8, "text").str("hello");
  });

  assert.deepEqual(readNbt(bytes), { byte: 7, short: -300, int: 70000, text: "hello" });
});

test("reads nested compounds", () => {
  const bytes = document((w) => {
    w.tag(10, "outer");
    w.tag(10, "inner");
    w.tag(3, "value").i32(42);
    w.end(); // inner
    w.end(); // outer
  });

  assert.deepEqual(readNbt(bytes), { outer: { inner: { value: 42 } } });
});

test("reads a list of compounds, the shape an inventory uses", () => {
  const bytes = document((w) => {
    w.tag(9, "i").u8(10).i32(2);
    w.tag(3, "slot").i32(0);
    w.end();
    w.tag(3, "slot").i32(1);
    w.end();
  });

  assert.deepEqual(readNbt(bytes), { i: [{ slot: 0 }, { slot: 1 }] });
});

test("an empty list is encoded as a list of TAG_End and reads as empty", () => {
  // Minecraft writes empty lists with element type 0 and a length that must not be trusted.
  const bytes = document((w) => w.tag(9, "i").u8(0).i32(0));
  assert.deepEqual(readNbt(bytes), { i: [] });
});

test("pulls item ids and recombobulations out of a bag", () => {
  const bytes = document((w) => {
    w.tag(9, "i").u8(10).i32(3);

    // An empty slot: a compound with nothing in it.
    w.end();

    // A recombobulated accessory.
    w.tag(10, "tag");
    w.tag(10, "ExtraAttributes");
    w.tag(8, "id").str("TARANTULA_RING");
    w.tag(3, "rarity_upgrades").i32(1);
    w.end(); // ExtraAttributes
    w.end(); // tag
    w.end(); // slot

    // A plain one.
    w.tag(10, "tag");
    w.tag(10, "ExtraAttributes");
    w.tag(8, "id").str("BAT_RING");
    w.end();
    w.end();
    w.end();
  });

  assert.deepEqual(bagItemsFrom(readNbt(bytes)), [
    { id: "TARANTULA_RING", rarityUpgrades: 1 },
    { id: "BAT_RING", rarityUpgrades: 0 },
  ]);
});

test("a document with no inventory list yields no items", () => {
  assert.deepEqual(bagItemsFrom(readNbt(document((w) => w.tag(3, "unrelated").i32(1)))), []);
});

test("refuses a document that isn't a compound", () => {
  assert.throws(() => readNbt(new Uint8Array([8, 0, 0])), /root compound/);
});

/**
 * An accessory's own lore states what it is: "§d§lMYTHIC ACCESSORY". That is the only exact
 * answer available, because six accessories climb the rarity ladder through their own mechanics
 * — a maxed player's Book of Progression reads mythic where the items resource calls it common.
 * Deriving rarity from a base tier plus a Recombobulator count read those six wrong, which cost
 * that player sixty-five magical power.
 */
test("an item's rarity is read from its lore when the blob carries it", () => {
  const bytes = document((w) => {
    w.tag(9, "i").u8(10).i32(2);

    w.tag(10, "tag");
    w.tag(10, "ExtraAttributes");
    w.tag(8, "id").str("BOOK_OF_PROGRESSION");
    w.end();
    w.tag(10, "display");
    w.tag(9, "Lore").u8(8).i32(2);
    w.str("§7Works while in Accessory Bag!");
    w.str("§d§lMYTHIC ACCESSORY");
    w.end(); // display
    w.end(); // tag
    w.end(); // slot

    // The obfuscated banner a recombobulated item carries, whose §ka markers leave a stray "a".
    w.tag(10, "tag");
    w.tag(10, "ExtraAttributes");
    w.tag(8, "id").str("TRAPPER_CREST");
    w.end();
    w.tag(10, "display");
    w.tag(9, "Lore").u8(8).i32(1);
    w.str("§5§l§ka§r §5§lEPIC ACCESSORY §5§l§ka");
    w.end();
    w.end();
    w.end();
  });

  assert.deepEqual(bagItemsFrom(readNbt(bytes)), [
    { id: "BOOK_OF_PROGRESSION", rarityUpgrades: 0, rarity: "MYTHIC" },
    { id: "TRAPPER_CREST", rarityUpgrades: 0, rarity: "EPIC" },
  ]);
});

/** A blob with no lore says nothing, and must not invent a rarity. */
test("an item with no lore reports no rarity at all", () => {
  const bytes = document((w) => {
    w.tag(9, "i").u8(10).i32(1);
    w.tag(10, "tag");
    w.tag(10, "ExtraAttributes");
    w.tag(8, "id").str("BAT_RING");
    w.end();
    w.end();
    w.end();
  });
  assert.deepEqual(bagItemsFrom(readNbt(bytes)), [{ id: "BAT_RING", rarityUpgrades: 0 }]);
});
