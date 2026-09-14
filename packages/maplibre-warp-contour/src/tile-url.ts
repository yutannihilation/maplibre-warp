import type { TileRequest } from "./generate.js";

const TILE_URL = /^[^:]+:\/\/(\d+)\/(\d+)\/(\d+)\.mvt$/;

/** Parse `protocol://z/x/y.mvt`. */
export function parseTileUrl(url: string): TileRequest {
  const match = TILE_URL.exec(url);
  if (!match) {
    throw new RangeError(`not a contour tile URL: ${url}`);
  }
  return {
    z: Number(match[1]),
    x: Number(match[2]),
    y: Number(match[3]),
  };
}
