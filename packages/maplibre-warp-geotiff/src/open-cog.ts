/**
 * Open a COG and resolve everything that depends only on its header: the
 * tile pyramid descriptor, CRS converters and dataset bounds.
 *
 * Shared by the render layer ({@link COGLayer}) and the contour source, so
 * both open a file the same way.
 */

import type { ConcurrencyLimiter, GeoTIFF } from "@developmentseed/geotiff";
import type { EpsgResolver, ProjectionDefinition } from "@developmentseed/proj";
import {
  epsgResolver as defaultEpsgResolver,
  makeClampedForwardTo3857,
  metersPerUnit,
  parseWkt,
  transformBounds,
} from "@developmentseed/proj";
import type {
  AffineTileset,
  Bounds,
  Point,
  ProjectionFunction,
} from "@yutannihilation/maplibre-warp-raster";
import { MAX_WEB_MERCATOR_LAT } from "@yutannihilation/maplibre-warp-raster";
import proj4 from "proj4";

import { geoTiffToDescriptor } from "./geotiff-tileset.js";
import { fetchGeoTIFF } from "./geotiff-utils.js";

export interface OpenCOGOptions {
  /**
   * Resolves numeric EPSG codes found in the GeoTIFF to projection
   * definitions. The default queries epsg.io and caches results.
   */
  epsgResolver?: EpsgResolver;
  /**
   * Caps concurrent HTTP requests. Ignored when `geotiff` is an already-opened
   * {@link GeoTIFF}.
   */
  concurrencyLimiter?: ConcurrencyLimiter | null;
  signal?: AbortSignal;
}

export interface OpenedCOG {
  geotiff: GeoTIFF;
  descriptor: AffineTileset;
  sourceProjection: ProjectionDefinition;
  /** Source CRS → WGS84 degrees. */
  projectTo4326: ProjectionFunction;
  /** Dataset extent in WGS84 degrees, unclamped. */
  rawBounds: Bounds;
  /** Dataset extent clamped to the Web Mercator latitude range. */
  wgs84Bounds: Bounds;
}

/**
 * Open the COG and derive its projection machinery. Resolves `null` when
 * `signal` aborts part-way; rethrows fetch and CRS errors.
 */
export async function openCOG(
  input: GeoTIFF | string | URL | ArrayBuffer,
  options: OpenCOGOptions = {},
): Promise<OpenedCOG | null> {
  const { signal } = options;
  const geotiff = await fetchGeoTIFF(input, {
    concurrencyLimiter: options.concurrencyLimiter,
    signal,
  });
  if (signal?.aborted) {
    return null;
  }

  const crs = geotiff.crs;
  const resolveEpsg = options.epsgResolver ?? defaultEpsgResolver;
  const sourceProjection =
    typeof crs === "number" ? await resolveEpsg(crs) : parseWkt(crs);
  if (signal?.aborted) {
    return null;
  }

  // proj4's TypeScript definitions don't cover wkt-parser output, which it
  // accepts at runtime.
  // @ts-expect-error - incomplete proj4 typings
  const converter4326 = proj4(sourceProjection, "EPSG:4326");
  const projectTo4326 = (x: number, y: number) =>
    converter4326.forward<Point>([x, y], false);
  const projectFrom4326 = (x: number, y: number) =>
    converter4326.inverse<Point>([x, y], false);

  // @ts-expect-error - incomplete proj4 typings
  const converter3857 = proj4(sourceProjection, "EPSG:3857");
  const rawProjectTo3857 = (x: number, y: number) =>
    converter3857.forward<Point>([x, y], false);
  const projectFrom3857 = (x: number, y: number) =>
    converter3857.inverse<Point>([x, y], false);

  const units = sourceProjection.units;
  if (!units) {
    throw new Error(
      "Source projection is missing a 'units' property, so metres per unit cannot be computed",
    );
  }
  const mpu = metersPerUnit(units as Parameters<typeof metersPerUnit>[0], {
    semiMajorAxis: sourceProjection.datum?.a ?? sourceProjection.a,
  });

  const descriptor = geoTiffToDescriptor(geotiff, {
    projectTo4326,
    projectFrom4326,
    // `AffineTileset` stores this as-is, so wrapping here means every
    // consumer (traversal, mesh) gets the pole-safe version — proj4 returns
    // NaN at the poles, where Mercator is undefined.
    projectTo3857: makeClampedForwardTo3857(rawProjectTo3857, projectTo4326),
    projectFrom3857,
    mpu,
  });

  // `transformBounds` densifies the edges, so a CRS whose boundary bows
  // outward in lng/lat is fully enclosed. Reprojecting only the four corners
  // would under-cover it.
  const rawBounds = transformBounds(
    projectTo4326,
    ...descriptor.projectedBounds,
  );
  // Web Mercator cannot represent latitudes beyond ±85.051°, and tile
  // selection converts these bounds through `lngLat → common space`.
  const wgs84Bounds: Bounds = [
    rawBounds[0],
    Math.max(rawBounds[1], -MAX_WEB_MERCATOR_LAT),
    rawBounds[2],
    Math.min(rawBounds[3], MAX_WEB_MERCATOR_LAT),
  ];

  return {
    geotiff,
    descriptor,
    sourceProjection,
    projectTo4326,
    rawBounds,
    wgs84Bounds,
  };
}
