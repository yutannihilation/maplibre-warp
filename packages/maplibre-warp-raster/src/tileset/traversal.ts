// Vendored from @developmentseed/deck.gl-raster (MIT, Development Seed):
// packages/deck.gl-raster/src/raster-tileset/raster-tile-traversal.ts
//
// Modifications:
//   1. The deck.gl `Viewport` dependency is replaced by {@link RasterViewport}
//      (see `viewport.ts`). Frustum planes arrive pre-extracted in common space
//      instead of being read off `viewport.getFrustumPlanes()`.
//   2. The globe branch is rewritten: instead of a `project` callback and
//      `REF_POINTS_11`, `computeBoundingVolume` maps the same reference points
//      onto MapLibre's unit sphere (`globe.ts`) when the viewport says the
//      frame is rendered under globe, and tiles spanning a large arc opt out of
//      culling instead of being sampled more densely. See
//      {@link RasterTileNode.computeBoundingVolume}.
//   3. World-copy passes are removed. The layer draws the primary world only;
//      see the README's limitations section.
//   4. Pole clamping is the descriptor's responsibility (see
//      `RasterTilesetDescriptor.projectTo3857`) rather than being re-applied
//      on every call here, and the common-space rescale helpers moved to
//      `mercator.ts`.
//   5. The LOD criterion's metres-per-CSS-pixel uses `2^(zoom + 9)`, matching
//      MapLibre's 512-pixel-tile zoom convention. See {@link getMetersPerPixel}.

import { transformBounds } from "@developmentseed/proj";
import {
  CullingVolume,
  makeOrientedBoundingBoxFromPoints,
} from "@math.gl/culling";

import type { SpherePoint } from "../globe.js";
import { sphereFromMercator } from "../globe.js";
import {
  commonSpaceFromLngLat,
  EARTH_CIRCUMFERENCE,
  lngLatFromCommonSpace,
  mercatorFromEPSG3857,
  rescaleEPSG3857ToCommonSpace,
} from "../mercator.js";
import type { ViewportProjection } from "../projection.js";
import type { BoundingVolumeCacheEntry } from "./bounding-volume-cache.js";
import { BoundingVolumeCache } from "./bounding-volume-cache.js";
import type {
  RasterTilesetDescriptor,
  RasterTilesetLevel,
} from "./tileset-interface.js";
import type {
  Bounds,
  Corners,
  Point,
  ProjectionFunction,
  TileIndex,
  ZRange,
} from "./types.js";
import type { RasterViewport } from "./viewport.js";

// Reference points used to sample tile boundaries for bounding volume
// calculation.
//
// Upstream deck.gl only needs such reference points for non-Web-Mercator
// projections, because the OSM tiling scheme is designed for Web Mercator and
// OSM tile extents are already axis-aligned there.
//
// For generic tiling grids, which are often not in Web Mercator, the grid tiles
// are never exact axis-aligned boxes in Web Mercator space, so oriented
// bounding boxes fitted to sampled reference points are required.

// For most tiles: sample 4 corners and center (5 points total)
const REF_POINTS_5: [number, number][] = [
  [0.5, 0.5], // center
  [0, 0], // top-left
  [0, 1], // bottom-left
  [1, 0], // top-right
  [1, 1], // bottom-right
];

// For higher detail: add 4 edge midpoints (9 points total)
const REF_POINTS_9 = REF_POINTS_5.concat([
  [0, 0.5], // left edge
  [0.5, 0], // top edge
  [1, 0.5], // right edge
  [0.5, 1], // bottom edge
]);

/**
 * Under globe, a tile spanning more than this many degrees of longitude or
 * latitude gets no bounding volume and is never frustum-culled.
 *
 * Nine points on a sphere bound a small patch well, but a hemisphere-sized
 * tile's samples can all lie on one great circle and collapse to a slab that
 * misses the visible surface entirely. Such tiles are few and coarse — the
 * top of a global pyramid — and their children are small enough to cull, so
 * always visiting them costs almost nothing.
 */
const GLOBE_MAX_CULLABLE_SPAN_DEGREES = 30;

/**
 * Below this, the foreshortening factor for globe LOD is clamped: a tile seen
 * exactly edge-on at the limb would otherwise ask for infinitely coarse data.
 */
const GLOBE_MIN_FORESHORTENING = 0.05;

/**
 * Raster Tile Node — represents a single tile in a tileset pyramid.
 *
 * Coordinate system:
 *
 * - x: tile column (0 to `RasterTilesetLevel.matrixWidth`, left to right)
 * - y: tile row (0 to `RasterTilesetLevel.matrixHeight`, top to bottom)
 * - z: overview level, 0 = coarsest, higher = finer
 */
export class RasterTileNode {
  /** Index across a row */
  x: number;

  /** Index down a column */
  y: number;

  /** Zoom index (higher = finer detail) */
  z: number;

  private descriptor: RasterTilesetDescriptor;

  /**
   * Flag indicating whether any descendant of this tile is visible.
   *
   * Used to prevent loading parent tiles when children are visible (avoids
   * overdraw).
   */
  private childVisible?: boolean;

  /**
   * Flag indicating this tile should be rendered.
   *
   * Set to `true` when this is the appropriate LOD for its distance from
   * camera.
   */
  private selected?: boolean;

  /** A cache of the children of this node. */
  private _children?: RasterTileNode[] | null;

  constructor(
    x: number,
    y: number,
    z: number,
    { descriptor }: { descriptor: RasterTilesetDescriptor },
  ) {
    this.x = x;
    this.y = y;
    this.z = z;
    this.descriptor = descriptor;
  }

  /** Get the level info for this tile's z index. */
  get level(): RasterTilesetLevel {
    return this.descriptor.levels[this.z]!;
  }

  /**
   * Get the children of this node.
   *
   * Find all tiles at level `this.z + 1` whose spatial extent overlaps this
   * tile.
   *
   * A tileset pyramid is not guaranteed to be a quadtree — it is a stack of
   * independent grids. We find children by mapping the parent tile's CRS bounds
   * into the child grid using {@link RasterTilesetLevel.crsBoundsToTileRange}.
   */
  get children(): RasterTileNode[] | null {
    if (!this._children) {
      const maxZ = this.descriptor.levels.length - 1;
      if (this.z >= maxZ) {
        // Already at finest resolution, no children
        this._children = null;
        return null;
      }

      const childZ = this.z + 1;
      const childLevel = this.descriptor.levels[childZ]!;

      // Compute this tile's bounds in the source CRS
      const parentCorners = this.level.projectedTileCorners(this.x, this.y);
      const parentBounds = cornersToBounds(parentCorners);

      // Find overlapping child index range
      const { minCol, maxCol, minRow, maxRow } =
        childLevel.crsBoundsToTileRange(...parentBounds);

      const children: RasterTileNode[] = [];
      const { descriptor } = this;
      for (let y = minRow; y <= maxRow; y++) {
        for (let x = minCol; x <= maxCol; x++) {
          children.push(new RasterTileNode(x, y, childZ, { descriptor }));
        }
      }

      this._children = children.length > 0 ? children : null;
    }
    return this._children;
  }

  /**
   * Recursively traverse the tile pyramid to determine if this tile (or its
   * descendants) should be rendered.
   *
   * 1. Bounds checking — reject tiles outside the dataset's geographic bounds
   * 2. Visibility culling — reject tiles outside the view frustum
   * 3. LOD selection — choose the coarsest level that resolves the display
   * 4. Recursive subdivision — if LOD is insufficient, test child tiles
   *
   * A tile is never rendered if any of its descendants are rendered.
   *
   * @returns true if this tile or any descendant is visible, false otherwise
   */
  update(params: {
    viewport: RasterViewport;
    /** Camera frustum for visibility testing */
    cullingVolume: CullingVolume;
    /** [min, max] elevation in common space */
    elevationBounds: ZRange;
    /** Minimum (coarsest) overview level */
    minZ: number;
    /** Maximum (finest) overview level */
    maxZ?: number;
    /** Optional common-space bounds filter */
    bounds?: Bounds;
    /**
     * Framebuffer pixels per CSS pixel. The LOD test selects a tile when its
     * source pixels are at most one framebuffer pixel wide; on HiDPI displays
     * (`pixelRatio > 1`) this picks a finer overview than the CSS-pixel
     * comparison would.
     */
    pixelRatio: number;
    /**
     * Bounding-volume cache shared by every node in this traversal. Populated
     * lazily as tiles are visited; reused across `getTileIndices` calls so
     * animation frames don't recompute proj4 reprojections + oriented-
     * bounding-box fits.
     */
    boundingVolumeCache: BoundingVolumeCache;
  }): boolean {
    const {
      viewport,
      cullingVolume,
      elevationBounds,
      minZ,
      maxZ = this.descriptor.levels.length - 1,
      bounds,
      pixelRatio,
      boundingVolumeCache,
    } = params;

    this.childVisible = false;
    this.selected = false;

    const { boundingVolume, commonSpaceBounds, sphereCenter } =
      this.getBoundingVolume(
        elevationBounds,
        viewport.projection,
        boundingVolumeCache,
      );

    // Step 1: Bounds checking
    if (bounds && !this.insideBounds(bounds, commonSpaceBounds)) {
      return false;
    }

    // Step 2: Frustum culling. A `null` volume is a tile too large to bound
    // (globe only); it is treated as visible and its children decide.
    // Returns: <0 if outside, 0 if intersecting, >0 if fully inside
    if (boundingVolume !== null) {
      const isInside = cullingVolume.computeVisibility(boundingVolume);
      if (isInside < 0) {
        return false;
      }
    }

    const children = this.children;

    // Step 3: LOD selection. Only select this tile if no child is visible,
    // which prevents overlapping tiles.
    if (!this.childVisible && this.z >= minZ) {
      const metersPerCSSPixel = getMetersPerCSSPixelForTile(
        viewport,
        commonSpaceBounds,
        sphereCenter,
      );

      const tileMetersPerPixel = this.level.metersPerPixel;

      // On-screen size of one source pixel, measured in framebuffer pixels.
      // ≤ 1 means the source can fully resolve the rendered framebuffer.
      const devicePixelsPerSourcePixel =
        (tileMetersPerPixel * pixelRatio) / metersPerCSSPixel;

      if (
        devicePixelsPerSourcePixel <= 1 ||
        this.z >= maxZ ||
        (children === null && this.z >= minZ)
      ) {
        this.selected = true;
        return true;
      }
    }

    // Step 4: LOD is not enough, recursively test child tiles.
    //
    // If `this.children` is `null` there are no children available because
    // we're already at the finest tile resolution.
    if (children && children.length > 0) {
      this.selected = false;

      let anyChildVisible = false;

      for (const child of children) {
        if (child.update(params)) {
          anyChildVisible = true;
        }
      }

      if (anyChildVisible) {
        this.childVisible = true;
      }
      return anyChildVisible;
    }

    return true;
  }

  /**
   * Collect all tiles marked as selected in the tree.
   *
   * @param result - Accumulator array for selected tiles
   * @returns Array of selected RasterTileNode tiles
   */
  getSelected(result: RasterTileNode[] = []): RasterTileNode[] {
    if (this.selected) {
      result.push(this);
    }
    if (this._children) {
      for (const node of this._children) {
        node.getSelected(result);
      }
    }
    return result;
  }

  /**
   * Test if this tile intersects the specified bounds in common space.
   *
   * @param bounds - `[minX, minY, maxX, maxY]` in common space (0-512)
   * @returns true if tile overlaps the bounds
   */
  insideBounds(bounds: Bounds, commonSpaceBounds: Bounds): boolean {
    const [minX, minY, maxX, maxY] = bounds;
    const [tileMinX, tileMinY, tileMaxX, tileMaxY] = commonSpaceBounds;

    return (
      tileMinX < maxX && tileMaxX > minX && tileMinY < maxY && tileMaxY > minY
    );
  }

  /**
   * The 3D bounding volume for this tile in the viewport's space, used for
   * frustum culling.
   *
   * Memoized in `boundingVolumeCache` (keyed by `z/x/y`): a tile's bounding
   * volume depends only on `(z, x, y, zRange, projection)` for a given
   * descriptor, so on a cache hit it is returned without rerunning
   * {@link computeBoundingVolume}'s proj4 reprojections + oriented-bounding-box
   * fit. A hit computed for another `zRange` or projection is a miss.
   */
  getBoundingVolume(
    zRange: ZRange,
    projection: ViewportProjection,
    boundingVolumeCache: BoundingVolumeCache,
  ): BoundingVolumeCacheEntry {
    const cacheHit = boundingVolumeCache.get(this.z, this.x, this.y);
    if (
      cacheHit &&
      cacheHit.projection === projection &&
      cacheHit.zRange[0] === zRange[0] &&
      cacheHit.zRange[1] === zRange[1]
    ) {
      return cacheHit;
    }
    const computed = this.computeBoundingVolume(zRange, projection);
    boundingVolumeCache.set(this.z, this.x, this.y, computed);
    return computed;
  }

  /**
   * Compute (without caching) the bounding volume for this tile: sample
   * reference points across the tile in its source CRS, reproject them to
   * EPSG:3857, and fit an oriented bounding box in the viewport's space.
   *
   * - Mercator: the points are rescaled to common space and `zRange` becomes
   *   a Z extent.
   * - Globe: the points go onto MapLibre's unit sphere the way the globe
   *   vertex prelude maps them, and `zRange` scales them radially. The sphere
   *   bulges outward between the samples, so the outer set is additionally
   *   inflated by `1 / cos(half the sample spacing)` to keep the surface
   *   inside the box. Tiles wider than {@link GLOBE_MAX_CULLABLE_SPAN_DEGREES}
   *   get no volume at all; see that constant.
   *
   * TODO: fast path when the source tiling is already EPSG:3857 (four corners
   * suffice, and the box is axis aligned).
   */
  private computeBoundingVolume(
    zRange: ZRange,
    projection: ViewportProjection,
  ): BoundingVolumeCacheEntry {
    const [minZ, maxZ] = zRange;

    const tileCorners = this.level.projectedTileCorners(this.x, this.y);

    const refPointsEPSG3857 = sampleReferencePointsInEPSG3857(
      REF_POINTS_9,
      tileCorners,
      this.descriptor.projectTo3857,
    );

    const commonSpacePositions = refPointsEPSG3857.map((xy) =>
      rescaleEPSG3857ToCommonSpace(xy),
    );

    // [minX, minY, maxX, maxY] in common space for the quick bounds check.
    // TODO: this doesn't densify edges
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;

    for (const [x, y] of commonSpacePositions) {
      if (x < minX) {
        minX = x;
      }
      if (y < minY) {
        minY = y;
      }
      if (x > maxX) {
        maxX = x;
      }
      if (y > maxY) {
        maxY = y;
      }
    }

    const commonSpaceBounds: Bounds = [minX, minY, maxX, maxY];

    if (projection === "globe") {
      return {
        zRange,
        projection,
        commonSpaceBounds,
        ...computeGlobeBoundingVolume(
          refPointsEPSG3857,
          commonSpaceBounds,
          zRange,
        ),
      };
    }

    const refPointPositions: [number, number, number][] = [];
    for (const p of commonSpacePositions) {
      refPointPositions.push([p[0], p[1], minZ]);

      if (minZ !== maxZ) {
        // Also sample at maximum elevation to capture the full 3D volume
        refPointPositions.push([p[0], p[1], maxZ]);
      }
    }

    return {
      zRange,
      projection,
      boundingVolume: makeOrientedBoundingBoxFromPoints(refPointPositions),
      commonSpaceBounds,
    };
  }
}

/**
 * The globe half of {@link RasterTileNode.computeBoundingVolume}.
 *
 * `refPointsEPSG3857` follows the `REF_POINTS_9` order, so its first entry is
 * the tile centre. `zRange` is already in sphere radii. A tile too large to
 * bound gets neither a volume nor a centre; see the early return below.
 */
function computeGlobeBoundingVolume(
  refPointsEPSG3857: Point[],
  commonSpaceBounds: Bounds,
  [minZ, maxZ]: ZRange,
): Pick<BoundingVolumeCacheEntry, "boundingVolume" | "sphereCenter"> {
  const spherePositions = refPointsEPSG3857.map((xy) =>
    sphereFromMercator(mercatorFromEPSG3857(xy)),
  );
  const sphereCenter = spherePositions[0]!;

  const [minX, minY, maxX, maxY] = commonSpaceBounds;
  const [west, south] = lngLatFromCommonSpace([minX, minY]);
  const [east, north] = lngLatFromCommonSpace([maxX, maxY]);
  const spanDegrees = Math.max(east - west, north - south);
  if (spanDegrees > GLOBE_MAX_CULLABLE_SPAN_DEGREES) {
    // No `sphereCenter` either: a tile this large is seen at every angle at
    // once, so one surface normal cannot describe how obliquely it is viewed.
    // Reporting the centre anyway would let the LOD criterion coarsen the
    // whole tile whenever that one point happens to face away from the
    // camera, which is how such a tile ends up selected at root resolution
    // instead of being subdivided.
    return { boundingVolume: null };
  }

  // Nine points form a 3×3 grid, so samples are half the span apart and the
  // surface between two of them rises `1 / cos(spacing / 2)` above their chord.
  const halfSpacingRadians = ((spanDegrees / 2) * Math.PI) / 180 / 2;
  const bulge = 1 / Math.cos(halfSpacingRadians);
  const innerRadius = 1 + minZ;
  const outerRadius = (1 + maxZ) * bulge;

  const refPointPositions: [number, number, number][] = [];
  for (const [x, y, z] of spherePositions) {
    refPointPositions.push([x * innerRadius, y * innerRadius, z * innerRadius]);
    refPointPositions.push([x * outerRadius, y * outerRadius, z * outerRadius]);
  }

  return {
    boundingVolume: makeOrientedBoundingBoxFromPoints(refPointPositions),
    sphereCenter,
  };
}

/**
 * Sample the selected reference points in EPSG:3857.
 *
 * Reference points are given as `[relX, relY]` fractions in `[0, 1]` and are
 * bilinearly interpolated across the tile's four CRS corners. For axis-aligned
 * tiles this is equivalent to an AABB lerp; for rotated tiles it correctly
 * samples the actual quadrilateral rather than its bounding box.
 */
function sampleReferencePointsInEPSG3857(
  refPoints: [number, number][],
  tileCorners: Corners,
  projectTo3857: ProjectionFunction,
): Point[] {
  const { topLeft, topRight, bottomLeft, bottomRight } = tileCorners;
  const refPointPositions: Point[] = [];

  for (const [relX, relY] of refPoints) {
    const [geoX, geoY] = bilerpPoint(
      topLeft,
      topRight,
      bottomLeft,
      bottomRight,
      relX,
      relY,
    );
    refPointPositions.push(projectTo3857(geoX, geoY));
  }

  return refPointPositions;
}

/**
 * Above this root-tile count, `createRootTiles` culls to the viewport before
 * instantiation. Below it, every root tile is created and downstream frustum
 * culling filters the unused ones. Typical COG pyramids have 1–a few dozen
 * tiles at z=0, so they stay on the unchanged path.
 */
const MAX_ROOT_TILES_NO_CULL = 100;

/**
 * Build the list of root (z=0) `RasterTileNode`s for the traversal.
 *
 * Exported for unit testing.
 */
export function createRootTiles(opts: {
  descriptor: RasterTilesetDescriptor;
  viewport: Pick<RasterViewport, "getBounds">;
  datasetWgs84Bounds: Bounds;
}): RasterTileNode[] {
  const { descriptor, viewport, datasetWgs84Bounds } = opts;
  const rootLevel = descriptor.levels[0]!;

  const roots: RasterTileNode[] = [];
  const rootTileCount = rootLevel.matrixWidth * rootLevel.matrixHeight;

  if (rootTileCount <= MAX_ROOT_TILES_NO_CULL) {
    for (let y = 0; y < rootLevel.matrixHeight; y++) {
      for (let x = 0; x < rootLevel.matrixWidth; x++) {
        roots.push(new RasterTileNode(x, y, 0, { descriptor }));
      }
    }
    return roots;
  }

  // Large root matrix → intersect dataset extent with viewport, project to
  // source CRS, use the root level's tile-range helper.
  const vpBounds = viewport.getBounds();
  const cullBounds: Bounds = [
    Math.max(datasetWgs84Bounds[0], vpBounds[0]),
    Math.max(datasetWgs84Bounds[1], vpBounds[1]),
    Math.min(datasetWgs84Bounds[2], vpBounds[2]),
    Math.min(datasetWgs84Bounds[3], vpBounds[3]),
  ];
  if (cullBounds[0] > cullBounds[2] || cullBounds[1] > cullBounds[3]) {
    return roots;
  }
  const [minX, minY, maxX, maxY] = transformBounds(
    descriptor.projectFrom4326,
    cullBounds[0],
    cullBounds[1],
    cullBounds[2],
    cullBounds[3],
  );
  const rootRange = rootLevel.crsBoundsToTileRange(minX, minY, maxX, maxY);
  for (let y = rootRange.minRow; y <= rootRange.maxRow; y++) {
    for (let x = rootRange.minCol; x <= rootRange.maxCol; x++) {
      roots.push(new RasterTileNode(x, y, 0, { descriptor }));
    }
  }
  return roots;
}

/**
 * Get the tile indices visible in the viewport.
 *
 * Overview levels follow the descriptor ordering: index 0 = coarsest, higher =
 * finer.
 */
export function getTileIndices(
  descriptor: RasterTilesetDescriptor,
  opts: {
    viewport: RasterViewport;
    maxZ: number;
    zRange: ZRange | null;
    wgs84Bounds: Bounds;
    /**
     * Cache for tile bounding volumes, reused across calls so repeated
     * traversals (animation frames) don't redo the proj4 reprojections +
     * oriented-bounding-box fit. If omitted, a throwaway cache is used — it
     * still dedups within a single traversal but provides no cross-call
     * benefit.
     */
    boundingVolumeCache?: BoundingVolumeCache;
  },
): TileIndex[] {
  const { viewport, maxZ, zRange, wgs84Bounds } = opts;

  const boundingVolumeCache =
    opts.boundingVolumeCache ?? new BoundingVolumeCache();

  // Trim the cache (no-op when under cap) before the traversal — never during,
  // so this frame can never evict an entry it will need again this frame.
  boundingVolumeCache.sweep();

  const cullingVolume = new CullingVolume(viewport.frustumPlanes);

  // Project zRange from metres to common space
  const unitsPerMeter = viewport.unitsPerMeter;
  const elevationMin = (zRange && zRange[0] * unitsPerMeter) || 0;
  const elevationMax = (zRange && zRange[1] * unitsPerMeter) || 0;

  // Upstream deck.gl has a pitch-based optimization here that skips the LOD
  // test below a given level. It relies on OSM tiles matching screen resolution
  // at a given zoom by construction, which is not true for arbitrary source
  // pyramids. We evaluate LOD at every level.
  const minZ = 0;

  const [minLng, minLat, maxLng, maxLat] = wgs84Bounds;
  const bottomLeft = commonSpaceFromLngLat(minLng, minLat);
  const topRight = commonSpaceFromLngLat(maxLng, maxLat);
  const bounds: Bounds = [
    bottomLeft[0],
    bottomLeft[1],
    topRight[0],
    topRight[1],
  ];

  const roots = createRootTiles({
    descriptor,
    viewport,
    datasetWgs84Bounds: wgs84Bounds,
  });

  const traversalParams = {
    viewport,
    cullingVolume,
    elevationBounds: [elevationMin, elevationMax] as ZRange,
    minZ,
    maxZ,
    bounds,
    pixelRatio: viewport.pixelRatio,
    boundingVolumeCache,
  };

  for (const root of roots) {
    root.update(traversalParams);
  }

  const selectedNodes: RasterTileNode[] = [];
  for (const root of roots) {
    root.getSelected(selectedNodes);
  }

  return selectedNodes.map(({ x, y, z }) => ({ x, y, z }));
}

/**
 * Metres of ground covered by one CSS pixel at a given latitude and MapLibre
 * zoom.
 *
 * `2^(zoom + 9)` because MapLibre's zoom uses 512-pixel tiles: at zoom `z` the
 * world is `512 · 2^z = 2^(z + 9)` CSS pixels wide.
 *
 * NOTE: upstream deck.gl-raster uses `2^(zoom + 8)` here (the 256-pixel-tile
 * convention) while being driven by a 512-pixel-tile zoom, which makes it
 * select one overview level coarser than the display can resolve. We use the
 * correct exponent, so this layer fetches ~4× more tiles than deck.gl-raster
 * for the same view and renders correspondingly sharper.
 */
function getMetersPerPixel(latitude: number, zoom: number): number {
  return (
    (EARTH_CIRCUMFERENCE * Math.cos((latitude * Math.PI) / 180)) /
    2 ** (zoom + 9)
  );
}

/**
 * Metres of ground per CSS pixel where this tile is drawn.
 *
 * - Mercator: the tile's own centre latitude, since mercator stretches the
 *   ground by `1 / cos(lat)`.
 * - Globe: MapLibre sizes the sphere so its scale everywhere equals the
 *   mercator scale at the *map centre's* latitude, so that latitude applies
 *   to every tile. A tile seen obliquely towards the limb covers fewer screen
 *   pixels per metre still, by roughly the cosine of the angle between its
 *   surface normal and the camera direction, so the scale is divided by that.
 */
function getMetersPerCSSPixelForTile(
  viewport: RasterViewport,
  commonSpaceBounds: Bounds,
  sphereCenter: SpherePoint | undefined,
): number {
  if (viewport.projection === "globe") {
    const atCenter = getMetersPerPixel(viewport.center[1], viewport.zoom);
    if (!sphereCenter) {
      // A tile with no bounding volume (too large to bound on the sphere) has
      // no single normal to foreshorten by, so it is judged at face value and
      // subdivides like any other.
      return atCenter;
    }
    const camera = viewport.cameraDirection;
    const foreshortening = Math.max(
      sphereCenter[0] * camera[0] +
        sphereCenter[1] * camera[1] +
        sphereCenter[2] * camera[2],
      GLOBE_MIN_FORESHORTENING,
    );
    return atCenter / foreshortening;
  }

  const [minX, minY, maxX, maxY] = commonSpaceBounds;
  const [, lat] = lngLatFromCommonSpace([(minX + maxX) / 2, (minY + maxY) / 2]);
  return getMetersPerPixel(lat, viewport.zoom);
}

/**
 * Compute the axis-aligned bounding box of a rotated tile rectangle.
 */
function cornersToBounds({
  topLeft,
  topRight,
  bottomLeft,
  bottomRight,
}: Corners): Bounds {
  const xs = [topLeft[0], topRight[0], bottomLeft[0], bottomRight[0]];
  const ys = [topLeft[1], topRight[1], bottomLeft[1], bottomRight[1]];
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

/**
 * Bilinearly interpolate a 2D point over a unit square, given four corner
 * points of a quadrilateral:
 *
 *   p(x, y) =
 *     p00 * (1 - x) * (1 - y) +
 *     p10 * x       * (1 - y) +
 *     p01 * (1 - x) * y       +
 *     p11 * x       * y
 *
 * Reduces to linear interpolation along edges when `x = 0/1` or `y = 0/1`.
 * Produces an affine mapping only if the four points form a parallelogram;
 * otherwise the interior mapping is bilinear (not affine). No CRS or geodesic
 * behavior is implied; inputs are treated as Cartesian coordinates.
 */
function bilerpPoint(
  p00: Point,
  p10: Point,
  p01: Point,
  p11: Point,
  x: number,
  y: number,
): Point {
  const w00 = (1 - x) * (1 - y);
  const w10 = x * (1 - y);
  const w01 = (1 - x) * y;
  const w11 = x * y;

  return [
    p00[0] * w00 + p10[0] * w10 + p01[0] * w01 + p11[0] * w11,
    p00[1] * w00 + p10[1] * w10 + p01[1] * w01 + p11[1] * w11,
  ];
}
