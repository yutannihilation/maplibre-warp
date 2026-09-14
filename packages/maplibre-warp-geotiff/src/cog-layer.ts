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
import type {
  Point,
  RasterCustomLayerProps,
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
  mercatorFromEPSG3857,
  RasterCustomLayer,
} from "@yutannihilation/maplibre-warp-raster";
import type { Map as MapLibreMap } from "maplibre-gl";
import { imageForLevel } from "./geotiff-tileset.js";
import { openCOG } from "./open-cog.js";
import type { GeoTiffRenderer } from "./render-pipeline.js";
import { inferRenderPipeline } from "./render-pipeline.js";

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
  private renderer?: GeoTiffRenderer;
  private geotiff?: GeoTIFF;

  constructor(props: COGLayerProps) {
    super(props);
    this.props = props;
  }

  /** The opened GeoTIFF, once the header has been read. */
  get source(): GeoTIFF | undefined {
    return this.geotiff;
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
    // managed to allocate before it failed. `inferRenderPipeline` can have
    // uploaded a colormap texture by then.
    this.renderer?.destroy(gl);
    this.renderer = undefined;
    this.geotiff = undefined;

    const opened = await openCOG(this.props.geotiff, {
      epsgResolver: this.props.epsgResolver,
      concurrencyLimiter:
        this.props.concurrencyLimiter === undefined
          ? DEFAULT_CONCURRENCY_LIMITER
          : this.props.concurrencyLimiter,
      signal,
    });
    if (!opened) {
      return null;
    }
    const {
      geotiff,
      descriptor,
      sourceProjection,
      projectTo4326,
      rawBounds,
      wgs84Bounds,
    } = opened;
    this.geotiff = geotiff;

    const renderer = inferRenderPipeline(geotiff, gl);
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

    const loadTile = async (
      index: TileIndex,
      context: { gl: WebGL2RenderingContext; signal: AbortSignal },
    ): Promise<RasterTilePayload> => {
      const image = imageForLevel(geotiff, index.z);
      const textures = await renderer.loadTileTextures(image, {
        gl: context.gl,
        x: index.x,
        y: index.y,
        signal: context.signal,
        pool,
      });

      if (context.signal.aborted) {
        renderer.destroyTileTextures(context.gl, textures);
        throw new DOMException("Tile load aborted", "AbortError");
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
      const mesh = new GpuMesh(context.gl, meshData);
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

    return { descriptor, wgs84Bounds, loadTile };
  }
}
