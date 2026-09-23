import type { RasterArray } from "@developmentseed/geotiff";
import { describe, expect, it } from "vitest";

import { bandPlanes } from "../src/geotiff-utils.js";

const base = {
  width: 2,
  height: 1,
  mask: null,
  transform: [1, 0, 0, 0, -1, 0] as [
    number,
    number,
    number,
    number,
    number,
    number,
  ],
  crs: 4326,
  nodata: null,
};

describe("bandPlanes", () => {
  it("de-interleaves pixel-interleaved data into one plane per band", () => {
    const planes = bandPlanes({
      ...base,
      layout: "pixel-interleaved",
      count: 3,
      data: new Uint16Array([1, 2, 3, 4, 5, 6]),
    });
    expect(planes).toHaveLength(3);
    expect(planes.map((p) => Array.from(p))).toEqual([
      [1, 4],
      [2, 5],
      [3, 6],
    ]);
    // The element type carries over, so the texture format still matches.
    expect(planes[0]).toBeInstanceOf(Uint16Array);
  });

  it("returns band-separate planes as they are, without copying", () => {
    const bands = [new Float32Array([1, 2]), new Float32Array([3, 4])];
    const planes = bandPlanes({
      ...base,
      layout: "band-separate",
      count: 2,
      bands,
    });
    expect(planes).toBe(bands);
  });

  it("rejects arrays whose data does not match their shape", () => {
    expect(() =>
      bandPlanes({
        ...base,
        layout: "pixel-interleaved",
        count: 3,
        data: new Uint8Array(4),
      } as RasterArray),
    ).toThrow(RangeError);
    expect(() =>
      bandPlanes({
        ...base,
        layout: "band-separate",
        count: 2,
        bands: [new Uint8Array(2)],
      } as RasterArray),
    ).toThrow(RangeError);
    expect(() =>
      bandPlanes({
        ...base,
        layout: "band-separate",
        count: 1,
        bands: [new Uint8Array(3)],
      } as RasterArray),
    ).toThrow(RangeError);
  });
});
