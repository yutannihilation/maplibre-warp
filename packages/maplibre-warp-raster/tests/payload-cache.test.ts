import { afterEach, describe, expect, it, vi } from "vitest";

import { TilePayloadCache } from "../src/headless/payload-cache.js";
import type { TileIndex } from "../src/tileset/types.js";

interface Payload {
  key: string;
  bytes: number;
}

/** A loader whose promises are resolved by the test. */
function deferredLoader() {
  const pending = new Map<
    string,
    { resolve(p: Payload): void; reject(e: unknown): void; signal: AbortSignal }
  >();
  const calls: string[] = [];
  const loadTile = (index: TileIndex, signal: AbortSignal): Promise<Payload> =>
    new Promise((resolve, reject) => {
      const key = `${index.z}/${index.x}/${index.y}`;
      calls.push(key);
      pending.set(key, { resolve, reject, signal });
    });
  const settle = (key: string, bytes = 1): void => {
    pending.get(key)!.resolve({ key, bytes });
    pending.delete(key);
  };
  return { loadTile, pending, calls, settle };
}

const destroyed: string[] = [];
const options = {
  destroyTile: (p: Payload) => {
    destroyed.push(p.key);
  },
  byteLengthOf: (p: Payload) => p.bytes,
  retryBaseDelay: 10,
};

afterEach(() => {
  destroyed.length = 0;
  vi.useRealTimers();
});

const t = (z: number, x: number, y: number): TileIndex => ({ z, x, y });

describe("TilePayloadCache.acquire", () => {
  it("loads each tile once however many requests want it", async () => {
    const loader = deferredLoader();
    const cache = new TilePayloadCache({ ...options, ...loader });
    const a = cache.acquire(
      [t(1, 0, 0), t(1, 1, 0)],
      new AbortController().signal,
    );
    const b = cache.acquire(
      [t(1, 1, 0), t(0, 0, 0)],
      new AbortController().signal,
    );
    expect(loader.calls).toEqual(["1/0/0", "1/1/0", "0/0/0"]);
    loader.settle("1/0/0");
    loader.settle("1/1/0");
    loader.settle("0/0/0");
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra.tiles.map((d) => d.payload.key)).toEqual(["1/0/0", "1/1/0"]);
    // Coarsest first, whatever the request order.
    expect(rb.tiles.map((d) => d.payload.key)).toEqual(["0/0/0", "1/1/0"]);
    expect(cache.size).toBe(3);
  });

  it("never evicts a pinned tile, and evicts LRU once released", async () => {
    const loader = deferredLoader();
    const cache = new TilePayloadCache({
      ...options,
      ...loader,
      maxCacheSize: 1,
    });
    const first = cache.acquire([t(0, 0, 0)], new AbortController().signal);
    loader.settle("0/0/0");
    const held = await first;

    const second = cache.acquire([t(1, 0, 0)], new AbortController().signal);
    loader.settle("1/0/0");
    const other = await second;
    // Both over the cap, both pinned: nothing can go.
    other.release();
    expect(destroyed).toEqual(["1/0/0"]);
    expect(cache.size).toBe(1);

    held.release();
    held.release(); // idempotent
    expect(cache.size).toBe(1); // under the cap, nothing more to evict
  });

  it("retries with backoff and rejects after the budget", async () => {
    vi.useFakeTimers();
    const errors: number[] = [];
    let attempts = 0;
    const cache = new TilePayloadCache<Payload>({
      ...options,
      maxRetries: 2,
      loadTile: () => {
        attempts++;
        return Promise.reject(new Error(`boom ${attempts}`));
      },
      onTileError: (_index, _error, { attempt }) => {
        errors.push(attempt);
      },
    });
    const promise = cache.acquire([t(0, 0, 0)], new AbortController().signal);
    const outcome = promise.then(
      () => "resolved",
      (e: Error) => e.message,
    );
    await vi.advanceTimersByTimeAsync(10 + 20);
    expect(await outcome).toBe("boom 3");
    expect(errors).toEqual([1, 2, 3]);
    // Forgotten, so the next request starts afresh.
    expect(cache.size).toBe(0);
  });

  it("aborts a load only when its last waiter leaves", async () => {
    const loader = deferredLoader();
    const cache = new TilePayloadCache({ ...options, ...loader });
    const ca = new AbortController();
    const cb = new AbortController();
    const a = cache.acquire([t(0, 0, 0)], ca.signal);
    const b = cache.acquire([t(0, 0, 0)], cb.signal);
    ca.abort();
    await expect(a).rejects.toMatchObject({ name: "AbortError" });
    expect(loader.pending.get("0/0/0")!.signal.aborted).toBe(false);
    cb.abort();
    await expect(b).rejects.toMatchObject({ name: "AbortError" });
    expect(loader.pending.get("0/0/0")!.signal.aborted).toBe(true);
    expect(cache.size).toBe(0);
    // A late resolution of the abandoned load is freed, not kept.
    loader.settle("0/0/0");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(destroyed).toEqual(["0/0/0"]);
  });

  it("stops waiting on every shared load when one tile fails", async () => {
    const loader = deferredLoader();
    const cache = new TilePayloadCache({
      ...options,
      ...loader,
      maxRetries: 0,
    });
    const failing = cache.acquire(
      [t(1, 0, 0), t(1, 1, 0)],
      new AbortController().signal,
    );
    loader.pending.get("1/0/0")!.reject(new Error("bad tile"));
    await expect(failing).rejects.toThrow("bad tile");
    // The request left; nobody else waits on the other tile, so its load is
    // aborted and forgotten rather than running on for no one.
    expect(loader.pending.get("1/1/0")!.signal.aborted).toBe(true);
    expect(cache.size).toBe(0);
  });

  it("destroy frees every payload and refuses further use", async () => {
    const loader = deferredLoader();
    const cache = new TilePayloadCache({ ...options, ...loader });
    const p = cache.acquire([t(0, 0, 0)], new AbortController().signal);
    loader.settle("0/0/0");
    await p;
    cache.destroy();
    expect(destroyed).toEqual(["0/0/0"]);
    await expect(
      cache.acquire([t(0, 0, 0)], new AbortController().signal),
    ).rejects.toThrow(/destroyed/);
  });
});
