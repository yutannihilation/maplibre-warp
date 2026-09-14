import type { Plane } from "@math.gl/culling";

import type { Bounds } from "./types.js";

/**
 * The minimal camera description the tile traversal needs.
 *
 * This is the seam that replaces deck.gl's `Viewport`. `viewport-shim.ts`
 * builds one of these per frame from MapLibre's `CustomRenderMethodInput` plus
 * the `Map` instance; unit tests build one directly.
 */
export interface RasterViewport {
  /**
   * Continuous MapLibre zoom. MapLibre's zoom is the 512-pixel-tile
   * convention: at zoom `z` the world is `512 · 2^z` CSS pixels wide.
   */
  zoom: number;

  /**
   * Frustum planes in **common space** (`[0, 512]`, Y north-up), with normals
   * pointing *into* the frustum and `distance` matching the normalised normal.
   *
   * That orientation is what `@math.gl/culling`'s
   * `OrientedBoundingBox.intersectPlane` expects: a box entirely on the
   * negative side of every plane normal is outside.
   */
  frustumPlanes: Plane[];

  /**
   * Visible geographic extent as `[west, south, east, north]` in degrees.
   * Used only to cull root tiles for very large root matrices.
   */
  getBounds(): Bounds;

  /**
   * Common-space units per metre of elevation, used to map a `zRange` in
   * metres into common space. Evaluated at the viewport centre latitude, which
   * is the same linearisation deck.gl's `distanceScales` uses.
   */
  unitsPerMeter: number;

  /**
   * Framebuffer pixels per CSS pixel (`drawingBufferWidth / clientWidth`).
   * Feeds the LOD criterion; see {@link getTileIndices}.
   */
  pixelRatio: number;
}
