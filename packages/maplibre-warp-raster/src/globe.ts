/**
 * The unit-sphere space MapLibre's globe shader works in.
 *
 * Under the `"globe"` shader variant, MapLibre's `projectTile` prelude turns a
 * mercator `[0, 1]` position into a point on a unit sphere and projects that
 * with `u_projection_matrix`. Tile culling under globe happens in the same
 * space, so the conversion here reproduces the prelude's `projectToSphere`
 * formula exactly rather than going through lng/lat.
 */

import { Plane } from "@math.gl/culling";

import type { Point } from "./tileset/types.js";

/**
 * Radius of the globe shader's sphere, in metres: the prelude's `GLOBE_RADIUS`.
 * Elevation is applied as `p · (1 + elevation / GLOBE_RADIUS)`, so one sphere
 * unit is this many metres.
 */
export const GLOBE_RADIUS = 6371008.8;

/** A position in the globe shader's unit-sphere space. */
export type SpherePoint = [x: number, y: number, z: number];

/**
 * Map a MapLibre mercator `[0, 1]` position (Y increasing south) onto the unit
 * sphere, exactly as the globe vertex prelude does.
 *
 * `(lng 0, lat 0)` lands on `(0, 0, 1)`, the north pole on `(0, 1, 0)` and
 * `lng 90°` on the equator at `(1, 0, 0)`.
 */
export function sphereFromMercator([mx, my]: Point): SpherePoint {
  const sphericalX = mx * Math.PI * 2 + Math.PI;
  const t = Math.exp(Math.PI - my * Math.PI * 2);
  const t2 = t * t;
  const denominator = t2 + 1;
  const sinY = (t2 - 1) / denominator;
  const cosY = (2 * t) / denominator;
  return [Math.sin(sphericalX) * cosY, sinY, Math.cos(sphericalX) * cosY];
}

/**
 * MapLibre's horizon plane as a culling plane.
 *
 * `clippingPlane` is `[nx, ny, nz, w]` with a sphere point visible iff
 * `dot(p, n) + w ≥ 0` — the shader writes `1 - (dot(p, n) + w)` to clip `z`
 * and lets clipping discard the far side. `@math.gl/culling` uses the same
 * sign convention (`getPointDistance = dot(normal, p) + distance`, negative is
 * outside), so the plane carries over directly once normalised.
 */
export function horizonPlane(clippingPlane: ArrayLike<number>): Plane {
  const [nx, ny, nz, w] = [
    clippingPlane[0]!,
    clippingPlane[1]!,
    clippingPlane[2]!,
    clippingPlane[3]!,
  ];
  const length = Math.hypot(nx, ny, nz);
  if (!Number.isFinite(length) || length === 0) {
    throw new Error("Globe clipping plane has a degenerate normal");
  }
  return new Plane([nx / length, ny / length, nz / length], w / length);
}
