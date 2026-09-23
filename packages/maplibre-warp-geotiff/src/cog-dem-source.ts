/**
 * A COG served as MapLibre `raster-dem` tiles through a custom protocol.
 *
 * MapLibre's terrain, `hillshade` and `color-relief` read square EPSG:3857
 * XYZ tiles with the elevation packed into RGB. `COGDemSource` produces those
 * in the page: for each requested tile it selects the COG tiles that cover
 * it, warps them through the same mesh and shader path the map layer uses
 * — into an `OffscreenCanvas` of its own — and hands MapLibre the resulting
 * `ImageBitmap`. Nothing is fetched twice across neighbouring output tiles;
 * the COG tiles sit in a byte-capped cache.
 *
 * Registration is explicit, once per page, so this package needs no runtime
 * import of `maplibre-gl`:
 *
 * ```ts
 * maplibregl.addProtocol(COG_DEM_PROTOCOL, cogDemProtocol);
 * const dem = new COGDemSource({ id: "dem", geotiff: url });
 * map.addSource("dem", await dem.open());
 * map.setTerrain({ source: "dem" });
 * ```
 */

import type { GeoTIFF } from "@developmentseed/geotiff";
import type {
  Bounds,
  RasterTilePayload,
  TileIndex,
} from "@yutannihilation/maplibre-warp-raster";
import {
  BoundingVolumeCache,
  createTileFrame,
  EARTH_CIRCUMFERENCE,
  getTileIndices,
  HeadlessTileRenderer,
  TilePayloadCache,
  validateTileIndex,
} from "@yutannihilation/maplibre-warp-raster";
import type { DemEncoding } from "@yutannihilation/maplibre-warp-raster/gpu-modules";
import {
  demClearColor,
  validateDemEncoding,
} from "@yutannihilation/maplibre-warp-raster/gpu-modules";
import type {
  AddProtocolAction,
  RasterDEMSourceSpecification,
} from "maplibre-gl";
import type { OpenCogSourceProps, OpenedCogSource } from "./open-cog-source.js";
import { openCogSource } from "./open-cog-source.js";
import { createDemRenderer } from "./render-pipeline.js";

/** The URL scheme; pass to `maplibregl.addProtocol` with {@link cogDemProtocol}. */
export const COG_DEM_PROTOCOL = "cog-dem";

/** MapLibre's greatest tile zoom. */
const MAX_ZOOM = 22;

export type DemTileSize = 256 | 512;

export interface COGDemSourceProps extends OpenCogSourceProps {
  /**
   * Identifies this source in tile URLs (`cog-dem://<id>/{z}/{x}/{y}`). Must
   * be unique among live `COGDemSource`s.
   */
  id: string;
  /** Band holding the elevation. @default 0 */
  band?: number;
  /** How elevation is packed into RGB. @default "terrarium" */
  encoding?: DemEncoding;
  /**
   * Elevation in metres written where the raster has no data: nodata and
   * masked texels, and everything outside the dataset. `raster-dem` has no
   * notion of missing data, so this is the ground MapLibre sees there.
   * @default 0
   */
  fillValue?: number;
  /** Output tile edge in pixels. @default 512 */
  tileSize?: DemTileSize;
  /**
   * Level-of-detail bias in zoom levels, as on the layer: `0` reads COG
   * pixels no larger than an output pixel; each `+1` allows twice as large.
   * Also lowers the source's `maxzoom` by the same amount.
   * @default 0
   */
  lodBias?: number;
  /** Soft cap on retained COG tiles in GPU bytes. @default 256 MiB */
  maxCacheByteSize?: number;
  /** Soft cap on retained COG tiles. @default 512 */
  maxCacheSize?: number;
  /** Delay before the first retry of a failed COG tile, doubling. @default 1000 */
  retryBaseDelay?: number;
  /** Retries per COG tile before the output tile fails. @default 3 */
  maxRetries?: number;
}

/**
 * The `raster-dem` source specification a {@link COGDemSource} emits:
 * MapLibre's own type, with the fields this source always fills in required
 * and narrowed to what it produces. `bounds` is `[west, south, east, north]`,
 * so MapLibre requests no tiles outside the data; `maxzoom` is where the
 * COG's finest level is reached, and MapLibre overzooms beyond it.
 */
export type COGDemSourceSpecification = RasterDEMSourceSpecification &
  Required<
    Pick<
      RasterDEMSourceSpecification,
      "tiles" | "bounds" | "minzoom" | "maxzoom"
    >
  > & {
    tileSize: DemTileSize;
    encoding: DemEncoding;
  };

const registry = new Map<string, COGDemSource>();

/**
 * The XYZ zoom at which one output pixel covers one source pixel of the
 * finest level at `latitude`, less `lodBias`, clamped to `[0, 22]`.
 */
export function demMaxZoom(
  metersPerPixel: number,
  latitude: number,
  tileSize: number,
  lodBias = 0,
): number {
  const groundWidth =
    EARTH_CIRCUMFERENCE * Math.cos((latitude * Math.PI) / 180);
  const zoom = Math.ceil(Math.log2(groundWidth / (metersPerPixel * tileSize)));
  return Math.min(MAX_ZOOM, Math.max(0, zoom - lodBias));
}

/**
 * {@link demMaxZoom} for a dataset extent: evaluated at the latitude nearest
 * the equator, where an output pixel covers the most ground and the source
 * resolution is therefore reached last. Mercator stretches the ground
 * toward the poles, so at the same zoom a pixel there covers fewer metres
 * and the poleward part of a tall dataset is only upsampled at `maxzoom`,
 * never left coarser than its data. The centre latitude would do exactly
 * that to the equatorward part.
 */
export function demMaxZoomForBounds(
  metersPerPixel: number,
  [, south, , north]: Bounds,
  tileSize: number,
  lodBias = 0,
): number {
  const latitude =
    south <= 0 && north >= 0 ? 0 : Math.min(Math.abs(south), Math.abs(north));
  return demMaxZoom(metersPerPixel, latitude, tileSize, lodBias);
}

/** Parse `cog-dem://<id>/<z>/<x>/<y>`. */
export function parseCogDemUrl(url: string): { id: string; index: TileIndex } {
  const malformed = (): Error =>
    new Error(
      `malformed ${COG_DEM_PROTOCOL} URL ${JSON.stringify(url)}; expected ${COG_DEM_PROTOCOL}://<id>/<z>/<x>/<y>`,
    );
  const match = new RegExp(
    `^${COG_DEM_PROTOCOL}://([^/]+)/(\\d+)/(\\d+)/(\\d+)$`,
  ).exec(url);
  if (!match) {
    throw malformed();
  }
  let id: string;
  try {
    id = decodeURIComponent(match[1]!);
  } catch {
    // A stray `%` in the id segment is as malformed as a missing `/z/x/y`.
    throw malformed();
  }
  return {
    id,
    index: { z: Number(match[2]), x: Number(match[3]), y: Number(match[4]) },
  };
}

/**
 * The protocol handler for {@link COG_DEM_PROTOCOL}: register once with
 * `maplibregl.addProtocol(COG_DEM_PROTOCOL, cogDemProtocol)`.
 */
export const cogDemProtocol: AddProtocolAction = async (params, controller) => {
  const { id, index } = parseCogDemUrl(params.url);
  const source = registry.get(id);
  if (!source) {
    throw new Error(
      `no COGDemSource is registered with id ${JSON.stringify(id)}`,
    );
  }
  return { data: await source.loadTile(index, controller.signal) };
};

interface Opened {
  source: OpenedCogSource;
  cache: TilePayloadCache<RasterTilePayload>;
  headless: HeadlessTileRenderer;
  boundingVolumeCache: BoundingVolumeCache;
  specification: COGDemSourceSpecification;
}

export class COGDemSource {
  readonly id: string;
  readonly tileSize: DemTileSize;
  readonly encoding: DemEncoding;
  readonly fillValue: number;
  readonly band: number;
  readonly lodBias: number;

  private readonly props: COGDemSourceProps;
  /** `fillValue` encoded once, the clear colour of every tile. */
  private readonly clearColor: readonly [number, number, number];
  private readonly controller = new AbortController();
  private opening?: Promise<COGDemSourceSpecification>;
  private opened?: Opened;
  private destroyed = false;

  constructor(props: COGDemSourceProps) {
    if (typeof props.id !== "string" || props.id.length === 0) {
      throw new RangeError("COGDemSource needs a non-empty string id");
    }
    if (props.id.includes("/")) {
      throw new RangeError(`COGDemSource id must not contain "/": ${props.id}`);
    }
    if (registry.has(props.id)) {
      throw new RangeError(
        `a COGDemSource with id ${JSON.stringify(props.id)} already exists; destroy it first`,
      );
    }
    const tileSize = props.tileSize ?? 512;
    if (tileSize !== 256 && tileSize !== 512) {
      throw new RangeError(`tileSize must be 256 or 512, got ${tileSize}`);
    }
    const fillValue = props.fillValue ?? 0;
    if (!Number.isFinite(fillValue)) {
      throw new RangeError(`fillValue must be finite, got ${fillValue}`);
    }
    const band = props.band ?? 0;
    if (!Number.isInteger(band) || band < 0) {
      throw new RangeError(`band must be a non-negative integer, got ${band}`);
    }
    const lodBias = props.lodBias ?? 0;
    if (!Number.isFinite(lodBias)) {
      throw new RangeError(`lodBias must be a finite number, got ${lodBias}`);
    }
    this.id = props.id;
    this.tileSize = tileSize;
    this.encoding = validateDemEncoding(props.encoding ?? "terrarium");
    this.fillValue = fillValue;
    this.band = band;
    this.lodBias = lodBias;
    this.clearColor = demClearColor(fillValue, this.encoding);
    this.props = props;
    registry.set(this.id, this);
  }

  /** The tile URL template MapLibre will request. */
  get tileUrlTemplate(): string {
    return `${COG_DEM_PROTOCOL}://${encodeURIComponent(this.id)}/{z}/{x}/{y}`;
  }

  /** The opened GeoTIFF, once {@link open} has resolved. */
  get source(): GeoTIFF | undefined {
    return this.opened?.source.geotiff;
  }

  /** The source specification, once {@link open} has resolved. */
  get specification(): COGDemSourceSpecification | undefined {
    return this.opened?.specification;
  }

  /**
   * Open the COG and return the `raster-dem` source specification to add to
   * the map. Calls while an open is in flight, or after one succeeded, share
   * its promise. Rejects if the header cannot be read, the CRS cannot be
   * resolved, or this environment has no `OffscreenCanvas` WebGL2; a failed
   * open is forgotten, so calling again retries from scratch.
   */
  open(): Promise<COGDemSourceSpecification> {
    if (this.destroyed) {
      return Promise.reject(
        new Error(`COGDemSource "${this.id}" is destroyed`),
      );
    }
    if (!this.opening) {
      const attempt = this.doOpen();
      this.opening = attempt;
      attempt.catch(() => {
        if (this.opening === attempt) {
          this.opening = undefined;
        }
      });
    }
    return this.opening;
  }

  private async doOpen(): Promise<COGDemSourceSpecification> {
    const headless = HeadlessTileRenderer.create(this.tileSize);
    const { gl } = headless;
    try {
      const source = await openCogSource(this.props, {
        gl,
        signal: this.controller.signal,
        createRenderer: (geotiff, glContext) =>
          createDemRenderer(geotiff, glContext, {
            band: this.band,
            encoding: this.encoding,
            fillValue: this.fillValue,
          }),
      });
      // `openCogSource` checks its signal only around its own awaits, so a
      // `destroy()` that lands between its last check and this continuation
      // still returns a source. Free it here rather than resurrect a
      // destroyed instance.
      if (!source || this.destroyed) {
        source?.renderer.destroy(gl);
        throw new Error(
          `COGDemSource "${this.id}" was destroyed while opening`,
        );
      }

      const cache = new TilePayloadCache<RasterTilePayload>({
        loadTile: (index, signal) => source.loadTile(index, { gl, signal }),
        destroyTile: (payload) => payload.destroy(gl),
        byteLengthOf: (payload) => payload.byteLength,
        maxCacheByteSize: this.props.maxCacheByteSize,
        maxCacheSize: this.props.maxCacheSize,
        retryBaseDelay: this.props.retryBaseDelay,
        maxRetries: this.props.maxRetries,
        onTileError: (index, error, { attempt, willRetry }) => {
          const tile = `tile ${index.z}/${index.x}/${index.y}`;
          if (willRetry) {
            console.warn(
              `[${this.id}] ${tile} failed (attempt ${attempt}), retrying`,
              error,
            );
          } else {
            console.error(`[${this.id}] ${tile} failed, giving up`, error);
          }
        },
      });

      const finest =
        source.descriptor.levels[source.descriptor.levels.length - 1]!;
      const specification: COGDemSourceSpecification = {
        type: "raster-dem",
        tiles: [this.tileUrlTemplate],
        tileSize: this.tileSize,
        encoding: this.encoding,
        bounds: [...source.wgs84Bounds],
        minzoom: 0,
        maxzoom: demMaxZoomForBounds(
          finest.metersPerPixel,
          source.wgs84Bounds,
          this.tileSize,
          this.lodBias,
        ),
      };

      this.opened = {
        source,
        cache,
        headless,
        boundingVolumeCache: new BoundingVolumeCache(),
        specification,
      };
      return specification;
    } catch (error) {
      headless.destroy();
      throw error;
    }
  }

  /**
   * Render one XYZ tile. Rejects before {@link open} has resolved, when a
   * covering COG tile cannot be loaded after its retries, or when `signal`
   * aborts.
   */
  async loadTile(
    index: TileIndex,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<ImageBitmap> {
    const opened = this.opened;
    if (!opened) {
      throw new Error(
        `COGDemSource "${this.id}" cannot load tiles before open() has resolved`,
      );
    }
    validateTileIndex(index);
    const { source, cache, headless, boundingVolumeCache } = opened;

    const frame = createTileFrame(index, this.tileSize);
    const selected = getTileIndices(source.descriptor, {
      viewport: frame.viewport,
      maxZ: source.descriptor.levels.length - 1,
      zRange: null,
      wgs84Bounds: source.wgs84Bounds,
      lodBias: this.lodBias,
      boundingVolumeCache,
    });

    const acquired = await cache.acquire(selected, signal);
    try {
      // `destroy()` during the wait has already freed the payloads and lost
      // the context; drawing them would only raise GL errors.
      if (this.opened !== opened) {
        throw new Error(
          `COGDemSource "${this.id}" was destroyed while loading tile ${index.z}/${index.x}/${index.y}`,
        );
      }
      return headless.render(
        acquired.tiles,
        frame.matrix,
        frame.origin,
        this.clearColor,
      );
    } finally {
      acquired.release();
    }
  }

  /** Unregister, abort any open in progress and free every GPU resource. */
  destroy(): void {
    this.destroyed = true;
    if (registry.get(this.id) === this) {
      registry.delete(this.id);
    }
    this.controller.abort();
    const { opened } = this;
    this.opened = undefined;
    if (opened) {
      opened.cache.destroy();
      opened.source.renderer.destroy(opened.headless.gl);
      opened.boundingVolumeCache.clear();
      opened.headless.destroy();
    }
  }
}
