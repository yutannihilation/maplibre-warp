// Vendored from @developmentseed/deck.gl-raster (MIT, Development Seed):
// packages/deck.gl-raster/src/raster-tileset/types.ts
// Unmodified.

export type ZRange = [minZ: number, maxZ: number];

/** An axis-aligned bounding box */
export type Bounds = [minX: number, minY: number, maxX: number, maxY: number];

/** Corners which may or may not be axis-aligned. */
export type Corners = {
  topLeft: Point;
  topRight: Point;
  bottomLeft: Point;
  bottomRight: Point;
};

/** A 2D point represented as [x, y] */
export type Point = [number, number];

/** A function that projects coordinates from one CRS to another */
export type ProjectionFunction = (x: number, y: number) => Point;

/**
 * Raster Tile Index
 *
 * In TileMatrixSet ordering: `level === z`.
 *
 * So level `z` is the coarsest resolution (0) and the highest `z` is the finest
 * resolution.
 */
export type TileIndex = {
  x: number;
  y: number;

  /**
   * TileMatrixSet/OSM zoom (0 = coarsest, higher = finer)
   */
  z: number;
};
