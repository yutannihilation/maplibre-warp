import type { Affine } from "@developmentseed/affine";
import { Plane } from "@math.gl/culling";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { rescaleEPSG3857ToCommonSpace } from "../src/mercator.js";
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

/**
 * Like {@link makeDescriptor} with a third level: 4×4 tiles at 256 m/px, so a
 * view can select tiles two levels below the root.
 */
function makeThreeLevelDescriptor(): AffineTileset {
  const base = makeDescriptor();
  return new AffineTileset({
    levels: [
      ...base.levels,
      new AffineTilesetLevel({
        affine: [256, 0, 0, 0, -256, 262144],
        arrayWidth: 1024,
        arrayHeight: 1024,
        tileWidth: 256,
        tileHeight: 256,
        mpu: 1,
      }),
    ],
    projectTo3857: base.projectTo3857,
    projectFrom3857: base.projectFrom3857,
    projectTo4326: base.projectTo4326,
    projectFrom4326: base.projectFrom4326,
  });
}

/**
 * A viewport whose frustum contains everything, at a chosen zoom.
 *
 * `maxX3857` clips the frustum on the right, in EPSG:3857 metres, so a test
 * can leave the right-hand tiles of the test pyramid out of view.
 */
function makeViewport(zoom: number, maxX3857?: number): RasterViewport {
  const far = 1e9;
  const rightPlane =
    maxX3857 === undefined
      ? new Plane([-1, 0, 0], far)
      : new Plane([-1, 0, 0], rescaleEPSG3857ToCommonSpace([maxX3857, 0])[0]);
  const frustumPlanes = [
    new Plane([1, 0, 0], far),
    rightPlane,
    new Plane([0, 1, 0], far),
    new Plane([0, -1, 0], far),
    new Plane([0, 0, 1], far),
    new Plane([0, 0, -1], far),
  ];
  const bounds: Bounds = [-180, -85, 180, 85];
  return {
    projection: "mercator",
    zoom,
    center: [0, 0],
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
  /** Every `loadTile` call, in order, as `z/x/y`. */
  let calls: string[];
  /** The scheduler {@link makeScheduler} built last, for {@link settle}. */
  let current: TileScheduler<FakePayload, FakePayload>;

  beforeEach(() => {
    resolvers = new Map();
    aborted = [];
    destroyed = [];
    calls = [];
  });

  function makeScheduler(
    overrides: Partial<
      Pick<
        TileSchedulerOptions<FakePayload, FakePayload>,
        | "descriptor"
        | "maxCacheByteSize"
        | "maxCacheSize"
        | "maxConcurrentRequests"
        | "lodBias"
      >
    > = {},
  ) {
    current = new TileScheduler<FakePayload, FakePayload>({
      descriptor,
      wgs84Bounds,
      ...overrides,
      loadTile: (index, signal) =>
        new Promise<FakePayload>((resolve, reject) => {
          const key = `${index.z}/${index.x}/${index.y}`;
          calls.push(key);
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
      uploadTile: (decoded) => decoded,
      byteLengthOf: () => 1000,
    });
    return current;
  }

  /**
   * Finish a load: resolve it, let the scheduler's `.then` run, then upload
   * as the layer's `prerender` does before every `update`.
   */
  async function settle(key: string): Promise<void> {
    const resolve = resolvers.get(key);
    expect(resolve, `no pending load for ${key}`).toBeDefined();
    resolve!({ index: parseKey(key), destroyed: false });
    resolvers.delete(key);
    await Promise.resolve();
    current.uploadPending();
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
    const scheduler = makeScheduler({ maxCacheByteSize: 1000 });
    scheduler.update(makeViewport(11));
    await settle("1/0/0");
    await settle("1/1/1");
    scheduler.update(makeViewport(11));

    // Both are in use this frame, so nothing is evicted yet.
    expect(destroyed).toHaveLength(0);

    // A frame over the left-hand tiles only: the right-hand one is neither
    // drawn nor related to anything selected, so the cap now bites.
    scheduler.update(makeViewport(11, 60000));
    expect(destroyed).toEqual([{ x: 1, y: 1, z: 1 }]);
    expect(scheduler.byteSize).toBeLessThanOrEqual(1000);
  });

  it("keeps off-screen loads running while under the in-flight cap", () => {
    // Default cap of 6: the four level-1 loads fit even once two of them have
    // panned out of view, so a user panning back and forth is not made to
    // restart the same requests.
    const scheduler = makeScheduler();
    scheduler.update(makeViewport(11));
    scheduler.update(makeViewport(11, 60000));
    expect(aborted).toEqual([]);
    expect(scheduler.loadingCount).toBe(4);
  });

  it("aborts off-screen loads once over the in-flight cap and re-requests them when reselected", () => {
    const scheduler = makeScheduler({ maxConcurrentRequests: 3 });
    scheduler.update(makeViewport(11));
    expect(scheduler.loadingCount).toBe(4);

    // Pan so only the left-hand column is in view: four in flight, one over
    // the cap, so one of the two right-hand loads goes. The selected loads
    // are untouchable.
    scheduler.update(makeViewport(11, 60000));
    expect(aborted).toHaveLength(1);
    expect(aborted[0]!.startsWith("1/1/")).toBe(true);
    expect(scheduler.loadingCount).toBe(3);

    // Pan back: the pruned entry is gone, so it is requested afresh rather
    // than mistaken for still-loading.
    const pruned = [...aborted];
    scheduler.update(makeViewport(11));
    for (const key of pruned) {
      expect(calls.filter((k) => k === key)).toHaveLength(2);
    }
  });

  it("keeps in-flight loads that still overlap the view when the level changes", () => {
    // Zoomed in with all four level-1 loads in flight, then out to where the
    // root is selected: every level-1 tile still lies under it, and will be
    // drawn as a stand-in the moment it lands, so none is cancelled even
    // with no in-flight allowance at all. Cancelling them made a small
    // zoom-out throw away seconds of loading for tiles still on screen.
    const scheduler = makeScheduler({ maxConcurrentRequests: 0 });
    scheduler.update(makeViewport(11));
    scheduler.update(makeViewport(4));
    expect(aborted).toEqual([]);
    expect(scheduler.loadingCount).toBe(5);
  });

  it("draws loaded finer tiles as stand-ins while a coarser selected tile loads", async () => {
    const scheduler = makeScheduler();
    scheduler.update(makeViewport(11));
    for (const key of ["1/0/0", "1/0/1", "1/1/0", "1/1/1"]) {
      await settle(key);
    }

    // Zoom out: the root is selected and loading. The detail already on
    // screen stays up rather than vanishing until the root arrives.
    const drawn = scheduler.update(makeViewport(4));
    expect(drawn.map((t) => t.index.z)).toEqual([1, 1, 1, 1]);
    expect(calls).toContain("0/0/0");

    // Once the root lands it takes over and the finer tiles are not drawn.
    await settle("0/0/0");
    const settled = scheduler.update(makeViewport(4));
    expect(settled.map((t) => t.index)).toEqual([{ x: 0, y: 0, z: 0 }]);
  });

  it("starts no loads while suspended but still draws stand-ins", async () => {
    const scheduler = makeScheduler();
    scheduler.update(makeViewport(4));
    await settle("0/0/0");

    // Mid-zoom: nothing new is requested, yet the loaded ancestor covers.
    const drawn = scheduler.update(makeViewport(11), { suspendLoads: true });
    expect(drawn.map((t) => t.index)).toEqual([{ x: 0, y: 0, z: 0 }]);
    expect(calls).toEqual(["0/0/0"]);

    // Zoom settled: the deferred loads start.
    scheduler.update(makeViewport(11));
    expect(calls).toHaveLength(5);
  });

  it("still prunes off-screen loads while suspended", () => {
    const scheduler = makeScheduler({ maxConcurrentRequests: 0 });
    scheduler.update(makeViewport(11));
    scheduler.update(makeViewport(11, 60000), { suspendLoads: true });
    expect(aborted.sort()).toEqual(["1/1/0", "1/1/1"]);
    expect(calls).toHaveLength(4);
  });

  it("selects a coarser level with a positive lodBias", () => {
    // At zoom 11 the root's pixels are ~27 framebuffer pixels wide, so
    // without a bias it subdivides (see "selects a finer level"). A bias of
    // five zoom levels allows 32, and the root suffices.
    const scheduler = makeScheduler({ lodBias: 5 });
    scheduler.update(makeViewport(11));
    expect(calls).toEqual(["0/0/0"]);
  });

  it("keeps loaded ancestors of selected tiles when the cap bites", async () => {
    // Four level-1 tiles fill the cap; the root is the fifth.
    const scheduler = makeScheduler({ maxCacheSize: 4 });
    scheduler.update(makeViewport(4));
    await settle("0/0/0");
    scheduler.update(makeViewport(11));
    for (const key of ["1/0/0", "1/0/1", "1/1/0", "1/1/1"]) {
      await settle(key);
    }

    // With every level-1 tile loaded the root is not drawn, and was the LRU
    // tile — the one eviction used to take, and the one the next zoom-out
    // needs first.
    scheduler.update(makeViewport(11));
    expect(destroyed).toEqual([]);

    const drawn = scheduler.update(makeViewport(4));
    expect(drawn.map((t) => t.index)).toEqual([{ x: 0, y: 0, z: 0 }]);
    expect(calls).toHaveLength(5);
  });

  describe("with loads in flight", () => {
    /**
     * Root and all four level-1 tiles loaded, then a view over the left
     * quarter of the pyramid at a zoom that wants level 2: four level-2 loads
     * start, the left-hand level-1 tiles stand in, and the right-hand level-1
     * tiles are the only loaded tiles nothing wants.
     */
    async function zoomIntoLeftHalf(maxCacheSize: number) {
      const scheduler = makeScheduler({
        descriptor: makeThreeLevelDescriptor(),
        maxCacheSize,
      });
      scheduler.update(makeViewport(4));
      await settle("0/0/0");
      scheduler.update(makeViewport(7));
      for (const key of ["1/0/0", "1/0/1", "1/1/0", "1/1/1"]) {
        await settle(key);
      }
      const drawn = scheduler.update(makeViewport(11, 60000));
      expect(scheduler.loadingCount).toBe(4);
      expect(
        drawn.map((t) => `${t.index.z}/${t.index.x}/${t.index.y}`).sort(),
      ).toEqual(["1/0/0", "1/0/1"]);
      return scheduler;
    }

    it("does not count them against the cache cap", async () => {
      // Five loaded tiles under a cap of five: nothing may go, even though
      // four more are loading. Counting those used to evict the two loaded
      // right-hand tiles, which then had to be fetched again on zoom-out —
      // behind the very burst that evicted them.
      await zoomIntoLeftHalf(5);
      expect(destroyed).toEqual([]);
    });

    it("evicts only loaded tiles that are neither drawn nor ancestors", async () => {
      const scheduler = await zoomIntoLeftHalf(3);
      expect(destroyed.map((i) => `${i.z}/${i.x}/${i.y}`).sort()).toEqual([
        "1/1/0",
        "1/1/1",
      ]);
      expect(aborted).toEqual([]);
      expect(scheduler.loadingCount).toBe(4);
    });
  });

  it("drops a tile that finishes decoding after it was pruned, without uploading it", async () => {
    // A loader that ignores its abort signal — a decoder already past the
    // point of no return, which is exactly when a result can outlive its
    // tile entry. It must neither be uploaded nor linger as pending.
    let resolveLate: ((payload: FakePayload) => void) | undefined;
    const uploaded: TileIndex[] = [];
    const scheduler = new TileScheduler<FakePayload, FakePayload>({
      descriptor,
      wgs84Bounds,
      maxConcurrentRequests: 0,
      loadTile: (index) =>
        new Promise<FakePayload>((resolve) => {
          if (index.z === 1 && index.x === 1 && index.y === 0) {
            resolveLate = resolve;
          }
        }),
      uploadTile: (decoded) => {
        uploaded.push(decoded.index);
        return decoded;
      },
      destroyTile: (payload) => {
        payload.destroyed = true;
      },
      byteLengthOf: () => 1000,
    });

    scheduler.update(makeViewport(11));
    expect(resolveLate).toBeDefined();

    // A frame over the left-hand column only prunes the right-hand loads
    // mid-flight.
    scheduler.update(makeViewport(11, 60000));
    scheduler.update(makeViewport(11, 60000));

    resolveLate!({ index: { x: 1, y: 0, z: 1 }, destroyed: false });
    await Promise.resolve();
    await Promise.resolve();
    expect(scheduler.pendingUploadCount).toBe(0);
    scheduler.uploadPending();
    expect(uploaded).toEqual([]);
  });

  it("reports a load failure once and does not retry it", async () => {
    const onTileError = vi.fn();
    const scheduler = new TileScheduler<FakePayload, FakePayload>({
      descriptor,
      wgs84Bounds,
      loadTile: () => Promise.reject(new Error("boom")),
      destroyTile: () => undefined,
      uploadTile: (decoded) => decoded,
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
    onTileError?: TileSchedulerOptions<FakePayload, FakePayload>["onTileError"];
  }) {
    const calls: string[] = [];
    const scheduler = new TileScheduler<FakePayload, FakePayload>({
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
      uploadTile: (decoded) => decoded,
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
    scheduler.uploadPending();
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
    scheduler.uploadPending();
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
      const scheduler = new TileScheduler<FakePayload, FakePayload>({
        descriptor,
        wgs84Bounds,
        retryBaseDelay: 1000,
        maxRetries: 1,
        loadTile: () => Promise.reject(new Error("boom")),
        destroyTile: () => undefined,
        uploadTile: (decoded) => decoded,
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
      const scheduler = new TileScheduler<FakePayload, FakePayload>({
        descriptor,
        wgs84Bounds,
        retryBaseDelay: 1000,
        loadTile: () => Promise.reject(new Error("boom")),
        destroyTile: () => undefined,
        uploadTile: (decoded) => decoded,
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

describe("TileScheduler upload", () => {
  const descriptor = makeDescriptor();
  const wgs84Bounds: Bounds = [-180, -85, 180, 85];
  const keyOf = (index: TileIndex) => `${index.z}/${index.x}/${index.y}`;

  /**
   * A scheduler whose loads resolve on demand through `decode`, with every
   * upload and destroy recorded. Uploads are the identity unless overridden.
   */
  function makeUploadingScheduler(
    opts: {
      uploadTile?: (decoded: FakePayload) => FakePayload;
      onTileError?: TileSchedulerOptions<
        FakePayload,
        FakePayload
      >["onTileError"];
      onNeedsRepaint?: () => void;
      maxUploadBytesPerFrame?: number;
    } = {},
  ) {
    const resolvers = new Map<string, (payload: FakePayload) => void>();
    const uploaded: string[] = [];
    const destroyed: string[] = [];
    const scheduler = new TileScheduler<FakePayload, FakePayload>({
      descriptor,
      wgs84Bounds,
      retryBaseDelay: 0,
      onTileError: opts.onTileError,
      onNeedsRepaint: opts.onNeedsRepaint,
      maxUploadBytesPerFrame: opts.maxUploadBytesPerFrame,
      loadTile: (index) =>
        new Promise<FakePayload>((resolve) => {
          resolvers.set(keyOf(index), resolve);
        }),
      uploadTile: (decoded) => {
        uploaded.push(keyOf(decoded.index));
        return (opts.uploadTile ?? ((d) => d))(decoded);
      },
      destroyTile: (payload) => {
        destroyed.push(keyOf(payload.index));
      },
      byteLengthOf: () => 1000,
    });
    /** Resolve the load for `key` and let the scheduler's `.then` run. */
    async function decode(key: string): Promise<void> {
      const resolve = resolvers.get(key);
      expect(resolve, `no pending load for ${key}`).toBeDefined();
      resolve!({ index: parseKey(key), destroyed: false });
      resolvers.delete(key);
      await flush();
    }
    return { scheduler, decode, uploaded, destroyed };
  }

  it("draws a decoded tile only after uploadPending has run", async () => {
    const { scheduler, decode, uploaded } = makeUploadingScheduler();
    scheduler.update(makeViewport(4));
    await decode("0/0/0");

    // Decoded, but the GPU half waits for the layer's `prerender`: nothing
    // may touch GL between frames.
    expect(scheduler.pendingUploadCount).toBe(1);
    expect(scheduler.update(makeViewport(4))).toEqual([]);
    expect(uploaded).toEqual([]);

    expect(scheduler.uploadPending()).toBe(1);
    expect(uploaded).toEqual(["0/0/0"]);
    expect(scheduler.pendingUploadCount).toBe(0);
    expect(scheduler.update(makeViewport(4)).map((t) => t.index)).toEqual([
      { x: 0, y: 0, z: 0 },
    ]);
    // Nothing left for the next frame.
    expect(scheduler.uploadPending()).toBe(0);
  });

  it("stands in with a loaded ancestor for a tile awaiting upload", async () => {
    const { scheduler, decode } = makeUploadingScheduler();
    scheduler.update(makeViewport(4));
    await decode("0/0/0");
    scheduler.uploadPending();
    scheduler.update(makeViewport(11));
    await decode("1/0/0");

    // Exactly as while loading: the ancestor covers until the upload lands.
    const drawn = scheduler.update(makeViewport(11));
    expect(drawn.map((t) => t.index)).toEqual([{ x: 0, y: 0, z: 0 }]);

    scheduler.uploadPending();
    const after = scheduler.update(makeViewport(11));
    expect(after.map((t) => t.index.z)).toEqual([0, 1]);
  });

  it("asks for a repaint when a tile finishes decoding, not again when it uploads", async () => {
    const onNeedsRepaint = vi.fn();
    const { scheduler, decode } = makeUploadingScheduler({ onNeedsRepaint });
    scheduler.update(makeViewport(4));
    await decode("0/0/0");
    // That repaint is the frame whose `prerender` uploads the tile.
    expect(onNeedsRepaint).toHaveBeenCalledTimes(1);
    scheduler.uploadPending();
    expect(onNeedsRepaint).toHaveBeenCalledTimes(1);
  });

  it("fails a tile whose upload throws and retries it like a failed load", async () => {
    const onTileError = vi.fn();
    let uploads = 0;
    const { scheduler, decode } = makeUploadingScheduler({
      onTileError,
      uploadTile: (decoded) => {
        if (++uploads === 1) {
          throw new Error("texture allocation failed");
        }
        return decoded;
      },
    });
    scheduler.update(makeViewport(4));
    await decode("0/0/0");

    // The frame goes on: the throw is reported, not propagated out of
    // `prerender` where it would take MapLibre's render loop down with it.
    expect(scheduler.uploadPending()).toBe(0);
    expect(onTileError).toHaveBeenCalledTimes(1);
    expect(onTileError.mock.calls[0]?.[2]).toEqual({
      attempt: 1,
      willRetry: true,
    });

    // retryBaseDelay is 0, so this frame re-requests the tile.
    expect(scheduler.update(makeViewport(4))).toEqual([]);
    await decode("0/0/0");
    expect(scheduler.uploadPending()).toBe(1);
    expect(scheduler.update(makeViewport(4)).map((t) => t.index)).toEqual([
      { x: 0, y: 0, z: 0 },
    ]);
  });

  it("spreads uploads over frames once the per-frame byte cap is reached", async () => {
    const onNeedsRepaint = vi.fn();
    // Every payload is 1000 bytes, so a 1500-byte cap fits one tile and the
    // one that crosses it: two per frame.
    const { scheduler, decode, uploaded } = makeUploadingScheduler({
      onNeedsRepaint,
      maxUploadBytesPerFrame: 1500,
    });
    scheduler.update(makeViewport(11));
    const order = ["1/1/1", "1/0/0", "1/1/0", "1/0/1"];
    for (const key of order) {
      await decode(key);
    }
    expect(scheduler.pendingUploadCount).toBe(4);
    onNeedsRepaint.mockClear();

    expect(scheduler.uploadPending()).toBe(2);
    // In the order they finished decoding, not cache order.
    expect(uploaded).toEqual(order.slice(0, 2));
    // Work remains, so the next frame is requested.
    expect(onNeedsRepaint).toHaveBeenCalledTimes(1);

    expect(scheduler.uploadPending()).toBe(2);
    expect(uploaded).toEqual(order);
    // Nothing left: no further frame is asked for.
    expect(onNeedsRepaint).toHaveBeenCalledTimes(1);
    expect(scheduler.pendingUploadCount).toBe(0);
  });

  it("uploads at least one tile per frame however small the cap", async () => {
    const { scheduler, decode } = makeUploadingScheduler({
      maxUploadBytesPerFrame: 0,
    });
    scheduler.update(makeViewport(11));
    for (const key of ["1/0/0", "1/0/1"]) {
      await decode(key);
    }
    expect(scheduler.uploadPending()).toBe(1);
    expect(scheduler.uploadPending()).toBe(1);
    expect(scheduler.uploadPending()).toBe(0);
  });

  it("drops decoded tiles on destroy without uploading or destroying them", async () => {
    const { scheduler, decode, uploaded, destroyed } = makeUploadingScheduler();
    scheduler.update(makeViewport(4));
    await decode("0/0/0");

    scheduler.destroy();
    expect(scheduler.uploadPending()).toBe(0);
    expect(uploaded).toEqual([]);
    // Nothing was ever on the GPU, so there is nothing to release.
    expect(destroyed).toEqual([]);
  });
});
