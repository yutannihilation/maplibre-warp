/**
 * Tile lifecycle: selection, loading, refinement, caching and eviction.
 *
 * This replaces deck.gl's `TileLayer` + `Tileset2D`, which MapLibre gives
 * custom layers no equivalent of. The scheduler is deliberately agnostic about
 * what a "loaded tile" contains — the caller supplies `loadTile` and
 * `destroyTile` — so the GPU-resource half stays in the layer.
 */

import { commonSpaceFromLngLat } from "./mercator.js";
import { BoundingVolumeCache } from "./tileset/bounding-volume-cache.js";
import type { RasterTilesetDescriptor } from "./tileset/tileset-interface.js";
import { getTileIndices } from "./tileset/traversal.js";
import type { Bounds, TileIndex, ZRange } from "./tileset/types.js";
import type { RasterViewport } from "./tileset/viewport.js";

export type TileState = "loading" | "loaded" | "error";

/** A tile tracked by the scheduler. */
export interface SchedulerTile<PayloadT> {
  readonly key: string;
  readonly index: TileIndex;
  state: TileState;
  /** Present once `state === "loaded"`. */
  payload?: PayloadT;
  /** Bytes attributed to this tile for the cache cap. */
  byteLength: number;
  /** Frame counter at last use, for LRU. */
  lastUsed: number;
  /**
   * The controller for the *current* attempt. Replaced on each retry, so a
   * settled promise from a superseded attempt can be recognised and ignored.
   */
  controller: AbortController;
  /** Failed attempts so far. Reset to 0 once the tile loads. */
  attempts: number;
  /**
   * Epoch milliseconds after which an errored tile may be retried.
   * `Infinity` once the retry budget is spent.
   */
  retryAt: number;
}

export interface TileSchedulerOptions<PayloadT> {
  descriptor: RasterTilesetDescriptor;
  /** Dataset extent in WGS84 degrees, `[west, south, east, north]`. */
  wgs84Bounds: Bounds;
  /** Fetch, decode and upload one tile. */
  loadTile(index: TileIndex, signal: AbortSignal): Promise<PayloadT>;
  /** Release every GPU resource the payload owns. */
  destroyTile(payload: PayloadT): void;
  /** Bytes the payload occupies, used for the cache cap. */
  byteLengthOf(payload: PayloadT): number;
  /**
   * Called when something has changed that the layer should redraw for: a tile
   * finished loading, or a failed tile's backoff elapsed so a retry is now due.
   *
   * The retry case matters because retries are driven by {@link update}, which
   * the layer only calls while repainting. Without this nudge a view whose
   * tiles all failed would never repaint, so it would never retry and the
   * failure would look permanent.
   */
  onNeedsRepaint?(): void;
  /**
   * Called when a tile fails for a reason other than abort, on every failed
   * attempt. `willRetry` distinguishes a transient failure that will be tried
   * again from the final one, so callers can log at the right level instead of
   * treating a blip as fatal.
   */
  onTileError?(
    index: TileIndex,
    error: unknown,
    info: { attempt: number; willRetry: boolean },
  ): void;
  /**
   * Soft cap on retained payload bytes. Tiles not needed by the current frame
   * are evicted least-recently-used-first once the cap is exceeded.
   *
   * @default 268435456 (256 MiB)
   */
  maxCacheByteSize?: number;
  /**
   * Soft cap on the number of retained tiles, applied alongside
   * {@link maxCacheByteSize}.
   *
   * Both caps are needed: a tile that is still loading holds no payload bytes
   * yet, so a byte-only cap would never evict — and therefore never abort —
   * requests for tiles the view has long since left behind.
   *
   * @default 512
   */
  maxCacheSize?: number;
  /**
   * Delay before the first retry of a failed tile, in milliseconds. Each
   * further failure doubles it.
   *
   * @default 1000
   */
  retryBaseDelay?: number;
  /**
   * How many times to retry a failed tile before giving up on it.
   *
   * Retries matter because a tile that stays errored is never re-requested,
   * so a single transient failure would otherwise leave that footprint
   * permanently missing. The backoff keeps a struggling server from being
   * hammered once per frame by every failing tile.
   *
   * @default 3
   */
  maxRetries?: number;
  /** Elevation range in metres, or null for a flat raster. */
  zRange?: ZRange | null;
}

const DEFAULT_MAX_CACHE_BYTE_SIZE = 256 * 1024 * 1024;
const DEFAULT_MAX_CACHE_SIZE = 512;
const DEFAULT_RETRY_BASE_DELAY = 1000;
const DEFAULT_MAX_RETRIES = 3;

/** A tile the layer should draw this frame, in painter order. */
export interface DrawableTile<PayloadT> {
  index: TileIndex;
  payload: PayloadT;
}

export class TileScheduler<PayloadT> {
  private readonly tiles = new Map<string, SchedulerTile<PayloadT>>();
  private readonly boundingVolumeCache = new BoundingVolumeCache();
  private readonly maxCacheByteSize: number;
  private readonly maxCacheSize: number;
  private readonly retryBaseDelay: number;
  private readonly maxRetries: number;
  private readonly zRange: ZRange | null;
  private readonly retryTimers = new Set<ReturnType<typeof setTimeout>>();
  private frame = 0;
  private destroyed = false;

  constructor(private readonly options: TileSchedulerOptions<PayloadT>) {
    this.maxCacheByteSize =
      options.maxCacheByteSize ?? DEFAULT_MAX_CACHE_BYTE_SIZE;
    this.maxCacheSize = options.maxCacheSize ?? DEFAULT_MAX_CACHE_SIZE;
    this.retryBaseDelay = options.retryBaseDelay ?? DEFAULT_RETRY_BASE_DELAY;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.zRange = options.zRange ?? null;
  }

  /** Number of tiles currently held (in any state). */
  get size(): number {
    return this.tiles.size;
  }

  /** Bytes currently attributed to loaded tiles. */
  get byteSize(): number {
    let total = 0;
    for (const tile of this.tiles.values()) {
      total += tile.byteLength;
    }
    return total;
  }

  /**
   * Run selection for this frame: start any missing loads, then return the
   * tiles to draw, coarsest first.
   *
   * Tiles that are selected but not yet loaded are stood in for by the nearest
   * loaded ancestor(s) that cover them, so panning and zooming never open
   * holes. Ancestors are drawn before finer tiles, which then paint over them.
   */
  update(viewport: RasterViewport): DrawableTile<PayloadT>[] {
    if (this.destroyed) {
      return [];
    }
    this.frame++;

    const { descriptor, wgs84Bounds } = this.options;
    const selected = getTileIndices(descriptor, {
      viewport,
      maxZ: descriptor.levels.length - 1,
      zRange: this.zRange,
      wgs84Bounds,
      boundingVolumeCache: this.boundingVolumeCache,
    });

    // Request in centre-out order. The concurrency limiter services its queue
    // in arrival order among equal priorities, so issuing centre-first is what
    // makes the middle of the screen fill in first.
    const sorted = this.sortByDistanceToCentre(selected, viewport);

    const drawing = new Map<string, DrawableTile<PayloadT>>();
    const missing: TileIndex[] = [];

    for (const index of sorted) {
      const key = tileKey(index);
      const tile = this.tiles.get(key);
      if (tile) {
        // Touch every selected tile, loaded or not, so eviction never drops
        // one this frame still wants.
        tile.lastUsed = this.frame;
      }
      if (tile?.state === "loaded" && tile.payload !== undefined) {
        drawing.set(key, { index, payload: tile.payload });
        continue;
      }
      if (!tile) {
        this.startLoad(index);
      } else if (tile.state === "error" && Date.now() >= tile.retryAt) {
        this.startLoad(index);
      }
      // Everything not drawable this frame needs ancestor cover, errored tiles
      // included. Skipping them left a failed tile's footprint as a permanent
      // hole showing the basemap, even with its parent overview already loaded.
      missing.push(index);
    }

    for (const index of missing) {
      for (const ancestor of this.findLoadedAncestors(index)) {
        const key = tileKey(ancestor.index);
        if (!drawing.has(key)) {
          drawing.set(key, ancestor);
        }
      }
    }

    this.evict(drawing);

    // Painter order: coarse (low z) first, so finer tiles paint over the
    // stand-in ancestors.
    return [...drawing.values()].sort((a, b) => a.index.z - b.index.z);
  }

  /**
   * Ask the layer to repaint once `delay` has passed, so the retry this frame
   * scheduled actually gets a chance to run.
   */
  private scheduleRetryRepaint(delay: number): void {
    const timer = setTimeout(() => {
      this.retryTimers.delete(timer);
      if (!this.destroyed) {
        this.options.onNeedsRepaint?.();
      }
    }, delay);
    this.retryTimers.add(timer);
  }

  /** Abort every in-flight load and free every payload. */
  destroy(): void {
    this.destroyed = true;
    for (const timer of this.retryTimers) {
      clearTimeout(timer);
    }
    this.retryTimers.clear();
    for (const tile of this.tiles.values()) {
      tile.controller.abort();
      if (tile.payload !== undefined) {
        this.options.destroyTile(tile.payload);
      }
    }
    this.tiles.clear();
    this.boundingVolumeCache.clear();
  }

  /**
   * Order tiles by the distance from their centre to the centre of the visible
   * extent, both in common space.
   *
   * The traversal has just populated `boundingVolumeCache` for every tile it
   * visited, so the centres are free. A tile missing from the cache sorts last.
   */
  private sortByDistanceToCentre(
    indices: TileIndex[],
    viewport: RasterViewport,
  ): TileIndex[] {
    const [west, south, east, north] = viewport.getBounds();
    const [centreX, centreY] = commonSpaceFromLngLat(
      (west + east) / 2,
      (south + north) / 2,
    );

    const distance = (index: TileIndex): number => {
      const entry = this.boundingVolumeCache.get(index.z, index.x, index.y);
      if (!entry) {
        return Number.POSITIVE_INFINITY;
      }
      const [minX, minY, maxX, maxY] = entry.commonSpaceBounds;
      const dx = (minX + maxX) / 2 - centreX;
      const dy = (minY + maxY) / 2 - centreY;
      return dx * dx + dy * dy;
    };

    return [...indices].sort((a, b) => distance(a) - distance(b));
  }

  /**
   * Start, or retry, the load for one tile.
   *
   * A retry reuses the existing entry so the attempt count and backoff survive
   * across attempts.
   */
  private startLoad(index: TileIndex): void {
    const key = tileKey(index);
    const controller = new AbortController();
    const tile: SchedulerTile<PayloadT> = this.tiles.get(key) ?? {
      key,
      index,
      state: "loading",
      byteLength: 0,
      lastUsed: this.frame,
      controller,
      attempts: 0,
      retryAt: 0,
    };
    tile.state = "loading";
    tile.controller = controller;
    tile.lastUsed = this.frame;
    this.tiles.set(key, tile);

    this.options
      .loadTile(index, controller.signal)
      .then((payload) => {
        // Evicted while in flight, superseded by a retry, or the whole
        // scheduler went away: drop the result rather than leaking it.
        if (
          this.destroyed ||
          this.tiles.get(key) !== tile ||
          tile.controller !== controller
        ) {
          this.options.destroyTile(payload);
          return;
        }
        tile.payload = payload;
        tile.state = "loaded";
        tile.byteLength = this.options.byteLengthOf(payload);
        tile.lastUsed = this.frame;
        tile.attempts = 0;
        tile.retryAt = 0;
        this.options.onNeedsRepaint?.();
      })
      .catch((error: unknown) => {
        // The entry may already have been replaced, or this attempt superseded
        // by a retry; never clobber the newer one.
        if (this.tiles.get(key) !== tile || tile.controller !== controller) {
          return;
        }
        if (controller.signal.aborted) {
          this.tiles.delete(key);
          return;
        }
        tile.state = "error";
        tile.attempts++;
        const willRetry = tile.attempts <= this.maxRetries;
        const delay = this.retryBaseDelay * 2 ** (tile.attempts - 1);
        tile.retryAt = willRetry
          ? Date.now() + delay
          : Number.POSITIVE_INFINITY;
        if (willRetry) {
          this.scheduleRetryRepaint(delay);
        }
        this.options.onTileError?.(index, error, {
          attempt: tile.attempts,
          willRetry,
        });
      });
  }

  /**
   * Find the loaded tiles at the nearest coarser level that cover `index`.
   *
   * The pyramid is a stack of independent grids rather than a quadtree, so
   * "the parent" is the set of tiles at level z−1 whose extent overlaps this
   * tile's source-CRS bounds. We walk coarser until a level yields at least one
   * loaded covering tile.
   */
  private findLoadedAncestors(index: TileIndex): DrawableTile<PayloadT>[] {
    const { levels } = this.options.descriptor;
    const level = levels[index.z];
    if (!level) {
      return [];
    }
    const corners = level.projectedTileCorners(index.x, index.y);
    const xs = [
      corners.topLeft[0],
      corners.topRight[0],
      corners.bottomLeft[0],
      corners.bottomRight[0],
    ];
    const ys = [
      corners.topLeft[1],
      corners.topRight[1],
      corners.bottomLeft[1],
      corners.bottomRight[1],
    ];
    const bounds: Bounds = [
      Math.min(...xs),
      Math.min(...ys),
      Math.max(...xs),
      Math.max(...ys),
    ];

    for (let z = index.z - 1; z >= 0; z--) {
      const coarser = levels[z];
      if (!coarser) {
        continue;
      }
      const { minCol, maxCol, minRow, maxRow } = coarser.crsBoundsToTileRange(
        ...bounds,
      );
      const found: DrawableTile<PayloadT>[] = [];
      for (let y = minRow; y <= maxRow; y++) {
        for (let x = minCol; x <= maxCol; x++) {
          const tile = this.tiles.get(tileKey({ x, y, z }));
          if (tile?.state === "loaded" && tile.payload !== undefined) {
            tile.lastUsed = this.frame;
            found.push({ index: { x, y, z }, payload: tile.payload });
          }
        }
      }
      if (found.length > 0) {
        return found;
      }
    }
    return [];
  }

  /**
   * Drop least-recently-used tiles until the cache is back under its cap.
   *
   * Tiles this frame touched — drawn, or selected and still loading — are
   * never evicted. Evicting a tile that is still loading aborts its request,
   * which is the only place we abort: a tile that merely scrolled out of view
   * keeps loading, because a user panning back and forth would otherwise
   * cancel and restart the same request over and over.
   */
  private evict(inUse: Map<string, DrawableTile<PayloadT>>): void {
    let bytes = this.byteSize;
    let count = this.tiles.size;
    if (bytes <= this.maxCacheByteSize && count <= this.maxCacheSize) {
      return;
    }

    const candidates = [...this.tiles.values()]
      .filter((tile) => !inUse.has(tile.key) && tile.lastUsed !== this.frame)
      .sort((a, b) => a.lastUsed - b.lastUsed);

    for (const tile of candidates) {
      if (bytes <= this.maxCacheByteSize && count <= this.maxCacheSize) {
        break;
      }
      tile.controller.abort();
      if (tile.payload !== undefined) {
        this.options.destroyTile(tile.payload);
      }
      bytes -= tile.byteLength;
      count--;
      this.tiles.delete(tile.key);
    }
  }
}

export function tileKey({ x, y, z }: TileIndex): string {
  return `${z}/${x}/${y}`;
}
