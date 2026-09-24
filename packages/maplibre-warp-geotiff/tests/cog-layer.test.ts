import { describe, expect, it, vi } from "vitest";

import { COGLayer } from "../src/cog-layer.js";

const geotiff = "https://example.com/dem.tif";

describe("COGLayer opacity", () => {
  it("defaults to 1 and validates the range", () => {
    expect(new COGLayer({ id: "o1", geotiff }).opacity).toBe(1);
    expect(new COGLayer({ id: "o2", geotiff, opacity: 0.25 }).opacity).toBe(
      0.25,
    );
    expect(() => new COGLayer({ id: "o3", geotiff, opacity: 1.5 })).toThrow(
      RangeError,
    );
    expect(() => new COGLayer({ id: "o4", geotiff, opacity: NaN })).toThrow(
      RangeError,
    );
  });

  it("setOpacity replaces the value and rejects out-of-range input", () => {
    const layer = new COGLayer({ id: "o5", geotiff });
    layer.setOpacity(0.5);
    expect(layer.opacity).toBe(0.5);
    expect(() => layer.setOpacity(-0.1)).toThrow(RangeError);
    expect(layer.opacity).toBe(0.5);
  });
});

describe("COGLayer prerender", () => {
  it("is a no-op before the COG has opened", () => {
    const layer = new COGLayer({ id: "p", geotiff });
    const gl = {} as WebGL2RenderingContext;
    const args = {} as Parameters<COGLayer["prerender"]>[1];
    expect(() => layer.prerender(gl, args)).not.toThrow();
  });

  it("creates the layer-wide textures before uploading tiles", () => {
    // Tiles built in this frame reference the colormap and contour colours,
    // so `prepare` must run first: the other way round, every palette or
    // contour tile would fail with "call prepare(gl) first".
    const calls: string[] = [];
    const layer = new COGLayer({ id: "o", geotiff });
    // Both are private and only exist once the COG has opened.
    Object.assign(layer as object, {
      renderer: { prepare: () => calls.push("prepare") },
      scheduler: { uploadPending: () => calls.push("upload") },
    });
    const gl = {} as WebGL2RenderingContext;
    layer.prerender(gl, {} as Parameters<COGLayer["prerender"]>[1]);
    expect(calls).toEqual(["prepare", "upload"]);
  });

  it("logs a failed prepare instead of throwing out of MapLibre's render loop", () => {
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    try {
      const layer = new COGLayer({ id: "q", geotiff });
      const prepare = vi.fn(() => {
        throw new Error("Failed to create WebGL texture");
      });
      // The renderer is private and only exists once the COG has opened.
      (layer as unknown as { renderer: { prepare: () => void } }).renderer = {
        prepare,
      };
      const gl = {} as WebGL2RenderingContext;
      const args = {} as Parameters<COGLayer["prerender"]>[1];
      expect(() => layer.prerender(gl, args)).not.toThrow();
      expect(prepare).toHaveBeenCalledTimes(1);
      expect(error).toHaveBeenCalledTimes(1);
      expect(String(error.mock.calls[0]?.[0])).toContain("[q]");
    } finally {
      error.mockRestore();
    }
  });
});

describe("COGLayer contour configuration", () => {
  it("fails fast in the constructor on any contour configuration error", () => {
    expect(
      () =>
        new COGLayer({
          id: "a",
          geotiff,
          contour: { thresholds: [1, 2], bands: { colors: ["red", "#fff"] } },
        }),
    ).toThrow(RangeError);
    expect(
      () =>
        new COGLayer({
          id: "b",
          geotiff,
          contour: { thresholds: [1], fill: "none", lines: false },
        }),
    ).toThrow(RangeError);
    expect(
      () =>
        new COGLayer({
          id: "c",
          geotiff,
          contour: { thresholds: Array.from({ length: 65 }, (_, i) => i) },
        }),
    ).toThrow(RangeError);
  });

  it("exposes the band model with colours before the COG is opened", () => {
    const layer = new COGLayer({
      id: "d",
      geotiff,
      contour: {
        thresholds: [100, 200],
        bands: { colors: ["#000"], includeUpper: false },
      },
    });
    expect(layer.getBands()).toEqual([
      { band: 0, min: 100, max: 200, color: "#000" },
    ]);
    expect(new COGLayer({ id: "e", geotiff }).getBands()).toEqual([]);
  });

  it("exposes the gradient model instead when the fill is a gradient", () => {
    const layer = new COGLayer({
      id: "d2",
      geotiff,
      contour: {
        thresholds: [100, 150, 200],
        fill: "gradient",
        bands: { colors: ["#000", "#fff"] },
      },
    });
    expect(layer.getBands()).toEqual([]);
    expect(layer.getGradient()).toEqual({
      min: 100,
      max: 200,
      stops: ["#000", "#fff"],
    });
    // A copy: mutating it does not reach the layer.
    layer.getGradient()!.stops.push("#f00");
    expect(layer.getGradient()!.stops).toHaveLength(2);
    expect(new COGLayer({ id: "e2", geotiff }).getGradient()).toBeNull();
  });

  describe("setContour", () => {
    const initial = {
      thresholds: [100, 200],
      bands: { colors: ["#000", "#fff"] },
    };

    it("replaces the options before the layer is added", () => {
      const layer = new COGLayer({ id: "f", geotiff, contour: initial });
      layer.setContour({
        thresholds: [1, 2, 3],
        bands: { colors: (t) => `rgb(${Math.round(t * 255)}, 0, 0)` },
      });
      expect(layer.getBands().map((b) => b.color)).toEqual([
        "rgb(0, 0, 0)",
        "rgb(128, 0, 0)",
        "rgb(255, 0, 0)",
      ]);
    });

    it("switches the fill mode before the layer is added", () => {
      const layer = new COGLayer({ id: "f2", geotiff, contour: initial });
      layer.setContour({ ...initial, fill: "gradient" });
      expect(layer.getBands()).toEqual([]);
      expect(layer.getGradient()).toEqual({
        min: 100,
        max: 200,
        stops: ["#000", "#fff"],
      });
      layer.setContour({ thresholds: [100], fill: "none" });
      expect(layer.getBands()).toEqual([]);
      expect(layer.getGradient()).toBeNull();
    });

    it("validates the new options and keeps the old ones on failure", () => {
      const layer = new COGLayer({ id: "g", geotiff, contour: initial });
      expect(() =>
        layer.setContour({ thresholds: [2, 1], bands: initial.bands }),
      ).toThrow(RangeError);
      expect(layer.getBands()).toHaveLength(2);
    });

    it("refuses on a layer created without contour", () => {
      const layer = new COGLayer({ id: "h", geotiff });
      expect(() => layer.setContour(initial)).toThrow(RangeError);
      expect(layer.getBands()).toEqual([]);
    });
  });
});
