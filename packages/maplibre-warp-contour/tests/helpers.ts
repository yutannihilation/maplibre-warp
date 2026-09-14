/** Shared test helpers for contour geometry. */

/** Build a row-major grid from a function of sample indices. */
export function makeGrid(
  n: number,
  f: (i: number, j: number) => number,
): Float32Array {
  const grid = new Float32Array(n * n);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      grid[j * n + i] = f(i, j);
    }
  }
  return grid;
}

/**
 * Surveyor's formula on an interleaved ring. Positive means clockwise on a
 * y-down grid, which is the MVT convention for exterior rings.
 */
export function signedArea(ring: ArrayLike<number>): number {
  let sum = 0;
  const n = ring.length / 2;
  for (let k = 0; k < n; k++) {
    const x0 = ring[2 * k]!;
    const y0 = ring[2 * k + 1]!;
    const k1 = (k + 1) % n;
    const x1 = ring[2 * k1]!;
    const y1 = ring[2 * k1 + 1]!;
    sum += x0 * y1 - x1 * y0;
  }
  return sum / 2;
}

/** Even-odd point-in-ring test on an interleaved ring. */
export function pointInRing(
  ring: ArrayLike<number>,
  x: number,
  y: number,
): boolean {
  let inside = false;
  const n = ring.length / 2;
  for (let k = 0, m = n - 1; k < n; m = k++) {
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

/** Point in polygon (outer ring minus holes). */
export function pointInPolygon(
  polygon: ArrayLike<number>[],
  x: number,
  y: number,
): boolean {
  if (!pointInRing(polygon[0]!, x, y)) {
    return false;
  }
  for (let h = 1; h < polygon.length; h++) {
    if (pointInRing(polygon[h]!, x, y)) {
      return false;
    }
  }
  return true;
}
