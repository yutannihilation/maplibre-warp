# ADR 0003: Contours rendered in the fragment shader

Status: Proposed

## Context

Filled contour bands and lines from a DEM should be drawable by `COGLayer`
itself, with colours from a colour scheme, configurable line width and
colour, and enough information to build a legend. Vector output (see ADR
0001, branch `feat/vector-contour`) exists separately; this is the GPU-only
raster counterpart: no labels, no picking, but no CPU contouring and it
follows the warp mesh and globe projection for free.

## Decision

Three shader modules in `maplibre-warp-raster/src/gpu-modules/contour.ts`,
chained by `inferRenderPipeline(geotiff, gl, { contour })`:

- **`ValueTexture`** (one variant per sampler kind: float, uint, int) seeds
  two fragment-template variables, `value` (data units, GDAL scale/offset
  applied) and `valid`. It interpolates **bilinearly itself with
  `texelFetch`**, so integer textures — which cannot be LINEAR-filtered — and
  float textures without `OES_texture_float_linear` behave alike, and a
  nodata texel among the four contributors marks the pixel invalid instead of
  bleeding. This is what lifts the 8-bit restriction for the contour path.
- **`Isoband`** counts thresholds ≤ `value` and looks the band colour up in an
  `n × 1` RGBA8 texture built from the configured colours (list or
  interpolator). Switched-off open bands become transparent, not discarded,
  so lines can still be drawn on them.
- **`ContourLine`** draws anti-aliased lines of constant screen width:
  `|value − t| / fwidth(value)` pixels from the nearest threshold, `smoothstep`
  edge, straight-alpha "over" compositing; every k-th threshold is a major
  line with its own width and colour. `ClearColor` provides a transparent base
  for lines without bands.

Supporting changes: `RasterProgram.setUniform` handles array uniforms
(`uniform1fv` etc.), modules may carry a `fsSharedDecl` emitted once per key
(the threshold uniforms shared by `Isoband` and `ContourLine`), and
`buildFragmentSource` declares `value`/`valid` in `main()`. The band model
(`bandsFromThresholds`, `resolveBandColors`, `parseCssColor`) is pure and
also drives `COGLayer.getBands()` for legends.

## Alternatives rejected

- Hardware LINEAR sampling: unavailable for int16/uint16, extension-gated
  for float32, and the nodata halo the README already documents.
- Parsing any CSS colour through a canvas `fillStyle`: DOM side effect,
  untestable in jsdom. Hex and `rgb()/rgba()` cover colour-scheme libraries.
- Thresholds as a texture instead of a `float[64]` uniform: more general,
  but 64 levels is ample and a uniform loop is simpler.

## Consequences

- At most 64 thresholds per layer (`MAX_THRESHOLDS`).
- Contours past source resolution look faceted (bilinear), like any raster
  method; tile edges clamp their own texels, so the half-texel at a tile
  boundary is not interpolated across tiles.
- Non-contour rendering of 16/32-bit rasters is still unsupported.
