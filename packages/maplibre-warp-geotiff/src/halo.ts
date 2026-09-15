/**
 * One-texel halo around a tile, stitched from its neighbours.
 *
 * A tile texture that holds exactly one COG tile cannot interpolate across
 * the seam to the next tile: within the outer half texel the bilinear taps
 * clamp to the edge column, the value goes flat, and an isoline crossing the
 * seam breaks into a step. Padding each tile with its neighbours' edge texels
 * gives both sides of a seam the same texel pairs to interpolate between.
 *
 * Everything here is pure: fetching is the caller's business.
 */

import type {
  RasterArrayPixelInterleaved,
  RasterTypedArray,
} from "@developmentseed/geotiff";
import { allocateLike } from "./geotiff-utils.js";

/**
 * Width of the halo in texels on each side. Not a tunable: {@link stitchHalo}
 * writes exactly one ring and guards against any other value.
 */
export const HALO = 1;

/** Offset of a neighbour from the centre tile, each component in −1..1. */
export type NeighbourOffset = readonly [dx: number, dy: number];

/** The eight neighbour offsets, row-major from top-left. */
export const NEIGHBOUR_OFFSETS: readonly NeighbourOffset[] = [
  [-1, -1],
  [0, -1],
  [1, -1],
  [-1, 0],
  [1, 0],
  [-1, 1],
  [0, 1],
  [1, 1],
];

/**
 * Slot of a neighbour offset in a 3 × 3 grid laid out row-major from the
 * top-left, so `[-1, -1]` is 0 and `[1, 1]` is 8. The centre, slot 4, is
 * never a neighbour.
 */
export function neighbourIndex([dx, dy]: NeighbourOffset): number {
  return (dy + 1) * 3 + (dx + 1);
}

/** Neighbours by {@link neighbourIndex}; a missing slot means no such tile. */
export type NeighbourGrid<T> = ReadonlyArray<T | undefined>;

/** A neighbour that exists in the tile grid: its offset and tile coordinates. */
export interface Neighbour {
  offset: NeighbourOffset;
  x: number;
  y: number;
}

/**
 * Every neighbour of `(x, y)` that lies inside a grid of
 * `tilesAcross × tilesDown` tiles, in {@link NEIGHBOUR_OFFSETS} order.
 */
export function neighbourCoordinates(
  x: number,
  y: number,
  tilesAcross: number,
  tilesDown: number,
): Neighbour[] {
  const out: Neighbour[] = [];
  for (const offset of NEIGHBOUR_OFFSETS) {
    const nx = x + offset[0];
    const ny = y + offset[1];
    if (nx >= 0 && ny >= 0 && nx < tilesAcross && ny < tilesDown) {
      out.push({ offset, x: nx, y: ny });
    }
  }
  return out;
}

type Stitchable = Pick<
  RasterArrayPixelInterleaved,
  "width" | "height" | "count" | "data" | "mask"
>;

/**
 * Pad `centre` by {@link HALO} texels on every side with the adjacent edge
 * texels of `neighbours`. Where a neighbour is absent (the tile sits on the
 * image edge, or the neighbour could not be fetched), or where the
 * neighbour's validity mask marks the texel as missing, the centre's own edge
 * is replicated instead, which is the clamp the sampler would apply anyway.
 * A masked texel's payload is fill of no meaning; letting it into the
 * bilinear taps would bend the isoline towards it.
 *
 * Neighbours must be edge-compatible with the centre: a left/right neighbour
 * shares the centre's height, a top/bottom neighbour its width. Edge tiles
 * decoded with `boundless: false` are clipped, so this holds for every pair
 * inside one image; anything else is a caller error and throws.
 *
 * @returns The padded pixel-interleaved data, `(width + 2) × (height + 2)`.
 */
export function stitchHalo(
  centre: Stitchable,
  neighbours: NeighbourGrid<Stitchable>,
): RasterTypedArray {
  if ((HALO as number) !== 1) {
    throw new Error(`stitchHalo writes one ring of padding; HALO is ${HALO}`);
  }
  const { width: w, height: h, count } = centre;
  const src = centre.data;
  if (src.length !== w * h * count) {
    throw new Error(
      `centre tile has ${src.length} samples, expected ${w}×${h}×${count}`,
    );
  }
  const pw = w + 2 * HALO;
  const ph = h + 2 * HALO;
  const out = allocateLike(src, pw * ph * count);

  // Validate each neighbour once, into a grid indexed like the input.
  const grid: Array<Stitchable | undefined> = [];
  for (const offset of NEIGHBOUR_OFFSETS) {
    const [dx, dy] = offset;
    const n = neighbours[neighbourIndex(offset)];
    if (!n) {
      continue;
    }
    if (n.count !== count) {
      throw new Error(
        `neighbour (${dx},${dy}) has ${n.count} bands, centre has ${count}`,
      );
    }
    if (n.data.length !== n.width * n.height * n.count) {
      throw new Error(
        `neighbour (${dx},${dy}) has ${n.data.length} samples, expected ${n.width}×${n.height}×${n.count}`,
      );
    }
    if (dx === 0 && n.width !== w) {
      throw new Error(
        `neighbour (${dx},${dy}) is ${n.width} wide, centre is ${w}`,
      );
    }
    if (dy === 0 && n.height !== h) {
      throw new Error(
        `neighbour (${dx},${dy}) is ${n.height} tall, centre is ${h}`,
      );
    }
    grid[neighbourIndex(offset)] = n;
  }
  const at = (dx: number, dy: number): Stitchable | undefined =>
    grid[neighbourIndex([dx, dy])];

  /** Copy texel `(col, row)` of `tile` into padded texel `(pcol, prow)`. */
  const copy = (
    tile: Stitchable,
    col: number,
    row: number,
    pcol: number,
    prow: number,
  ): void => {
    const from = (row * tile.width + col) * count;
    const to = (prow * pw + pcol) * count;
    for (let b = 0; b < count; b++) {
      out[to + b] = tile.data[from + b]!;
    }
  };
  /** Whether `tile` marks texel `(col, row)` as missing. */
  const masked = (tile: Stitchable, col: number, row: number): boolean =>
    tile.mask !== null && tile.mask[row * tile.width + col] === 0;

  // Along one axis, an offset of −1 reads a neighbour's far edge and writes
  // the padded near edge; +1 the reverse; 0 runs along the seam at `t`.
  const sourceIndex = (size: number, d: number, t: number): number =>
    d < 0 ? size - 1 : d > 0 ? 0 : t;
  const ownIndex = (size: number, d: number, t: number): number =>
    d < 0 ? 0 : d > 0 ? size - 1 : t;
  const paddedIndex = (size: number, d: number, t: number): number =>
    d < 0 ? 0 : d > 0 ? size - 1 : t + HALO;

  // Interior: one row copy per line.
  for (let row = 0; row < h; row++) {
    out.set(
      src.subarray(row * w * count, (row + 1) * w * count),
      ((row + HALO) * pw + HALO) * count,
    );
  }

  // Edges: the neighbour's edge line, or the centre's own where it is
  // missing or masked.
  for (const [dx, dy] of NEIGHBOUR_OFFSETS) {
    if (dx !== 0 && dy !== 0) {
      continue;
    }
    const n = at(dx, dy);
    const length = dx === 0 ? w : h;
    for (let t = 0; t < length; t++) {
      const pcol = paddedIndex(pw, dx, t);
      const prow = paddedIndex(ph, dy, t);
      if (n) {
        const col = sourceIndex(n.width, dx, t);
        const row = sourceIndex(n.height, dy, t);
        if (!masked(n, col, row)) {
          copy(n, col, row, pcol, prow);
          continue;
        }
      }
      copy(centre, ownIndex(w, dx, t), ownIndex(h, dy, t), pcol, prow);
    }
  }

  // Corners: the diagonal neighbour's corner texel; failing that, clamp the
  // way the sampler would, by copying the already-filled padded texel that
  // is nearest along whichever axis has a neighbour. In a rectangular grid a
  // missing diagonal means at most one of the two edge neighbours exists.
  const padded: Stitchable = {
    width: pw,
    height: ph,
    count,
    data: out,
    mask: null,
  };
  for (const [dx, dy] of NEIGHBOUR_OFFSETS) {
    if (dx === 0 || dy === 0) {
      continue;
    }
    const pcol = paddedIndex(pw, dx, 0);
    const prow = paddedIndex(ph, dy, 0);
    const n = at(dx, dy);
    if (n) {
      const col = sourceIndex(n.width, dx, 0);
      const row = sourceIndex(n.height, dy, 0);
      if (!masked(n, col, row)) {
        copy(n, col, row, pcol, prow);
        continue;
      }
    }
    const innerCol = dx < 0 ? HALO : pw - 1 - HALO;
    const innerRow = dy < 0 ? HALO : ph - 1 - HALO;
    const [c, r]: [number, number] = at(dx, 0)
      ? [pcol, innerRow]
      : at(0, dy)
        ? [innerCol, prow]
        : [innerCol, innerRow];
    copy(padded, c, r, pcol, prow);
  }

  return out;
}
