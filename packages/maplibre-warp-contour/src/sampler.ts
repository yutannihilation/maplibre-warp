/**
 * Bilinear sampling of a raster window in level pixel space.
 */

import type { RasterTypedArray } from "@developmentseed/geotiff";

/** A rectangular window of one level's pixels, pixel-interleaved. */
export interface PixelWindow {
  /** Level pixel column of the window's first column. */
  x0: number;
  /** Level pixel row of the window's first row. */
  y0: number;
  width: number;
  height: number;
  data: RasterTypedArray;
  /** Samples per pixel. */
  stride: number;
  /** Index of the band to read within a pixel. */
  offset: number;
  nodata: number | null;
  /** Validity mask, one byte per pixel, 0 = missing. */
  mask: Uint8Array | null;
}

export type Sampler = (px: number, py: number) => number;

/**
 * Bilinear interpolation between the four pixel centres around `(px, py)`.
 * Any contributing pixel that is nodata, masked or outside the window makes
 * the result `NaN`, so no-data never bleeds into interpolated values.
 */
export function createBilinearSampler(window: PixelWindow): Sampler {
  const { x0, y0, width, height, data, stride, offset, nodata, mask } = window;

  const read = (col: number, row: number): number => {
    if (col < 0 || row < 0 || col >= width || row >= height) {
      return Number.NaN;
    }
    const p = row * width + col;
    if (mask && mask[p] === 0) {
      return Number.NaN;
    }
    const v = data[p * stride + offset]!;
    if (nodata !== null && v === nodata) {
      return Number.NaN;
    }
    return v;
  };

  return (px, py) => {
    if (!Number.isFinite(px) || !Number.isFinite(py)) {
      return Number.NaN;
    }
    // Pixel centres sit at integer + 0.5.
    const fx = px - x0 - 0.5;
    const fy = py - y0 - 0.5;
    const c0 = Math.floor(fx);
    const r0 = Math.floor(fy);
    const u = fx - c0;
    const v = fy - r0;
    // Neighbours with zero weight do not contribute, so a sample exactly on
    // the last pixel centre must not fail because the pixel beyond is missing.
    const v00 = read(c0, r0);
    const v10 = u === 0 ? 0 : read(c0 + 1, r0);
    const v01 = v === 0 ? 0 : read(c0, r0 + 1);
    const v11 = u === 0 || v === 0 ? 0 : read(c0 + 1, r0 + 1);
    return (
      (1 - u) * (1 - v) * v00 +
      u * (1 - v) * v10 +
      (1 - u) * v * v01 +
      u * v * v11
    );
  };
}

/** Evaluate `sampler` at every interleaved `(x, y)` pair. */
export function resampleGrid(
  pixelCoords: Float64Array,
  sampler: Sampler,
): Float32Array {
  const n = pixelCoords.length / 2;
  const out = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    out[k] = sampler(pixelCoords[2 * k]!, pixelCoords[2 * k + 1]!);
  }
  return out;
}
