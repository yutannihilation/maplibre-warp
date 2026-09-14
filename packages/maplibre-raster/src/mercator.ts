/**
 * Conversions between the three coordinate spaces this package uses.
 *
 * 1. **EPSG:3857 metres** — what `RasterTilesetDescriptor.projectTo3857`
 *    produces. Y increases north.
 * 2. **Common space** `[0, 512]²` — the space the tile traversal works in. Y
 *    increases **north**, matching `@math.gl/web-mercator`'s `lngLatToWorld`
 *    (and therefore deck.gl's "common space", which the traversal was ported
 *    from). Bounding volumes and frustum planes live here.
 * 3. **MapLibre mercator** `[0, 1]²` — what MapLibre's `projectTile` prelude
 *    consumes when fed `defaultProjectionData`. Y increases **south**, `[0, 0]`
 *    is the top-left of the mercator world. Mesh vertices live here.
 *
 * The Y axis flips between (2) and (3). Keeping the traversal in its original
 * space means the vendored traversal code needs no coordinate rework; only the
 * frustum-plane shim and the mesh output cross the boundary.
 */

import type { Point } from "./tileset/types.js";

/**
 * Semi-major axis of the WGS84 ellipsoid. EPSG:3857 also uses the WGS84 datum.
 */
export const WGS84_ELLIPSOID_A = 6378137;

/** Full circumference of the EPSG:3857 Web Mercator world, in metres. */
export const EPSG_3857_CIRCUMFERENCE = 2 * Math.PI * WGS84_ELLIPSOID_A;

const EPSG_3857_HALF_CIRCUMFERENCE = EPSG_3857_CIRCUMFERENCE / 2;

/** Maximum latitude representable in Web Mercator (EPSG:3857), in degrees. */
export const MAX_WEB_MERCATOR_LAT = 85.05112877980659;

/**
 * Width of the whole world in common space. At zoom 0 one tile covers the
 * world and is 512×512 common units.
 */
export const COMMON_SPACE_SIZE = 512;

/**
 * Mean circumference of the Earth in metres, as used for metres-per-pixel.
 * (The `2πa` value above is the Web Mercator world width; this is the value
 * conventionally used in the zoom ↔ resolution relation.)
 */
export const EARTH_CIRCUMFERENCE = 40075016.686;

/**
 * Rescale a position from EPSG:3857 metres into common space `[0, 512]`.
 *
 * Vendored from @developmentseed/deck.gl-raster (MIT, Development Seed):
 * `raster-tile-traversal.ts#rescaleEPSG3857ToCommonSpace`.
 */
export function rescaleEPSG3857ToCommonSpace([x, y]: Point): Point {
  const clampedY = Math.max(
    -EPSG_3857_HALF_CIRCUMFERENCE,
    Math.min(EPSG_3857_HALF_CIRCUMFERENCE, y),
  );

  return [
    (x / EPSG_3857_CIRCUMFERENCE + 0.5) * COMMON_SPACE_SIZE,
    (clampedY / EPSG_3857_CIRCUMFERENCE + 0.5) * COMMON_SPACE_SIZE,
  ];
}

/**
 * Inverse of {@link rescaleEPSG3857ToCommonSpace}.
 *
 * Common-space inputs are in range by construction, so no latitude clamp is
 * applied.
 */
export function rescaleCommonSpaceToEPSG3857([x, y]: Point): Point {
  return [
    (x / COMMON_SPACE_SIZE - 0.5) * EPSG_3857_CIRCUMFERENCE,
    (y / COMMON_SPACE_SIZE - 0.5) * EPSG_3857_CIRCUMFERENCE,
  ];
}

/**
 * Convert EPSG:3857 metres to MapLibre mercator `[0, 1]` (Y increasing south).
 *
 * Y is clamped to the representable Web Mercator band, matching
 * {@link rescaleEPSG3857ToCommonSpace}.
 */
export function mercatorFromEPSG3857([x, y]: Point): Point {
  const clampedY = Math.max(
    -EPSG_3857_HALF_CIRCUMFERENCE,
    Math.min(EPSG_3857_HALF_CIRCUMFERENCE, y),
  );
  return [
    x / EPSG_3857_CIRCUMFERENCE + 0.5,
    0.5 - clampedY / EPSG_3857_CIRCUMFERENCE,
  ];
}

/** Inverse of {@link mercatorFromEPSG3857}. */
export function epsg3857FromMercator([mx, my]: Point): Point {
  return [
    (mx - 0.5) * EPSG_3857_CIRCUMFERENCE,
    (0.5 - my) * EPSG_3857_CIRCUMFERENCE,
  ];
}

/**
 * Convert WGS84 lng/lat (degrees) to MapLibre mercator `[0, 1]`, Y south-down.
 *
 * Equivalent to `maplibregl.MercatorCoordinate.fromLngLat`, reimplemented so
 * this package has no runtime import of `maplibre-gl` (it is a peer dependency
 * and the unit tests run without it).
 */
export function mercatorFromLngLat(lng: number, lat: number): Point {
  const clampedLat = Math.max(
    -MAX_WEB_MERCATOR_LAT,
    Math.min(MAX_WEB_MERCATOR_LAT, lat),
  );
  const phi = (clampedLat * Math.PI) / 180;
  return [
    (180 + lng) / 360,
    0.5 - Math.log(Math.tan(Math.PI / 4 + phi / 2)) / (2 * Math.PI),
  ];
}

/** Convert WGS84 lng/lat (degrees) to common space `[0, 512]`, Y north-up. */
export function commonSpaceFromLngLat(lng: number, lat: number): Point {
  const clampedLat = Math.max(
    -MAX_WEB_MERCATOR_LAT,
    Math.min(MAX_WEB_MERCATOR_LAT, lat),
  );
  const phi = (clampedLat * Math.PI) / 180;
  return [
    ((lng + 180) / 360) * COMMON_SPACE_SIZE,
    ((Math.PI + Math.log(Math.tan(Math.PI / 4 + phi / 2))) / (2 * Math.PI)) *
      COMMON_SPACE_SIZE,
  ];
}

/** Convert a common-space position back to WGS84 lng/lat (degrees). */
export function lngLatFromCommonSpace([x, y]: Point): Point {
  const lng = (x / COMMON_SPACE_SIZE) * 360 - 180;
  const phi =
    2 * Math.atan(Math.exp((y / COMMON_SPACE_SIZE) * 2 * Math.PI - Math.PI)) -
    Math.PI / 2;
  return [lng, (phi * 180) / Math.PI];
}
