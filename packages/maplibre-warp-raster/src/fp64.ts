// Vendored from @developmentseed/deck.gl-raster (MIT, Development Seed):
// packages/deck.gl-raster/src/fp64.ts
// Modified: returns `[high, low]` rather than `[low, high]`, and the doc no
// longer refers to deck.gl's projection module.

/**
 * Split a Float64Array into the high + low Float32 component arrays used for
 * fp64-emulated positions on the GPU.
 *
 * For each element `v`, the high part is `Math.fround(v)` (the nearest
 * float32) and the low part is the residual `v - Math.fround(v)`, itself
 * rounded to float32 on storage. The pair therefore carries roughly 48 bits of
 * mantissa rather than float64's 53 — far more than the ~30 bits a mercator
 * `[0, 1]` position needs to stay sub-pixel at z22, and the most any float32
 * attribute pipeline can deliver.
 *
 * The vertex shader recovers that precision as
 * `(posHigh - originHigh) + (posLow - originLow)` — see `shader/sources.ts`.
 *
 * @returns `[high, low]` — both `Float32Array`s the same length as `values`.
 */
export function splitFloat64Array(
  values: Float64Array,
): [high: Float32Array, low: Float32Array] {
  const high = new Float32Array(values.length);
  const low = new Float32Array(values.length);
  for (let i = 0; i < values.length; i++) {
    const v = values[i]!;
    const hi = Math.fround(v);
    high[i] = hi;
    low[i] = v - hi;
  }
  return [high, low];
}

/** Split a single float64 into its float32 high and low components. */
export function splitFloat64(value: number): [high: number, low: number] {
  const high = Math.fround(value);
  return [high, value - high];
}
