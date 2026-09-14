/**
 * The zoom range a contour source should advertise.
 */

import { tileMetersPerPixel } from "./level.js";

export interface ZoomRangeParams {
  /** Coarsest first. */
  levelMetersPerPixel: readonly number[];
  latitudeDeg: number;
  tileSize: number;
  /** Source tile width in pixels, for the tile budget. */
  sourceTileWidth: number;
  /** Most source tiles one vector tile may need. */
  maxSourceTiles: number;
}

const MAX_ZOOM = 30;

/**
 * `maxzoom` is the first zoom whose tile pixel is at least as fine as the
 * finest level; beyond it MapLibre overzooms. `minzoom` is the first zoom at
 * which one tile of the coarsest level fits the source-tile budget (below it
 * a single tile would pull in too much of the dataset), clamped to `maxzoom`.
 */
export function computeZoomRange(params: ZoomRangeParams): {
  minzoom: number;
  maxzoom: number;
} {
  const { levelMetersPerPixel, latitudeDeg, tileSize } = params;
  if (levelMetersPerPixel.length === 0) {
    throw new RangeError("levelMetersPerPixel must not be empty");
  }
  const coarsest = levelMetersPerPixel[0]!;
  const finest = levelMetersPerPixel[levelMetersPerPixel.length - 1]!;

  let maxzoom = MAX_ZOOM;
  for (let z = 0; z <= MAX_ZOOM; z++) {
    if (tileMetersPerPixel(z, latitudeDeg, tileSize) <= finest) {
      maxzoom = z;
      break;
    }
  }

  let minzoom = maxzoom;
  for (let z = 0; z <= maxzoom; z++) {
    const pixelsAcross =
      (tileSize * tileMetersPerPixel(z, latitudeDeg, tileSize)) / coarsest;
    const tilesAcross = Math.ceil(pixelsAcross / params.sourceTileWidth) + 1;
    if (tilesAcross ** 2 <= params.maxSourceTiles) {
      minzoom = z;
      break;
    }
  }
  return { minzoom, maxzoom };
}
