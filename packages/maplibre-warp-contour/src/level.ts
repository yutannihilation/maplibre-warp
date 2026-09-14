/**
 * Level-of-detail selection: which tileset level to warp for an XYZ tile.
 */

/** Web Mercator equatorial circumference in metres. */
export const EARTH_CIRCUMFERENCE = 40075016.686;

/**
 * Ground size of one tile pixel in metres, at the given latitude.
 *
 * A web-mercator tile at zoom `z` spans `circumference / 2^z`; the mercator
 * scale factor `cos(lat)` converts that projected length to ground length.
 */
export function tileMetersPerPixel(
  z: number,
  latitudeDeg: number,
  tileSize: number,
): number {
  return (
    (EARTH_CIRCUMFERENCE * Math.cos((latitudeDeg * Math.PI) / 180)) /
    (tileSize * 2 ** z)
  );
}

/**
 * Pick the coarsest level whose pixels are no larger than a tile pixel, or
 * the finest level when even that is coarser than the tile.
 *
 * @param levelMetersPerPixel  Per-level ground pixel size, coarsest first.
 */
export function selectLevel(
  levelMetersPerPixel: readonly number[],
  z: number,
  latitudeDeg: number,
  tileSize: number,
): number {
  if (levelMetersPerPixel.length === 0) {
    throw new RangeError("levelMetersPerPixel must not be empty");
  }
  if (
    !Number.isFinite(z) ||
    !Number.isFinite(latitudeDeg) ||
    !Number.isFinite(tileSize)
  ) {
    throw new RangeError("z, latitude and tileSize must be finite");
  }
  const target = tileMetersPerPixel(z, latitudeDeg, tileSize);
  for (let i = 0; i < levelMetersPerPixel.length; i++) {
    if (levelMetersPerPixel[i]! <= target) {
      return i;
    }
  }
  return levelMetersPerPixel.length - 1;
}
