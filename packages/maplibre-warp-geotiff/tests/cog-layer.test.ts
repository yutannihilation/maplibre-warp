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
});
