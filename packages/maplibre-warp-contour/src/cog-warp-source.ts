/**
 * Adapt an opened COG to the {@link WarpSource} the tile generator consumes.
 */

import type { DecoderPool, Tile } from "@developmentseed/geotiff";
import type { OpenedCOG } from "@yutannihilation/maplibre-warp-geotiff";
import { imageForLevel } from "@yutannihilation/maplibre-warp-geotiff";
import type { AffineTilesetLevel } from "@yutannihilation/maplibre-warp-raster";
import { epsg3857FromMercator } from "@yutannihilation/maplibre-warp-raster";

import type { ContourMeta } from "./backend.js";
import type { WarpLevel, WarpSource } from "./generate.js";
import type { FetchedTile } from "./window.js";

export function warpLevelFrom(level: AffineTilesetLevel): WarpLevel {
  // The tile transform of tile (0, 0) is the level-wide pixel ↔ CRS affine.
  const { inverseTransform } = level.tileTransform(0, 0);
  return {
    metersPerPixel: level.metersPerPixel,
    tileWidth: level.tileWidth,
    tileHeight: level.tileHeight,
    matrixWidth: level.matrixWidth,
    matrixHeight: level.matrixHeight,
    crsToPixel: (x, y) => {
      const [px, py] = inverseTransform(x, y);
      return [px, py];
    },
  };
}

/** Reduce a decoded tile to one band, without copying pixel data. */
export function toFetchedTile(tile: Tile, band: number): FetchedTile {
  const { array } = tile;
  if (!Number.isInteger(band) || band < 0 || band >= array.count) {
    throw new RangeError(
      `band ${band} is out of range for a ${array.count}-band image`,
    );
  }
  const base = {
    x: tile.x,
    y: tile.y,
    width: array.width,
    height: array.height,
    nodata: array.nodata,
    mask: array.mask,
  };
  if (array.layout === "band-separate") {
    return { ...base, data: array.bands[band]!, stride: 1, offset: 0 };
  }
  return { ...base, data: array.data, stride: array.count, offset: band };
}

export function warpSourceFromCOG(
  opened: OpenedCOG,
  options: { band: number; pool?: DecoderPool },
): { source: WarpSource; meta: ContourMeta } {
  const { geotiff, descriptor } = opened;
  const levels = descriptor.levels.map(warpLevelFrom);
  const source: WarpSource = {
    levels,
    mercatorToCrs: (mx, my) => {
      const [x, y] = descriptor.projectFrom3857(
        ...epsg3857FromMercator([mx, my]),
      );
      return [x, y];
    },
    fetchTiles: async (levelIndex, xy, signal) => {
      const image = imageForLevel(geotiff, levelIndex);
      const tiles = await image.fetchTiles(xy, {
        boundless: false,
        pool: options.pool,
        signal,
      });
      return tiles.map((tile) => toFetchedTile(tile, options.band));
    },
  };
  const bounds = opened.wgs84Bounds;
  return {
    source,
    meta: {
      levelMetersPerPixel: levels.map((l) => l.metersPerPixel),
      sourceTileWidth: geotiff.tileWidth,
      wgs84Bounds: [bounds[0], bounds[1], bounds[2], bounds[3]],
    },
  };
}
