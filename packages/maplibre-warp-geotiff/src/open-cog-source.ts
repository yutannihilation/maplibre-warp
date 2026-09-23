/**
 * Open a COG as a {@link RasterSource}: read the header, resolve the CRS,
 * build the tile pyramid and the per-tile loader.
 *
 * Shared by `COGLayer` (which draws on a map) and `COGDemSource` (which
 * draws XYZ tiles offscreen); only the renderer they plug in differs.
 */

import type {
  ConcurrencyLimiter,
  DecoderPool,
  GeoTIFF,
} from "@developmentseed/geotiff";
import {
  defaultDecoderPool,
  PerOriginSemaphore,
} from "@developmentseed/geotiff";
import type { EpsgResolver, ProjectionDefinition } from "@developmentseed/proj";
import {
  epsgResolver as defaultEpsgResolver,
  makeClampedForwardTo3857,
  metersPerUnit,
  parseWkt,
  transformBounds,
} from "@developmentseed/proj";
import type {
  Bounds,
  Point,
  RasterSource,
  RasterTilePayload,
  TileIndex,
} from "@yutannihilation/maplibre-warp-raster";
import {
  buildTileMesh,
  createInitialWebMercatorTriangulation,
  DEFAULT_MAX_ERROR,
  epsg3857FromMercator,
  GpuMesh,
  MAX_WEB_MERCATOR_LAT,
  mercatorFromEPSG3857,
} from "@yutannihilation/maplibre-warp-raster";
import proj4 from "proj4";
import { geoTiffToDescriptor, imageForLevel } from "./geotiff-tileset.js";
import { abortError, fetchGeoTIFF } from "./geotiff-utils.js";
import type { GeoTiffRenderer } from "./render-pipeline.js";

/**
 * Default per-origin request cap. Six matches the browser's HTTP/1.1
 * per-origin connection limit; raise it for HTTP/2 or HTTP/3 sources.
 */
const DEFAULT_CONCURRENCY_LIMITER = new PerOriginSemaphore({ maxRequests: 6 });

export interface OpenCogSourceProps {
  /**
   * The Cloud-Optimized GeoTIFF: a URL, an `ArrayBuffer` holding the whole
   * file, or an already-opened {@link GeoTIFF}.
   */
  geotiff: GeoTIFF | string | URL | ArrayBuffer;

  /**
   * Resolves numeric EPSG codes found in the GeoTIFF to projection
   * definitions. The default queries epsg.io and caches results.
   */
  epsgResolver?: EpsgResolver;

  /** Worker pool for decoding tiles. Defaults to a shared pool. */
  pool?: DecoderPool;

  /**
   * Caps concurrent HTTP requests. Pass `null` to disable. Ignored when
   * `geotiff` is an already-opened {@link GeoTIFF} — wire the limiter through
   * `GeoTIFF.fromUrl` instead.
   */
  concurrencyLimiter?: ConcurrencyLimiter | null;

  /**
   * Maximum reprojection error of the warp mesh, in source pixels. Lower
   * values give denser meshes.
   *
   * @default 0.125
   */
  maxError?: number;
}

/** The dataset's true footprint in WGS84 degrees, unclamped. */
export interface GeographicBounds {
  west: number;
  south: number;
  east: number;
  north: number;
}

export interface OpenedCogSource extends RasterSource {
  geotiff: GeoTIFF;
  projection: ProjectionDefinition;
  geographicBounds: GeographicBounds;
  renderer: GeoTiffRenderer;
}

/**
 * Open the COG described by `props`. Resolves to `null` if `signal` aborts
 * part-way; rejects on any other failure.
 *
 * `createRenderer` runs once the header is read, so it can inspect the tags;
 * a renderer it allocated is the caller's to destroy.
 */
export async function openCogSource(
  props: OpenCogSourceProps,
  context: {
    gl: WebGL2RenderingContext;
    signal: AbortSignal;
    createRenderer(
      geotiff: GeoTIFF,
      gl: WebGL2RenderingContext,
    ): GeoTiffRenderer;
  },
): Promise<OpenedCogSource | null> {
  const { gl, signal } = context;

  const geotiff = await fetchGeoTIFF(props.geotiff, {
    concurrencyLimiter:
      props.concurrencyLimiter === undefined
        ? DEFAULT_CONCURRENCY_LIMITER
        : props.concurrencyLimiter,
    signal,
  });
  if (signal.aborted) {
    return null;
  }

  const crs = geotiff.crs;
  const resolveEpsg = props.epsgResolver ?? defaultEpsgResolver;
  const sourceProjection =
    typeof crs === "number" ? await resolveEpsg(crs) : parseWkt(crs);
  if (signal.aborted) {
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

  const renderer = context.createRenderer(geotiff, gl);

  const maxError = props.maxError ?? DEFAULT_MAX_ERROR;
  const pool = props.pool ?? defaultDecoderPool();

  // Source CRS ↔ MapLibre mercator [0, 1]. Built once so the reprojector
  // sees stable closures.
  const forwardReproject = (x: number, y: number): Point =>
    mercatorFromEPSG3857(descriptor.projectTo3857(x, y));
  const inverseReproject = (mx: number, my: number): Point =>
    descriptor.projectFrom3857(...epsg3857FromMercator([mx, my]));

  const loadTile = async (
    index: TileIndex,
    tileContext: { gl: WebGL2RenderingContext; signal: AbortSignal },
  ): Promise<RasterTilePayload> => {
    const image = imageForLevel(geotiff, index.z);
    const textures = await renderer.loadTileTextures(image, {
      gl: tileContext.gl,
      x: index.x,
      y: index.y,
      signal: tileContext.signal,
      pool,
    });

    if (tileContext.signal.aborted) {
      renderer.destroyTileTextures(tileContext.gl, textures);
      throw abortError();
    }

    const level = descriptor.levels[index.z]!;
    const { forwardTransform, inverseTransform } = level.tileTransform(
      index.x,
      index.y,
    );

    // Corner latitudes of the *decoded* extent — edge tiles are clipped, so
    // the nominal tile corners would overstate it.
    const latAt = (px: number, py: number) =>
      projectTo4326(...forwardTransform(px, py))[1];
    const initialTriangulation = createInitialWebMercatorTriangulation({
      topLeft: latAt(0, 0),
      topRight: latAt(textures.width, 0),
      bottomLeft: latAt(0, textures.height),
      bottomRight: latAt(textures.width, textures.height),
    });

    const meshData = buildTileMesh(
      textures.width,
      textures.height,
      {
        forwardTransform,
        inverseTransform,
        forwardReproject,
        inverseReproject,
      },
      { maxError, initialTriangulation },
    );
    const mesh = new GpuMesh(tileContext.gl, meshData);
    const pipeline = renderer.buildPipeline(textures);

    return {
      mesh,
      pipeline,
      byteLength: textures.byteLength + meshData.byteLength,
      destroy: (glContext) => {
        mesh.destroy(glContext);
        renderer.destroyTileTextures(glContext, textures);
      },
    };
  };

  return {
    geotiff,
    projection: sourceProjection,
    geographicBounds: {
      west: rawBounds[0],
      south: rawBounds[1],
      east: rawBounds[2],
      north: rawBounds[3],
    },
    renderer,
    descriptor,
    wgs84Bounds,
    loadTile,
  };
}
