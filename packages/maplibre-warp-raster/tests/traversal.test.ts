/**
 * The globe branch of the tile traversal: sphere-space bounding volumes, the
 * horizon plane, the large-tile opt-out, and the centre-latitude LOD rule.
 */

import type { Affine } from "@developmentseed/affine";
import { Plane } from "@math.gl/culling";
import { describe, expect, it } from "vitest";

import { horizonPlane } from "../src/globe.js";
import { EPSG_3857_CIRCUMFERENCE } from "../src/mercator.js";
import { AffineTileset } from "../src/tileset/affine-tileset.js";
import { AffineTilesetLevel } from "../src/tileset/affine-tileset-level.js";
import { BoundingVolumeCache } from "../src/tileset/bounding-volume-cache.js";
import { getTileIndices } from "../src/tileset/traversal.js";
import type { Bounds, Point } from "../src/tileset/types.js";
import type {
  GlobeRasterViewport,
  MercatorRasterViewport,
} from "../src/tileset/viewport.js";

const identity = (x: number, y: number): Point => [x, y];
const toLngLat = (x: number, y: number): Point => [
  (x / 20037508.34) * 180,
  (Math.atan(Math.exp((y / 20037508.34) * Math.PI)) * 360) / Math.PI - 90,
];
const fromLngLat = (lng: number, lat: number): Point => [
  (lng / 180) * 20037508.34,
  (Math.log(Math.tan(((90 + lat) * Math.PI) / 360)) / Math.PI) * 20037508.34,
];

/** +10° of latitude in EPSG:3857 metres. */
const LAT_10_METRES = fromLngLat(0, 10)[1];

/** One level of `columns` tiles of 256 px laid all the way round the equator. */
function beltLevel(columns: number): AffineTilesetLevel {
  const arrayWidth = 256 * columns;
  const affine: Affine = [
    EPSG_3857_CIRCUMFERENCE / arrayWidth,
    0,
    -EPSG_3857_CIRCUMFERENCE / 2,
    0,
    -(2 * LAT_10_METRES) / 256,
    LAT_10_METRES,
  ];
  return new AffineTilesetLevel({
    affine,
    arrayWidth,
    arrayHeight: 256,
    tileWidth: 256,
    tileHeight: 256,
    mpu: 1,
  });
}

/**
 * An equatorial belt spanning ±10° of latitude and the whole globe, with one
 * level per entry in `columns` (coarsest first), in a CRS that is EPSG:3857
 * itself.
 */
function makeBelt(...columns: number[]): AffineTileset {
  return new AffineTileset({
    levels: columns.map(beltLevel),
    projectTo3857: identity,
    projectFrom3857: identity,
    projectTo4326: toLngLat,
    projectFrom4326: fromLngLat,
  });
}

/** The two-level pyramid from the scheduler tests, near (lng 0, lat 0). */
function makePyramid(): AffineTileset {
  const level0Affine: Affine = [1024, 0, 0, 0, -1024, 262144];
  const level1Affine: Affine = [512, 0, 0, 0, -512, 262144];
  return new AffineTileset({
    levels: [
      new AffineTilesetLevel({
        affine: level0Affine,
        arrayWidth: 256,
        arrayHeight: 256,
        tileWidth: 256,
        tileHeight: 256,
        mpu: 1,
      }),
      new AffineTilesetLevel({
        affine: level1Affine,
        arrayWidth: 512,
        arrayHeight: 512,
        tileWidth: 256,
        tileHeight: 256,
        mpu: 1,
      }),
    ],
    projectTo3857: identity,
    projectFrom3857: identity,
    projectTo4326: toLngLat,
    projectFrom4326: fromLngLat,
  });
}

const WORLD: Bounds = [-180, -85, 180, 85];

/**
 * A globe viewport looking straight at `(lng 0, lat 0)` with only the horizon
 * plane as a frustum: the visible cap is everything within `acos(0.3) ≈ 72.5°`
 * of the centre.
 */
function makeGlobeViewport(
  zoom: number,
  overrides: Partial<GlobeRasterViewport> = {},
): GlobeRasterViewport {
  return {
    projection: "globe",
    zoom,
    center: [0, 0],
    frustumPlanes: [horizonPlane([0, 0, 1, -0.3])],
    cameraDirection: [0, 0, 1],
    getBounds: () => WORLD,
    unitsPerMeter: 1 / 6371008.8,
    pixelRatio: 1,
    ...overrides,
  };
}

/** A mercator viewport whose frustum contains everything. */
function makeMercatorViewport(zoom: number): MercatorRasterViewport {
  const far = 1e9;
  return {
    projection: "mercator",
    zoom,
    center: [0, 0],
    frustumPlanes: [
      new Plane([1, 0, 0], far),
      new Plane([-1, 0, 0], far),
      new Plane([0, 1, 0], far),
      new Plane([0, -1, 0], far),
      new Plane([0, 0, 1], far),
      new Plane([0, 0, -1], far),
    ],
    getBounds: () => WORLD,
    unitsPerMeter: 1,
    pixelRatio: 1,
  };
}

describe("globe tile traversal", () => {
  it("culls tiles beyond the horizon and keeps the visible cap", () => {
    // 24 tiles of 15° each. Tile x spans [-180 + 15x, -165 + 15x].
    const descriptor = makeBelt(24);
    const selected = getTileIndices(descriptor, {
      viewport: makeGlobeViewport(2),
      maxZ: 0,
      zRange: null,
      wgs84Bounds: WORLD,
    });
    const columns = selected.map((t) => t.x).sort((a, b) => a - b);

    // Visible iff some part of the tile is within 72.5° of lng 0: tiles whose
    // near edge is at 75° (x = 6 and x = 17) are entirely over the horizon.
    expect(columns).toEqual([7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
  });

  it("never culls a tile too wide to bound on the sphere", () => {
    // Four 90° tiles: every one is wider than the 30° cull threshold, so all
    // are visited even though two of them face away from the camera.
    const descriptor = makeBelt(4);
    const cache = new BoundingVolumeCache();
    const selected = getTileIndices(descriptor, {
      viewport: makeGlobeViewport(1),
      maxZ: 0,
      zRange: null,
      wgs84Bounds: WORLD,
      boundingVolumeCache: cache,
    });
    expect(selected.map((t) => t.x).sort()).toEqual([0, 1, 2, 3]);
    expect(cache.get(0, 0, 0)?.boundingVolume).toBeNull();
    expect(cache.get(0, 0, 0)?.projection).toBe("globe");
  });

  it("subdivides a too-wide tile whose centre faces away from the camera", () => {
    // Two 180° tiles over a 15°-tile level. Neither root can be bounded, and
    // both have their centre (lng ±90) exactly on the horizon. Foreshortening
    // must not be applied to them: judged by their own centre they would look
    // 20× coarser than they are (the clamp), pass the LOD test, and be
    // selected at root resolution — leaving the visible hemisphere blurry
    // instead of descending to the finer level.
    const descriptor = makeBelt(2, 24);
    const selected = getTileIndices(descriptor, {
      viewport: makeGlobeViewport(2),
      maxZ: 1,
      zRange: null,
      wgs84Bounds: WORLD,
      boundingVolumeCache: new BoundingVolumeCache(),
    });

    expect(selected.length).toBeGreaterThan(0);
    expect(selected.every((t) => t.z === 1)).toBe(true);
    const columns = [...new Set(selected.map((t) => t.x))].sort(
      (a, b) => a - b,
    );
    expect(columns).toEqual([7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
  });

  it("recomputes a cached volume when the projection changes", () => {
    const descriptor = makeBelt(24);
    const cache = new BoundingVolumeCache();

    getTileIndices(descriptor, {
      viewport: makeMercatorViewport(2),
      maxZ: 0,
      zRange: null,
      wgs84Bounds: WORLD,
      boundingVolumeCache: cache,
    });
    const mercatorEntry = cache.get(0, 12, 0);
    expect(mercatorEntry?.projection).toBe("mercator");

    getTileIndices(descriptor, {
      viewport: makeGlobeViewport(2),
      maxZ: 0,
      zRange: null,
      wgs84Bounds: WORLD,
      boundingVolumeCache: cache,
    });
    const globeEntry = cache.get(0, 12, 0);
    expect(globeEntry?.projection).toBe("globe");
    expect(globeEntry).not.toBe(mercatorEntry);
    // The common-space bounds are projection-independent and still present.
    expect(globeEntry?.commonSpaceBounds).toEqual(
      mercatorEntry?.commonSpaceBounds,
    );
  });

  it("scales LOD by the map-centre latitude rather than the tile's", () => {
    // Level 0 is 1024 m/px, level 1 is 512 m/px, near the equator. At zoom 6
    // one CSS pixel at the equator is ~1223 m, so mercator settles for level
    // 0. On a globe centred at 60°N the whole sphere is drawn at that
    // latitude's scale — ~611 m per pixel — so the equatorial tile needs
    // level 1 to stay sharp. The camera still faces the tile, so only the
    // scale changes.
    const descriptor = makePyramid();
    const common = { maxZ: 1, zRange: null, wgs84Bounds: WORLD } as const;

    const mercator = getTileIndices(descriptor, {
      ...common,
      viewport: makeMercatorViewport(6),
    });
    expect(mercator.map((t) => t.z)).toEqual([0]);

    const globeAtEquator = getTileIndices(descriptor, {
      ...common,
      viewport: makeGlobeViewport(6),
    });
    expect(globeAtEquator.map((t) => t.z)).toEqual([0]);

    const globeAt60 = getTileIndices(descriptor, {
      ...common,
      viewport: makeGlobeViewport(6, { center: [0, 60] }),
    });
    expect(globeAt60.every((t) => t.z === 1)).toBe(true);
    expect(globeAt60).toHaveLength(4);
  });

  it("coarsens LOD for tiles seen obliquely near the limb", () => {
    // Same pyramid, same zoom as above, but the camera sits 80° of longitude
    // away, so the tile is almost edge-on and level 0 is plenty even at the
    // scale that otherwise demanded level 1.
    const descriptor = makePyramid();
    const oblique = getTileIndices(descriptor, {
      maxZ: 1,
      zRange: null,
      wgs84Bounds: WORLD,
      viewport: makeGlobeViewport(6, {
        center: [0, 60],
        frustumPlanes: [],
        cameraDirection: [
          Math.sin((80 * Math.PI) / 180),
          0,
          Math.cos((80 * Math.PI) / 180),
        ],
      }),
    });
    expect(oblique.map((t) => t.z)).toEqual([0]);
  });
});
