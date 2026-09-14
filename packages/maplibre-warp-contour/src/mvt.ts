/**
 * A minimal Mapbox Vector Tile v2 encoder.
 *
 * Only what contour tiles need: line and polygon features with numeric,
 * string and boolean properties. Written by hand so the runtime carries no
 * protobuf dependency; the tests round-trip through `@mapbox/vector-tile`.
 */

export type MvtPropertyValue = number | string | boolean;

export interface MvtFeature {
  id?: number;
  type: "line" | "polygon";
  /**
   * One `Int32Array` of interleaved tile coordinates per part: a polyline
   * for lines, a ring for polygons (an explicit closing point is dropped).
   */
  geometry: Int32Array[];
  properties: Record<string, MvtPropertyValue>;
}

export interface MvtLayer {
  name: string;
  extent: number;
  features: MvtFeature[];
}

const GEOM_LINESTRING = 2;
const GEOM_POLYGON = 3;
const CMD_MOVE_TO = 1;
const CMD_LINE_TO = 2;
const CMD_CLOSE_PATH = 7;
const INT32_MAX = 2 ** 31 - 1;

class ProtoWriter {
  private buffer = new Uint8Array(1024);
  private length = 0;

  private ensure(extra: number): void {
    if (this.length + extra <= this.buffer.length) {
      return;
    }
    let size = this.buffer.length * 2;
    while (size < this.length + extra) {
      size *= 2;
    }
    const next = new Uint8Array(size);
    next.set(this.buffer.subarray(0, this.length));
    this.buffer = next;
  }

  rawVarint(value: number): void {
    this.ensure(10);
    let v = value;
    while (v >= 0x80) {
      this.buffer[this.length++] = (v % 0x80) | 0x80;
      v = Math.floor(v / 0x80);
    }
    this.buffer[this.length++] = v;
  }

  varint(field: number, value: number): void {
    this.rawVarint(field * 8);
    this.rawVarint(value);
  }

  bytes(field: number, data: Uint8Array): void {
    this.rawVarint(field * 8 + 2);
    this.rawVarint(data.length);
    this.ensure(data.length);
    this.buffer.set(data, this.length);
    this.length += data.length;
  }

  string(field: number, value: string): void {
    this.bytes(field, new TextEncoder().encode(value));
  }

  double(field: number, value: number): void {
    this.rawVarint(field * 8 + 1);
    this.ensure(8);
    new DataView(this.buffer.buffer).setFloat64(this.length, value, true);
    this.length += 8;
  }

  packed(field: number, values: number[]): void {
    const inner = new ProtoWriter();
    for (const v of values) {
      inner.rawVarint(v);
    }
    this.bytes(field, inner.finish());
  }

  finish(): Uint8Array {
    return this.buffer.slice(0, this.length);
  }
}

function zigzag(n: number): number {
  return n >= 0 ? 2 * n : -2 * n - 1;
}

function command(id: number, count: number): number {
  return (id & 7) | (count << 3);
}

function encodeValue(value: MvtPropertyValue): Uint8Array {
  const w = new ProtoWriter();
  if (typeof value === "string") {
    w.string(1, value);
  } else if (typeof value === "boolean") {
    w.varint(7, value ? 1 : 0);
  } else if (Number.isInteger(value)) {
    if (value >= 0) {
      w.varint(5, value);
    } else {
      w.varint(6, zigzag(value));
    }
  } else {
    w.double(3, value);
  }
  return w.finish();
}

function encodeGeometry(feature: MvtFeature): number[] {
  const out: number[] = [];
  let cx = 0;
  let cy = 0;
  const push = (x: number, y: number): void => {
    if (
      !Number.isInteger(x) ||
      !Number.isInteger(y) ||
      Math.abs(x) > INT32_MAX ||
      Math.abs(y) > INT32_MAX
    ) {
      throw new RangeError(`coordinate (${x}, ${y}) is not a valid int32`);
    }
    out.push(zigzag(x - cx), zigzag(y - cy));
    cx = x;
    cy = y;
  };
  for (const part of feature.geometry) {
    let count = part.length / 2;
    if (count === 0) {
      continue;
    }
    if (
      feature.type === "polygon" &&
      count > 1 &&
      part[0] === part[2 * count - 2] &&
      part[1] === part[2 * count - 1]
    ) {
      count--;
    }
    out.push(command(CMD_MOVE_TO, 1));
    push(part[0]!, part[1]!);
    if (count > 1) {
      out.push(command(CMD_LINE_TO, count - 1));
      for (let k = 1; k < count; k++) {
        push(part[2 * k]!, part[2 * k + 1]!);
      }
    }
    if (feature.type === "polygon") {
      out.push(command(CMD_CLOSE_PATH, 1));
    }
  }
  return out;
}

function encodeLayer(layer: MvtLayer): Uint8Array {
  if (layer.name.length === 0) {
    throw new RangeError("layer name must not be empty");
  }
  const keys: string[] = [];
  const keyIndex = new Map<string, number>();
  const values: MvtPropertyValue[] = [];
  const valueIndex = new Map<string, number>();

  const w = new ProtoWriter();
  w.varint(15, 2);
  w.string(1, layer.name);

  for (const feature of layer.features) {
    const f = new ProtoWriter();
    if (feature.id !== undefined) {
      f.varint(1, feature.id);
    }
    const tags: number[] = [];
    for (const [key, value] of Object.entries(feature.properties)) {
      let ki = keyIndex.get(key);
      if (ki === undefined) {
        ki = keys.length;
        keys.push(key);
        keyIndex.set(key, ki);
      }
      const vk = `${typeof value}:${String(value)}`;
      let vi = valueIndex.get(vk);
      if (vi === undefined) {
        vi = values.length;
        values.push(value);
        valueIndex.set(vk, vi);
      }
      tags.push(ki, vi);
    }
    f.packed(2, tags);
    f.varint(3, feature.type === "line" ? GEOM_LINESTRING : GEOM_POLYGON);
    f.packed(4, encodeGeometry(feature));
    w.bytes(2, f.finish());
  }
  for (const key of keys) {
    w.string(3, key);
  }
  for (const value of values) {
    w.bytes(4, encodeValue(value));
  }
  w.varint(5, layer.extent);
  return w.finish();
}

export function encodeMvt(layers: MvtLayer[]): Uint8Array {
  const w = new ProtoWriter();
  for (const layer of layers) {
    w.bytes(3, encodeLayer(layer));
  }
  return w.finish();
}
