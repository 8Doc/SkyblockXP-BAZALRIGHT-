/**
 * A minimal Java-edition NBT reader, over already-decompressed bytes.
 *
 * Exists so the accessory-bag decode runs unchanged in Node and in the browser: the two
 * platforms differ only in how they gunzip (zlib vs DecompressionStream), and everything after
 * that is this file. Returns plain JS values rather than prismarine-nbt's {type, value} pairs,
 * which is all the bag walk needs.
 */

export type NbtValue = number | bigint | string | Uint8Array | NbtValue[] | NbtCompound;
export interface NbtCompound {
  [key: string]: NbtValue;
}

const TAG_END = 0;

class Reader {
  private offset = 0;
  private readonly view: DataView;

  constructor(private readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  byte(): number {
    return this.view.getInt8(this.offset++);
  }

  unsignedByte(): number {
    return this.view.getUint8(this.offset++);
  }

  short(): number {
    const value = this.view.getInt16(this.offset);
    this.offset += 2;
    return value;
  }

  unsignedShort(): number {
    const value = this.view.getUint16(this.offset);
    this.offset += 2;
    return value;
  }

  int(): number {
    const value = this.view.getInt32(this.offset);
    this.offset += 4;
    return value;
  }

  long(): bigint {
    const value = this.view.getBigInt64(this.offset);
    this.offset += 8;
    return value;
  }

  float(): number {
    const value = this.view.getFloat32(this.offset);
    this.offset += 4;
    return value;
  }

  double(): number {
    const value = this.view.getFloat64(this.offset);
    this.offset += 8;
    return value;
  }

  string(): string {
    const length = this.unsignedShort();
    const slice = this.bytes.subarray(this.offset, this.offset + length);
    this.offset += length;
    return new TextDecoder().decode(slice);
  }

  bytes_(length: number): Uint8Array {
    const slice = this.bytes.subarray(this.offset, this.offset + length);
    this.offset += length;
    return slice;
  }

  payload(type: number): NbtValue {
    switch (type) {
      case 1:
        return this.byte();
      case 2:
        return this.short();
      case 3:
        return this.int();
      case 4:
        return this.long();
      case 5:
        return this.float();
      case 6:
        return this.double();
      case 7:
        return this.bytes_(this.int());
      case 8:
        return this.string();
      case 9: {
        const elementType = this.unsignedByte();
        const length = this.int();
        const list: NbtValue[] = [];
        // A list of TAG_End is how an empty list is encoded; it has no payloads to read.
        if (elementType === TAG_END) return list;
        for (let i = 0; i < length; i++) list.push(this.payload(elementType));
        return list;
      }
      case 10:
        return this.compound();
      case 11: {
        const length = this.int();
        const out: number[] = [];
        for (let i = 0; i < length; i++) out.push(this.int());
        return out;
      }
      case 12: {
        const length = this.int();
        const out: NbtValue[] = [];
        for (let i = 0; i < length; i++) out.push(this.long());
        return out;
      }
      default:
        throw new Error(`Unknown NBT tag type ${type}`);
    }
  }

  compound(): NbtCompound {
    const out: NbtCompound = {};
    for (;;) {
      const type = this.unsignedByte();
      if (type === TAG_END) return out;
      const name = this.string();
      out[name] = this.payload(type);
    }
  }
}

/** Parse a decompressed NBT document. The root is a named compound; its name is discarded. */
export function readNbt(bytes: Uint8Array): NbtCompound {
  const reader = new Reader(bytes);
  const type = reader.unsignedByte();
  if (type !== 10) throw new Error(`Expected a root compound, got tag type ${type}`);
  reader.string();
  return reader.compound();
}

/* -------------------------------------------------------------- bag reading */

export type BagItem = {
  id: string;
  rarityUpgrades: number;
  /**
   * The rarity the item itself claims, off its lore, or null where it carries no lore.
   *
   * Worth reading because for some accessories the items resource is not the last word: a Book
   * of Progression and a Pandora's Box are both COMMON in the resource and both MYTHIC in the
   * bag, having climbed there through play. Trusting the resource scored them 3 magical power
   * each instead of 22.
   */
  rarity: string | null;
};

/** Rarities longest-first, so "VERY SPECIAL" is never read as "SPECIAL". */
const RARITY_WORDS = [
  "VERY SPECIAL", "SPECIAL", "SUPREME", "DIVINE", "MYTHIC",
  "LEGENDARY", "EPIC", "RARE", "UNCOMMON", "COMMON",
];

/**
 * The rarity an item's lore states, e.g. "§d§lMYTHIC ACCESSORY".
 *
 * Read from the bottom, because the rarity line is the last one and words like "RARE" turn up
 * in ability text above it.
 *
 * A recombobulated item writes that line differently, and the difference is easy to miss:
 * "§d§l§ka§r §d§lMYTHIC ACCESSORY §d§l§ka". `§k` is Minecraft's obfuscation code and the
 * character after it is the shimmer the recombobulator puts either side of the rarity. Strip
 * only the colour codes and the line reads "a MYTHIC ACCESSORY a", which starts with neither a
 * rarity nor anything useful — so every recombobulated item silently fell through to the items
 * resource. On a maxed bag that was 142 of 157 items, and it hid the accessories that climb
 * rarity in place: a Pulse Ring reads UNCOMMON in the resource and MYTHIC on the item.
 */
function rarityFromLore(display: NbtCompound | null): string | null {
  const lore = display?.Lore;
  if (!Array.isArray(lore)) return null;
  for (let i = lore.length - 1; i >= 0; i--) {
    const line = String(lore[i])
      // The obfuscated run first: from §k to the §r that ends it, or to the end of the line.
      .replace(/§k.*?(?:§r|$)/g, "")
      .replace(/§./g, "")
      .trim();
    const hit = RARITY_WORDS.find((word) => line.startsWith(word));
    if (hit) return hit.replace(" ", "_");
  }
  return null;
}

function asCompound(value: NbtValue | undefined): NbtCompound | null {
  return value && typeof value === "object" && !Array.isArray(value) && !(value instanceof Uint8Array)
    ? (value as NbtCompound)
    : null;
}

/** How many slots the container has, empty ones included — the bag's capacity. */
export function bagCapacityFrom(root: NbtCompound): number {
  return Array.isArray(root.i) ? root.i.length : 0;
}

/**
 * Pull the SkyBlock item ids out of a decoded inventory document. Slots are `i`, item metadata
 * lives under `tag.ExtraAttributes`, and `rarity_upgrades` is how a recombobulator shows up.
 */
export function bagItemsFrom(root: NbtCompound): BagItem[] {
  const slots = root.i;
  if (!Array.isArray(slots)) return [];

  const items: BagItem[] = [];
  for (const slot of slots) {
    const tag = asCompound(asCompound(slot)?.tag);
    const extra = asCompound(tag?.ExtraAttributes);
    const id = extra?.id;
    if (typeof id !== "string") continue; // empty slot
    const upgrades = extra?.rarity_upgrades;
    items.push({
      id,
      rarityUpgrades: typeof upgrades === "number" ? upgrades : 0,
      rarity: rarityFromLore(asCompound(tag?.display)),
    });
  }
  return items;
}

/** Every item id in an NBT blob's slot list, ignoring empty slots. */
export function itemIdsFrom(root: NbtCompound): string[] {
  return bagItemsFrom(root).map((item) => item.id);
}
