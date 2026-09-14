import { VectorTile } from "@mapbox/vector-tile";
import { PbfReader } from "pbf";
import { describe, expect, it } from "vitest";
import type { MvtLayer } from "../src/mvt.js";
import { encodeMvt } from "../src/mvt.js";

function decode(bytes: Uint8Array): VectorTile {
  return new VectorTile(new PbfReader(bytes));
}

function coords(points: { x: number; y: number }[]): number[] {
  return points.flatMap((p) => [p.x, p.y]);
}

describe("encodeMvt", () => {
  it("round-trips a line layer", () => {
    const layer: MvtLayer = {
      name: "lines",
      extent: 4096,
      features: [
        {
          id: 7,
          type: "line",
          geometry: [new Int32Array([0, 0, 100, 50, 4096, 4096])],
          properties: { level: 100, major: true, unit: "m" },
        },
      ],
    };
    const tile = decode(encodeMvt([layer]));
    const decoded = tile.layers.lines!;
    expect(decoded.extent).toBe(4096);
    expect(decoded.length).toBe(1);
    const feature = decoded.feature(0);
    expect(feature.type).toBe(2);
    expect(feature.id).toBe(7);
    expect(feature.properties).toEqual({ level: 100, major: true, unit: "m" });
    const geometry = feature.loadGeometry();
    expect(geometry).toHaveLength(1);
    expect(coords(geometry[0]!)).toEqual([0, 0, 100, 50, 4096, 4096]);
  });

  it("round-trips a multi-line feature and negative buffer coordinates", () => {
    const tile = decode(
      encodeMvt([
        {
          name: "lines",
          extent: 4096,
          features: [
            {
              type: "line",
              geometry: [
                new Int32Array([-16, -16, 10, 10]),
                new Int32Array([4112, 0, 4112, 4112, 4000, 4112]),
              ],
              properties: {},
            },
          ],
        },
      ]),
    );
    const geometry = tile.layers.lines!.feature(0).loadGeometry();
    expect(geometry.map(coords)).toEqual([
      [-16, -16, 10, 10],
      [4112, 0, 4112, 4112, 4000, 4112],
    ]);
  });

  it("round-trips a polygon with a hole, closing rings implicitly", () => {
    const outer = new Int32Array([0, 0, 100, 0, 100, 100, 0, 100]);
    const hole = new Int32Array([20, 20, 20, 80, 80, 80, 80, 20]);
    const tile = decode(
      encodeMvt([
        {
          name: "bands",
          extent: 4096,
          features: [
            {
              type: "polygon",
              geometry: [outer, hole],
              properties: { band: 2 },
            },
          ],
        },
      ]),
    );
    const feature = tile.layers.bands!.feature(0);
    expect(feature.type).toBe(3);
    const geometry = feature.loadGeometry();
    expect(geometry).toHaveLength(2);
    // loadGeometry appends the closing point for polygons.
    expect(coords(geometry[0]!)).toEqual([...outer, 0, 0]);
    expect(coords(geometry[1]!)).toEqual([...hole, 20, 20]);
  });

  it("drops an explicit closing point so rings are not doubled", () => {
    const closed = new Int32Array([0, 0, 100, 0, 100, 100, 0, 0]);
    const tile = decode(
      encodeMvt([
        {
          name: "bands",
          extent: 4096,
          features: [{ type: "polygon", geometry: [closed], properties: {} }],
        },
      ]),
    );
    expect(coords(tile.layers.bands!.feature(0).loadGeometry()[0]!)).toEqual([
      0, 0, 100, 0, 100, 100, 0, 0,
    ]);
  });

  it("encodes several layers and shared property keys and values once", () => {
    const tile = decode(
      encodeMvt([
        {
          name: "a",
          extent: 512,
          features: [
            {
              type: "line",
              geometry: [new Int32Array([0, 0, 1, 1])],
              properties: { k: 1 },
            },
            {
              type: "line",
              geometry: [new Int32Array([0, 0, 2, 2])],
              properties: { k: 1 },
            },
          ],
        },
        {
          name: "b",
          extent: 4096,
          features: [
            {
              type: "line",
              geometry: [new Int32Array([0, 0, 3, 3])],
              properties: { k: 2.5, s: "x" },
            },
          ],
        },
      ]),
    );
    expect(Object.keys(tile.layers).sort()).toEqual(["a", "b"]);
    expect(tile.layers.a!.extent).toBe(512);
    expect(tile.layers.a!.length).toBe(2);
    expect(tile.layers.a!.feature(1).properties).toEqual({ k: 1 });
    expect(tile.layers.b!.feature(0).properties).toEqual({ k: 2.5, s: "x" });
  });

  it("rejects empty layer names and out-of-range coordinates", () => {
    expect(() => encodeMvt([{ name: "", extent: 4096, features: [] }])).toThrow(
      RangeError,
    );
    expect(() =>
      encodeMvt([
        {
          name: "x",
          extent: 4096,
          features: [
            {
              type: "line",
              geometry: [new Int32Array([0, 0, 1, 1])],
              properties: {},
            },
          ],
        },
      ]),
    ).not.toThrow();
    expect(() =>
      encodeMvt([
        {
          name: "x",
          extent: 4096,
          features: [
            {
              type: "line",
              geometry: [Int32Array.from([0, 0, 2 ** 31, 0])],
              properties: {},
            },
          ],
        },
      ]),
    ).toThrow(RangeError);
  });
});
