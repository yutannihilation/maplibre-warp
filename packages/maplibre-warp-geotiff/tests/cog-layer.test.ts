import { describe, expect, it } from "vitest";

import { COGLayer } from "../src/cog-layer.js";

const geotiff = "https://example.com/dem.tif";

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
          contour: { thresholds: [1], bands: false, lines: false },
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
