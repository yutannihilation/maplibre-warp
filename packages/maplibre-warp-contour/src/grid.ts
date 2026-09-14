/**
 * The mercator-aligned sample grid for one XYZ tile, and its projection into
 * a tileset level's pixel space.
 *
 * The grid holds corner samples of `tileSize + 2·buffer` cells per side, so
 * that the outer ring of cells is exactly the vector tile's buffer. Sample
 * positions lie on a lattice that is global per zoom level: neighbouring
 * tiles sample the same points along their shared edge, which is what makes
 * contours seamless without any clipping.
 */

export interface GridSpec {
  z: number;
  x: number;
  y: number;
  /** Cells across the tile proper (typically 256). */
  tileSize: number;
  /** Extra cells on every side. */
  buffer: number;
}

/** Number of samples per side. */
export function gridSize(spec: Pick<GridSpec, "tileSize" | "buffer">): number {
  return spec.tileSize + 2 * spec.buffer + 1;
}

/** Mercator `[0, 1]` position of grid sample `(i, j)`. */
export function gridSampleMercator(
  spec: GridSpec,
  i: number,
  j: number,
): [number, number] {
  const worldSize = spec.tileSize * 2 ** spec.z;
  return [
    (spec.x * spec.tileSize + i - spec.buffer) / worldSize,
    (spec.y * spec.tileSize + j - spec.buffer) / worldSize,
  ];
}

export interface TileCoordinateOptions {
  tileSize: number;
  buffer: number;
  extent: number;
}

/** Grid coordinate → integer vector-tile coordinate (round half up). */
export function toTileCoordinate(
  g: number,
  { tileSize, buffer, extent }: TileCoordinateOptions,
): number {
  return Math.round(((g - buffer) * extent) / tileSize);
}

export type MercatorToPixel = (mx: number, my: number) => [number, number];

export interface ProjectGridOptions {
  /**
   * Evaluate the projection every `latticeStep` samples and interpolate
   * bilinearly in between; the last lattice cell is shorter when the step
   * does not divide the cell count. @default 16
   */
  latticeStep?: number;
}

/**
 * Pixel coordinates of every grid sample, interleaved `x, y`, row-major.
 *
 * Bilinear interpolation of pixel coordinates is exact for affine maps and
 * sub-pixel for smooth projections over a 16-sample cell; it turns ~66k
 * projection calls per tile into a few hundred. A lattice cell with any
 * non-finite corner is `NaN` throughout (samples it shares with a finite
 * neighbour keep the neighbour's value), so failed projections (poles,
 * out-of-domain) simply produce no data there.
 */
export function projectGrid(
  spec: GridSpec,
  mercatorToPixel: MercatorToPixel,
  options: ProjectGridOptions = {},
): Float64Array {
  const step = options.latticeStep ?? 16;
  if (!Number.isInteger(step) || step <= 0) {
    throw new RangeError(`latticeStep (${step}) must be a positive integer`);
  }
  const cells = spec.tileSize + 2 * spec.buffer;
  const n = cells + 1;

  // Lattice node positions along one axis: every `step` samples, plus the
  // far edge, so the last lattice cell may be shorter than the others.
  const nodes: number[] = [];
  for (let s = 0; s < cells; s += step) {
    nodes.push(s);
  }
  nodes.push(cells);
  const latticeN = nodes.length;

  const lattice = new Float64Array(2 * latticeN * latticeN);
  for (let lj = 0; lj < latticeN; lj++) {
    for (let li = 0; li < latticeN; li++) {
      const [mx, my] = gridSampleMercator(spec, nodes[li]!, nodes[lj]!);
      const [px, py] = mercatorToPixel(mx, my);
      const k = 2 * (lj * latticeN + li);
      lattice[k] = px;
      lattice[k + 1] = py;
    }
  }

  // Start from NaN and only write finite cells: a sample on the boundary
  // between a failed cell and a finite one then keeps the finite value.
  const out = new Float64Array(2 * n * n).fill(Number.NaN);
  for (let lj = 0; lj < latticeN - 1; lj++) {
    for (let li = 0; li < latticeN - 1; li++) {
      const k00 = 2 * (lj * latticeN + li);
      const k10 = k00 + 2;
      const k01 = k00 + 2 * latticeN;
      const k11 = k01 + 2;
      const finite =
        Number.isFinite(lattice[k00]!) &&
        Number.isFinite(lattice[k00 + 1]!) &&
        Number.isFinite(lattice[k10]!) &&
        Number.isFinite(lattice[k10 + 1]!) &&
        Number.isFinite(lattice[k01]!) &&
        Number.isFinite(lattice[k01 + 1]!) &&
        Number.isFinite(lattice[k11]!) &&
        Number.isFinite(lattice[k11 + 1]!);
      if (!finite) {
        continue;
      }

      const i0 = nodes[li]!;
      const i1 = nodes[li + 1]!;
      const j0 = nodes[lj]!;
      const j1 = nodes[lj + 1]!;
      // Each lattice cell fills its samples inclusive of both edges; a shared
      // boundary is written twice with identical values.
      for (let j = j0; j <= j1; j++) {
        const v = (j - j0) / (j1 - j0);
        for (let i = i0; i <= i1; i++) {
          const u = (i - i0) / (i1 - i0);
          const o = 2 * (j * n + i);
          const w00 = (1 - u) * (1 - v);
          const w10 = u * (1 - v);
          const w01 = (1 - u) * v;
          const w11 = u * v;
          out[o] =
            w00 * lattice[k00]! +
            w10 * lattice[k10]! +
            w01 * lattice[k01]! +
            w11 * lattice[k11]!;
          out[o + 1] =
            w00 * lattice[k00 + 1]! +
            w10 * lattice[k10 + 1]! +
            w01 * lattice[k01 + 1]! +
            w11 * lattice[k11 + 1]!;
        }
      }
    }
  }
  return out;
}
