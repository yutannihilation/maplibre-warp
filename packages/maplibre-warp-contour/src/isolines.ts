/**
 * Marching-squares isolines on a square sample grid.
 *
 * Grid coordinates: sample `(i, j)` sits at `(i, j)`; every emitted point
 * lies on a grid edge, linearly interpolated between the two samples that
 * straddle the level. Segments are joined into maximal polylines by the id of
 * the grid edge they cross, so shared edges join exactly.
 */

export interface Isoline {
  level: number;
  /** Interleaved grid coordinates; a closed ring repeats its first point. */
  lines: Float64Array[];
}

/** Which of a cell's four edges a segment endpoint lies on. */
const TOP = 0;
const RIGHT = 1;
const BOTTOM = 2;
const LEFT = 3;

/**
 * Segment table indexed by the corner mask `tl | tr<<1 | br<<2 | bl<<3`
 * (bit set = sample ≥ level). Saddles (5, 10) are resolved at run time.
 */
const SEGMENTS: ReadonlyArray<ReadonlyArray<[number, number]>> = [
  [],
  [[LEFT, TOP]],
  [[TOP, RIGHT]],
  [[LEFT, RIGHT]],
  [[RIGHT, BOTTOM]],
  [], // saddle
  [[TOP, BOTTOM]],
  [[LEFT, BOTTOM]],
  [[BOTTOM, LEFT]],
  [[TOP, BOTTOM]],
  [], // saddle
  [[BOTTOM, RIGHT]],
  [[LEFT, RIGHT]],
  [[TOP, RIGHT]],
  [[LEFT, TOP]],
  [],
];
const SADDLE_5_CONNECTED: ReadonlyArray<[number, number]> = [
  [TOP, RIGHT],
  [LEFT, BOTTOM],
];
const SADDLE_5_SPLIT: ReadonlyArray<[number, number]> = [
  [TOP, LEFT],
  [RIGHT, BOTTOM],
];
const SADDLE_10_CONNECTED: ReadonlyArray<[number, number]> = [
  [TOP, LEFT],
  [RIGHT, BOTTOM],
];
const SADDLE_10_SPLIT: ReadonlyArray<[number, number]> = [
  [TOP, RIGHT],
  [LEFT, BOTTOM],
];

export function validateThresholds(thresholds: readonly number[]): void {
  for (let k = 0; k < thresholds.length; k++) {
    const t = thresholds[k]!;
    if (!Number.isFinite(t)) {
      throw new RangeError(`threshold ${k} is not finite`);
    }
    if (k > 0 && t <= thresholds[k - 1]!) {
      throw new RangeError("thresholds must be strictly increasing");
    }
  }
}

export function validateGrid(grid: ArrayLike<number>, n: number): void {
  if (!Number.isInteger(n) || n < 2 || grid.length !== n * n) {
    throw new RangeError(
      `grid length ${grid.length} does not match gridSize ${n}`,
    );
  }
}

export function traceIsolines(
  grid: Float32Array,
  n: number,
  thresholds: readonly number[],
): Isoline[] {
  validateGrid(grid, n);
  validateThresholds(thresholds);
  return thresholds.map((level) => ({
    level,
    lines: traceLevel(grid, n, level),
  }));
}

/**
 * Edge ids: horizontal edge from `(i, j)` to `(i+1, j)` is `2·(j·n + i)`,
 * vertical edge from `(i, j)` to `(i, j+1)` is `2·(j·n + i) + 1`.
 */
function edgeId(n: number, i: number, j: number, side: number): number {
  switch (side) {
    case TOP:
      return 2 * (j * n + i);
    case BOTTOM:
      return 2 * ((j + 1) * n + i);
    case LEFT:
      return 2 * (j * n + i) + 1;
    default:
      return 2 * (j * n + i + 1) + 1;
  }
}

/** Interpolated crossing of `level` on an edge, in grid coordinates. */
function crossing(
  grid: Float32Array,
  n: number,
  id: number,
  level: number,
): [number, number] {
  const vertical = id % 2 === 1;
  const cell = (id - (vertical ? 1 : 0)) / 2;
  const i = cell % n;
  const j = (cell - i) / n;
  const a = grid[j * n + i]!;
  const b = vertical ? grid[(j + 1) * n + i]! : grid[j * n + i + 1]!;
  const t = a === b ? 0.5 : (level - a) / (b - a);
  return vertical ? [i, j + t] : [i + t, j];
}

function traceLevel(
  grid: Float32Array,
  n: number,
  level: number,
): Float64Array[] {
  // Adjacency: edge id → the (up to two) edge ids it is joined to.
  const links = new Map<number, number[]>();
  const link = (a: number, b: number): void => {
    let la = links.get(a);
    if (!la) {
      la = [];
      links.set(a, la);
    }
    la.push(b);
    let lb = links.get(b);
    if (!lb) {
      lb = [];
      links.set(b, lb);
    }
    lb.push(a);
  };

  for (let j = 0; j < n - 1; j++) {
    for (let i = 0; i < n - 1; i++) {
      const tl = grid[j * n + i]!;
      const tr = grid[j * n + i + 1]!;
      const bl = grid[(j + 1) * n + i]!;
      const br = grid[(j + 1) * n + i + 1]!;
      if (
        Number.isNaN(tl) ||
        Number.isNaN(tr) ||
        Number.isNaN(bl) ||
        Number.isNaN(br)
      ) {
        continue;
      }
      const mask =
        (tl >= level ? 1 : 0) |
        (tr >= level ? 2 : 0) |
        (br >= level ? 4 : 0) |
        (bl >= level ? 8 : 0);
      let segments = SEGMENTS[mask]!;
      if (mask === 5 || mask === 10) {
        const connected = (tl + tr + bl + br) / 4 >= level;
        segments =
          mask === 5
            ? connected
              ? SADDLE_5_CONNECTED
              : SADDLE_5_SPLIT
            : connected
              ? SADDLE_10_CONNECTED
              : SADDLE_10_SPLIT;
      }
      for (const [from, to] of segments) {
        link(edgeId(n, i, j, from), edgeId(n, i, j, to));
      }
    }
  }

  // Walk: open polylines first (from edges of degree 1), then closed loops.
  const visited = new Set<number>();
  const lines: Float64Array[] = [];
  const walk = (start: number): void => {
    const path: number[] = [start];
    visited.add(start);
    let previous = -1;
    let current = start;
    for (;;) {
      const next = links
        .get(current)!
        .find((e) => e !== previous && !visited.has(e));
      if (next === undefined) {
        // Closed loop: back to the start.
        if (links.get(current)!.includes(start) && path.length > 2) {
          path.push(start);
        }
        break;
      }
      visited.add(next);
      path.push(next);
      previous = current;
      current = next;
    }
    const out = new Float64Array(2 * path.length);
    path.forEach((id, k) => {
      const [x, y] = crossing(grid, n, id, level);
      out[2 * k] = x;
      out[2 * k + 1] = y;
    });
    lines.push(out);
  };

  for (const [id, neighbours] of links) {
    if (neighbours.length === 1 && !visited.has(id)) {
      walk(id);
    }
  }
  for (const id of links.keys()) {
    if (!visited.has(id)) {
      walk(id);
    }
  }
  return lines;
}
