import { describe, expect, it, vi } from "vitest";

import type { ContourBackend, ContourMeta } from "../src/backend.js";
import { COGContourSource } from "../src/cog-contour-source.js";
import { parseTileUrl } from "../src/tile-url.js";

const META: ContourMeta = {
  levelMetersPerPixel: [320, 160, 80, 40, 20, 10],
  sourceTileWidth: 256,
  wgs84Bounds: [7, 45, 9, 47],
};

function fakeBackend(
  overrides: Partial<ContourBackend> = {},
): ContourBackend & { tile: ReturnType<typeof vi.fn> } {
  const tile = vi.fn(async (_z: number, _x: number, _y: number) =>
    Uint8Array.of(1, 2, 3),
  );
  return {
    open: vi.fn(async () => META),
    tile,
    destroy: vi.fn(),
    ...overrides,
  } as ContourBackend & { tile: ReturnType<typeof vi.fn> };
}

function fakeRegistry() {
  const protocols = new Map<string, unknown>();
  return {
    protocols,
    addProtocol: (name: string, handler: unknown) => {
      protocols.set(name, handler);
    },
    removeProtocol: (name: string) => {
      protocols.delete(name);
    },
  };
}

type Handler = (
  request: { url: string },
  controller: AbortController,
) => Promise<{ data: ArrayBuffer }>;

describe("parseTileUrl", () => {
  it("extracts z/x/y", () => {
    expect(parseTileUrl("cog-contour://4/3/5.mvt")).toEqual({
      z: 4,
      x: 3,
      y: 5,
    });
  });
  it("rejects malformed urls", () => {
    expect(() => parseTileUrl("cog-contour://4/3.mvt")).toThrow(RangeError);
    expect(() => parseTileUrl("cog-contour://a/b/c.mvt")).toThrow(RangeError);
  });
});

describe("COGContourSource", () => {
  const make = (backend: ContourBackend) =>
    new COGContourSource({
      id: "test",
      geotiff: "https://example.com/dem.tif",
      thresholds: [100, 200],
      createBackend: () => backend,
    });

  it("registers one protocol and reports its tile template", () => {
    const registry = fakeRegistry();
    const source = make(fakeBackend());
    source.register(registry);
    expect([...registry.protocols.keys()]).toEqual(["test"]);
    expect(source.tileUrlTemplate).toBe("test://{z}/{x}/{y}.mvt");
    source.register(registry);
    expect(registry.protocols.size).toBe(1);
  });

  it("builds a vector source specification from the opened COG", async () => {
    const source = make(fakeBackend());
    const spec = await source.getSourceSpecification();
    expect(spec.type).toBe("vector");
    expect(spec.tiles).toEqual(["test://{z}/{x}/{y}.mvt"]);
    expect(spec.bounds).toEqual([7, 45, 9, 47]);
    expect(spec.maxzoom).toBeGreaterThan(spec.minzoom!);
    // 10 m at lat 46: tile pixel ≤ 10 m first at z14 (≈ 6.6 m; z13 ≈ 13 m).
    expect(spec.maxzoom).toBe(14);
  });

  it("serves tiles through the protocol handler and caches them", async () => {
    const backend = fakeBackend();
    const registry = fakeRegistry();
    const source = make(backend);
    source.register(registry);
    const handler = registry.protocols.get("test") as Handler;

    const first = await handler(
      { url: "test://4/3/5.mvt" },
      new AbortController(),
    );
    expect(new Uint8Array(first.data)).toEqual(Uint8Array.of(1, 2, 3));
    await handler({ url: "test://4/3/5.mvt" }, new AbortController());
    expect(backend.tile).toHaveBeenCalledTimes(1);
    expect(backend.tile).toHaveBeenCalledWith(4, 3, 5, expect.any(AbortSignal));
    expect(backend.open).toHaveBeenCalledTimes(1);
  });

  it("returns an empty tile when the backend has nothing for it", async () => {
    const backend = fakeBackend();
    backend.tile.mockResolvedValue(null);
    const registry = fakeRegistry();
    const source = make(backend);
    source.register(registry);
    const handler = registry.protocols.get("test") as Handler;
    const response = await handler(
      { url: "test://1/0/0.mvt" },
      new AbortController(),
    );
    expect(response.data.byteLength).toBe(0);
  });

  it("shares one in-flight generation between concurrent requests", async () => {
    let resolve!: (v: Uint8Array) => void;
    const backend = fakeBackend();
    backend.tile.mockReturnValue(
      new Promise<Uint8Array>((r) => {
        resolve = r;
      }),
    );
    const registry = fakeRegistry();
    make(backend).register(registry);
    const handler = registry.protocols.get("test") as Handler;
    const a = handler({ url: "test://2/1/1.mvt" }, new AbortController());
    const b = handler({ url: "test://2/1/1.mvt" }, new AbortController());
    resolve(Uint8Array.of(9));
    const [ra, rb] = await Promise.all([a, b]);
    expect(new Uint8Array(ra.data)).toEqual(Uint8Array.of(9));
    expect(new Uint8Array(rb.data)).toEqual(Uint8Array.of(9));
    expect(backend.tile).toHaveBeenCalledTimes(1);
  });

  it("aborts the backend only when every requester has aborted", async () => {
    let seen: AbortSignal | undefined;
    const backend = fakeBackend();
    backend.tile.mockImplementation(
      (_z: number, _x: number, _y: number, signal: AbortSignal) =>
        new Promise<Uint8Array>((_, reject) => {
          seen = signal;
          signal.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
    );
    const registry = fakeRegistry();
    make(backend).register(registry);
    const handler = registry.protocols.get("test") as Handler;
    const ca = new AbortController();
    const cb = new AbortController();
    const a = handler({ url: "test://3/1/1.mvt" }, ca);
    const b = handler({ url: "test://3/1/1.mvt" }, cb);
    await Promise.resolve();
    ca.abort();
    await expect(a).rejects.toMatchObject({ name: "AbortError" });
    expect(seen!.aborted).toBe(false);
    cb.abort();
    await expect(b).rejects.toMatchObject({ name: "AbortError" });
    expect(seen!.aborted).toBe(true);
  });

  it("exposes the band model for legends", () => {
    const source = new COGContourSource({
      id: "bands",
      geotiff: "https://example.com/dem.tif",
      thresholds: [100, 200],
      includeLower: true,
      createBackend: () => fakeBackend(),
    });
    expect(source.getBands()).toEqual([
      { band: 0, max: 100 },
      { band: 1, min: 100, max: 200 },
      { band: 2, min: 200 },
    ]);
  });

  it("destroys the backend and unregisters the protocol", async () => {
    const backend = fakeBackend();
    const registry = fakeRegistry();
    const source = make(backend);
    source.register(registry);
    await source.getSourceSpecification();
    source.destroy();
    expect(backend.destroy).toHaveBeenCalledTimes(1);
    expect(registry.protocols.size).toBe(0);
  });

  it("validates options", () => {
    expect(
      () =>
        new COGContourSource({
          id: "",
          geotiff: "https://example.com/dem.tif",
          thresholds: [1],
        }),
    ).toThrow(RangeError);
    expect(
      () =>
        new COGContourSource({
          id: "x",
          geotiff: "https://example.com/dem.tif",
          thresholds: [2, 1],
        }),
    ).toThrow(RangeError);
  });
});
