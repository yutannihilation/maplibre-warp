import type { Plane } from "@math.gl/culling";

import type { SpherePoint } from "../globe.js";
import type { Bounds } from "./types.js";

/**
 * What every {@link RasterViewport} carries, whichever projection is active.
 *
 * This is the seam that replaces deck.gl's `Viewport`. `viewport-shim.ts`
 * builds one of these per frame from MapLibre's `CustomRenderMethodInput` plus
 * the `Map` instance; unit tests build one directly.
 */
interface RasterViewportBase {
  /**
   * Continuous MapLibre zoom. MapLibre's zoom is the 512-pixel-tile
   * convention: at zoom `z` the world is `512 · 2^z` CSS pixels wide.
   */
  zoom: number;

  /**
   * Map centre in WGS84 degrees.
   *
   * Its latitude sets the ground scale: under mercator that is the scale at
   * the centre only, but under globe MapLibre sizes the whole sphere by it, so
   * it applies to every tile. Its position also orders tile requests
   * centre-out.
   */
  center: [lng: number, lat: number];

  /**
   * Frustum planes in the projection's space, with normals pointing *into* the
   * frustum and `distance` matching the normalised normal.
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
   * Units of the bounding-volume space per metre of elevation, used to map a
   * `zRange` in metres into that space. Under mercator this is common-space
   * units per metre at the viewport centre latitude (the same linearisation
   * deck.gl's `distanceScales` uses); under globe it is sphere radii per metre.
   */
  unitsPerMeter: number;

  /**
   * Framebuffer pixels per CSS pixel (`drawingBufferWidth / clientWidth`).
   * Feeds the LOD criterion; see {@link getTileIndices}.
   */
  pixelRatio: number;
}

/** A frame drawn flat, with bounding volumes in common space `[0, 512]²`. */
export interface MercatorRasterViewport extends RasterViewportBase {
  projection: "mercator";
}

/** A frame drawn on MapLibre's unit sphere. */
export interface GlobeRasterViewport extends RasterViewportBase {
  projection: "globe";

  /**
   * Unit vector from the sphere centre towards the camera, used to coarsen the
   * LOD of tiles seen obliquely near the limb.
   *
   * Required rather than optional: it is always available under globe (it is
   * MapLibre's own clipping-plane normal), and making the type say so keeps
   * the traversal from having to guess when it is missing.
   */
  cameraDirection: SpherePoint;
}

/**
 * The minimal camera description the tile traversal needs, in whichever space
 * the active projection culls in.
 */
export type RasterViewport = MercatorRasterViewport | GlobeRasterViewport;

export type { ViewportProjection } from "../projection.js";
