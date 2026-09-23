import { describe, expect, it, vi } from "vitest";

import { mercatorFromLngLat } from "../src/mercator.js";
import type {
  RasterCustomLayerProps,
  RasterSource,
} from "../src/raster-custom-layer.js";
import {
  globeFrameUniforms,
  mercatorFrameUniforms,
  RasterCustomLayer,
} from "../src/raster-custom-layer.js";
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

/** A map stub exposing only what `onAdd`/`onRemove` and source opening touch. */
function makeMap() {
  return {
    triggerRepaint: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    isZooming: () => false,
  } as unknown as Parameters<RasterCustomLayer["onAdd"]>[0] & {
    triggerRepaint: ReturnType<typeof vi.fn>;
    on: ReturnType<typeof vi.fn>;
    off: ReturnType<typeof vi.fn>;
  };
}

const gl = {} as WebGL2RenderingContext;

/** A column-major 4×4 identity matrix. */
function identityMatrix(): Float64Array {
  const m = new Float64Array(16);
  m[0] = 1;
  m[5] = 1;
  m[10] = 1;
  m[15] = 1;
  return m;
}

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

describe("RasterCustomLayer zoom handling", () => {
  it("repaints when a zoom ends so deferred loads start, and unsubscribes on remove", () => {
    const layer = new TestLayer({ id: "t" }, () => Promise.resolve(source));
    const map = makeMap();

    layer.onAdd(map, gl);
    const subscription = map.on.mock.calls.find(
      ([event]) => event === "zoomend",
    );
    expect(subscription).toBeDefined();
    const handler = subscription![1] as () => void;

    // Loads are held back while zooming and MapLibre does not repaint once
    // the zoom settles, so `zoomend` has to trigger the frame that starts them.
    expect(map.triggerRepaint).not.toHaveBeenCalled();
    handler();
    expect(map.triggerRepaint).toHaveBeenCalledTimes(1);

    layer.onRemove(map, gl);
    expect(map.off).toHaveBeenCalledWith("zoomend", handler);
  });
});

describe("RasterCustomLayer prerender", () => {
  it("exists, so MapLibre runs the offscreen pass, and is a no-op before a source is attached", () => {
    const layer = new TestLayer({ id: "t" }, () => Promise.resolve(source));
    // MapLibre opts a custom layer into the offscreen pass only when
    // `prerender` is defined — and that pass is where tiles get uploaded.
    expect(typeof layer.prerender).toBe("function");
    const args = {} as Parameters<RasterCustomLayer["prerender"]>[1];
    expect(() => layer.prerender(gl, args)).not.toThrow();
  });
});

describe("per-frame uniforms", () => {
  it("folds the map centre into the matrix under mercator", () => {
    const map = {
      getCenter: () => ({ lng: 8.5417, lat: 47.3769 }),
    } as unknown as Parameters<typeof mercatorFrameUniforms>[0];
    const args = {
      defaultProjectionData: { mainMatrix: identityMatrix() },
    } as unknown as Parameters<typeof mercatorFrameUniforms>[1];

    const uniforms = mercatorFrameUniforms(map, args);
    expect(Object.keys(uniforms).sort()).toEqual([
      "u_origin_high",
      "u_origin_low",
      "u_projection_matrix",
    ]);

    // With an identity matrix the translated matrix's fourth column is the
    // origin itself, and high + low reconstruct that same origin.
    const origin = mercatorFromLngLat(8.5417, 47.3769);
    const matrix = uniforms.u_projection_matrix as Float32Array;
    expect(matrix[12]).toBeCloseTo(origin[0], 6);
    expect(matrix[13]).toBeCloseTo(origin[1], 6);

    const high = uniforms.u_origin_high as Float32Array;
    const low = uniforms.u_origin_low as Float32Array;
    expect(high[0]! + low[0]!).toBeCloseTo(origin[0], 15);
    expect(high[1]! + low[1]!).toBeCloseTo(origin[1], 15);
  });

  it("passes MapLibre's globe uniforms through untouched", () => {
    // Every uniform the globe vertex prelude declares must be set, and the
    // fallback matrix must be the mercator one — feeding it `mainMatrix`
    // would break the globe↔mercator transition blend.
    const mainMatrix = identityMatrix();
    const fallbackMatrix = identityMatrix();
    fallbackMatrix[0] = 7;
    const args = {
      defaultProjectionData: {
        mainMatrix,
        fallbackMatrix,
        tileMercatorCoords: [0, 0, 1, 1],
        clippingPlane: [0, 0, 1, -0.3],
        projectionTransition: 0.25,
      },
    } as unknown as Parameters<typeof globeFrameUniforms>[0];

    const uniforms = globeFrameUniforms(args);
    expect(Object.keys(uniforms).sort()).toEqual([
      "u_projection_clipping_plane",
      "u_projection_fallback_matrix",
      "u_projection_matrix",
      "u_projection_tile_mercator_coords",
      "u_projection_transition",
    ]);
    expect(uniforms.u_projection_transition).toBe(0.25);
    expect(uniforms.u_projection_clipping_plane).toEqual(
      new Float32Array([0, 0, 1, -0.3]),
    );
    expect(uniforms.u_projection_tile_mercator_coords).toEqual(
      new Float32Array([0, 0, 1, 1]),
    );
    expect((uniforms.u_projection_fallback_matrix as Float32Array)[0]).toBe(7);
    expect((uniforms.u_projection_matrix as Float32Array)[0]).toBe(1);
  });
});
