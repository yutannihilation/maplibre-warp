# ADR 0001: Contour vector tiles by warping the raster first

Status: Proposed

## Context

Contours (filled bands and lines) from a COG should be a MapLibre **vector
source**, so users style them with fill and line layers. The COG is in its own
CRS; MapLibre requests web-mercator XYZ tiles. Generating on the GPU was ruled
out: MapLibre GL JS 6 is WebGL2-only, WebGPU cannot read its textures, and the
expensive stages (ring joining, band topology) are not GPU-shaped.

## Decision

Per XYZ tile, **resample the raster onto a mercator-aligned grid on the CPU**,
then contour that grid (`packages/maplibre-warp-contour`):

- The grid holds corner samples of `tileSize + 2·buffer` cells, so its outer
  edge is the MVT buffer and no polygon clipping is needed. Samples lie on a
  global lattice per zoom, so neighbouring tiles agree along shared edges.
- Inverse projection (mercator → source pixel) runs on a coarse lattice
  (every 16 samples) with bilinear interpolation in between; exact for affine
  maps, sub-pixel for smooth projections, and ~300 proj4 calls instead of 66k.
- Isolines: own 16-case marching squares with edge-id joining.
- Isobands: `d3-contour` cumulative regions `P_i = {v ≥ t_i}`; band `i` is the
  union of rings of `P_i` and `P_{i+1}` re-nested by containment (even depth =
  outer, odd = hole), identical ring pairs cancelling. Exact, no boolean
  clipping library.
- Encoding: hand-written MVT v2 writer (no runtime dependency); round-trip
  tested with `@mapbox/vector-tile`.
- The whole pipeline runs in a module worker owning its own `GeoTIFF`;
  `worker: false` runs it in the calling thread.

## Alternatives rejected

- Contour in source space, project vertices, clip to a rectangle: viable, but
  per-source-tile caching leaves hairline seams along curved source-tile
  edges inside a vector tile, and without caching it contours 1–4× more cells.
- MLT via `@maplibre/mlt`: adds a runtime dependency for no functional gain.
- GeoJSON source with `setData`: does not scale beyond small datasets.

## Consequences

- Bilinear resampling smooths the data slightly (sub-pixel at matched
  resolution). Contours past source resolution look faceted, as with any
  raster method.
- Tiles below the advertised `minzoom` are refused explicitly (`RangeError`)
  rather than fetching an unbounded number of source tiles.
- Decoded tiles are not shared with `COGLayer`; both fetch the same byte
  ranges, which the HTTP cache usually dedupes.
