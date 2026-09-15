import type { Tile } from "@developmentseed/geotiff";
import { describe, expect, it, vi } from "vitest";
import type { TileSource } from "../src/tile-cache.js";
import { DecodedTileCache, tileByteLength } from "../src/tile-cache.js";

function fakeTile(x: number, y: number, bytes = 16): Tile {
  return {
    x,
    y,
    array: {
      layout: "pixel-interleaved",
      data: new Uint8Array(bytes),
      width: bytes,
      height: 1,
      count: 1,
      mask: null,
    } as unknown as Tile["array"],
  };
}

/**
 * A source that records calls and lets the test resolve them by hand.
 * `failing` tiles reject the batched call and their own single fetch.
 */
function fakeSource(
  opts: { manual?: boolean; failing?: Array<[number, number]> } = {},
) {
  const calls: Array<{
    xy: Array<[number, number]>;
    signal: AbortSignal | undefined;
    resolve: (tiles: Tile[]) => void;
    reject: (reason: unknown) => void;
  }> = [];
  const singles: Array<[number, number]> = [];
  const fails = (x: number, y: number) =>
    opts.failing?.some(([fx, fy]) => fx === x && fy === y) ?? false;
  const source: TileSource = {
    fetchTile: vi.fn(async (x: number, y: number) => {
      singles.push([x, y]);
      if (fails(x, y)) {
        throw new Error(`Tile at (${x}, ${y}) not found`);
      }
      return fakeTile(x, y);
    }),
    fetchTiles: vi.fn((xy: Array<[number, number]>, options) => {
      return new Promise<Tile[]>((resolve, reject) => {
        const call = { xy, signal: options?.signal, resolve, reject };
        options?.signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
        calls.push(call);
        if (!opts.manual) {
          const bad = xy.find(([x, y]) => fails(x, y));
          if (bad) {
            reject(new Error(`Tile at (${bad[0]}, ${bad[1]}) not found`));
          } else {
            resolve(xy.map(([x, y]) => fakeTile(x, y)));
          }
        }
      });
    }),
  };
  return { source, calls, singles };
}

/** Unwrap settled results, throwing on any rejection. */
function values(results: PromiseSettledResult<Tile>[]): Tile[] {
  return results.map((r) => {
    if (r.status === "rejected") {
      throw r.reason;
    }
    return r.value;
  });
}

describe("DecodedTileCache", () => {
  it("fetches missing tiles once, in a single batch, and reuses them", async () => {
    const { source, calls } = fakeSource();
    const cache = new DecodedTileCache();

    const first = values(
      await cache.getTiles(source, [
        [0, 0],
        [1, 0],
        [0, 1],
      ]),
    );
    expect(first.map((t) => [t.x, t.y])).toEqual([
      [0, 0],
      [1, 0],
      [0, 1],
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.xy).toEqual([
      [0, 0],
      [1, 0],
      [0, 1],
    ]);

    // Overlapping request: only the new tile is fetched.
    const second = values(
      await cache.getTiles(source, [
        [1, 0],
        [1, 1],
      ]),
    );
    expect(calls).toHaveLength(2);
    expect(calls[1]!.xy).toEqual([[1, 1]]);
    expect(second[0]).toBe(first[1]);
  });

  it("keys tiles per source", async () => {
    const a = fakeSource();
    const b = fakeSource();
    const cache = new DecodedTileCache();
    await cache.getTiles(a.source, [[0, 0]]);
    await cache.getTiles(b.source, [[0, 0]]);
    expect(a.calls).toHaveLength(1);
    expect(b.calls).toHaveLength(1);
  });

  it("shares an in-flight fetch between concurrent consumers", async () => {
    const { source, calls } = fakeSource({ manual: true });
    const cache = new DecodedTileCache();
    const p1 = cache.getTiles(source, [[0, 0]]);
    const p2 = cache.getTiles(source, [[0, 0]]);
    expect(calls).toHaveLength(1);
    calls[0]!.resolve([fakeTile(0, 0)]);
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(values(r1)[0]).toBe(values(r2)[0]);
  });

  it("rejects an aborted consumer at once but keeps the fetch for others", async () => {
    const { source, calls } = fakeSource({ manual: true });
    const cache = new DecodedTileCache();
    const ac = new AbortController();
    const aborted = cache.getTiles(source, [[0, 0]], { signal: ac.signal });
    const kept = cache.getTiles(source, [[0, 0]]);
    ac.abort();
    await expect(aborted).rejects.toMatchObject({ name: "AbortError" });
    expect(calls[0]!.signal!.aborted).toBe(false);
    calls[0]!.resolve([fakeTile(0, 0)]);
    expect(values(await kept)[0]!.x).toBe(0);
  });

  it("aborts the fetch and forgets the entry when every consumer aborts", async () => {
    const { source, calls } = fakeSource({ manual: true });
    const cache = new DecodedTileCache();
    const a = new AbortController();
    const b = new AbortController();
    const pa = cache.getTiles(source, [[0, 0]], { signal: a.signal });
    const pb = cache.getTiles(source, [[0, 0]], { signal: b.signal });
    a.abort();
    expect(calls[0]!.signal!.aborted).toBe(false);
    b.abort();
    expect(calls[0]!.signal!.aborted).toBe(true);
    // The entry leaves the cache the moment the batch is aborted, not when
    // the rejection eventually propagates.
    expect(cache.size).toBe(0);
    await expect(pa).rejects.toMatchObject({ name: "AbortError" });
    await expect(pb).rejects.toMatchObject({ name: "AbortError" });

    // A later request refetches instead of reusing the aborted entry.
    const again = cache.getTiles(source, [[0, 0]]);
    expect(calls).toHaveLength(2);
    calls[1]!.resolve([fakeTile(0, 0)]);
    await again;
  });

  it("does not let a new consumer join a batch aborted by its last waiter", async () => {
    const { source, calls } = fakeSource({ manual: true });
    const cache = new DecodedTileCache();
    const ac = new AbortController();
    const first = cache.getTiles(
      source,
      [
        [0, 0],
        [1, 0],
      ],
      { signal: ac.signal },
    );
    ac.abort();
    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    // Before the aborted fetch has even rejected, another tile wants (1,0).
    const second = cache.getTiles(source, [[1, 0]]);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.xy).toEqual([[1, 0]]);
    calls[1]!.resolve([fakeTile(1, 0)]);
    expect(values(await second)[0]!.y).toBe(0);
  });

  it("isolates one tile's failure by falling back to single fetches", async () => {
    const { source, calls, singles } = fakeSource({ failing: [[1, 1]] });
    const cache = new DecodedTileCache();
    const results = await cache.getTiles(source, [
      [0, 0],
      [1, 1],
      [2, 2],
    ]);
    expect(results.map((r) => r.status)).toEqual([
      "fulfilled",
      "rejected",
      "fulfilled",
    ]);
    expect((results[1] as PromiseRejectedResult).reason).toMatchObject({
      message: "Tile at (1, 1) not found",
    });
    // One batched attempt, then one single fetch per tile.
    expect(calls).toHaveLength(1);
    expect(singles).toEqual([
      [0, 0],
      [1, 1],
      [2, 2],
    ]);
    // Successes are cached; the failure is not, so it can be retried.
    expect(cache.size).toBe(2);
    await cache.getTiles(source, [[0, 0]]);
    expect(source.fetchTiles).toHaveBeenCalledTimes(1);
  });

  it("does not fall back for a single-tile batch", async () => {
    const { source, singles } = fakeSource({ failing: [[1, 1]] });
    const cache = new DecodedTileCache();
    const [only] = await cache.getTiles(source, [[1, 1]]);
    expect(only!.status).toBe("rejected");
    expect(singles).toEqual([]);
  });

  it("rejects immediately when the signal is already aborted", async () => {
    const { source, calls } = fakeSource();
    const cache = new DecodedTileCache();
    const ac = new AbortController();
    ac.abort();
    await expect(
      cache.getTiles(source, [[0, 0]], { signal: ac.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(calls).toHaveLength(0);
  });

  it("drops a failed fetch so it can be retried", async () => {
    const { source, calls } = fakeSource({ manual: true });
    const cache = new DecodedTileCache();
    const p = cache.getTiles(source, [[0, 0]]);
    calls[0]!.reject(new Error("network"));
    const [only] = await p;
    expect(only).toMatchObject({ status: "rejected" });
    expect((only as PromiseRejectedResult).reason).toMatchObject({
      message: "network",
    });
    expect(cache.size).toBe(0);
  });

  it("evicts least-recently-used resolved tiles over the byte budget", async () => {
    const { source } = fakeSource();
    // Each fake tile is 16 bytes; budget for two.
    const cache = new DecodedTileCache(32);
    await cache.getTiles(source, [[0, 0]]);
    await cache.getTiles(source, [[1, 0]]);
    expect(cache.byteLength).toBe(32);
    // Touch (0,0) so (1,0) becomes the oldest.
    await cache.getTiles(source, [[0, 0]]);
    await cache.getTiles(source, [[2, 0]]);
    expect(cache.byteLength).toBe(32);
    expect(cache.size).toBe(2);
    expect(source.fetchTiles).toHaveBeenCalledTimes(3);
    // (1,0) was evicted; (0,0) was not.
    await cache.getTiles(source, [[0, 0]]);
    expect(source.fetchTiles).toHaveBeenCalledTimes(3);
    await cache.getTiles(source, [[1, 0]]);
    expect(source.fetchTiles).toHaveBeenCalledTimes(4);
  });

  it("never evicts a tile someone is still waiting on", async () => {
    const { source, calls } = fakeSource({ manual: true });
    const cache = new DecodedTileCache(16);
    const pending = cache.getTiles(source, [
      [0, 0],
      [1, 0],
    ]);
    calls[0]!.resolve([fakeTile(0, 0), fakeTile(1, 0)]);
    const tiles = await pending;
    expect(tiles).toHaveLength(2);
    // Released now: over budget by one tile, so one is evicted.
    expect(cache.size).toBe(1);
    expect(cache.byteLength).toBe(16);
  });

  it("clear() empties the cache and aborts every pending fetch", async () => {
    const { source, calls } = fakeSource({ manual: true });
    const cache = new DecodedTileCache();
    const resolved = cache.getTiles(source, [[5, 5]]);
    calls[0]!.resolve([fakeTile(5, 5)]);
    await resolved;
    const pending = cache.getTiles(source, [[0, 0]]);
    expect(cache.size).toBe(2);
    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.byteLength).toBe(0);
    expect(calls[1]!.signal!.aborted).toBe(true);
    const [only] = await pending;
    expect(only).toMatchObject({ status: "rejected" });
  });

  it("measures a tile's decoded bytes including its mask", () => {
    const tile = fakeTile(0, 0, 8);
    expect(tileByteLength(tile)).toBe(8);
    (tile.array as { mask: Uint8Array | null }).mask = new Uint8Array(3);
    expect(tileByteLength(tile)).toBe(11);
  });
});
