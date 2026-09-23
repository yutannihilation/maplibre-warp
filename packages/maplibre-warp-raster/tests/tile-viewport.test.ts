import { describe, expect, it } from "vitest";

import {
  createTileFrame,
  mercatorTileBounds,
  tileClipMatrix,
  validateTileIndex,
} from "../src/headless/tile-viewport.js";
import { commonSpaceFromLngLat, lngLatFromMercator } from "../src/mercator.js";

/** Apply a column-major 4×4 to `(x, y, 0, 1)`. */
function project(m: Float64Array, x: number, y: number): [number, number] {
  const cx = m[0]! * x + m[4]! * y + m[12]!;
  const cy = m[1]! * x + m[5]! * y + m[13]!;
  const w = m[3]! * x + m[7]! * y + m[15]!;
  return [cx / w, cy / w];
}

describe("mercatorTileBounds", () => {
  it("covers the world at z0 and quarters it at z1", () => {
    expect(mercatorTileBounds({ z: 0, x: 0, y: 0 })).toEqual([0, 0, 1, 1]);
    expect(mercatorTileBounds({ z: 1, x: 1, y: 0 })).toEqual([0.5, 0, 1, 0.5]);
  });

  it("rejects indices outside the level", () => {
    expect(() => validateTileIndex({ z: 2, x: 4, y: 0 })).toThrow(RangeError);
    expect(() => validateTileIndex({ z: -1, x: 0, y: 0 })).toThrow(RangeError);
    expect(() => validateTileIndex({ z: 1, x: 0.5, y: 0 })).toThrow(RangeError);
  });
});

describe("tileClipMatrix", () => {
  it("maps the tile to the clip square with north up", () => {
    const bounds = mercatorTileBounds({ z: 3, x: 5, y: 2 });
    const m = tileClipMatrix(bounds);
    const [x0, y0, x1, y1] = bounds;
    expect(project(m, x0, y0)).toEqual([-1, 1]); // north-west
    expect(project(m, x1, y1)).toEqual([1, -1]); // south-east
    expect(project(m, (x0 + x1) / 2, (y0 + y1) / 2)).toEqual([0, 0]);
  });
});

describe("createTileFrame", () => {
  it("uses MapLibre's 512-pixel zoom convention", () => {
    expect(createTileFrame({ z: 5, x: 0, y: 0 }, 512).viewport.zoom).toBe(5);
    expect(createTileFrame({ z: 5, x: 0, y: 0 }, 256).viewport.zoom).toBe(4);
    expect(() => createTileFrame({ z: 0, x: 0, y: 0 }, 0)).toThrow(RangeError);
  });

  it("centres the camera on the tile and reports its lng/lat bounds", () => {
    const frame = createTileFrame({ z: 2, x: 1, y: 1 }, 512);
    expect(frame.origin).toEqual([0.375, 0.375]);
    expect(frame.viewport.center).toEqual(lngLatFromMercator([0.375, 0.375]));
    const [west, south, east, north] = frame.viewport.getBounds();
    expect(west).toBeCloseTo(-90);
    expect(east).toBeCloseTo(0);
    expect(north).toBeCloseTo(66.51326, 4);
    expect(south).toBeCloseTo(0);
  });

  it("builds a frustum that holds the tile and excludes its neighbours", () => {
    const frame = createTileFrame({ z: 4, x: 8, y: 5 }, 512);
    const inside = (lng: number, lat: number): boolean => {
      const [x, y] = commonSpaceFromLngLat(lng, lat);
      return frame.viewport.frustumPlanes.every(
        (plane) =>
          plane.normal.x * x + plane.normal.y * y + plane.distance >= 0,
      );
    };
    const [lng, lat] = frame.viewport.center;
    const [west, south, east, north] = frame.viewport.getBounds();
    expect(inside(lng, lat)).toBe(true);
    // Two tiles east and two tiles north.
    expect(inside(lng + 2 * (east - west), lat)).toBe(false);
    expect(inside(lng, north + (north - south))).toBe(false);
  });
});
