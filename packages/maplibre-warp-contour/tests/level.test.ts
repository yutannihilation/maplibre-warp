import { describe, expect, it } from "vitest";

import { selectLevel, tileMetersPerPixel } from "../src/level.js";

const EARTH_CIRCUMFERENCE = 40075016.686;

describe("tileMetersPerPixel", () => {
  it("is the equatorial circumference over the pixel count at the equator", () => {
    expect(tileMetersPerPixel(0, 0, 256)).toBeCloseTo(
      EARTH_CIRCUMFERENCE / 256,
      6,
    );
    expect(tileMetersPerPixel(10, 0, 256)).toBeCloseTo(
      EARTH_CIRCUMFERENCE / (256 * 1024),
      6,
    );
  });

  it("shrinks with the cosine of latitude", () => {
    expect(tileMetersPerPixel(5, 60, 256)).toBeCloseTo(
      (EARTH_CIRCUMFERENCE * 0.5) / (256 * 32),
      6,
    );
  });
});

describe("selectLevel", () => {
  // Coarsest first, halving each level.
  const levels = [1000, 500, 250, 125];

  it("picks the coarsest level whose pixels are no larger than a tile pixel", () => {
    // Tile pixel of 600 m: level 0 (1000 m) is too coarse, level 1 (500 m) fits.
    const z = Math.log2(EARTH_CIRCUMFERENCE / (256 * 600));
    expect(selectLevel(levels, z, 0, 256)).toBe(1);
  });

  it("accepts an exact match", () => {
    const z = Math.log2(EARTH_CIRCUMFERENCE / (256 * 250));
    expect(selectLevel(levels, z, 0, 256)).toBe(2);
  });

  it("falls back to the finest level when the tile is finer than all levels", () => {
    expect(selectLevel(levels, 22, 0, 256)).toBe(3);
  });

  it("returns the coarsest level for very small zooms", () => {
    expect(selectLevel(levels, 0, 0, 256)).toBe(0);
  });

  it("rejects empty level lists and non-finite inputs", () => {
    expect(() => selectLevel([], 5, 0, 256)).toThrow(RangeError);
    expect(() => selectLevel(levels, Number.NaN, 0, 256)).toThrow(RangeError);
    expect(() => selectLevel(levels, 5, Number.POSITIVE_INFINITY, 256)).toThrow(
      RangeError,
    );
  });
});
