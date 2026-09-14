import { describe, expect, it } from "vitest";

import {
  bandColorImage,
  bandsFromThresholds,
  parseCssColor,
  resolveBandColors,
} from "../src/gpu-modules/contour-bands.js";

describe("bandsFromThresholds", () => {
  it("emits closed bands plus an open upper band by default", () => {
    expect(bandsFromThresholds([100, 200], {})).toEqual([
      { band: 0, min: 100, max: 200 },
      { band: 1, min: 200 },
    ]);
  });

  it("adds an open lower band and can drop the upper one", () => {
    expect(
      bandsFromThresholds([100, 200], {
        includeLower: true,
        includeUpper: false,
      }),
    ).toEqual([
      { band: 0, max: 100 },
      { band: 1, min: 100, max: 200 },
    ]);
  });

  it("rejects empty or non-increasing thresholds", () => {
    expect(() => bandsFromThresholds([], {})).toThrow(RangeError);
    expect(() => bandsFromThresholds([2, 1], {})).toThrow(RangeError);
    expect(() => bandsFromThresholds([1, Number.NaN], {})).toThrow(RangeError);
  });
});

describe("parseCssColor", () => {
  it("parses hex forms", () => {
    expect(parseCssColor("#fff")).toEqual([255, 255, 255, 255]);
    expect(parseCssColor("#f008")).toEqual([255, 0, 0, 136]);
    expect(parseCssColor("#1a2B3c")).toEqual([26, 43, 60, 255]);
    expect(parseCssColor("#1a2b3c80")).toEqual([26, 43, 60, 128]);
  });

  it("parses rgb() and rgba() with commas, spaces and percentages", () => {
    expect(parseCssColor("rgb(86, 139, 84)")).toEqual([86, 139, 84, 255]);
    expect(parseCssColor("rgba(86,139,84,0.5)")).toEqual([86, 139, 84, 128]);
    expect(parseCssColor("rgb(50% 0% 100% / 25%)")).toEqual([128, 0, 255, 64]);
    expect(parseCssColor(" RGB(1 2 3) ")).toEqual([1, 2, 3, 255]);
  });

  it("rejects anything else explicitly", () => {
    for (const bad of ["red", "hsl(0 0% 0%)", "#12", "rgb(1,2)", "", "#ggg"]) {
      expect(() => parseCssColor(bad)).toThrow(RangeError);
    }
  });
});

describe("resolveBandColors", () => {
  it("passes an array of the right length through", () => {
    expect(resolveBandColors(["#000", "#fff"], 2)).toEqual(["#000", "#fff"]);
  });

  it("rejects a length mismatch", () => {
    expect(() => resolveBandColors(["#000"], 2)).toThrow(RangeError);
  });

  it("evaluates a colour function at normalised positions", () => {
    const seen: Array<[number, number, number]> = [];
    const colors = resolveBandColors((t, index, count) => {
      seen.push([t, index, count]);
      return `rgb(${Math.round(t * 255)}, 0, 0)`;
    }, 3);
    expect(seen).toEqual([
      [0, 0, 3],
      [0.5, 1, 3],
      [1, 2, 3],
    ]);
    expect(colors).toEqual([
      "rgb(0, 0, 0)",
      "rgb(128, 0, 0)",
      "rgb(255, 0, 0)",
    ]);
  });

  it("uses t = 0 for a single band", () => {
    expect(resolveBandColors((t) => `rgb(${t}, 0, 0)`, 1)).toEqual([
      "rgb(0, 0, 0)",
    ]);
  });
});

describe("bandColorImage", () => {
  it("packs parsed colours into an n×1 RGBA8 row", () => {
    const image = bandColorImage(["#ff0000", "rgba(0, 0, 255, 0.5)"]);
    expect(image.width).toBe(2);
    expect(image.height).toBe(1);
    expect(Array.from(image.data)).toEqual([255, 0, 0, 255, 0, 0, 255, 128]);
  });
});
