/**
 * Assemble fetched source tiles into one contiguous pixel window.
 */

import type { RasterTypedArray } from "@developmentseed/geotiff";

import type { PixelWindow } from "./sampler.js";

/** One decoded source tile, already reduced to a pixel-interleaved array. */
export interface FetchedTile {
  /** Tile column in the level's tile matrix. */
  x: number;
  /** Tile row in the level's tile matrix. */
  y: number;
  /** Decoded width; edge tiles may be narrower than the nominal tile width. */
  width: number;
  height: number;
  data: RasterTypedArray;
  stride: number;
  offset: number;
  nodata: number | null;
  mask: Uint8Array | null;
}

export interface TileRange {
  minCol: number;
  maxCol: number;
  minRow: number;
  maxRow: number;
}

/**
 * Copy `tiles` into a window covering `range`. Pixels no tile covers (tiles
 * missing from the list, or clipped edge tiles) are masked out, and per-tile
 * masks are merged in.
 */
export function assembleWindow(
  tiles: FetchedTile[],
  level: { tileWidth: number; tileHeight: number },
  range: TileRange,
): PixelWindow {
  const { tileWidth, tileHeight } = level;
  const width = (range.maxCol - range.minCol + 1) * tileWidth;
  const height = (range.maxRow - range.minRow + 1) * tileHeight;
  const first = tiles[0];
  const stride = first?.stride ?? 1;
  const offset = first?.offset ?? 0;
  const nodata = first?.nodata ?? null;

  const data = first
    ? (new (first.data.constructor as new (n: number) => RasterTypedArray)(
        width * height * stride,
      ) as RasterTypedArray)
    : new Float32Array(width * height);
  const mask = new Uint8Array(width * height);

  for (const tile of tiles) {
    if (tile.stride !== stride || tile.offset !== offset) {
      throw new RangeError("all tiles must share the same sample layout");
    }
    const ox = (tile.x - range.minCol) * tileWidth;
    const oy = (tile.y - range.minRow) * tileHeight;
    for (let r = 0; r < tile.height; r++) {
      const dstRow = (oy + r) * width + ox;
      const srcRow = r * tile.width;
      data.set(
        tile.data.subarray(srcRow * stride, (srcRow + tile.width) * stride),
        dstRow * stride,
      );
      if (tile.mask) {
        mask.set(tile.mask.subarray(srcRow, srcRow + tile.width), dstRow);
      } else {
        mask.fill(1, dstRow, dstRow + tile.width);
      }
    }
  }

  return {
    x0: range.minCol * tileWidth,
    y0: range.minRow * tileHeight,
    width,
    height,
    data,
    stride,
    offset,
    nodata,
    mask,
  };
}
