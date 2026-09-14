import { describe, expect, it, vi } from "vitest";

import type {
  RasterCustomLayerProps,
  RasterSource,
} from "../src/raster-custom-layer.js";
import { RasterCustomLayer } from "../src/raster-custom-layer.js";
import type { RasterTilesetDescriptor } from "../src/tileset/tileset-interface.js";
import type { Point } from "../src/tileset/types.js";

/**
 * The smallest descriptor the scheduler's constructor accepts. These tests
 * never call `render`, so nothing reads past construction.
 */
const descriptor: RasterTilesetDescriptor = {
  levels: [],
  projectTo3857: (x, y): Point => [x, y],
  projectFrom3857: (x, y): Point => [x, y],
  projectTo4326: (x, y): Point => [x, y],
  projectFrom4326: (x, y): Point => [x, y],
  projectedBounds: [0, 0, 1, 1],
};

const source: RasterSource = {
  descriptor,
  wgs84Bounds: [0, 0, 1, 1],
  loadTile: () => Promise.reject(new Error("not used")),
};

/** A map stub exposing only what the source-open path touches. */
function makeMap() {
  return { triggerRepaint: vi.fn() } as unknown as Parameters<
    RasterCustomLayer["onAdd"]
  >[0];
}

const gl = {} as WebGL2RenderingContext;

class TestLayer extends RasterCustomLayer {
  attempts = 0;
  ready = 0;

  constructor(
    props: RasterCustomLayerProps,
    private readonly behaviour: (
      attempt: number,
    ) => Promise<RasterSource | null>,
  ) {
    super(props);
  }

  protected createSource(): Promise<RasterSource | null> {
    this.attempts++;
    return this.behaviour(this.attempts);
  }

  protected override onSourceReady(): void {
    this.ready++;
  }
}

/** Let pending promise callbacks run without advancing timers. */
async function flush(times = 6): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
  }
}

describe("RasterCustomLayer source opening", () => {
  it("retries a failed source open and succeeds", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      // Fails once, then succeeds: the transient-outage case that previously
      // left the whole layer permanently empty.
      const layer = new TestLayer(
        { id: "t", retryBaseDelay: 1000 },
        (attempt) =>
          attempt === 1
            ? Promise.reject(new Error("boom"))
            : Promise.resolve(source),
      );
      const map = makeMap();

      layer.onAdd(map, gl);
      await flush();
      expect(layer.attempts).toBe(1);
      expect(layer.ready).toBe(0);

      await vi.advanceTimersByTimeAsync(1000);
      await flush();

      expect(layer.attempts).toBe(2);
      expect(layer.ready).toBe(1);
      expect(map.triggerRepaint).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it("backs off exponentially and gives up after maxRetries", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    try {
      const layer = new TestLayer(
        { id: "t", retryBaseDelay: 1000, maxRetries: 2 },
        () => Promise.reject(new Error("boom")),
      );

      layer.onAdd(makeMap(), gl);
      await flush();
      expect(layer.attempts).toBe(1);

      await vi.advanceTimersByTimeAsync(1000);
      await flush();
      expect(layer.attempts).toBe(2);

      // Second backoff is twice as long, so 1000 ms is not yet enough.
      await vi.advanceTimersByTimeAsync(1000);
      await flush();
      expect(layer.attempts).toBe(2);

      await vi.advanceTimersByTimeAsync(1000);
      await flush();
      expect(layer.attempts).toBe(3);

      // Budget spent: no further attempts, and one final error.
      await vi.advanceTimersByTimeAsync(60000);
      await flush();
      expect(layer.attempts).toBe(3);
      expect(error).toHaveBeenCalledTimes(1);
      expect(layer.ready).toBe(0);
    } finally {
      warn.mockRestore();
      error.mockRestore();
      vi.useRealTimers();
    }
  });

  it("stops retrying once the layer is removed", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const layer = new TestLayer({ id: "t", retryBaseDelay: 1000 }, () =>
        Promise.reject(new Error("boom")),
      );
      const map = makeMap();

      layer.onAdd(map, gl);
      await flush();
      expect(layer.attempts).toBe(1);

      // Removing mid-backoff must abandon the pending retry rather than
      // leaving a timer that resumes work on a detached layer.
      layer.onRemove(map, gl);
      await vi.advanceTimersByTimeAsync(60000);
      await flush();

      expect(layer.attempts).toBe(1);
      expect(layer.ready).toBe(0);
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it("does not retry when the source resolves to null", async () => {
    vi.useFakeTimers();
    try {
      // `null` means "deliberately empty", not "failed", so it must not retry.
      const layer = new TestLayer({ id: "t", retryBaseDelay: 1000 }, () =>
        Promise.resolve(null),
      );
      layer.onAdd(makeMap(), gl);
      await flush();
      await vi.advanceTimersByTimeAsync(60000);
      await flush();

      expect(layer.attempts).toBe(1);
      expect(layer.ready).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
