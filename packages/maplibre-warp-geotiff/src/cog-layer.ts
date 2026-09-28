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
  RasterTilePayload,
  RenderPipeline,
  TileIndex,
  TileMeshData,
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
  UnrecoverableSourceError,
} from "@yutannihilation/maplibre-warp-raster";
import type { CustomRenderMethodInput, Map as MapLibreMap } from "maplibre-gl";
import proj4 from "proj4";
import type { ImageryRenderOptions, Rescale } from "./bands.js";
import { readExtraSamples, validateImageryOptions } from "./bands.js";
import { geoTiffToDescriptor, imageForLevel } from "./geotiff-tileset.js";
import { abortError, fetchGeoTIFF } from "./geotiff-utils.js";
import type {
  ContourBandWithColor,
  ContourGradient,
  ContourRenderOptions,
  GeoTiffRenderer,
  GeoTiffTilePixels,
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

export interface COGLayerProps
  extends RasterCustomLayerProps,
    ImageryRenderOptions {
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
   * between them live. `bands` and `rescale` are ignored with `contour`.
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
  /**
   * {@link contour} resolved: validated once, fed to the renderer, and what
   * {@link getBands} and {@link getGradient} read.
   */
  private resolvedContour?: ResolvedContourOptions;
  /** Current imagery options; start as the props', see {@link setBands}. */
  private imagery: ImageryRenderOptions;
  private renderer?: GeoTiffRenderer;
  private geotiff?: GeoTIFF;

  constructor(props: COGLayerProps) {
    super(props);
    // Fail here rather than inside the retried source-open path; what
    // depends on the file's tags is checked again when they are known.
    if (props.contour) {
      this.resolvedContour = resolveContourOptions(props.contour);
    }
    validateImageryOptions(props);
    this.props = props;
    this.contour = props.contour;
    this.imagery = { bands: props.bands, rescale: props.rescale };
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
    return this.resolvedContour?.bands.slice() ?? [];
  }

  /**
   * The gradient fill's domain and colour stops, for legends. Available
   * before the COG has opened; `null` unless the fill is `"gradient"`.
   */
  getGradient(): ContourGradient | null {
    const gradient = this.resolvedContour?.gradient;
    return gradient
      ? { min: gradient.min, max: gradient.max, stops: gradient.stops.slice() }
      : null;
  }

  /**
   * Re-style the contours without reloading anything: thresholds, colours,
   * the fill mode (`"bands"`, `"gradient"`, `"none"`), lines on or off and
   * their style. Tiles already on the GPU pick the change up on the next
   * frame, which this schedules; a new module chain is compiled on demand.
   * Applies at `onAdd` if the layer is not on a map yet.
   *
   * The new colour textures are created in that frame's `prerender`. If that
   * fails the error is logged and the previous style stays.
   *
   * `band` may change too: every band is on the GPU as a layer of the tile's
   * texture array.
   *
   * Refused with a `RangeError`: any option that fails the constructor's
   * validation, a `band` the file does not have, and a layer created without
   * `contour` (recreate the layer to switch imagery to contours).
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
      // Recorded now, applied by `prepare` in the next frame's `prerender`,
      // inside MapLibre's GL-state bracket.
      this.renderer.updateContour(resolved);
      this.map?.triggerRepaint();
    }
    this.contour = contour;
    this.resolvedContour = resolved;
  }

  /**
   * Re-compose the imagery without reloading anything: another selection of
   * file bands (`[gray]`, `[r, g, b]` or `[r, g, b, a]`, 0-based) and,
   * optionally, another stretch; without `rescale` the current one is kept.
   * Every band is already on the GPU, so tiles pick the change up on the
   * next frame, which this schedules. Applies at `onAdd` if the layer is not
   * on a map yet.
   *
   * Refused with a `RangeError`, leaving the current options in place: a
   * layer created with `contour`, a band outside the file, a selection the
   * photometric interpretation forbids, or a stretch that does not fit it.
   */
  setBands(bands: readonly number[], rescale?: Rescale): void {
    this.setImagery({ bands, rescale: rescale ?? this.imagery.rescale });
  }

  /**
   * Re-stretch the imagery without reloading anything; `undefined` returns
   * to the default, which only 8-bit unsigned rasters have. Same rules and
   * timing as {@link setBands}.
   */
  setRescale(rescale: Rescale | undefined): void {
    this.setImagery({ ...this.imagery, rescale });
  }

  private setImagery(imagery: ImageryRenderOptions): void {
    if (this.contour) {
      throw new RangeError(
        "setBands/setRescale need a layer created without `contour`; its tiles are drawn as contours",
      );
    }
    validateImageryOptions(imagery);
    if (this.renderer) {
      // Validates against the file's tags before touching any tile.
      this.renderer.updateImagery(imagery);
      this.map?.triggerRepaint();
    }
    this.imagery = imagery;
  }

  /**
   * Before the tile uploads: create or replace the renderer's layer-wide
   * textures (a palette's colormap, the contour colours), so the tiles built
   * this frame can reference them.
   *
   * A failure is logged, not rethrown: out of `prerender` it would escape
   * MapLibre's render loop and take every layer's frame down with it.
   * `prepare` consumes the work it attempted, so this logs once per failed
   * change rather than once per frame. If the very first `prepare` failed,
   * tile uploads then fail through the scheduler's bounded retry path, since
   * `buildPipeline` has nothing to build from.
   */
  override prerender(
    gl: WebGL2RenderingContext,
    args: CustomRenderMethodInput,
  ): void {
    try {
      this.renderer?.prepare(gl);
    } catch (error) {
      console.error(
        `[${this.id}] failed to create the layer's textures`,
        error,
      );
    }
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
    // Two independent reads — an EPSG lookup and a tag the library does not
    // prefetch, which decides whether a fourth band is alpha or data — so
    // they overlap. Contours read one band and never need the tag.
    const [sourceProjection, extraSamples] = await Promise.all([
      typeof crs === "number" ? resolveEpsg(crs) : parseWkt(crs),
      this.contour ? null : readExtraSamples(geotiff.image),
    ]);
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

    let renderer: GeoTiffRenderer;
    try {
      renderer = inferRenderPipeline(geotiff, gl, {
        contour: this.contour,
        ...this.imagery,
        extraSamples,
      });
    } catch (error) {
      // Every I/O is done by now: a RangeError here says the options do not
      // fit the file's tags, which no retry can change.
      throw error instanceof RangeError
        ? new UnrecoverableSourceError(error)
        : error;
    }
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

      return { upload: (gl) => uploadTile(gl, renderer, pixels, meshData) };
    };

    return { descriptor, wgs84Bounds, loadTile };
  }
}

/**
 * Upload one decoded tile: textures, mesh and module chain.
 *
 * A module-level function rather than a closure inside the loader, so that
 * the payload's `destroy` captures only the GPU handles. Nested in the
 * loader, it would share the loader's closure context and keep the tile's
 * decoded pixels and mesh arrays alive for as long as the tile stays cached.
 *
 * Anything created before a throw is released, so a failed upload leaks
 * nothing however often the scheduler retries it.
 */
function uploadTile(
  gl: WebGL2RenderingContext,
  renderer: GeoTiffRenderer,
  pixels: GeoTiffTilePixels,
  meshData: TileMeshData,
): RasterTilePayload {
  const textures = renderer.uploadTileTextures(gl, pixels);
  let mesh: GpuMesh | undefined;
  let pipeline: RenderPipeline;
  try {
    mesh = new GpuMesh(gl, meshData);
    pipeline = renderer.buildPipeline(textures);
  } catch (error) {
    mesh?.destroy(gl);
    renderer.destroyTileTextures(gl, textures);
    throw error;
  }
  const gpuMesh = mesh;
  return {
    mesh: gpuMesh,
    pipeline,
    byteLength: textures.byteLength + meshData.byteLength,
    destroy: (glContext) => {
      gpuMesh.destroy(glContext);
      renderer.destroyTileTextures(glContext, textures);
    },
  };
}
