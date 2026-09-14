// Adapted from @developmentseed/deck.gl-raster (MIT, Development Seed):
// packages/deck.gl-geotiff/src/geotiff-tileset.ts

import type { GeoTIFF, Overview } from "@developmentseed/geotiff";
import type { ProjectionFunction } from "@yutannihilation/maplibre-warp-raster";
import {
  AffineTileset,
  AffineTilesetLevel,
} from "@yutannihilation/maplibre-warp-raster";

/**
 * Build an {@link AffineTileset} from a {@link GeoTIFF}: one level per
 * overview plus a final entry for the full-resolution image, coarsest first.
 *
 * Because {@link AffineTilesetLevel} is parameterised by an arbitrary affine,
 * this works for COGs with rotated, skewed or non-square-pixel geotransforms.
 */
export function geoTiffToDescriptor(
  geotiff: GeoTIFF,
  opts: {
    projectTo3857: ProjectionFunction;
    projectFrom3857: ProjectionFunction;
    projectTo4326: ProjectionFunction;
    projectFrom4326: ProjectionFunction;
    mpu: number;
  },
): AffineTileset {
  // `GeoTIFF.overviews` is sorted finest-to-coarsest. Reverse for
  // coarsest-first and append the full-resolution image as the finest level.
  const images: Array<GeoTIFF | Overview> = [
    ...[...geotiff.overviews].reverse(),
    geotiff,
  ];

  const levels = images.map(
    (img) =>
      new AffineTilesetLevel({
        affine: img.transform,
        arrayWidth: img.width,
        arrayHeight: img.height,
        tileWidth: img.tileWidth,
        tileHeight: img.tileHeight,
        mpu: opts.mpu,
      }),
  );

  return new AffineTileset({
    levels,
    projectTo3857: opts.projectTo3857,
    projectFrom3857: opts.projectFrom3857,
    projectTo4326: opts.projectTo4326,
    projectFrom4326: opts.projectFrom4326,
  });
}

/**
 * Pick the image for a tileset level: level `z === overviews.length` is the
 * full-resolution image; lower `z` indexes the finest-first overview list from
 * the far end (levels are emitted coarsest-first).
 */
export function imageForLevel(geotiff: GeoTIFF, z: number): GeoTIFF | Overview {
  if (z === geotiff.overviews.length) {
    return geotiff;
  }
  const overview = geotiff.overviews[geotiff.overviews.length - 1 - z];
  if (!overview) {
    throw new Error(`No image for tileset level ${z}`);
  }
  return overview;
}
