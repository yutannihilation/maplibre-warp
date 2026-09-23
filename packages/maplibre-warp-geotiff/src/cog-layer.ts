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
  RasterCustomLayerProps,
  RasterSource,
  RasterTileData,
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
  RasterCustomLayer,
} from "@yutannihilation/maplibre-warp-raster";
import type { CustomRenderMethodInput, Map as MapLibreMap } from "maplibre-gl";
import proj4 from "proj4";
import { geoTiffToDescriptor, imageForLevel } from "./geotiff-tileset.js";
import { abortError, fetchGeoTIFF } from "./geotiff-utils.js";
import type {
  ContourBandWithColor,
  ContourGradient,
  ContourRenderOptions,
  GeoTiffRenderer,
  ResolvedContourOptions,
} from "./render-pipeline.js";
import {
  inferRenderPipeline,
  resolveContourOptions,
} from "./render-pipeline.js";

/**
 * Default per-origin request cap. Six matches the browser's HTTP/1.1
 * per-origin connection limit; raise it for HTTP/2 or HTTP/3 sources.
 */
const DEFAULT_CONCURRENCY_LIMITER = new PerOriginSemaphore({ maxRequests: 6 });

export interface COGLayerProps extends RasterCustomLayerProps {
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

  /**
   * Render the raster as contours — filled bands or a continuous gradient,
   * with or without lines — instead of as imagery. See
   * {@link ContourRenderOptions}; {@link COGLayer.setContour} switches
   * between them live.
   */
  contour?: ContourRenderOptions;

  /** Called once the GeoTIFF header has been read and its CRS resolved. */
  onGeoTIFFLoad?(
    geotiff: GeoTIFF,
    info: {
      projection: ProjectionDefinition;
      geographicBounds: {
        west: number;
        south: number;
        east: number;
        north: number;
      };
    },
  ): void;
}

/**
 * Renders a COG as a MapLibre custom layer, reprojecting from the file's own
 * CRS on the GPU.
 *
 * ```ts
 * map.addLayer(
 *   new COGLayer({ id: "cog", geotiff: url }),
 *   "waterway-label", // draw under MapLibre's labels
 * );
 * ```
 */
export class COGLayer extends RasterCustomLayer {
  private readonly props: COGLayerProps;
  /** Current contour options; starts as `props.contour`, see {@link setContour}. */
  private contour?: ContourRenderOptions;
  /** Band model of {@link contour}, resolved once alongside its validation. */
  private contourBands: ContourBandWithColor[] = [];
  /** Gradient model of {@link contour}, likewise. */
  private contourGradient: ContourGradient | null = null;
  private renderer?: GeoTiffRenderer;
  private geotiff?: GeoTIFF;

  constructor(props: COGLayerProps) {
    super(props);
    if (props.contour) {
      // Fail here rather than inside the retried source-open path.
      this.rememberContourModel(resolveContourOptions(props.contour));
    }
    this.props = props;
    this.contour = props.contour;
  }

  private rememberContourModel(resolved: ResolvedContourOptions): void {
    this.contourBands = resolved.bands;
    this.contourGradient = resolved.gradient
      ? {
          min: resolved.gradient.min,
          max: resolved.gradient.max,
          stops: resolved.gradient.stops,
        }
      : null;
  }

  /** The opened GeoTIFF, once the header has been read. */
  get source(): GeoTIFF | undefined {
    return this.geotiff;
  }

  /**
   * The contour band model with colours, for legends. Available before the
   * COG has opened, since it depends only on the options; empty unless the
   * fill is `"bands"`.
   */
  getBands(): ContourBandWithColor[] {
    return this.contourBands.slice();
  }

  /**
   * The gradient fill's domain and colour stops, for legends. Available
   * before the COG has opened; `null` unless the fill is `"gradient"`.
   */
  getGradient(): ContourGradient | null {
    return this.contourGradient
      ? { ...this.contourGradient, stops: this.contourGradient.stops.slice() }
      : null;
  }

  /**
   * Re-style the contours without reloading anything: thresholds, colours,
   * the fill mode (`"bands"`, `"gradient"`, `"none"`), lines on or off and
   * their style. Tiles already on the GPU pick the change up on the next
   * frame, which this schedules; a new module chain is compiled on demand.
   * Applies at `onAdd` if the layer is not on a map yet.
   *
   * Refused with a `RangeError`: any option that fails the constructor's
   * validation, a layer created without `contour` (its tiles hold imagery
   * textures, not values), and changing `band`. Recreate the layer for
   * those.
   */
  setContour(contour: ContourRenderOptions): void {
    if (!this.contour) {
      throw new RangeError(
        "setContour needs a layer created with `contour`; imagery cannot be switched to contours in place",
      );
    }
    // Resolved exactly once: this validates, feeds the renderer, and is what
    // `getBands()` hands out afterwards.
    const resolved = resolveContourOptions(
      contour,
      this.geotiff?.cachedTags.samplesPerPixel,
    );
    if (this.renderer) {
      if (!this.renderer.updateContour) {
        throw new Error("the active renderer does not support updateContour");
      }
      // Recorded now, applied by `prepare` in the next frame's `prerender`,
      // inside MapLibre's GL-state bracket.
      this.renderer.updateContour(resolved);
      this.map?.triggerRepaint();
    }
    this.contour = contour;
    this.rememberContourModel(resolved);
  }

  /**
   * Before the tile uploads: create or replace the renderer's layer-wide
   * textures (a palette's colormap, the contour colours), so the tiles built
   * this frame can reference them.
   */
  override prerender(
    gl: WebGL2RenderingContext,
    args: CustomRenderMethodInput,
  ): void {
    this.renderer?.prepare(gl);
    super.prerender(gl, args);
  }

  override onRemove(map: MapLibreMap, gl: WebGL2RenderingContext): void {
    super.onRemove(map, gl);
    this.renderer?.destroy(gl);
    this.renderer = undefined;
    this.geotiff = undefined;
  }

  protected async createSource({
    gl,
    signal,
  }: {
    map: MapLibreMap;
    gl: WebGL2RenderingContext;
    signal: AbortSignal;
  }): Promise<RasterSource | null> {
    // A retry re-runs this method, so release anything a previous attempt
    // managed to allocate before it failed: a frame's `prerender` may have had
    // the renderer create its textures by then.
    this.renderer?.destroy(gl);
    this.renderer = undefined;
    this.geotiff = undefined;

    const geotiff = await fetchGeoTIFF(this.props.geotiff, {
      concurrencyLimiter:
        this.props.concurrencyLimiter === undefined
          ? DEFAULT_CONCURRENCY_LIMITER
          : this.props.concurrencyLimiter,
      signal,
    });
    if (signal.aborted) {
      return null;
    }
    this.geotiff = geotiff;

    const crs = geotiff.crs;
    const resolveEpsg = this.props.epsgResolver ?? defaultEpsgResolver;
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

    const renderer = inferRenderPipeline(geotiff, gl, {
      contour: this.contour,
    });
    this.renderer = renderer;

    this.props.onGeoTIFFLoad?.(geotiff, {
      projection: sourceProjection,
      // The unclamped extent: callers want the dataset's true footprint, while
      // `wgs84Bounds` above is clamped for tile selection.
      geographicBounds: {
        west: rawBounds[0],
        south: rawBounds[1],
        east: rawBounds[2],
        north: rawBounds[3],
      },
    });

    const maxError = this.props.maxError ?? DEFAULT_MAX_ERROR;
    const pool = this.props.pool ?? defaultDecoderPool();

    // Source CRS ↔ MapLibre mercator [0, 1]. Built once so the reprojector
    // sees stable closures.
    const forwardReproject = (x: number, y: number): Point =>
      mercatorFromEPSG3857(descriptor.projectTo3857(x, y));
    const inverseReproject = (mx: number, my: number): Point =>
      descriptor.projectFrom3857(...epsg3857FromMercator([mx, my]));

    // Everything up to the GPU upload: fetch, decode and mesh generation run
    // here, asynchronously; `upload` runs later, from `prerender`.
    const loadTile = async (
      index: TileIndex,
      { signal }: { signal: AbortSignal },
    ): Promise<RasterTileData> => {
      const image = imageForLevel(geotiff, index.z);
      const pixels = await renderer.loadTilePixels(image, {
        x: index.x,
        y: index.y,
        signal,
        pool,
      });

      if (signal.aborted) {
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
        topRight: latAt(pixels.width, 0),
        bottomLeft: latAt(0, pixels.height),
        bottomRight: latAt(pixels.width, pixels.height),
      });

      const meshData = buildTileMesh(
        pixels.width,
        pixels.height,
        {
          forwardTransform,
          inverseTransform,
          forwardReproject,
          inverseReproject,
        },
        { maxError, initialTriangulation },
      );

      return {
        upload: (gl) => {
          const textures = renderer.uploadTileTextures(gl, pixels);
          let mesh: GpuMesh;
          try {
            mesh = new GpuMesh(gl, meshData);
          } catch (error) {
            renderer.destroyTileTextures(gl, textures);
            throw error;
          }
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
        },
      };
    };

    return { descriptor, wgs84Bounds, loadTile };
  }
}
