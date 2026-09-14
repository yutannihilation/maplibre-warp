import { describe, expect, it } from "vitest";

import { tileMetersPerPixel } from "../src/level.js";
import { computeZoomRange } from "../src/zoom-range.js";

describe("computeZoomRange", () => {
  const params = {
    levelMetersPerPixel: [320, 160, 80, 40, 20, 10],
    latitudeDeg: 0,
    tileSize: 256,
    sourceTileWidth: 256,
    maxSourceTiles: 16,
  };

  it("sets maxzoom to the first zoom whose tile pixel is at least as fine as the finest level", () => {
    const { maxzoom } = computeZoomRange(params);
    expect(tileMetersPerPixel(maxzoom, 0, 256)).toBeLessThanOrEqual(10);
    expect(tileMetersPerPixel(maxzoom - 1, 0, 256)).toBeGreaterThan(10);
  });

  it("sets minzoom to the first zoom where the coarsest level fits the source-tile budget", () => {
    const { minzoom } = computeZoomRange(params);
    const tilesAcross = (z: number) =>
      Math.ceil((256 * tileMetersPerPixel(z, 0, 256)) / 320 / 256) + 1;
    expect(tilesAcross(minzoom) ** 2).toBeLessThanOrEqual(16);
    expect(tilesAcross(minzoom - 1) ** 2).toBeGreaterThan(16);
  });

  it("never returns minzoom above maxzoom", () => {
    const { minzoom, maxzoom } = computeZoomRange({
      ...params,
      levelMetersPerPixel: [10],
      maxSourceTiles: 1,
    });
    expect(minzoom).toBeLessThanOrEqual(maxzoom);
  });

  it("rejects an empty level list", () => {
    expect(() =>
      computeZoomRange({ ...params, levelMetersPerPixel: [] }),
    ).toThrow(RangeError);
  });
});
