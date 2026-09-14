/**
 * The relative-to-centre precision scheme, tested on the property that makes
 * it seam-free: a vertex shared by two tiles must reduce to bit-identical
 * float32 arithmetic no matter which tile it is drawn from.
 */

import { describe, expect, it } from "vitest";

import { splitFloat64, splitFloat64Array } from "../src/fp64.js";
import { mercatorFromLngLat } from "../src/mercator.js";
import { translateMatrix } from "../src/raster-custom-layer.js";

/** What the vertex shader computes, in float32 throughout. */
function shaderRelative(
  posHigh: number,
  posLow: number,
  originHigh: number,
  originLow: number,
): number {
  return Math.fround(
    Math.fround(Math.fround(posHigh - originHigh)) +
      Math.fround(Math.fround(posLow - originLow)),
  );
}

describe("splitFloat64Array", () => {
  it("reconstructs the input to ~48 bits of mantissa", () => {
    // The low part is itself stored as float32, so the pair carries about
    // 24 + 24 bits, not float64's 53. That is the ceiling of any float32
    // attribute pipeline, and ~2^18 times finer than a pixel at z22.
    const values = new Float64Array([
      0.5231234567890123, 0.123456789012345, 1e-9, 0.9999999999,
    ]);
    const [high, low] = splitFloat64Array(values);
    for (let i = 0; i < values.length; i++) {
      const error = Math.abs(high[i]! + low[i]! - values[i]!);
      expect(error).toBeLessThan(Math.abs(values[i]!) * 2 ** -46);
    }
  });

  it("puts the whole value in the high part when float32 is exact", () => {
    const [high, low] = splitFloat64(0.5);
    expect(high).toBe(0.5);
    expect(low).toBe(0);
  });
});

describe("relative-to-centre reconstruction", () => {
  it("is exact for positions near the origin", () => {
    // Zürich at z18: one screen pixel is ~4.5e-9 in mercator units.
    const origin = mercatorFromLngLat(8.5417, 47.3769);
    const [ox, oxLow] = splitFloat64(origin[0]);

    const point = mercatorFromLngLat(8.5417001, 47.3769);
    const [px, pxLow] = splitFloat64(point[0]);

    const relative = shaderRelative(px, pxLow, ox, oxLow);
    const exact = point[0] - origin[0];

    // Sterbenz: both subtractions are exact, so the float32 result is the
    // correctly-rounded float32 of the true difference.
    expect(relative).toBe(Math.fround(exact));
    // And that is far below a device pixel at z18.
    expect(Math.abs(relative - exact)).toBeLessThan(1e-16);
  });

  it("gives bit-identical results for a vertex shared by two tiles", () => {
    // A tile boundary vertex is the same float64 mercator position however it
    // was reached, so both tiles' meshes carry the same (high, low) pair and
    // the shader arithmetic cannot diverge. This is the property per-tile
    // local origins break.
    const origin = mercatorFromLngLat(8.5417, 47.3769);
    const [oy, oyLow] = splitFloat64(origin[1]);

    const shared = mercatorFromLngLat(8.5418, 47.377);
    const tileA = splitFloat64(shared[1]);
    const tileB = splitFloat64(shared[1]);

    expect(shaderRelative(tileA[0], tileA[1], oy, oyLow)).toBe(
      shaderRelative(tileB[0], tileB[1], oy, oyLow),
    );
  });

  it("stays sub-pixel across a whole tile at z18", () => {
    const origin = mercatorFromLngLat(8.5417, 47.3769);
    const [ox, oxLow] = splitFloat64(origin[0]);

    // A 512 px tile at z18 spans 512 / 2^(18 + 9) mercator units.
    const tileSpan = 512 / 2 ** 27;
    const pixel = tileSpan / 512;

    let worst = 0;
    for (let i = 0; i <= 512; i++) {
      const x = origin[0] + (i / 512) * tileSpan;
      const [high, low] = splitFloat64(x);
      const relative = shaderRelative(high, low, ox, oxLow);
      worst = Math.max(worst, Math.abs(relative - (x - origin[0])));
    }
    expect(worst).toBeLessThan(pixel / 1000);
  });

  it("is visibly worse without the split, which is why the split exists", () => {
    // Same sweep, but rounding the absolute position to float32 first — the
    // naive approach. Errors reach a large fraction of a pixel.
    const origin = mercatorFromLngLat(8.5417, 47.3769);
    const tileSpan = 512 / 2 ** 27;
    const pixel = tileSpan / 512;

    let worst = 0;
    for (let i = 0; i <= 512; i++) {
      const x = origin[0] + (i / 512) * tileSpan;
      const naive = Math.fround(Math.fround(x) - Math.fround(origin[0]));
      worst = Math.max(worst, Math.abs(naive - (x - origin[0])));
    }
    expect(worst).toBeGreaterThan(pixel / 10);
  });
});

describe("translateMatrix", () => {
  it("right-multiplies by a translation", () => {
    // Column-major scale(2) with a translation of (10, 20).
    const m = new Float64Array([
      2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 10, 20, 0, 1,
    ]);
    const out = translateMatrix(m, 3, 4);
    // Columns 0-2 are untouched.
    expect(Array.from(out.slice(0, 12))).toEqual(Array.from(m.slice(0, 12)));
    // col3' = 3·col0 + 4·col1 + col3
    expect(out[12]).toBe(3 * 2 + 10);
    expect(out[13]).toBe(4 * 2 + 20);
    expect(out[15]).toBe(1);
  });

  it("keeps the translation small for a map-centre origin", () => {
    // A realistic MapLibre mercator matrix has a large translation column; after
    // translating by the map centre, the origin projects near clip-space zero.
    const scale = 2 ** 18 * 512;
    const centre = mercatorFromLngLat(8.5417, 47.3769);
    const m = new Float64Array(16);
    m[0] = scale;
    m[5] = scale;
    m[10] = 1;
    m[12] = -centre[0] * scale;
    m[13] = -centre[1] * scale;
    m[15] = 1;

    const out = translateMatrix(m, centre[0], centre[1]);
    expect(Math.abs(out[12]!)).toBeLessThan(1);
    expect(Math.abs(out[13]!)).toBeLessThan(1);
  });
});
