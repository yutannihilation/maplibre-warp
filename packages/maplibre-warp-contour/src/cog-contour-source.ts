/**
 * A MapLibre vector source of contours generated on demand from a COG.
 *
 * ```ts
 * const contours = new COGContourSource({
 *   id: "dem-contours",
 *   geotiff: "https://example.com/dem.tif",
 *   thresholds: [200, 400, 600, 800],
 * });
 * contours.register(maplibregl);
 * map.addSource("contours", await contours.getSourceSpecification());
 * map.addLayer({ id: "bands", type: "fill", source: "contours",
 *   "source-layer": "bands", paint: { "fill-color": ["match", ["get", "band"], …] } });
 * ```
 */

import type { AddProtocolAction, VectorSourceSpecification } from "maplibre-gl";

import type { BackendInit, ContourBackend, GeoTIFFInput } from "./backend.js";
import type { ContourOptions } from "./generate.js";
import { validateThresholds } from "./isolines.js";
import { LocalBackend } from "./local-backend.js";
import { parseTileUrl } from "./tile-url.js";
import { defaultCreateWorker, WorkerBackend } from "./worker-backend.js";
import { computeZoomRange } from "./zoom-range.js";

export interface ProtocolRegistry {
  addProtocol(name: string, handler: AddProtocolAction): void;
  removeProtocol?(name: string): void;
}

export interface COGContourSourceOptions {
  /** Protocol name; the tile template becomes `<id>://{z}/{x}/{y}.mvt`. */
  id: string;
  geotiff: GeoTIFFInput;
  /** Strictly increasing contour levels, in the raster's units. */
  thresholds: readonly number[];
  /** Band to contour. @default 0 */
  band?: number;
  /** Which layers to generate. @default "both" */
  mode?: "bands" | "lines" | "both";
  /** Emit the band below the first threshold. @default false */
  includeLower?: boolean;
  /** Emit the band above the last threshold. @default true */
  includeUpper?: boolean;
  /** Sample cells across a tile. @default 256 */
  tileSize?: number;
  /** Buffer cells on each side. @default 1 */
  buffer?: number;
  /** MVT extent. @default 4096 */
  extent?: number;
  /** Source-layer names. @default { bands: "bands", lines: "lines" } */
  layerNames?: { bands: string; lines: string };
  /** Most source tiles one vector tile may need; also sets `minzoom`. @default 64 */
  maxSourceTiles?: number;
  /** Encoded tiles kept in memory. @default 256 */
  cacheSize?: number;
  /** Generate in a module worker. @default true */
  worker?: boolean;
  /** Custom worker construction, e.g. a bundler's `?worker` import. */
  createWorker?: () => Worker;
  /** Replace the backend entirely (testing, custom transports). */
  createBackend?: (init: BackendInit) => ContourBackend;
}

export interface ContourBand {
  band: number;
  min?: number;
  max?: number;
}

interface InFlight {
  promise: Promise<Uint8Array | null>;
  controller: AbortController;
  waiters: number;
}

export class COGContourSource {
  readonly id: string;
  readonly tileUrlTemplate: string;
  readonly options: ContourOptions;

  private readonly backend: ContourBackend;
  private readonly cacheSize: number;
  private readonly cache = new Map<string, Uint8Array | null>();
  private readonly inFlight = new Map<string, InFlight>();
  private opening?: ReturnType<ContourBackend["open"]>;
  private registry?: ProtocolRegistry;

  constructor(options: COGContourSourceOptions) {
    if (!options.id) {
      throw new RangeError("id must not be empty");
    }
    if (options.thresholds.length === 0) {
      throw new RangeError("thresholds must not be empty");
    }
    validateThresholds(options.thresholds);
    this.id = options.id;
    this.tileUrlTemplate = `${options.id}://{z}/{x}/{y}.mvt`;
    this.cacheSize = options.cacheSize ?? 256;
    this.options = {
      band: options.band ?? 0,
      thresholds: [...options.thresholds],
      mode: options.mode ?? "both",
      tileSize: options.tileSize ?? 256,
      buffer: options.buffer ?? 1,
      extent: options.extent ?? 4096,
      includeLower: options.includeLower ?? false,
      includeUpper: options.includeUpper ?? true,
      layerNames: options.layerNames ?? { bands: "bands", lines: "lines" },
      maxSourceTiles: options.maxSourceTiles ?? 64,
    };
    const init: BackendInit = {
      geotiff: options.geotiff,
      options: this.options,
    };
    this.backend = options.createBackend
      ? options.createBackend(init)
      : (options.worker ?? true)
        ? new WorkerBackend(init, options.createWorker ?? defaultCreateWorker)
        : new LocalBackend(init);
  }

  /** Register the protocol with `maplibregl` (or any `addProtocol` owner). */
  register(registry: ProtocolRegistry): this {
    if (this.registry) {
      return this;
    }
    registry.addProtocol(this.id, this.protocol);
    this.registry = registry;
    return this;
  }

  /** The band model: one entry per emitted band, for styles and legends. */
  getBands(): ContourBand[] {
    const { thresholds, includeLower, includeUpper } = this.options;
    const bands: ContourBand[] = [];
    let index = 0;
    if (includeLower) {
      bands.push({ band: index++, max: thresholds[0]! });
    }
    for (let k = 0; k < thresholds.length; k++, index++) {
      const isLast = k === thresholds.length - 1;
      if (isLast && !includeUpper) {
        break;
      }
      const band: ContourBand = { band: index, min: thresholds[k]! };
      if (!isLast) {
        band.max = thresholds[k + 1]!;
      }
      bands.push(band);
    }
    return bands;
  }

  /** Opens the COG (once) and describes the source to MapLibre. */
  async getSourceSpecification(): Promise<VectorSourceSpecification> {
    const meta = await this.ensureOpen();
    const [west, south, east, north] = meta.wgs84Bounds;
    const { minzoom, maxzoom } = computeZoomRange({
      levelMetersPerPixel: meta.levelMetersPerPixel,
      latitudeDeg: (south + north) / 2,
      tileSize: this.options.tileSize,
      sourceTileWidth: meta.sourceTileWidth,
      maxSourceTiles: this.options.maxSourceTiles,
    });
    return {
      type: "vector",
      tiles: [this.tileUrlTemplate],
      minzoom,
      maxzoom,
      bounds: [west, south, east, north],
    };
  }

  destroy(): void {
    this.registry?.removeProtocol?.(this.id);
    this.registry = undefined;
    for (const entry of this.inFlight.values()) {
      entry.controller.abort();
    }
    this.inFlight.clear();
    this.cache.clear();
    this.backend.destroy();
  }

  private ensureOpen(): ReturnType<ContourBackend["open"]> {
    this.opening ??= this.backend.open();
    return this.opening;
  }

  private readonly protocol: AddProtocolAction = async (
    request,
    controller,
  ) => {
    const { z, x, y } = parseTileUrl(request.url);
    const bytes = await this.getTile(z, x, y, controller.signal);
    if (bytes === null) {
      return { data: new ArrayBuffer(0) };
    }
    return {
      data: bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      ) as ArrayBuffer,
    };
  };

  /**
   * One generation per tile key, shared by concurrent requesters and
   * aborted only when the last of them has gone.
   */
  private getTile(
    z: number,
    x: number,
    y: number,
    signal: AbortSignal,
  ): Promise<Uint8Array | null> {
    const key = `${z}/${x}/${y}`;
    const cached = this.cache.get(key);
    if (cached !== undefined) {
      // Refresh recency.
      this.cache.delete(key);
      this.cache.set(key, cached);
      return Promise.resolve(cached);
    }

    let entry = this.inFlight.get(key);
    if (!entry) {
      const controller = new AbortController();
      const promise = (async () => {
        await this.ensureOpen();
        const bytes = await this.backend.tile(z, x, y, controller.signal);
        this.remember(key, bytes);
        return bytes;
      })().finally(() => {
        this.inFlight.delete(key);
      });
      entry = { promise, controller, waiters: 0 };
      this.inFlight.set(key, entry);
    }
    const shared = entry;
    shared.waiters++;

    return new Promise((resolve, reject) => {
      const onAbort = (): void => {
        shared.waiters--;
        if (shared.waiters === 0) {
          shared.controller.abort();
        }
        reject(new DOMException("Contour tile aborted", "AbortError"));
      };
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
      shared.promise.then(
        (value) => {
          signal.removeEventListener("abort", onAbort);
          resolve(value);
        },
        (error) => {
          signal.removeEventListener("abort", onAbort);
          reject(error);
        },
      );
    });
  }

  private remember(key: string, bytes: Uint8Array | null): void {
    this.cache.set(key, bytes);
    while (this.cache.size > this.cacheSize) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.cache.delete(oldest);
    }
  }
}
