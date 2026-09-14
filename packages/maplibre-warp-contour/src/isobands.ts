/**
 * Exact isobands from cumulative threshold regions, without a boolean
 * clipping library.
 *
 * `d3-contour` yields, per threshold `t_i`, the region `P_i = { v ≥ t_i }` on
 * the same grid, so `P_{i+1} ⊂ P_i`. The band `[t_i, t_{i+1})` is
 * `P_i \ P_{i+1}`, whose boundary is the union of both regions' rings. Under
 * the even-odd rule that union already describes the band, so all that is
 * left is to rebuild ring nesting by containment (parent = smallest enclosing
 * ring; even depth = outer, odd = hole of its parent) and orient rings the
 * way MVT expects.
 *
 * Grid coordinates: sample `(i, j)` at `(i, j)`. `d3-contour` places sample
 * `k` at `k + 0.5` and extends regions half a cell beyond the outermost
 * samples; padding the grid with a `NaN` border makes its smoothing snap the
 * boundary onto the outermost valid sample instead, and a `−1.5` shift then
 * brings the coordinates back.
 */

import { contours } from "d3-contour";

import { validateGrid, validateThresholds } from "./isolines.js";

/** Interleaved grid coordinates, closed (first point repeated). */
export type Ring = Float64Array;

export interface Isoband {
  band: number;
  /** Lower bound, absent for the open lower band. */
  min?: number;
  /** Upper bound, absent for the open upper band. */
  max?: number;
  /** `polygons[k][0]` is the outer ring (positive area), the rest holes. */
  polygons: Ring[][];
}

export interface IsobandOptions {
  /** Emit the band below the first threshold. @default false */
  includeLower?: boolean;
  /** Emit the band above the last threshold. @default true */
  includeUpper?: boolean;
}

export function buildIsobands(
  grid: Float32Array,
  n: number,
  thresholds: readonly number[],
  options: IsobandOptions,
): Isoband[] {
  validateGrid(grid, n);
  if (thresholds.length === 0) {
    throw new RangeError("at least one threshold is required");
  }
  validateThresholds(thresholds);
  const includeLower = options.includeLower ?? false;
  const includeUpper = options.includeUpper ?? true;

  const padded = padWithNaN(grid, n);
  const m = n + 2;
  const generator = contours().size([m, m]).smooth(true);

  const cumulative = thresholds.map((t) =>
    ringsOf(generator.thresholds([t])(padded as unknown as number[])[0]!, m),
  );

  const result: Isoband[] = [];
  let band = 0;
  if (includeLower) {
    const finite = Float32Array.from(padded, (v) =>
      Number.isFinite(v) ? 1 : Number.NaN,
    );
    const finiteRings = ringsOf(
      generator.thresholds([0.5])(finite as unknown as number[])[0]!,
      m,
    );
    const polygons = nest([...finiteRings, ...cumulative[0]!]);
    if (polygons.length > 0) {
      result.push({ band, max: thresholds[0]!, polygons });
    }
    band++;
  }
  for (let k = 0; k < thresholds.length; k++, band++) {
    const isLast = k === thresholds.length - 1;
    if (isLast && !includeUpper) {
      break;
    }
    const rings = isLast
      ? cumulative[k]!
      : [...cumulative[k]!, ...cumulative[k + 1]!];
    const polygons = nest(rings);
    if (polygons.length === 0) {
      continue;
    }
    const entry: Isoband = { band, min: thresholds[k]!, polygons };
    if (!isLast) {
      entry.max = thresholds[k + 1]!;
    }
    result.push(entry);
  }
  return result;
}

function padWithNaN(grid: Float32Array, n: number): Float32Array {
  const m = n + 2;
  const out = new Float32Array(m * m).fill(Number.NaN);
  for (let j = 0; j < n; j++) {
    out.set(grid.subarray(j * n, (j + 1) * n), (j + 1) * m + 1);
  }
  return out;
}

/** Flatten a d3 MultiPolygon into closed rings in grid coordinates. */
function ringsOf(
  geometry: { coordinates: number[][][][] },
  _paddedSize: number,
): Ring[] {
  const rings: Ring[] = [];
  for (const polygon of geometry.coordinates) {
    for (const ring of polygon) {
      const out = new Float64Array(2 * ring.length);
      ring.forEach(([x, y], k) => {
        out[2 * k] = x! - 1.5;
        out[2 * k + 1] = y! - 1.5;
      });
      rings.push(out);
    }
  }
  return rings;
}

/** Standard shoelace: positive = clockwise on a y-down grid (MVT outer). */
export function signedArea(ring: Ring): number {
  let sum = 0;
  const count = ring.length / 2 - 1; // closed ring
  for (let k = 0; k < count; k++) {
    sum +=
      ring[2 * k]! * ring[2 * k + 3]! - ring[2 * k + 2]! * ring[2 * k + 1]!;
  }
  return sum / 2;
}

function reversed(ring: Ring): Ring {
  const count = ring.length / 2;
  const out = new Float64Array(ring.length);
  for (let k = 0; k < count; k++) {
    out[2 * k] = ring[2 * (count - 1 - k)]!;
    out[2 * k + 1] = ring[2 * (count - 1 - k) + 1]!;
  }
  return out;
}

function pointInRing(ring: Ring, x: number, y: number): boolean {
  let inside = false;
  const count = ring.length / 2 - 1;
  for (let k = 0, m = count - 1; k < count; m = k++) {
    const xi = ring[2 * k]!;
    const yi = ring[2 * k + 1]!;
    const xm = ring[2 * m]!;
    const ym = ring[2 * m + 1]!;
    if (yi > y !== ym > y && x < ((xm - xi) * (y - yi)) / (ym - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/** Does `outer` contain `inner`? Rings never cross, so one clear vertex decides. */
function contains(outer: Ring, inner: Ring): boolean {
  // Prefer edge midpoints of `inner`: a vertex may coincide with a vertex of
  // `outer` where the two regions touch, a midpoint of a non-shared edge
  // cannot.
  const count = inner.length / 2 - 1;
  for (let k = 0; k < count; k++) {
    const x = (inner[2 * k]! + inner[2 * k + 2]!) / 2;
    const y = (inner[2 * k + 1]! + inner[2 * k + 3]!) / 2;
    if (!onRing(outer, x, y)) {
      return pointInRing(outer, x, y);
    }
  }
  return false;
}

function onRing(ring: Ring, x: number, y: number): boolean {
  const count = ring.length / 2 - 1;
  for (let k = 0; k < count; k++) {
    const x0 = ring[2 * k]!;
    const y0 = ring[2 * k + 1]!;
    const x1 = ring[2 * k + 2]!;
    const y1 = ring[2 * k + 3]!;
    const cross = (x - x0) * (y1 - y0) - (y - y0) * (x1 - x0);
    if (Math.abs(cross) > 1e-9) {
      continue;
    }
    if (
      x >= Math.min(x0, x1) - 1e-9 &&
      x <= Math.max(x0, x1) + 1e-9 &&
      y >= Math.min(y0, y1) - 1e-9 &&
      y <= Math.max(y0, y1) + 1e-9
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Remove rings that occur twice. Two regions sharing an entire boundary ring
 * (the finite region and `P_0` when the whole grid is above the first
 * threshold, for instance) enclose nothing between them, and under the
 * even-odd rule the pair cancels.
 */
function cancelDuplicates(rings: Ring[]): Ring[] {
  const keyOf = (ring: Ring): string => {
    const count = ring.length / 2 - 1;
    const points: string[] = [];
    for (let k = 0; k < count; k++) {
      points.push(`${ring[2 * k]},${ring[2 * k + 1]}`);
    }
    return points.sort().join(";");
  };
  const seen = new Map<string, number>();
  rings.forEach((ring, k) => {
    const key = keyOf(ring);
    if (seen.has(key)) {
      seen.set(key, -1 - k - rings.length * seen.get(key)!);
    } else {
      seen.set(key, k);
    }
  });
  const drop = new Set<number>();
  for (const value of seen.values()) {
    if (value < 0) {
      const encoded = -1 - value;
      drop.add(encoded % rings.length);
      drop.add(Math.floor(encoded / rings.length));
    }
  }
  return rings.filter((_, k) => !drop.has(k));
}

/**
 * Group rings into polygons by containment depth and orient them: outer
 * rings positive, holes negative.
 */
export function nest(input: Ring[]): Ring[][] {
  const rings = cancelDuplicates(input);
  const areas = rings.map((r) => Math.abs(signedArea(r)));
  const parent = rings.map((ring, k) => {
    let best = -1;
    for (let o = 0; o < rings.length; o++) {
      if (o === k || areas[o]! <= areas[k]!) {
        continue;
      }
      if (
        contains(rings[o]!, ring) &&
        (best === -1 || areas[o]! < areas[best]!)
      ) {
        best = o;
      }
    }
    return best;
  });
  const depth = rings.map((_, k) => {
    let d = 0;
    for (let p = parent[k]!; p !== -1; p = parent[p]!) {
      d++;
    }
    return d;
  });

  const oriented = rings.map((ring, k) => {
    const wantPositive = depth[k]! % 2 === 0;
    return signedArea(ring) > 0 === wantPositive ? ring : reversed(ring);
  });

  const polygons: Ring[][] = [];
  const polygonOf = new Map<number, Ring[]>();
  rings.forEach((_, k) => {
    if (depth[k]! % 2 === 0) {
      const polygon = [oriented[k]!];
      polygonOf.set(k, polygon);
      polygons.push(polygon);
    }
  });
  rings.forEach((_, k) => {
    if (depth[k]! % 2 === 1) {
      polygonOf.get(parent[k]!)!.push(oriented[k]!);
    }
  });
  return polygons;
}
