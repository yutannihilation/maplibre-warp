/**
 * A request/response tile cache for headless rendering.
 *
 * `TileScheduler` is built for a camera that moves every frame: it draws
 * stand-ins, prunes loads the view has left, and retries on repaint. A
 * protocol handler has none of that — it needs *exactly* the tiles that
 * cover one output tile, all of them, now — and several handlers run at
 * once, each wanting a different set. This cache dedups loads across those
 * requests, pins what a request is drawing so a concurrent request's
 * eviction cannot pull it out from under the draw, and otherwise keeps a
 * plain byte- and count-capped LRU.
 */

import type { DrawableTile } from "../tile-scheduler.js";
import { tileKey } from "../tile-scheduler.js";
import type { TileIndex } from "../tileset/types.js";
import {
  abortError,
  DEFAULT_MAX_CACHE_BYTE_SIZE,
  DEFAULT_MAX_CACHE_SIZE,
  DEFAULT_MAX_RETRIES,
  DEFAULT_RETRY_BASE_DELAY,
  sleep,
} from "../util.js";

export interface TilePayloadCacheOptions<PayloadT> {
  /** Fetch, decode and upload one tile. */
  loadTile(index: TileIndex, signal: AbortSignal): Promise<PayloadT>;
  /** Release every GPU resource the payload owns. */
  destroyTile(payload: PayloadT): void;
  /** Bytes the payload occupies, for the cache cap. */
  byteLengthOf(payload: PayloadT): number;
  /**
   * Called on every failed attempt for a reason other than abort, before the
   * retry (or the final rejection).
   */
  onTileError?(
    index: TileIndex,
    error: unknown,
    info: { attempt: number; willRetry: boolean },
  ): void;
  /** Soft cap on retained payload bytes. @default 256 MiB */
  maxCacheByteSize?: number;
  /** Soft cap on retained payloads. @default 512 */
  maxCacheSize?: number;
  /** Delay before the first retry, doubling each time. @default 1000 */
  retryBaseDelay?: number;
  /** Failed attempts allowed before a load rejects. @default 3 */
  maxRetries?: number;
}

/** Tiles handed out by {@link TilePayloadCache.acquire}. */
export interface AcquiredTiles<PayloadT> {
  /** Coarsest level first, the painter order the draw loop expects. */
  tiles: DrawableTile<PayloadT>[];
  /** Unpin the tiles; the cache may evict them afterwards. Idempotent. */
  release(): void;
}

interface Pending<PayloadT> {
  promise: Promise<PayloadT>;
  controller: AbortController;
  /** Requests awaiting this load; the load is aborted when it reaches 0. */
  waiters: number;
}

interface Entry<PayloadT> {
  readonly key: string;
  readonly index: TileIndex;
  payload?: PayloadT;
  byteLength: number;
  /** Acquire counter at last use, for LRU. */
  lastUsed: number;
  /** Requests currently holding this tile; never evicted while > 0. */
  pins: number;
  pending?: Pending<PayloadT>;
}

export class TilePayloadCache<PayloadT> {
  private readonly entries = new Map<string, Entry<PayloadT>>();
  private readonly maxCacheByteSize: number;
  private readonly maxCacheSize: number;
  private readonly retryBaseDelay: number;
  private readonly maxRetries: number;
  private tick = 0;
  private destroyed = false;

  constructor(private readonly options: TilePayloadCacheOptions<PayloadT>) {
    this.maxCacheByteSize =
      options.maxCacheByteSize ?? DEFAULT_MAX_CACHE_BYTE_SIZE;
    this.maxCacheSize = options.maxCacheSize ?? DEFAULT_MAX_CACHE_SIZE;
    this.retryBaseDelay = options.retryBaseDelay ?? DEFAULT_RETRY_BASE_DELAY;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  }

  /** Number of tiles held, loaded or in flight. */
  get size(): number {
    return this.entries.size;
  }

  /** Bytes attributed to loaded tiles. */
  get byteSize(): number {
    let total = 0;
    for (const entry of this.entries.values()) {
      total += entry.byteLength;
    }
    return total;
  }

  /**
   * Load whatever of `indices` is not yet loaded and return all of them,
   * pinned until `release()`.
   *
   * Rejects with the first tile's error once its retries are spent, or with
   * an `AbortError` when `signal` aborts; either way nothing stays pinned or
   * waited on. A load shared with another request survives this request
   * leaving; one nobody else waits for is aborted.
   */
  async acquire(
    indices: readonly TileIndex[],
    signal: AbortSignal,
  ): Promise<AcquiredTiles<PayloadT>> {
    if (this.destroyed) {
      throw new Error("TilePayloadCache has been destroyed");
    }
    if (signal.aborted) {
      throw abortError();
    }
    this.tick++;

    const held: Entry<PayloadT>[] = [];
    const awaited: Entry<PayloadT>[] = [];
    for (const index of indices) {
      const key = tileKey(index);
      let entry = this.entries.get(key);
      if (!entry) {
        entry = {
          key,
          index,
          byteLength: 0,
          lastUsed: this.tick,
          pins: 0,
        };
        this.entries.set(key, entry);
      }
      entry.pins++;
      entry.lastUsed = this.tick;
      held.push(entry);
      if (entry.payload === undefined) {
        if (entry.pending) {
          entry.pending.waiters++;
        } else {
          this.startLoad(entry);
        }
        awaited.push(entry);
      }
    }

    const unpin = (): void => {
      for (const entry of held) {
        entry.pins--;
      }
    };
    const dropWait = (): void => {
      for (const entry of awaited) {
        const { pending } = entry;
        if (!pending) {
          continue;
        }
        pending.waiters--;
        if (pending.waiters === 0) {
          pending.controller.abort();
          this.entries.delete(entry.key);
        }
      }
    };

    let released = false;
    const release = (): void => {
      if (released) {
        return;
      }
      released = true;
      unpin();
      this.evict();
    };

    try {
      await Promise.all(
        awaited.map((entry) => raceAbort(entry.pending!.promise, signal)),
      );
    } catch (error) {
      // Whether this request aborted or one of its tiles failed, it is no
      // longer waiting on anything: leave every load it shared, so one whose
      // other waiters have all gone can be aborted rather than run on for
      // nobody.
      unpin();
      dropWait();
      this.evict();
      throw signal.aborted ? abortError() : error;
    }

    if (this.destroyed) {
      unpin();
      throw new Error("TilePayloadCache was destroyed while loading");
    }

    const tiles = held
      .map(
        (entry): DrawableTile<PayloadT> => ({
          index: entry.index,
          payload: entry.payload!,
        }),
      )
      .sort((a, b) => a.index.z - b.index.z);
    return { tiles, release };
  }

  /** Abort every load in flight and free every payload. */
  destroy(): void {
    this.destroyed = true;
    for (const entry of this.entries.values()) {
      entry.pending?.controller.abort();
      if (entry.payload !== undefined) {
        this.options.destroyTile(entry.payload);
      }
    }
    this.entries.clear();
  }

  private startLoad(entry: Entry<PayloadT>): void {
    const controller = new AbortController();
    const promise = this.loadWithRetry(entry.index, controller.signal);
    const pending: Pending<PayloadT> = { promise, controller, waiters: 1 };
    entry.pending = pending;

    promise
      .then((payload) => {
        // Aborted (last waiter left) or the cache went away: nothing owns
        // this payload any more, so free it rather than leak it.
        if (
          this.destroyed ||
          this.entries.get(entry.key) !== entry ||
          entry.pending !== pending
        ) {
          this.options.destroyTile(payload);
          return;
        }
        entry.payload = payload;
        entry.byteLength = this.options.byteLengthOf(payload);
        entry.pending = undefined;
      })
      .catch(() => {
        // Waiters see the rejection through `acquire`; here only forget the
        // entry so the next request starts afresh instead of finding a
        // permanently failed tile.
        if (
          this.entries.get(entry.key) === entry &&
          entry.pending === pending
        ) {
          this.entries.delete(entry.key);
        }
      });
  }

  private async loadWithRetry(
    index: TileIndex,
    signal: AbortSignal,
  ): Promise<PayloadT> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.options.loadTile(index, signal);
      } catch (error) {
        if (signal.aborted) {
          throw error;
        }
        const willRetry = attempt <= this.maxRetries;
        this.options.onTileError?.(index, error, { attempt, willRetry });
        if (!willRetry) {
          throw error;
        }
        await sleep(this.retryBaseDelay * 2 ** (attempt - 1), signal);
        if (signal.aborted) {
          throw abortError();
        }
      }
    }
  }

  /**
   * Drop least-recently-used unpinned payloads until the cache is back under
   * its caps. Loads in flight are neither counted nor touched.
   */
  private evict(): void {
    let bytes = 0;
    let count = 0;
    for (const entry of this.entries.values()) {
      if (entry.payload === undefined) {
        continue;
      }
      count++;
      bytes += entry.byteLength;
    }
    if (bytes <= this.maxCacheByteSize && count <= this.maxCacheSize) {
      return;
    }
    const candidates = [...this.entries.values()]
      .filter((entry) => entry.payload !== undefined && entry.pins === 0)
      .sort((a, b) => a.lastUsed - b.lastUsed);
    for (const entry of candidates) {
      if (bytes <= this.maxCacheByteSize && count <= this.maxCacheSize) {
        break;
      }
      this.options.destroyTile(entry.payload!);
      bytes -= entry.byteLength;
      count--;
      this.entries.delete(entry.key);
    }
  }
}

/** `promise`, or a rejection as soon as `signal` aborts. */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(abortError());
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", onAbort);
    });
  });
}
