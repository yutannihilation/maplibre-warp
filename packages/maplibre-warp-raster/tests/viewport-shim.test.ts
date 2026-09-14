import {
  CullingVolume,
  makeOrientedBoundingBoxFromPoints,
} from "@math.gl/culling";
import { describe, expect, it } from "vitest";

import {
  extractFrustumPlanes,
  unitsPerMeterAtLatitude,
} from "../src/viewport-shim.js";

/** Column-major orthographic projection, the same convention WebGL uses. */
function ortho(
  left: number,
  right: number,
  bottom: number,
  top: number,
  near: number,
  far: number,
): Float64Array {
  const m = new Float64Array(16);
  m[0] = 2 / (right - left);
  m[5] = 2 / (top - bottom);
  m[10] = -2 / (far - near);
  m[12] = -(right + left) / (right - left);
  m[13] = -(top + bottom) / (top - bottom);
  m[14] = -(far + near) / (far - near);
  m[15] = 1;
  return m;
}

describe("extractFrustumPlanes", () => {
  it("returns six normalised planes", () => {
    const planes = extractFrustumPlanes(ortho(-1, 1, -1, 1, -1, 1));
    expect(planes).toHaveLength(6);
    for (const plane of planes) {
      expect(plane.normal.len()).toBeCloseTo(1, 12);
    }
  });

  it("orients normals into the frustum, as @math.gl/culling expects", () => {
    // Identity: clip space is the input space, so the frustum is the unit cube.
    const planes = extractFrustumPlanes(ortho(-1, 1, -1, 1, -1, 1));
    // A point at the centre must be on the positive side of every plane.
    for (const plane of planes) {
      expect(plane.getPointDistance([0, 0, 0])).toBeGreaterThan(0);
    }
    // A point outside must be on the negative side of at least one.
    const outside = planes.some(
      (plane) => plane.getPointDistance([3, 0, 0]) < 0,
    );
    expect(outside).toBe(true);
  });

  it("culls a box outside the frustum and keeps one inside", () => {
    // A 100-unit-wide box centred on the origin, i.e. the camera sees
    // x, y ∈ [-50, 50].
    const planes = extractFrustumPlanes(ortho(-50, 50, -50, 50, -50, 50));
    const volume = new CullingVolume(planes);

    const inside = makeOrientedBoundingBoxFromPoints([
      [-1, -1, 0],
      [1, -1, 0],
      [1, 1, 0],
      [-1, 1, 0],
    ]);
    const outside = makeOrientedBoundingBoxFromPoints([
      [200, 200, 0],
      [210, 200, 0],
      [210, 210, 0],
      [200, 210, 0],
    ]);

    expect(volume.computeVisibility(inside)).toBeGreaterThanOrEqual(0);
    expect(volume.computeVisibility(outside)).toBeLessThan(0);
  });

  it("tracks an off-centre camera", () => {
    // Camera looking at x ∈ [100, 200].
    const planes = extractFrustumPlanes(ortho(100, 200, -50, 50, -50, 50));
    const volume = new CullingVolume(planes);

    const near = makeOrientedBoundingBoxFromPoints([
      [140, -1, 0],
      [160, -1, 0],
      [160, 1, 0],
      [140, 1, 0],
    ]);
    const far = makeOrientedBoundingBoxFromPoints([
      [0, -1, 0],
      [10, -1, 0],
      [10, 1, 0],
      [0, 1, 0],
    ]);

    expect(volume.computeVisibility(near)).toBeGreaterThanOrEqual(0);
    expect(volume.computeVisibility(far)).toBeLessThan(0);
  });

  it("skips degenerate planes instead of culling everything", () => {
    const planes = extractFrustumPlanes(new Float64Array(16));
    expect(planes).toHaveLength(0);
  });
});

describe("unitsPerMeterAtLatitude", () => {
  it("matches the closed form at the equator", () => {
    // 512 common units span the whole 40 075 016.686 m equator.
    expect(unitsPerMeterAtLatitude(0)).toBeCloseTo(512 / 40075016.686, 15);
  });

  it("grows with the Mercator latitude distortion", () => {
    expect(unitsPerMeterAtLatitude(60)).toBeCloseTo(
      unitsPerMeterAtLatitude(0) * 2,
      9,
    );
  });

  it("clamps past the Web Mercator latitude limit", () => {
    expect(unitsPerMeterAtLatitude(90)).toEqual(unitsPerMeterAtLatitude(89));
    expect(Number.isFinite(unitsPerMeterAtLatitude(90))).toBe(true);
  });
});
