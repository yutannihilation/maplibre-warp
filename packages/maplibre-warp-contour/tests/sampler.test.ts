import { describe, expect, it } from "vitest";

import { createBilinearSampler, resampleGrid } from "../src/sampler.js";

/** A 3×2 single-band window at pixel origin (10, 20). */
const window3x2 = {
  x0: 10,
  y0: 20,
  width: 3,
  height: 2,
  data: new Float32Array([1, 2, 3, 4, 5, 6]),
  stride: 1,
  offset: 0,
  nodata: null,
  mask: null,
};

describe("createBilinearSampler", () => {
  it("returns the pixel value at a pixel centre", () => {
    const sample = createBilinearSampler(window3x2);
    expect(sample(10.5, 20.5)).toBe(1);
    expect(sample(12.5, 21.5)).toBe(6);
  });

  it("interpolates linearly between neighbouring centres", () => {
    const sample = createBilinearSampler(window3x2);
    expect(sample(11, 20.5)).toBeCloseTo(1.5, 12);
    expect(sample(10.5, 21)).toBeCloseTo(2.5, 12);
    expect(sample(11, 21)).toBeCloseTo(3, 12);
  });

  it("returns NaN when any contributing pixel lies outside the window", () => {
    const sample = createBilinearSampler(window3x2);
    expect(sample(10.4, 20.5)).toBeNaN();
    expect(sample(12.6, 20.5)).toBeNaN();
    expect(sample(11, 21.6)).toBeNaN();
  });

  it("returns NaN for non-finite coordinates", () => {
    const sample = createBilinearSampler(window3x2);
    expect(sample(Number.NaN, 20.5)).toBeNaN();
  });

  it("treats the nodata sentinel as missing", () => {
    const sample = createBilinearSampler({
      ...window3x2,
      data: new Int16Array([1, -9999, 3, 4, 5, 6]),
      nodata: -9999,
    });
    expect(sample(10.5, 20.5)).toBe(1);
    expect(sample(11, 20.5)).toBeNaN();
  });

  it("treats masked pixels as missing", () => {
    const sample = createBilinearSampler({
      ...window3x2,
      mask: new Uint8Array([1, 1, 1, 1, 0, 1]),
    });
    expect(sample(11.5, 21.5)).toBeNaN();
    expect(sample(11, 20.5)).toBeCloseTo(1.5, 12);
  });

  it("reads one band out of pixel-interleaved data", () => {
    const sample = createBilinearSampler({
      ...window3x2,
      data: new Uint16Array([1, 100, 2, 200, 3, 300, 4, 400, 5, 500, 6, 600]),
      stride: 2,
      offset: 1,
    });
    expect(sample(10.5, 20.5)).toBe(100);
    expect(sample(12.5, 21.5)).toBe(600);
  });
});

describe("resampleGrid", () => {
  it("evaluates the sampler at every interleaved coordinate pair", () => {
    const coords = new Float64Array([10.5, 20.5, 12.5, 21.5, Number.NaN, 0]);
    const out = resampleGrid(coords, createBilinearSampler(window3x2));
    expect(out).toBeInstanceOf(Float32Array);
    expect(Array.from(out)).toEqual([1, 6, Number.NaN]);
  });
});
