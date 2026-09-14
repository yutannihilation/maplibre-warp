import type { Affine } from "@developmentseed/affine";
import { Plane } from "@math.gl/culling";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { TileSchedulerOptions } from "../src/tile-scheduler.js";
import { TileScheduler } from "../src/tile-scheduler.js";
import { AffineTileset } from "../src/tileset/affine-tileset.js";
import { AffineTilesetLevel } from "../src/tileset/affine-tileset-level.js";
import type { Bounds, Point, TileIndex } from "../src/tileset/types.js";
import type { RasterViewport } from "../src/tileset/viewport.js";

/**
 * A two-level pyramid in a metric CRS that is, for the purpose of these tests,
 * EPSG:3857 itself — the projections are identity-ish so the maths stays
 * legible and the traversal still exercises its real code path.
 */
function makeDescriptor(): AffineTileset {
  // Level 0: 1 tile of 256 px at 1024 m/px. Level 1: 2×2 tiles at 512 m/px.
  const level0Affine: Affine = [1024, 0, 0, 0, -1024, 262144];
  const level1Affine: Affine = [512, 0, 0, 0, -512, 262144];

  const identity = (x: number, y: number): Point => [x, y];
  const toLngLat = (x: number, y: number): Point => [
    (x / 20037508.34) * 180,
    (Math.atan(Math.exp((y / 20037508.34) * Math.PI)) * 360) / Math.PI - 90,
  ];
  const fromLngLat = (lng: number, lat: number): Point => [
    (lng / 180) * 20037508.34,
    (Math.log(Math.tan(((90 + lat) * Math.PI) / 360)) / Math.PI) * 20037508.34,
  ];

  return new AffineTileset({
    levels: [
      new AffineTilesetLevel({
        affine: level0Affine,
        arrayWidth: 256,
        arrayHeight: 256,
        tileWidth: 256,
        tileHeight: 256,
        mpu: 1,
      }),
      new AffineTilesetLevel({
        affine: level1Affine,
        arrayWidth: 512,
        arrayHeight: 512,
        tileWidth: 256,
        tileHeight: 256,
        mpu: 1,
      }),
    ],
    projectTo3857: identity,
    projectFrom3857: identity,
    projectTo4326: toLngLat,
    projectFrom4326: fromLngLat,
  });
}

/** A viewport whose frustum contains everything, at a chosen zoom. */
function makeViewport(zoom: number): RasterViewport {
  const far = 1e9;
  const frustumPlanes = [
    new Plane([1, 0, 0], far),
    new Plane([-1, 0, 0], far),
    new Plane([0, 1, 0], far),
    new Plane([0, -1, 0], far),
    new Plane([0, 0, 1], far),
    new Plane([0, 0, -1], far),
  ];
  const bounds: Bounds = [-180, -85, 180, 85];
  return {
    zoom,
    frustumPlanes,
    getBounds: () => bounds,
    unitsPerMeter: 1,
    pixelRatio: 1,
  };
}

interface FakePayload {
  index: TileIndex;
  destroyed: boolean;
}

describe("TileScheduler", () => {
  const descriptor = makeDescriptor();
  const wgs84Bounds: Bounds = [-180, -85, 180, 85];

  let resolvers: Map<string, (payload: FakePayload) => void>;
  let aborted: string[];
  let destroyed: TileIndex[];

  beforeEach(() => {
    resolvers = new Map();
    aborted = [];
    destroyed = [];
  });

  function makeScheduler(maxCacheByteSize?: number, maxCacheSize?: number) {
    return new TileScheduler<FakePayload>({
      descriptor,
      wgs84Bounds,
      maxCacheByteSize,
      maxCacheSize,
      loadTile: (index, signal) =>
        new Promise<FakePayload>((resolve, reject) => {
          const key = `${index.z}/${index.x}/${index.y}`;
          resolvers.set(key, resolve);
          signal.addEventListener("abort", () => {
            aborted.push(key);
            reject(new DOMException("aborted", "AbortError"));
          });
        }),
      destroyTile: (payload) => {
        payload.destroyed = true;
        destroyed.push(payload.index);
      },
      byteLengthOf: () => 1000,
    });
  }

  function settle(key: string): Promise<void> {
    const resolve = resolvers.get(key);
    expect(resolve, `no pending load for ${key}`).toBeDefined();
    resolve!({ index: parseKey(key), destroyed: false });
    resolvers.delete(key);
    // Let the scheduler's `.then` run.
    return Promise.resolve().then(() => undefined);
  }

  it("requests every selected tile exactly once", () => {
    const scheduler = makeScheduler();
    // Coarse zoom: level 0 (1024 m/px) already resolves the display.
    scheduler.update(makeViewport(4));
    expect([...resolvers.keys()]).toEqual(["0/0/0"]);

    scheduler.update(makeViewport(4));
    expect(scheduler.size).toBe(1);
  });

  it("draws nothing until a tile has loaded, then draws it", async () => {
    const scheduler = makeScheduler();
    expect(scheduler.update(makeViewport(4))).toEqual([]);

    await settle("0/0/0");

    const drawn = scheduler.update(makeViewport(4));
    expect(drawn.map((t) => t.index)).toEqual([{ x: 0, y: 0, z: 0 }]);
  });

  it("selects a finer level as the viewport zooms in", () => {
    const scheduler = makeScheduler();
    scheduler.update(makeViewport(11));
    expect([...resolvers.keys()].sort()).toEqual([
      "1/0/0",
      "1/0/1",
      "1/1/0",
      "1/1/1",
    ]);
  });

  it("stands in with a loaded ancestor while children load", async () => {
    const scheduler = makeScheduler();
    scheduler.update(makeViewport(4));
    await settle("0/0/0");
    scheduler.update(makeViewport(4));

    // Zoom in: the level-1 tiles are requested but none has arrived, so the
    // loaded level-0 tile covers for all four.
    const drawn = scheduler.update(makeViewport(11));
    expect(drawn.map((t) => t.index)).toEqual([{ x: 0, y: 0, z: 0 }]);
  });

  it("draws the ancestor before the finer tiles that cover it", async () => {
    const scheduler = makeScheduler();
    scheduler.update(makeViewport(4));
    await settle("0/0/0");
    scheduler.update(makeViewport(11));
    await settle("1/0/0");

    const drawn = scheduler.update(makeViewport(11));
    // Coarse first: the stand-in must be painted over, not on top of, the
    // finer tile.
    expect(drawn[0]!.index.z).toBe(0);
    expect(drawn.slice(1).every((t) => t.index.z === 1)).toBe(true);
    expect(drawn).toHaveLength(2);
  });

  it("evicts least-recently-used tiles over the byte cap and frees them", async () => {
    // Cap of 1000 bytes: one tile fits, so loading a second must evict.
    const scheduler = makeScheduler(1000);
    scheduler.update(makeViewport(11));
    await settle("1/0/0");
    await settle("1/1/1");
    scheduler.update(makeViewport(11));

    // Both are in use this frame, so nothing is evicted yet.
    expect(destroyed).toHaveLength(0);

    // A frame that needs neither of them: the cap now bites.
    const narrow = makeViewport(4);
    scheduler.update(narrow);
    expect(destroyed.length).toBeGreaterThan(0);
    expect(scheduler.byteSize).toBeLessThanOrEqual(1000);
  });

  it("aborts a still-loading tile when it is evicted", async () => {
    const scheduler = makeScheduler(0, 0);
    scheduler.update(makeViewport(11));
    await settle("1/0/0");
    // Cap is 0, so the next frame evicts everything not being drawn.
    scheduler.update(makeViewport(4));
    await Promise.resolve();
    expect(aborted.length).toBeGreaterThan(0);
  });

  it("destroys a payload that arrives after its tile was evicted", async () => {
    // A loader that ignores its abort signal — a decoder already past the
    // point of no return, which is exactly when a payload can outlive its
    // tile entry and leak GPU memory.
    let resolveLate: ((payload: FakePayload) => void) | undefined;
    const scheduler = new TileScheduler<FakePayload>({
      descriptor,
      wgs84Bounds,
      maxCacheByteSize: 0,
      maxCacheSize: 0,
      loadTile: (index) =>
        new Promise<FakePayload>((resolve) => {
          if (index.z === 1 && index.x === 0 && index.y === 0) {
            resolveLate = resolve;
          }
        }),
      destroyTile: (payload) => {
        payload.destroyed = true;
      },
      byteLengthOf: () => 1000,
    });

    scheduler.update(makeViewport(11));
    expect(resolveLate).toBeDefined();

    // A frame that wants none of the level-1 tiles evicts them mid-flight.
    scheduler.update(makeViewport(4));
    scheduler.update(makeViewport(4));

    const payload: FakePayload = {
      index: { x: 0, y: 0, z: 1 },
      destroyed: false,
    };
    resolveLate!(payload);
    await Promise.resolve();
    await Promise.resolve();
    expect(payload.destroyed).toBe(true);
  });

  it("reports a load failure once and does not retry it", async () => {
    const onTileError = vi.fn();
    const scheduler = new TileScheduler<FakePayload>({
      descriptor,
      wgs84Bounds,
      loadTile: () => Promise.reject(new Error("boom")),
      destroyTile: () => undefined,
      byteLengthOf: () => 0,
      onTileError,
    });

    scheduler.update(makeViewport(4));
    await Promise.resolve();
    await Promise.resolve();
    expect(onTileError).toHaveBeenCalledTimes(1);

    scheduler.update(makeViewport(4));
    await Promise.resolve();
    expect(onTileError).toHaveBeenCalledTimes(1);
  });

  it("aborts everything in flight on destroy", () => {
    const scheduler = makeScheduler();
    scheduler.update(makeViewport(11));
    scheduler.destroy();
    expect(aborted).toHaveLength(4);
    expect(scheduler.size).toBe(0);
  });
});

function parseKey(key: string): TileIndex {
  const [z, x, y] = key.split("/").map(Number);
  return { x: x!, y: y!, z: z! };
}

/** Let the loadTile promise chain settle without advancing any timers. */
async function flush(times = 6): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
  }
}

describe("TileScheduler failure handling", () => {
  const descriptor = makeDescriptor();
  const wgs84Bounds: Bounds = [-180, -85, 180, 85];

  /**
   * A scheduler whose loads fail for the given keys. `failFor` is consulted on
   * every attempt, so a test can let a tile start succeeding partway through.
   */
  function makeFailingScheduler(opts: {
    failFor: (key: string, attempt: number) => boolean;
    retryBaseDelay?: number;
    maxRetries?: number;
    onTileError?: TileSchedulerOptions<FakePayload>["onTileError"];
  }) {
    const calls: string[] = [];
    const scheduler = new TileScheduler<FakePayload>({
      descriptor,
      wgs84Bounds,
      retryBaseDelay: opts.retryBaseDelay ?? 0,
      maxRetries: opts.maxRetries,
      onTileError: opts.onTileError,
      loadTile: (index) => {
        const key = `${index.z}/${index.x}/${index.y}`;
        calls.push(key);
        const attempt = calls.filter((k) => k === key).length;
        return opts.failFor(key, attempt)
          ? Promise.reject(new Error(`boom ${key} #${attempt}`))
          : Promise.resolve({ index, destroyed: false });
      },
      destroyTile: () => undefined,
      byteLengthOf: () => 1000,
    });
    const callsFor = (key: string) => calls.filter((k) => k === key).length;
    return { scheduler, calls, callsFor };
  }

  it("covers an errored tile with its loaded ancestor instead of leaving a hole", async () => {
    // Level 0 loads; every level-1 tile fails.
    const { scheduler } = makeFailingScheduler({
      failFor: (key) => key.startsWith("1/"),
      maxRetries: 0,
    });

    scheduler.update(makeViewport(4));
    await flush();
    scheduler.update(makeViewport(4));

    // Zoom in: all four level-1 tiles fail, so the loaded level-0 tile must
    // stand in for them. Before the fix this returned an empty draw list and
    // the basemap showed through permanently.
    scheduler.update(makeViewport(11));
    await flush();
    const drawn = scheduler.update(makeViewport(11));

    expect(drawn.map((t) => t.index)).toEqual([{ x: 0, y: 0, z: 0 }]);
  });

  it("retries a failed tile once its backoff has elapsed", async () => {
    // Fails once, then succeeds.
    const { scheduler, callsFor } = makeFailingScheduler({
      failFor: (_key, attempt) => attempt === 1,
    });

    scheduler.update(makeViewport(4));
    await flush();
    expect(callsFor("0/0/0")).toBe(1);

    // retryBaseDelay is 0, so the next frame may retry immediately.
    scheduler.update(makeViewport(4));
    await flush();
    expect(callsFor("0/0/0")).toBe(2);

    // The retry succeeded, so the tile now draws and is not requested again.
    const drawn = scheduler.update(makeViewport(4));
    expect(drawn.map((t) => t.index)).toEqual([{ x: 0, y: 0, z: 0 }]);
    expect(callsFor("0/0/0")).toBe(2);
  });

  it("gives up after maxRetries and stops re-requesting", async () => {
    const { scheduler, callsFor } = makeFailingScheduler({
      failFor: () => true,
      maxRetries: 2,
    });

    for (let i = 0; i < 10; i++) {
      scheduler.update(makeViewport(4));
      await flush();
    }

    // One initial attempt plus two retries, then no more: a permanently bad
    // tile must not turn into a request loop.
    expect(callsFor("0/0/0")).toBe(3);
  });

  it("spaces retries exponentially", async () => {
    vi.useFakeTimers();
    try {
      const { scheduler, callsFor } = makeFailingScheduler({
        failFor: () => true,
        retryBaseDelay: 1000,
        maxRetries: 3,
      });

      scheduler.update(makeViewport(4));
      await flush();
      expect(callsFor("0/0/0")).toBe(1);

      // Too early for the first retry.
      scheduler.update(makeViewport(4));
      await flush();
      expect(callsFor("0/0/0")).toBe(1);

      vi.advanceTimersByTime(1000);
      scheduler.update(makeViewport(4));
      await flush();
      expect(callsFor("0/0/0")).toBe(2);

      // The second backoff is twice as long, so the same wait is not enough.
      vi.advanceTimersByTime(1000);
      scheduler.update(makeViewport(4));
      await flush();
      expect(callsFor("0/0/0")).toBe(2);

      vi.advanceTimersByTime(1000);
      scheduler.update(makeViewport(4));
      await flush();
      expect(callsFor("0/0/0")).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("asks for a repaint when a retry falls due, so retries can run at all", async () => {
    vi.useFakeTimers();
    try {
      const onNeedsRepaint = vi.fn();
      const scheduler = new TileScheduler<FakePayload>({
        descriptor,
        wgs84Bounds,
        retryBaseDelay: 1000,
        maxRetries: 1,
        loadTile: () => Promise.reject(new Error("boom")),
        destroyTile: () => undefined,
        byteLengthOf: () => 0,
        onNeedsRepaint,
      });

      scheduler.update(makeViewport(4));
      await flush();
      // Nothing loaded, so without the retry nudge the layer would never
      // repaint, never call update again, and never retry.
      expect(onNeedsRepaint).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1000);
      expect(onNeedsRepaint).toHaveBeenCalledTimes(1);

      scheduler.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not repaint for a retry after being destroyed", async () => {
    vi.useFakeTimers();
    try {
      const onNeedsRepaint = vi.fn();
      const scheduler = new TileScheduler<FakePayload>({
        descriptor,
        wgs84Bounds,
        retryBaseDelay: 1000,
        loadTile: () => Promise.reject(new Error("boom")),
        destroyTile: () => undefined,
        byteLengthOf: () => 0,
        onNeedsRepaint,
      });
      scheduler.update(makeViewport(4));
      await flush();
      scheduler.destroy();

      vi.advanceTimersByTime(10000);
      expect(onNeedsRepaint).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("tells the caller whether a failure will be retried", async () => {
    const onTileError = vi.fn();
    const { scheduler } = makeFailingScheduler({
      failFor: () => true,
      maxRetries: 1,
      onTileError,
    });

    for (let i = 0; i < 4; i++) {
      scheduler.update(makeViewport(4));
      await flush();
    }

    expect(onTileError).toHaveBeenCalledTimes(2);
    expect(onTileError.mock.calls[0]?.[2]).toEqual({
      attempt: 1,
      willRetry: true,
    });
    expect(onTileError.mock.calls[1]?.[2]).toEqual({
      attempt: 2,
      willRetry: false,
    });
  });
});
