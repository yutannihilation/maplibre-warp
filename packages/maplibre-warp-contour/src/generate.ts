/**
 * One contour vector tile from a warped raster: the composition of level
 * selection, grid projection, fetching, resampling, contouring and encoding.
 *
 * Everything here is pure apart from `WarpSource.fetchTiles`, which is the
 * only I/O and is injected.
 */

import type { TileCoordinateOptions } from "./grid.js";
import { gridSize, projectGrid, toTileCoordinate } from "./grid.js";
import { buildIsobands } from "./isobands.js";
import { traceIsolines } from "./isolines.js";
import { selectLevel } from "./level.js";
import type { MvtFeature, MvtLayer } from "./mvt.js";
import { encodeMvt } from "./mvt.js";
import { createBilinearSampler, resampleGrid } from "./sampler.js";
import type { FetchedTile, TileRange } from "./window.js";
import { assembleWindow } from "./window.js";

export interface WarpLevel {
  metersPerPixel: number;
  tileWidth: number;
  tileHeight: number;
  matrixWidth: number;
  matrixHeight: number;
  /** Source CRS → this level's continuous pixel coordinates. */
  crsToPixel: (x: number, y: number) => [number, number];
}

export interface WarpSource {
  /** Coarsest first. */
  levels: WarpLevel[];
  /** MapLibre mercator `[0, 1]` → source CRS. May throw or return NaN. */
  mercatorToCrs: (mx: number, my: number) => [number, number];
  fetchTiles(
    levelIndex: number,
    xy: Array<[number, number]>,
    signal?: AbortSignal,
  ): Promise<FetchedTile[]>;
}

export interface ContourOptions {
  /** Band index to contour. */
  band: number;
  thresholds: readonly number[];
  mode: "bands" | "lines" | "both";
  tileSize: number;
  buffer: number;
  extent: number;
  includeLower: boolean;
  includeUpper: boolean;
  layerNames: { bands: string; lines: string };
  /** Fail rather than fetch more source tiles than this for one tile. */
  maxSourceTiles: number;
}

export interface TileRequest {
  z: number;
  x: number;
  y: number;
}

/** Latitude of a tile's centre, in degrees. */
export function tileCentreLatitude(z: number, y: number): number {
  const my = (y + 0.5) / 2 ** z;
  return (Math.atan(Math.sinh(Math.PI * (1 - 2 * my))) * 180) / Math.PI;
}

export async function generateContourTile(
  request: TileRequest,
  source: WarpSource,
  options: ContourOptions,
  signal?: AbortSignal,
): Promise<Uint8Array | null> {
  const { z, x, y } = request;
  const { tileSize, buffer } = options;
  const levelIndex = selectLevel(
    source.levels.map((l) => l.metersPerPixel),
    z,
    tileCentreLatitude(z, y),
    tileSize,
  );
  const level = source.levels[levelIndex]!;

  const spec = { z, x, y, tileSize, buffer };
  const pixelCoords = projectGrid(spec, (mx, my) => {
    try {
      const [cx, cy] = source.mercatorToCrs(mx, my);
      return level.crsToPixel(cx, cy);
    } catch {
      return [Number.NaN, Number.NaN];
    }
  });

  const range = tileRangeFor(pixelCoords, level);
  if (!range) {
    return null;
  }
  const count =
    (range.maxCol - range.minCol + 1) * (range.maxRow - range.minRow + 1);
  if (count > options.maxSourceTiles) {
    throw new RangeError(
      `tile ${z}/${x}/${y} needs ${count} source tiles at level ${levelIndex}, ` +
        `more than maxSourceTiles (${options.maxSourceTiles}); raise the source's minzoom`,
    );
  }

  const xy: Array<[number, number]> = [];
  for (let row = range.minRow; row <= range.maxRow; row++) {
    for (let col = range.minCol; col <= range.maxCol; col++) {
      xy.push([col, row]);
    }
  }
  const tiles = await source.fetchTiles(levelIndex, xy, signal);
  if (signal?.aborted) {
    throw new DOMException("Contour tile aborted", "AbortError");
  }

  const window = assembleWindow(tiles, level, range);
  const grid = resampleGrid(pixelCoords, createBilinearSampler(window));
  const n = gridSize(spec);
  const coord: TileCoordinateOptions = {
    tileSize,
    buffer,
    extent: options.extent,
  };

  const layers: MvtLayer[] = [];
  if (options.mode !== "lines") {
    const features: MvtFeature[] = [];
    for (const band of buildIsobands(grid, n, options.thresholds, {
      includeLower: options.includeLower,
      includeUpper: options.includeUpper,
    })) {
      const properties: MvtFeature["properties"] = { band: band.band };
      if (band.min !== undefined) {
        properties.min = band.min;
      }
      if (band.max !== undefined) {
        properties.max = band.max;
      }
      for (const polygon of band.polygons) {
        features.push({
          type: "polygon",
          geometry: polygon.map((ring) => toTileGeometry(ring, coord)),
          properties,
        });
      }
    }
    layers.push({
      name: options.layerNames.bands,
      extent: options.extent,
      features,
    });
  }
  if (options.mode !== "bands") {
    const features: MvtFeature[] = [];
    traceIsolines(grid, n, options.thresholds).forEach((iso, index) => {
      if (iso.lines.length === 0) {
        return;
      }
      features.push({
        type: "line",
        geometry: iso.lines.map((line) => toTileGeometry(line, coord)),
        properties: { level: iso.level, index },
      });
    });
    layers.push({
      name: options.layerNames.lines,
      extent: options.extent,
      features,
    });
  }
  return encodeMvt(layers);
}

/**
 * Source tile range covering the finite pixel coordinates, widened by one
 * pixel for bilinear neighbours and clamped to the tile matrix. `null` when
 * nothing projects into the level.
 */
function tileRangeFor(
  pixelCoords: Float64Array,
  level: WarpLevel,
): TileRange | null {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (let k = 0; k < pixelCoords.length; k += 2) {
    const px = pixelCoords[k]!;
    const py = pixelCoords[k + 1]!;
    if (!Number.isFinite(px) || !Number.isFinite(py)) {
      continue;
    }
    minX = Math.min(minX, px);
    maxX = Math.max(maxX, px);
    minY = Math.min(minY, py);
    maxY = Math.max(maxY, py);
  }
  if (!Number.isFinite(minX)) {
    return null;
  }
  const range: TileRange = {
    minCol: Math.max(0, Math.floor((minX - 1) / level.tileWidth)),
    maxCol: Math.min(
      level.matrixWidth - 1,
      Math.floor((maxX + 1) / level.tileWidth),
    ),
    minRow: Math.max(0, Math.floor((minY - 1) / level.tileHeight)),
    maxRow: Math.min(
      level.matrixHeight - 1,
      Math.floor((maxY + 1) / level.tileHeight),
    ),
  };
  if (range.minCol > range.maxCol || range.minRow > range.maxRow) {
    return null;
  }
  return range;
}

function toTileGeometry(
  coords: Float64Array,
  options: TileCoordinateOptions,
): Int32Array {
  const out = new Int32Array(coords.length);
  for (let k = 0; k < coords.length; k++) {
    out[k] = toTileCoordinate(coords[k]!, options);
  }
  return out;
}
