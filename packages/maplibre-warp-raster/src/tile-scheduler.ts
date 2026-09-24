/**
 * Tile lifecycle: selection, loading, refinement, caching and eviction.
 *
 * This replaces deck.gl's `TileLayer` + `Tileset2D`, which MapLibre gives
 * custom layers no equivalent of. The scheduler is deliberately agnostic about
 * what a tile contains — the caller supplies `loadTile`, `uploadTile` and
 * `destroyTile` — so the GPU-resource half stays in the layer.
 *
 * A tile's life is `loading` → `decoded` → `loaded`, or `error` from either
 * of the first two. The split between `decoded` and `loaded` exists because
 * fetching and decoding finish asynchronously, between frames, where a
 * MapLibre custom layer must not touch GL; the upload waits for
 * {@link TileScheduler.uploadPending}, which the layer runs from its
 * `prerender` hook inside MapLibre's GL-state bracket.
 */

import { commonSpaceFromLngLat } from "./mercator.js";
import { BoundingVolumeCache } from "./tileset/bounding-volume-cache.js";
import type { RasterTilesetDescriptor } from "./tileset/tileset-interface.js";
import { getTileIndices } from "./tileset/traversal.js";
import type { Bounds, TileIndex, ZRange } from "./tileset/types.js";
import type { RasterViewport } from "./tileset/viewport.js";

export type TileState = "loading" | "decoded" | "loaded" | "error";

/** A tile tracked by the scheduler. */
export interface SchedulerTile<DecodedT, PayloadT> {
  readonly key: string;
  readonly index: TileIndex;
  state: TileState;
  /** Present while `state === "decoded"`: fetched and decoded, awaiting upload. */
  decoded?: DecodedT;
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

export interface TileSchedulerOptions<DecodedT, PayloadT> {
  descriptor: RasterTilesetDescriptor;
  /** Dataset extent in WGS84 degrees, `[west, south, east, north]`. */
  wgs84Bounds: Bounds;
  /**
   * Fetch and decode one tile. Runs asynchronously, between frames, so it
   * must not touch GL; that is what {@link uploadTile} is for.
   */
  loadTile(index: TileIndex, signal: AbortSignal): Promise<DecodedT>;
  /**
   * Turn a decoded tile into a drawable payload: the GPU upload. Called
   * synchronously from {@link TileScheduler.uploadPending}, which the layer
   * runs inside MapLibre's custom-layer bracket, so it may leave GL state as
   * it likes. A throw fails the tile the same way a rejected load does.
   */
  uploadTile(decoded: DecodedT): PayloadT;
  /** Release every GPU resource the payload owns. */
  destroyTile(payload: PayloadT): void;
  /** Bytes the payload occupies, used for the cache cap. */
  byteLengthOf(payload: PayloadT): number;
  /**
   * Called when something has changed that the layer should redraw for: a tile
   * finished decoding and is waiting to be uploaded, or a failed tile's
   * backoff elapsed so a retry is now due.
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
   * Soft cap on retained payload bytes. Loaded tiles not needed by the current
   * frame are evicted least-recently-used-first once the cap is exceeded.
   *
   * @default 268435456 (256 MiB)
   */
  maxCacheByteSize?: number;
  /**
   * Soft cap on the number of retained settled (loaded or errored) tiles,
   * applied alongside {@link maxCacheByteSize}.
   *
   * Tiles still loading are not counted: they are bounded separately by
   * {@link maxConcurrentRequests}. Counting them here let a burst of requests
   * for a fine level push every loaded coarse tile out of the cache, which
   * then had to be re-fetched — behind that same burst — as soon as the user
   * zoomed back out.
   *
   * @default 512
   */
  maxCacheSize?: number;
  /**
   * How many loads may be in flight before loads for tiles that have left the
   * view are aborted, least-recently-wanted first.
   *
   * Requests are serviced by a small per-origin connection pool (six for
   * HTTP/1.1), in arrival order. Without pruning, tiles the view has panned
   * away from queue ahead of the ones it now needs, and the user waits
   * through all of them. Pruning only above this threshold keeps a handful of
   * just-scrolled-past loads alive, so panning back and forth does not cancel
   * and restart the same request over and over. Aborting a request that is
   * still queued in the pool costs nothing.
   *
   * A load whose tile still overlaps a selected tile is never pruned, even
   * when it is at a different level: it will be drawn as a stand-in the
   * moment it lands (see {@link MAX_STAND_IN_DEPTH}), and it is what the user
   * gets back on zooming in again. Cancelling those made a small zoom-out
   * throw away seconds of loading for tiles that were still on screen.
   *
   * @default 6
   */
  maxConcurrentRequests?: number;
  /**
   * Level-of-detail bias in zoom levels, passed through to tile selection.
   * `0` selects the coarsest level whose source pixels are no larger than one
   * framebuffer pixel; each `+1` allows source pixels twice as large, roughly
   * quartering the number of tiles fetched. Fractional values are allowed.
   *
   * @default 0
   */
  lodBias?: number;
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
  /**
   * Soft cap on the bytes {@link TileScheduler.uploadPending} uploads in one
   * frame, measured with `byteLengthOf`. Once a frame's uploads reach it the
   * rest wait for the next frame, which is requested through
   * `onNeedsRepaint`. The tile that crosses the cap is still uploaded, so
   * every frame makes progress however small the cap.
   *
   * Without a cap, a burst of tiles that finish decoding together (a fast
   * zoom over a warm HTTP cache) is uploaded in a single frame, which then
   * stalls visibly.
   *
   * @default 16777216 (16 MiB)
   */
  maxUploadBytesPerFrame?: number;
  /** Elevation range in metres, or null for a flat raster. */
  zRange?: ZRange | null;
}

/** Per-frame options for {@link TileScheduler.update}. */
export interface TileSchedulerUpdateOptions {
  /**
   * Start no new loads this frame; only draw what is already loaded, with
   * ancestor stand-ins for the rest. Loads for tiles no longer selected are
   * still pruned.
   *
   * The layer sets this while the map is zooming. Every intermediate zoom of
   * an animation selects a different level, and none of those levels is the
   * one the user will end up looking at; requesting them only delays the
   * final level. The caller must arrange a repaint once the zoom settles so
   * the deferred loads start.
   */
  suspendLoads?: boolean;
}

const DEFAULT_MAX_CACHE_BYTE_SIZE = 256 * 1024 * 1024;
const DEFAULT_MAX_CACHE_SIZE = 512;
const DEFAULT_MAX_CONCURRENT_REQUESTS = 6;
/**
 * How many levels finer than a selected tile loaded descendants may be and
 * still stand in for it while it loads. Deeper than this the tiles get too
 * numerous to look up, and too small to be worth it. The same depth bounds
 * which in-flight finer loads {@link TileScheduler.pruneLoads} keeps.
 */
export const MAX_STAND_IN_DEPTH = 2;
const DEFAULT_LOD_BIAS = 0;
const DEFAULT_RETRY_BASE_DELAY = 1000;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_MAX_UPLOAD_BYTES_PER_FRAME = 16 * 1024 * 1024;

/** A tile the layer should draw this frame, in painter order. */
export interface DrawableTile<PayloadT> {
  index: TileIndex;
  payload: PayloadT;
}

export class TileScheduler<DecodedT, PayloadT> {
  private readonly tiles = new Map<string, SchedulerTile<DecodedT, PayloadT>>();
  private readonly boundingVolumeCache = new BoundingVolumeCache();
  private readonly maxCacheByteSize: number;
  private readonly maxCacheSize: number;
  private readonly maxConcurrentRequests: number;
  private readonly lodBias: number;
  private readonly retryBaseDelay: number;
  private readonly maxRetries: number;
  private readonly maxUploadBytesPerFrame: number;
  private readonly zRange: ZRange | null;
  private readonly retryTimers = new Set<ReturnType<typeof setTimeout>>();
  /**
   * Decoded tiles awaiting upload, in the order they finished decoding, so
   * {@link uploadPending} need not scan the whole cache every frame. A
   * decoded tile leaves `tiles` only through {@link destroy}, which clears
   * this too: neither pruning nor eviction touches decoded tiles.
   */
  private readonly pendingUploads = new Set<
    SchedulerTile<DecodedT, PayloadT>
  >();
  private frame = 0;
  private destroyed = false;

  constructor(
    private readonly options: TileSchedulerOptions<DecodedT, PayloadT>,
  ) {
    this.maxCacheByteSize =
      options.maxCacheByteSize ?? DEFAULT_MAX_CACHE_BYTE_SIZE;
    this.maxCacheSize = options.maxCacheSize ?? DEFAULT_MAX_CACHE_SIZE;
    this.maxConcurrentRequests =
      options.maxConcurrentRequests ?? DEFAULT_MAX_CONCURRENT_REQUESTS;
    this.lodBias = options.lodBias ?? DEFAULT_LOD_BIAS;
    this.retryBaseDelay = options.retryBaseDelay ?? DEFAULT_RETRY_BASE_DELAY;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.maxUploadBytesPerFrame =
      options.maxUploadBytesPerFrame ?? DEFAULT_MAX_UPLOAD_BYTES_PER_FRAME;
    this.zRange = options.zRange ?? null;
  }

  /** Number of tiles currently held (in any state). */
  get size(): number {
    return this.tiles.size;
  }

  /** Number of tiles whose load is in flight. */
  get loadingCount(): number {
    let total = 0;
    for (const tile of this.tiles.values()) {
      if (tile.state === "loading") {
        total++;
      }
    }
    return total;
  }

  /** Number of tiles decoded and waiting for {@link uploadPending}. */
  get pendingUploadCount(): number {
    return this.pendingUploads.size;
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
   * loaded ancestor(s) that cover them and by any loaded descendants up to
   * {@link MAX_STAND_IN_DEPTH} levels finer, so panning and zooming never open
   * holes and a zoom-out keeps showing the detail it already has. Coarser
   * tiles are drawn first, so finer ones paint over them.
   */
  update(
    viewport: RasterViewport,
    { suspendLoads = false }: TileSchedulerUpdateOptions = {},
  ): DrawableTile<PayloadT>[] {
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
      lodBias: this.lodBias,
      boundingVolumeCache: this.boundingVolumeCache,
    });

    // Request in centre-out order. The concurrency limiter services its queue
    // in arrival order among equal priorities, so issuing centre-first is what
    // makes the middle of the screen fill in first.
    const sorted = this.sortByDistanceToCentre(selected, viewport);

    const drawing = new Map<string, DrawableTile<PayloadT>>();
    const selectedKeys = new Set<string>();
    const missing: TileIndex[] = [];

    for (const index of sorted) {
      const key = tileKey(index);
      selectedKeys.add(key);
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
      if (!suspendLoads) {
        if (!tile) {
          this.startLoad(index);
        } else if (tile.state === "error" && Date.now() >= tile.retryAt) {
          this.startLoad(index);
        }
      }
      // Everything not drawable this frame needs ancestor cover: tiles still
      // loading, tiles decoded but not yet uploaded, and errored tiles alike.
      // Skipping the last left a failed tile's footprint as a permanent hole
      // showing the basemap, even with its parent overview already loaded.
      missing.push(index);
    }

    const selectedFootprints = this.footprintsOf(sorted);

    // Prune before anything else can queue behind the stale loads.
    this.pruneLoads(selectedKeys, selectedFootprints);

    for (const index of missing) {
      for (const standIn of [
        ...this.findLoadedAncestors(index),
        ...this.findLoadedDescendants(index),
      ]) {
        const key = tileKey(standIn.index);
        if (!drawing.has(key)) {
          drawing.set(key, standIn);
        }
      }
    }

    this.protectAncestors(selectedFootprints);
    this.evict(drawing);

    // Painter order: coarse (low z) first, so finer tiles paint over the
    // stand-in ancestors.
    return [...drawing.values()].sort((a, b) => a.index.z - b.index.z);
  }

  /**
   * Upload decoded tiles in the order they finished decoding, up to
   * `maxUploadBytesPerFrame`, making them drawable from the next
   * {@link update}. Returns how many were uploaded. If any remain, asks for
   * another frame through `onNeedsRepaint`.
   *
   * The layer calls this from `prerender`, inside MapLibre's custom-layer
   * bracket, so `uploadTile` may change GL state freely. An upload that
   * throws fails its tile the way a rejected load does: it is reported
   * through `onTileError` and retried with the same backoff, and the frame
   * goes on.
   */
  uploadPending(): number {
    if (this.destroyed) {
      return 0;
    }
    let uploaded = 0;
    let bytes = 0;
    // Deleting the entry being visited is safe during Set iteration.
    for (const tile of this.pendingUploads) {
      this.pendingUploads.delete(tile);
      const decoded = tile.decoded!;
      tile.decoded = undefined;
      let payload: PayloadT;
      try {
        payload = this.options.uploadTile(decoded);
      } catch (error) {
        this.fail(tile, error);
        continue;
      }
      tile.payload = payload;
      tile.state = "loaded";
      tile.byteLength = this.options.byteLengthOf(payload);
      tile.attempts = 0;
      tile.retryAt = 0;
      uploaded++;
      bytes += tile.byteLength;
      if (bytes >= this.maxUploadBytesPerFrame) {
        break;
      }
    }
    if (this.pendingUploads.size > 0) {
      this.options.onNeedsRepaint?.();
    }
    return uploaded;
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

  /**
   * Abort every in-flight load and free every payload. Decoded tiles awaiting
   * upload hold no GPU resources and are simply dropped.
   */
  destroy(): void {
    this.destroyed = true;
    for (const timer of this.retryTimers) {
      clearTimeout(timer);
    }
    this.retryTimers.clear();
    this.pendingUploads.clear();
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
   * Order tiles by the distance from their centre to the map centre, both in
   * common space.
   *
   * Deliberately the map centre rather than the middle of `getBounds()`: under
   * globe MapLibre widens those bounds to the whole world as soon as a pole is
   * on screen, which would put the ordering centre at lng 0 and fill the
   * screen in from the wrong side.
   *
   * The traversal has just populated `boundingVolumeCache` for every tile it
   * visited, so the centres are free. A tile missing from the cache sorts last.
   */
  private sortByDistanceToCentre(
    indices: TileIndex[],
    viewport: RasterViewport,
  ): TileIndex[] {
    const [centreX, centreY] = commonSpaceFromLngLat(...viewport.center);

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
    const tile: SchedulerTile<DecodedT, PayloadT> = this.tiles.get(key) ?? {
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
      .then((decoded) => {
        // Pruned or evicted while in flight, superseded by a retry, or the
        // whole scheduler went away: drop the result. Nothing to release —
        // a decoded tile holds no GPU resources yet.
        if (
          this.destroyed ||
          this.tiles.get(key) !== tile ||
          tile.controller !== controller
        ) {
          return;
        }
        tile.decoded = decoded;
        tile.state = "decoded";
        tile.lastUsed = this.frame;
        this.pendingUploads.add(tile);
        // Drawing it takes a frame: the layer's `prerender` uploads it.
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
        this.fail(tile, error);
      });
  }

  /**
   * Record a failed attempt — a rejected load or a throwing upload — and
   * schedule the retry, or give up once the budget is spent.
   */
  private fail(tile: SchedulerTile<DecodedT, PayloadT>, error: unknown): void {
    tile.state = "error";
    tile.attempts++;
    const willRetry = tile.attempts <= this.maxRetries;
    const delay = this.retryBaseDelay * 2 ** (tile.attempts - 1);
    tile.retryAt = willRetry ? Date.now() + delay : Number.POSITIVE_INFINITY;
    if (willRetry) {
      this.scheduleRetryRepaint(delay);
    }
    this.options.onTileError?.(tile.index, error, {
      attempt: tile.attempts,
      willRetry,
    });
  }

  /**
   * Abort in-flight loads for tiles that have left the view, least recently
   * wanted first, until no more than `maxConcurrentRequests` loads remain in
   * flight or every such load is gone.
   *
   * A load is kept — however many are in flight — if its tile is selected, or
   * if it overlaps a selected tile and is coarser than it or at most
   * {@link MAX_STAND_IN_DEPTH} levels finer: those are the tiles that will be
   * drawn as stand-ins when they land. Everything else has scrolled off
   * screen.
   *
   * Pruned entries are removed immediately rather than waiting for the
   * rejection to arrive, so a tile that is reselected next frame is requested
   * afresh instead of being taken for still-loading.
   */
  private pruneLoads(
    selectedKeys: Set<string>,
    selectedFootprints: Footprint[],
  ): void {
    let inFlight = 0;
    const candidates: SchedulerTile<DecodedT, PayloadT>[] = [];
    for (const tile of this.tiles.values()) {
      if (tile.state !== "loading") {
        continue;
      }
      inFlight++;
      if (
        !selectedKeys.has(tile.key) &&
        !this.overlapsSelection(tile.index, selectedFootprints)
      ) {
        candidates.push(tile);
      }
    }
    if (inFlight <= this.maxConcurrentRequests) {
      return;
    }
    candidates.sort((a, b) => a.lastUsed - b.lastUsed);
    for (const tile of candidates) {
      if (inFlight <= this.maxConcurrentRequests) {
        break;
      }
      tile.controller.abort();
      this.tiles.delete(tile.key);
      inFlight--;
    }
  }

  /** This tile's extent in the source CRS, as an axis-aligned box. */
  private crsBoundsOf(index: TileIndex): Bounds | null {
    const level = this.options.descriptor.levels[index.z];
    if (!level) {
      return null;
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
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  }

  /**
   * The loaded tiles at level `z` whose extent overlaps `bounds`, each touched
   * as used this frame.
   *
   * The pyramid is a stack of independent grids rather than a quadtree, so
   * "the parent" is a set of overlapping tiles, not a single index.
   */
  private loadedTilesCovering(
    bounds: Bounds,
    z: number,
  ): DrawableTile<PayloadT>[] {
    const level = this.options.descriptor.levels[z];
    if (!level) {
      return [];
    }
    const { minCol, maxCol, minRow, maxRow } = level.crsBoundsToTileRange(
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
    return found;
  }

  /** Source-CRS footprints of `indices`, skipping any at an unknown level. */
  private footprintsOf(indices: TileIndex[]): Footprint[] {
    const footprints: Footprint[] = [];
    for (const index of indices) {
      const bounds = this.crsBoundsOf(index);
      if (bounds) {
        footprints.push({ z: index.z, bounds });
      }
    }
    return footprints;
  }

  /**
   * Whether `index` overlaps a selected tile that it could stand in for: one
   * it is coarser than, or finer than by at most {@link MAX_STAND_IN_DEPTH}.
   */
  private overlapsSelection(
    index: TileIndex,
    selectedFootprints: Footprint[],
  ): boolean {
    const bounds = this.crsBoundsOf(index);
    if (!bounds) {
      return false;
    }
    for (const selected of selectedFootprints) {
      if (
        index.z - selected.z <= MAX_STAND_IN_DEPTH &&
        boundsOverlap(bounds, selected.bounds)
      ) {
        return true;
      }
    }
    return false;
  }

  /**
   * Find the loaded tiles at the nearest finer level that overlap `index`,
   * walking down to {@link MAX_STAND_IN_DEPTH} levels until one yields any.
   *
   * These are what keeps a zoom-out looking sharp: the detail already on
   * screen stays up until the coarser tile that replaces it has arrived,
   * rather than dropping to whatever ancestor happens to be cached.
   */
  private findLoadedDescendants(index: TileIndex): DrawableTile<PayloadT>[] {
    const bounds = this.crsBoundsOf(index);
    if (!bounds) {
      return [];
    }
    const maxZ = this.options.descriptor.levels.length - 1;
    const deepest = Math.min(index.z + MAX_STAND_IN_DEPTH, maxZ);
    for (let z = index.z + 1; z <= deepest; z++) {
      const found = this.loadedTilesCovering(bounds, z);
      if (found.length > 0) {
        return found;
      }
    }
    return [];
  }

  /**
   * Find the loaded tiles at the nearest coarser level that cover `index`,
   * walking coarser until a level yields at least one.
   */
  private findLoadedAncestors(index: TileIndex): DrawableTile<PayloadT>[] {
    const bounds = this.crsBoundsOf(index);
    if (!bounds) {
      return [];
    }
    for (let z = index.z - 1; z >= 0; z--) {
      const found = this.loadedTilesCovering(bounds, z);
      if (found.length > 0) {
        return found;
      }
    }
    return [];
  }

  /**
   * Mark every loaded ancestor of every selected tile, at every coarser level,
   * as used this frame so eviction leaves them alone.
   *
   * With a fine level fully loaded, its ancestors are not drawn and would
   * otherwise be the least recently used tiles in the cache — the first to go
   * when the cap bites. They are exactly the tiles the next zoom-out draws,
   * and they cost little to keep.
   */
  private protectAncestors(selectedFootprints: Footprint[]): void {
    for (const { z: selectedZ, bounds } of selectedFootprints) {
      for (let z = selectedZ - 1; z >= 0; z--) {
        this.loadedTilesCovering(bounds, z);
      }
    }
  }

  /**
   * Drop least-recently-used settled tiles until the cache is back under its
   * caps.
   *
   * Tiles this frame touched — drawn, selected, or an ancestor of a selected
   * tile — are never evicted. Loads in flight are neither counted nor evicted
   * here; {@link pruneLoads} bounds them. Nor are decoded tiles awaiting
   * upload: they hold no GPU memory yet, and the next frame's
   * {@link uploadPending} settles them.
   */
  private evict(inUse: Map<string, DrawableTile<PayloadT>>): void {
    let bytes = 0;
    let count = 0;
    for (const tile of this.tiles.values()) {
      if (!isSettled(tile)) {
        continue;
      }
      count++;
      bytes += tile.byteLength;
    }
    if (bytes <= this.maxCacheByteSize && count <= this.maxCacheSize) {
      return;
    }

    const candidates = [...this.tiles.values()]
      .filter(
        (tile) =>
          isSettled(tile) &&
          !inUse.has(tile.key) &&
          tile.lastUsed !== this.frame,
      )
      .sort((a, b) => a.lastUsed - b.lastUsed);

    for (const tile of candidates) {
      if (bytes <= this.maxCacheByteSize && count <= this.maxCacheSize) {
        break;
      }
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

/** Whether a tile has reached a resting state: loaded, or errored. */
function isSettled(tile: SchedulerTile<unknown, unknown>): boolean {
  return tile.state === "loaded" || tile.state === "error";
}

/** A tile's level and its extent in the source CRS. */
interface Footprint {
  z: number;
  bounds: Bounds;
}

/** Whether two `[minX, minY, maxX, maxY]` boxes share any interior. */
function boundsOverlap(a: Bounds, b: Bounds): boolean {
  return a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];
}
