/**
 * A synthetic camera looking straight down at one Web Mercator XYZ tile.
 *
 * The tile traversal and the vertex shader only ever see a `RasterViewport`
 * and a mercator → clip matrix, so rendering an XYZ tile offscreen is a
 * matter of building those two for the tile instead of from MapLibre's
 * `CustomRenderMethodInput`.
 */

import { lngLatFromMercator } from "../mercator.js";
import type { Bounds, Point, TileIndex } from "../tileset/types.js";
import type { MercatorRasterViewport } from "../tileset/viewport.js";
import {
  commonSpaceToClip,
  extractFrustumPlanes,
  unitsPerMeterAtLatitude,
} from "../viewport-shim.js";

/** Everything the headless renderer needs to draw one XYZ tile. */
export interface TileFrame {
  index: TileIndex;
  /** The tile in MapLibre mercator `[0, 1]`, Y south-down. */
  bounds: Bounds;
  /**
   * Mercator `[0, 1]` → clip space, column-major float64. North maps to
   * clip `+1`, so a canvas drawn with it is upright.
   */
  matrix: Float64Array;
  /** The tile centre in mercator, the relative-to-centre origin. */
  origin: Point;
  viewport: MercatorRasterViewport;
}

/** Validate an XYZ index: integer `z ≥ 0`, `0 ≤ x, y < 2^z`. */
export function validateTileIndex({ z, x, y }: TileIndex): void {
  if (!Number.isInteger(z) || z < 0) {
    throw new RangeError(`tile z must be a non-negative integer, got ${z}`);
  }
  const n = 2 ** z;
  for (const [name, v] of [
    ["x", x],
    ["y", y],
  ] as const) {
    if (!Number.isInteger(v) || v < 0 || v >= n) {
      throw new RangeError(
        `tile ${name} must be an integer in [0, ${n}), got ${v}`,
      );
    }
  }
}

/** The tile's extent in MapLibre mercator `[0, 1]` (Y increasing south). */
export function mercatorTileBounds(index: TileIndex): Bounds {
  validateTileIndex(index);
  const n = 2 ** index.z;
  return [index.x / n, index.y / n, (index.x + 1) / n, (index.y + 1) / n];
}

/**
 * Orthographic mercator → clip matrix for `bounds`: `x0 → -1`, `x1 → +1`,
 * `y0` (north) `→ +1`, `y1` (south) `→ -1`; `z` passes through.
 */
export function tileClipMatrix([x0, y0, x1, y1]: Bounds): Float64Array {
  const sx = 2 / (x1 - x0);
  const sy = -2 / (y1 - y0);
  const m = new Float64Array(16);
  m[0] = sx;
  m[5] = sy;
  m[10] = 1;
  m[15] = 1;
  m[12] = -1 - sx * x0;
  m[13] = 1 - sy * y0;
  return m;
}

/**
 * Build the camera for one XYZ tile rendered at `tileSize` pixels.
 *
 * MapLibre zoom is the 512-pixel convention, so a 256-pixel tile at XYZ
 * zoom `z` has the pixel density of MapLibre zoom `z - 1`; the traversal's
 * LOD test sees that through `zoom`.
 */
export function createTileFrame(index: TileIndex, tileSize: number): TileFrame {
  if (!(Number.isFinite(tileSize) && tileSize > 0)) {
    throw new RangeError(`tileSize must be positive, got ${tileSize}`);
  }
  const bounds = mercatorTileBounds(index);
  const matrix = tileClipMatrix(bounds);
  const origin: Point = [
    (bounds[0] + bounds[2]) / 2,
    (bounds[1] + bounds[3]) / 2,
  ];
  const [west, north] = lngLatFromMercator([bounds[0], bounds[1]]);
  const [east, south] = lngLatFromMercator([bounds[2], bounds[3]]);
  const center = lngLatFromMercator(origin);
  const unitsPerMeter = unitsPerMeterAtLatitude(center[1]);
  const lngLatBounds: Bounds = [west, south, east, north];

  const viewport: MercatorRasterViewport = {
    projection: "mercator",
    zoom: index.z + Math.log2(tileSize / 512),
    center,
    getBounds: () => lngLatBounds,
    pixelRatio: 1,
    unitsPerMeter,
    frustumPlanes: extractFrustumPlanes(
      commonSpaceToClip(matrix, unitsPerMeter),
    ),
  };

  return { index, bounds, matrix, origin, viewport };
}
