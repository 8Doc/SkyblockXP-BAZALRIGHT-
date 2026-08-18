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

export type BagItem = { id: string; rarityUpgrades: number };

function asCompound(value: NbtValue | undefined): NbtCompound | null {
  return value && typeof value === "object" && !Array.isArray(value) && !(value instanceof Uint8Array)
    ? (value as NbtCompound)
    : null;
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
    const extra = asCompound(asCompound(asCompound(slot)?.tag)?.ExtraAttributes);
    const id = extra?.id;
    if (typeof id !== "string") continue; // empty slot
    const upgrades = extra?.rarity_upgrades;
    items.push({ id, rarityUpgrades: typeof upgrades === "number" ? upgrades : 0 });
  }
  return items;
}
