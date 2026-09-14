/**
 * Builds a {@link RasterViewport} from MapLibre's custom-layer render
 * arguments.
 *
 * This is the whole of what deck.gl's `Viewport` gave the tile traversal:
 * frustum planes, zoom, geographic bounds, and an elevation scale.
 */

import { Plane } from "@math.gl/culling";
import type { CustomRenderMethodInput, Map as MapLibreMap } from "maplibre-gl";

import {
  COMMON_SPACE_SIZE,
  EARTH_CIRCUMFERENCE,
  MAX_WEB_MERCATOR_LAT,
} from "./mercator.js";
import type { Bounds } from "./tileset/types.js";
import type { RasterViewport } from "./tileset/viewport.js";

/** A 4×4 matrix in column-major order (`m[col * 4 + row]`), as WebGL wants. */
export type Mat4 = Float64Array;

/**
 * MapLibre's mercator shader variant name. Under any other variant (globe, or
 * the globe↔mercator transition) this package refuses to render; see
 * {@link isMercatorVariant}.
 */
const MERCATOR_VARIANT = "mercator";

/**
 * Whether MapLibre is currently rendering with the plain mercator projection.
 *
 * The shader variant name is MapLibre's own cache key for "which projection
 * shader code applies", so it is the right thing to gate on.
 */
export function isMercatorVariant(variantName: string): boolean {
  return variantName === MERCATOR_VARIANT;
}

/**
 * Compose `mainMatrix` (mercator `[0, 1]` + elevation in metres → clip space)
 * with the mapping from common space (`[0, 512]`, Y north-up) so the result
 * takes a common-space position straight to clip space.
 *
 * ```
 *   mercX   = c.x / 512
 *   mercY   = 1 - c.y / 512
 *   metres  = c.z / unitsPerMeter
 * ```
 */
function commonSpaceToClip(
  mainMatrix: ArrayLike<number>,
  unitsPerMeter: number,
): Mat4 {
  const s = 1 / COMMON_SPACE_SIZE;
  const zs = 1 / unitsPerMeter;

  // The common-space → mainMatrix-input transform, by column.
  const t = [
    [s, 0, 0, 0],
    [0, -s, 0, 0],
    [0, 0, zs, 0],
    [0, 1, 0, 1],
  ];

  const out = new Float64Array(16);
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) {
        sum += mainMatrix[k * 4 + row]! * t[col]![k]!;
      }
      out[col * 4 + row] = sum;
    }
  }
  return out;
}

/**
 * Extract the six frustum planes from a combined view-projection matrix
 * (Gribb & Hartmann), in the matrix's *input* space.
 *
 * The returned planes have normals pointing **into** the frustum, normalised,
 * which is the orientation `@math.gl/culling` expects: a bounding volume
 * entirely on a plane's negative side is outside.
 */
export function extractFrustumPlanes(m: ArrayLike<number>): Plane[] {
  // Rows of the matrix. Column-major storage: row i is m[0*4+i], m[1*4+i], …
  const row = (i: number): [number, number, number, number] => [
    m[i]!,
    m[4 + i]!,
    m[8 + i]!,
    m[12 + i]!,
  ];
  const r0 = row(0);
  const r1 = row(1);
  const r2 = row(2);
  const r3 = row(3);

  const add = (
    a: [number, number, number, number],
    b: [number, number, number, number],
    sign: 1 | -1,
  ): [number, number, number, number] => [
    a[0] + sign * b[0],
    a[1] + sign * b[1],
    a[2] + sign * b[2],
    a[3] + sign * b[3],
  ];

  const coefficients: [number, number, number, number][] = [
    add(r3, r0, 1), // left
    add(r3, r0, -1), // right
    add(r3, r1, 1), // bottom
    add(r3, r1, -1), // top
    add(r3, r2, 1), // near
    add(r3, r2, -1), // far
  ];

  const planes: Plane[] = [];
  for (const [a, b, c, d] of coefficients) {
    const length = Math.sqrt(a * a + b * b + c * c);
    if (!Number.isFinite(length) || length === 0) {
      // A degenerate plane would silently cull everything. Skipping it makes
      // the frustum more permissive, which only costs a few extra tiles.
      continue;
    }
    // `Plane` normalises the normal but takes `distance` as given, so scale it
    // to match.
    planes.push(new Plane([a / length, b / length, c / length], d / length));
  }
  return planes;
}

/**
 * Common-space units per metre of elevation, linearised at `latitude`.
 *
 * Matches `@math.gl/web-mercator`'s `getDistanceScales().unitsPerMeter`, which
 * is what the vendored traversal's `zRange` handling assumes.
 */
export function unitsPerMeterAtLatitude(latitude: number): number {
  const clamped = Math.max(
    -MAX_WEB_MERCATOR_LAT,
    Math.min(MAX_WEB_MERCATOR_LAT, latitude),
  );
  return (
    COMMON_SPACE_SIZE /
    (Math.cos((clamped * Math.PI) / 180) * EARTH_CIRCUMFERENCE)
  );
}

/**
 * Framebuffer pixels per CSS pixel for a canvas.
 *
 * Deliberately the *drawing-buffer* ratio rather than `devicePixelRatio`: it
 * reflects what is actually being rendered to, which is what the LOD criterion
 * should match.
 */
export function drawingBufferRatio(gl: WebGL2RenderingContext): number {
  const canvas = gl.canvas;
  const cssWidth =
    canvas instanceof HTMLCanvasElement ? canvas.clientWidth : canvas.width;
  if (!cssWidth) {
    return 1;
  }
  return gl.drawingBufferWidth / cssWidth;
}

/**
 * Build a {@link RasterViewport} for this frame.
 *
 * @param map   The MapLibre map (for zoom and geographic bounds).
 * @param args  MapLibre's `CustomRenderMethodInput`.
 * @param gl    The map's GL context, for the drawing-buffer ratio.
 */
export function createRasterViewport(
  map: MapLibreMap,
  args: CustomRenderMethodInput,
  gl: WebGL2RenderingContext,
): RasterViewport {
  const center = map.getCenter();
  const unitsPerMeter = unitsPerMeterAtLatitude(center.lat);
  const clipMatrix = commonSpaceToClip(
    args.defaultProjectionData.mainMatrix,
    unitsPerMeter,
  );

  const frustumPlanes = extractFrustumPlanes(clipMatrix);
  const bounds = map.getBounds();
  const wgs84Bounds: Bounds = [
    bounds.getWest(),
    bounds.getSouth(),
    bounds.getEast(),
    bounds.getNorth(),
  ];

  return {
    zoom: map.getZoom(),
    frustumPlanes,
    getBounds: () => wgs84Bounds,
    unitsPerMeter,
    pixelRatio: drawingBufferRatio(gl),
  };
}
