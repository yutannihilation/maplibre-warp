import { describe, expect, it } from "vitest";

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

describe("COGLayer imagery configuration", () => {
  it("fails fast in the constructor on a malformed selection or stretch", () => {
    expect(() => new COGLayer({ id: "i1", geotiff, bands: [0, 1] })).toThrow(
      RangeError,
    );
    expect(() => new COGLayer({ id: "i2", geotiff, bands: [-1] })).toThrow(
      RangeError,
    );
    expect(
      () => new COGLayer({ id: "i3", geotiff, rescale: [2000, 0] }),
    ).toThrow(RangeError);
    expect(
      () =>
        new COGLayer({
          id: "i4",
          geotiff,
          bands: [4, 2, 1],
          rescale: [
            [0, 1],
            [0, 1],
          ],
        }),
    ).toThrow(RangeError);
  });

  it("accepts what only the file can check, deferring the rest", () => {
    // Band 12 may or may not exist: that is checked when the header is read.
    expect(
      () => new COGLayer({ id: "i5", geotiff, bands: [12], rescale: [0, 1] }),
    ).not.toThrow();
  });

  it("setBands and setRescale validate before the layer is added", () => {
    const layer = new COGLayer({ id: "i6", geotiff, bands: [4, 2, 1] });
    expect(() => layer.setBands([6, 4, 2], [0, 3000])).not.toThrow();
    expect(() => layer.setBands([0, 1])).toThrow(RangeError);
    expect(() => layer.setRescale([1, 0])).toThrow(RangeError);
    // Three pairs no longer fit once a single band is selected.
    layer.setRescale([
      [0, 1],
      [0, 1],
      [0, 1],
    ]);
    expect(() => layer.setBands([6])).toThrow(/1 colour channel/);
    expect(() => layer.setRescale(undefined)).not.toThrow();
  });

  it("refuses on a layer created with contour", () => {
    const layer = new COGLayer({
      id: "i7",
      geotiff,
      contour: { thresholds: [1], fill: "none" },
    });
    expect(() => layer.setBands([0])).toThrow(RangeError);
    expect(() => layer.setRescale([0, 1])).toThrow(RangeError);
  });
});
