import { describe, expect, it } from "vitest";

import { horizonPlane, sphereFromMercator } from "../src/globe.js";
import { mercatorFromLngLat } from "../src/mercator.js";

function sphereFromLngLat(lng: number, lat: number) {
  return sphereFromMercator(mercatorFromLngLat(lng, lat));
}

describe("sphereFromMercator", () => {
  it("matches the globe prelude's orientation", () => {
    // (lng 0, lat 0) faces +z; the north pole is +y; lng 90° on the equator
    // is +x. These are the conventions MapLibre's `projectToSphere` uses, and
    // culling must agree with the shader about where a tile is.
    const [x0, y0, z0] = sphereFromLngLat(0, 0);
    expect(x0).toBeCloseTo(0, 12);
    expect(y0).toBeCloseTo(0, 12);
    expect(z0).toBeCloseTo(1, 12);

    const [x90, y90, z90] = sphereFromLngLat(90, 0);
    expect(x90).toBeCloseTo(1, 12);
    expect(y90).toBeCloseTo(0, 12);
    expect(z90).toBeCloseTo(0, 12);

    const [, yNorth] = sphereFromLngLat(0, 85);
    expect(yNorth).toBeCloseTo(Math.sin((85 * Math.PI) / 180), 9);
  });

  it("stays on the unit sphere", () => {
    for (const [lng, lat] of [
      [-180, -85],
      [-45, 30],
      [12.3, -67.8],
      [179.9, 0],
    ]) {
      const [x, y, z] = sphereFromLngLat(lng!, lat!);
      expect(Math.hypot(x, y, z)).toBeCloseTo(1, 12);
    }
  });
});

describe("horizonPlane", () => {
  // A camera above (lng 0, lat 0): the visible cap is `z > 0.3`.
  const clippingPlane = [0, 0, 2, -0.6];

  it("is normalised and keeps MapLibre's visible-side sign", () => {
    const plane = horizonPlane(clippingPlane);
    expect(plane.normal.len()).toBeCloseTo(1, 12);
    expect(plane.distance).toBeCloseTo(-0.3, 12);

    // Cap centre inside, antipode outside, 60° from the centre inside
    // (cos 60° = 0.5 > 0.3), 80° from the centre outside.
    expect(plane.getPointDistance(sphereFromLngLat(0, 0))).toBeGreaterThan(0);
    expect(plane.getPointDistance(sphereFromLngLat(180, 0))).toBeLessThan(0);
    expect(plane.getPointDistance(sphereFromLngLat(60, 0))).toBeGreaterThan(0);
    expect(plane.getPointDistance(sphereFromLngLat(80, 0))).toBeLessThan(0);
  });

  it("rejects a degenerate normal rather than culling everything", () => {
    expect(() => horizonPlane([0, 0, 0, 1])).toThrow();
  });
});
