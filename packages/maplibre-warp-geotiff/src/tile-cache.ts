/**
 * LRU cache of decoded tiles, shared by every tile load of one layer.
 *
 * Stitching a halo needs a tile's eight neighbours, and the geotiff library
 * caches header blocks but never decoded tile data. Without this cache each
 * displayed tile would cost nine fetches and decodes; with it, a tile that
 * is both displayed and a neighbour is decoded once.
 *
 * Tiles missing from the cache are requested in one `fetchTiles` call so the
 * library can coalesce their byte ranges. That call is all-or-nothing, so
 * when it fails for any reason other than abort the tiles are re-requested
 * one by one: a sparse or corrupt tile then fails only its own entry. A
 * pending fetch is aborted only when every consumer waiting on it has
 * aborted, and its entries leave the cache at that moment.
 */

import type { DecoderPool, GeoTIFF, Tile } from "@developmentseed/geotiff";
import { abortError } from "./geotiff-utils.js";

/** The part of `GeoTIFF` / `Overview` the cache needs. */
export type TileSource = Pick<GeoTIFF, "fetchTile" | "fetchTiles">;

interface Batch {
  controller: AbortController;
  entries: Entry[];
}

interface Entry {
  key: string;
  promise: Promise<Tile>;
  /** Set once resolved. */
  tile?: Tile;
  bytes: number;
  /** Consumers currently awaiting this entry. */
  waiters: number;
  /** The fetch this entry belongs to, until it settles. */
  batch?: Batch;
}

/** Decoded size of a tile, for the byte budget. */
export function tileByteLength(tile: Tile): number {
  const { array } = tile;
  let bytes = array.mask?.byteLength ?? 0;
  if (array.layout === "pixel-interleaved") {
    bytes += array.data.byteLength;
  } else {
    for (const band of array.bands) {
      bytes += band.byteLength;
    }
  }
  return bytes;
}

export const DEFAULT_TILE_CACHE_BYTES = 64 * 1024 * 1024;

export class DecodedTileCache {
  /** Insertion order is LRU order: `touch` re-inserts. */
  private readonly entries = new Map<string, Entry>();
  private readonly sourceIds = new WeakMap<TileSource, number>();
  private nextSourceId = 0;
  private resolvedBytes = 0;

  constructor(private readonly maxBytes = DEFAULT_TILE_CACHE_BYTES) {
    if (!(maxBytes >= 0)) {
      throw new RangeError(`maxBytes must be non-negative, got ${maxBytes}`);
    }
  }

  /** Decoded bytes held by resolved entries. */
  get byteLength(): number {
    return this.resolvedBytes;
  }

  get size(): number {
    return this.entries.size;
  }

  /**
   * The tiles at `xy` from `source`, in order, each settled on its own so
   * one tile's failure leaves the others usable. Rejects with an `AbortError`
   * as soon as `signal` aborts; the underlying fetch keeps going while any
   * other consumer still wants it.
   */
  getTiles(
    source: TileSource,
    xy: ReadonlyArray<readonly [number, number]>,
    options: { pool?: DecoderPool; signal?: AbortSignal } = {},
  ): Promise<PromiseSettledResult<Tile>[]> {
    const { pool, signal } = options;
    if (signal?.aborted) {
      return Promise.reject(abortError());
    }
    const prefix = this.sourceId(source);
    const requests = xy.map(([x, y]) => ({ key: `${prefix}/${x}/${y}`, x, y }));

    const missing = requests.filter(({ key }) => !this.entries.has(key));
    if (missing.length > 0) {
      this.fetchBatch(source, missing, pool);
    }

    const held = requests.map(({ key }) => {
      const entry = this.entries.get(key)!;
      entry.waiters++;
      this.touch(entry);
      return entry;
    });

    let released = false;
    const release = (): void => {
      if (released) {
        return;
      }
      released = true;
      for (const entry of held) {
        this.unhold(entry);
      }
      this.evict();
    };

    const all = Promise.allSettled(held.map((entry) => entry.promise));
    if (!signal) {
      return all.finally(release);
    }
    return new Promise<PromiseSettledResult<Tile>[]>((resolve, reject) => {
      const onAbort = (): void => {
        release();
        reject(abortError());
      };
      signal.addEventListener("abort", onAbort, { once: true });
      all.then(resolve, reject).finally(() => {
        signal.removeEventListener("abort", onAbort);
        release();
      });
    });
  }

  /** Drop every entry and abort every pending fetch. */
  clear(): void {
    for (const entry of this.entries.values()) {
      entry.batch?.controller.abort();
    }
    this.entries.clear();
    this.resolvedBytes = 0;
  }

  private sourceId(source: TileSource): number {
    let id = this.sourceIds.get(source);
    if (id === undefined) {
      id = this.nextSourceId++;
      this.sourceIds.set(source, id);
    }
    return id;
  }

  private fetchBatch(
    source: TileSource,
    requests: ReadonlyArray<{ key: string; x: number; y: number }>,
    pool: DecoderPool | undefined,
  ): void {
    const batch: Batch = { controller: new AbortController(), entries: [] };
    const { signal } = batch.controller;
    const fetchOptions = { boundless: false, pool, signal };
    const xy = requests.map(({ x, y }): [number, number] => [x, y]);
    // One failing tile rejects the whole batched call. Fall back to single
    // fetches so each entry settles on its own; a lone tile has nothing to
    // fall back to.
    const batched: Promise<Tile[] | null> = source
      .fetchTiles(xy, fetchOptions)
      .catch((error: unknown) => {
        if (signal.aborted || xy.length === 1) {
          throw error;
        }
        return null;
      });
    requests.forEach(({ key, x, y }, i) => {
      const entry: Entry = {
        key,
        promise: batched.then((tiles) => {
          if (tiles === null) {
            return source.fetchTile(x, y, fetchOptions);
          }
          const tile = tiles[i];
          if (!tile) {
            throw new Error(`fetchTiles returned no tile at index ${i}`);
          }
          return tile;
        }),
        bytes: 0,
        waiters: 0,
        batch,
      };
      batch.entries.push(entry);
      entry.promise.then(
        (tile) => {
          entry.batch = undefined;
          if (this.entries.get(key) !== entry) {
            return; // cleared or aborted while in flight
          }
          entry.tile = tile;
          entry.bytes = tileByteLength(tile);
          this.resolvedBytes += entry.bytes;
          this.evict();
        },
        () => {
          entry.batch = undefined;
          if (this.entries.get(key) === entry) {
            this.entries.delete(key);
          }
        },
      );
      this.entries.set(key, entry);
    });
  }

  /**
   * Release one consumer's hold. When no consumer awaits any pending entry
   * of a batch, the fetch has no one left to serve: abort it and drop its
   * pending entries at once, so a later request refetches instead of joining
   * a doomed entry.
   */
  private unhold(entry: Entry): void {
    entry.waiters--;
    const batch = entry.batch;
    if (
      !batch ||
      batch.entries.some((e) => e.batch === batch && e.waiters > 0)
    ) {
      return;
    }
    batch.controller.abort();
    for (const pending of batch.entries) {
      if (
        pending.batch === batch &&
        this.entries.get(pending.key) === pending
      ) {
        this.entries.delete(pending.key);
      }
    }
  }

  private touch(entry: Entry): void {
    this.entries.delete(entry.key);
    this.entries.set(entry.key, entry);
  }

  /** Drop least-recently-used resolved, unwaited entries over the budget. */
  private evict(): void {
    if (this.resolvedBytes <= this.maxBytes) {
      return;
    }
    for (const entry of this.entries.values()) {
      if (this.resolvedBytes <= this.maxBytes) {
        break;
      }
      if (entry.tile && entry.waiters === 0) {
        this.entries.delete(entry.key);
        this.resolvedBytes -= entry.bytes;
      }
    }
  }
}
