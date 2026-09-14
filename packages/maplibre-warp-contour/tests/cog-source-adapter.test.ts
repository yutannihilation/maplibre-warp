import type { Tile } from "@developmentseed/geotiff";
import { AffineTilesetLevel } from "@yutannihilation/maplibre-warp-raster";
import { describe, expect, it } from "vitest";

import { toFetchedTile, warpLevelFrom } from "../src/cog-warp-source.js";

describe("warpLevelFrom", () => {
  // 10 m pixels, origin (500000, 4000000), north-up, 1000×600 array, 256 tiles.
  const level = new AffineTilesetLevel({
    affine: [10, 0, 500000, 0, -10, 4000000],
    arrayWidth: 1000,
    arrayHeight: 600,
    tileWidth: 256,
    tileHeight: 256,
    mpu: 1,
  });

  it("copies the tile matrix geometry", () => {
    const warp = warpLevelFrom(level);
    expect(warp.metersPerPixel).toBe(10);
    expect(warp.tileWidth).toBe(256);
    expect(warp.tileHeight).toBe(256);
    expect(warp.matrixWidth).toBe(4);
    expect(warp.matrixHeight).toBe(3);
  });

  it("maps CRS coordinates to level-wide continuous pixels", () => {
    const warp = warpLevelFrom(level);
    expect(warp.crsToPixel(500000, 4000000)).toEqual([0, 0]);
    const [px, py] = warp.crsToPixel(500000 + 10 * 300.5, 4000000 - 10 * 20.25);
    expect(px).toBeCloseTo(300.5, 9);
    expect(py).toBeCloseTo(20.25, 9);
  });
});

describe("toFetchedTile", () => {
  const base = {
    count: 1,
    width: 2,
    height: 2,
    mask: null,
    transform: [1, 0, 0, 0, -1, 0] as Tile["array"]["transform"],
    crs: 4326,
    nodata: -9999,
  };

  it("selects a band from pixel-interleaved data by stride and offset", () => {
    const data = new Int16Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    const tile: Tile = {
      x: 3,
      y: 4,
      array: { ...base, count: 3, layout: "pixel-interleaved", data },
    };
    const fetched = toFetchedTile(tile, 1);
    expect(fetched).toMatchObject({
      x: 3,
      y: 4,
      width: 2,
      height: 2,
      stride: 3,
      offset: 1,
      nodata: -9999,
      mask: null,
    });
    expect(fetched.data).toBe(data);
  });

  it("selects a band from band-separate data as a stride-1 array", () => {
    const b0 = new Float32Array([1, 2, 3, 4]);
    const b1 = new Float32Array([5, 6, 7, 8]);
    const tile: Tile = {
      x: 0,
      y: 0,
      array: { ...base, count: 2, layout: "band-separate", bands: [b0, b1] },
    };
    const fetched = toFetchedTile(tile, 1);
    expect(fetched.data).toBe(b1);
    expect(fetched.stride).toBe(1);
    expect(fetched.offset).toBe(0);
  });

  it("carries the mask through", () => {
    const mask = new Uint8Array([1, 0, 1, 1]);
    const tile: Tile = {
      x: 0,
      y: 0,
      array: {
        ...base,
        mask,
        layout: "pixel-interleaved",
        data: new Uint8Array([1, 2, 3, 4]),
      },
    };
    expect(toFetchedTile(tile, 0).mask).toBe(mask);
  });

  it("rejects a band index outside the sample count", () => {
    const tile: Tile = {
      x: 0,
      y: 0,
      array: {
        ...base,
        layout: "pixel-interleaved",
        data: new Uint8Array([1, 2, 3, 4]),
      },
    };
    expect(() => toFetchedTile(tile, 1)).toThrow(RangeError);
  });
});
