# maplibre-warp

Render Cloud-Optimized GeoTIFFs as a **native MapLibre GL JS custom layer**,
reprojecting from the file's own CRS on the GPU — no deck.gl, no server-side
warping, no requirement that the COG be in EPSG:3857.

This is an experiment: it takes the I/O, decode, georeferencing and
mesh-generation half of [`deck.gl-raster`][dgr] (which is framework-free and
published on npm) and reimplements the rendering half directly against
MapLibre's `CustomLayerInterface` and raw WebGL2.

[dgr]: https://github.com/developmentseed/deck.gl-raster

```ts
import * as maplibregl from "maplibre-gl";
import { COGLayer } from "@yutannihilation/maplibre-warp-geotiff";

const map = new maplibregl.Map({ container: "map", style: "…" });

map.on("load", () => {
  map.addLayer(
    new COGLayer({
      id: "cog",
      geotiff: "https://example.com/some-utm-cog.tif",
    }),
    // Insert under the basemap's labels.
    "place-label",
  );
});
```

## Why this rather than a protocol plugin

The established MapLibre COG plugin,
[`@geomatico/maplibre-cog-protocol`](https://github.com/geomatico/maplibre-cog-protocol),
decodes tiles on the CPU via `addProtocol` and hands MapLibre 8-bit RGBA: it is
EPSG:3857 only, with no reprojection and CPU colormaps. This layer instead
uploads the raw bands as GPU textures, warps each tile through a CPU-generated
adaptive mesh, and styles it in a composed fragment shader — so any CRS works,
and the data reaches the GPU unquantised.

## Packages

| Package | What it is |
| --- | --- |
| `@yutannihilation/maplibre-warp-raster` | Renderer core: the custom-layer base class, tile scheduler, warp mesh, shader assembly and program cache. Source-format agnostic. |
| `@yutannihilation/maplibre-warp-geotiff` | COG specifics: opening the file, building the tile pyramid, inferring a render pipeline from TIFF tags, texture formats. |

`examples/cog-basic` is a Vite app with six datasets that exercise different
paths: swisstopo PK1000 (EPSG:2056 oblique Mercator, RGB), NLCD land cover
(Albers Equal Area, palette + nodata), a Tennessee orthophoto (EPSG:2274
State Plane in US survey feet, grayscale + nodata), two float32 DEMs
(swissALTI3D in EPSG:2056, USGS 3DEP in EPSG:4326) and a uint16 Sentinel-2
band (EPSG:32636), the last three drawn as shader contours with a legend. A projection selector switches the map between mercator, globe
and vertical-perspective.

```bash
pnpm install
pnpm dev
```

## How it works

This is the short version. [`docs/internals.md`](docs/internals.md) walks
through the MapLibre custom-layer API, the load-to-texture path and the warp
in detail.

**Tile selection.** A frustum-culling traversal walks the COG's overview
pyramid, choosing per tile the coarsest level whose source pixels are no larger
than a framebuffer pixel. Because a COG pyramid is a stack of independent grids
rather than a quadtree, children are found by mapping a tile's source-CRS bounds
into the next level's grid.

**Tile loading.** Requests are issued centre-out and go through
`@developmentseed/geotiff`'s per-origin connection pool, which is small (six
for HTTP/1.1) and first-come-first-served. To keep that queue from filling with
tiles the view has moved on from, the scheduler starts no loads while the map
is zooming — every intermediate zoom would select a level the user never ends
up looking at — and aborts loads for tiles that have scrolled off screen once
more than `maxConcurrentRequests` are in flight. Loads still overlapping the
view are kept even after a level change, because a tile that is not the
selected level still gets drawn: while a selected tile loads, its loaded
ancestors and any loaded descendants up to two levels finer stand in for it,
so a small zoom-out keeps the detail already on screen instead of dropping to
a coarse overview. Loaded tiles are cached up to `maxCacheSize` tiles /
`maxCacheByteSize` bytes; in-flight loads do not count, and the loaded
ancestors of whatever is on screen are never evicted. `lodBias` trades sharpness for
tile count: `1` fetches what deck.gl-raster does for the same view, about a
quarter of the default.

**Warping.** Each tile's mesh comes from `@developmentseed/raster-reproject`
(Delatin, refined until the reprojection error falls below 0.125 source pixels),
evaluated straight into MapLibre mercator `[0, 1]` in float64. Flat areas get a
handful of triangles; areas where the projection curves get more.

**Styling.** Shader modules are concatenated into one fragment shader —
texture seed, nodata discard, mask discard, photometric conversion, colormap —
and one program is compiled per distinct module chain.

### Contours in the shader

With the `contour` option the layer draws a DEM as filled bands, a continuous
gradient or lines only — instead of imagery, entirely in the fragment shader:

```ts
import { interpolateViridis, schemeBlues } from "d3-scale-chromatic";

// Continuous interpolator: called once per band with t in [0, 1]
// (plus the band index and count, if you want them).
const layer = new COGLayer({
  id: "dem",
  geotiff: "https://example.com/dem.tif",
  opacity: 0.8,
  contour: {
    thresholds: [200, 400, 600, 800],
    fill: "bands", // the default
    bands: { colors: interpolateViridis },
    lines: { width: 1, color: "#333", majorEvery: 5, majorWidth: 2 },
  },
});
layer.getBands(); // [{ band, min, max, color }, …] for a legend

// Discrete scheme: an array whose length must equal the number of bands.
bands: { colors: schemeBlues[5] }

// Re-style in place — no reload, tiles on the GPU repaint with the new
// options on the next frame. Everything but `band` can change, including
// the fill mode and lines on or off; a new module chain is compiled on
// demand.
layer.setContour({
  thresholds: [100, 300, 500, 700, 900],
  bands: { colors: interpolateViridis },
  lines: { width: 1 },
});

// The raw-raster view: the same colours run continuously from the first
// threshold to the last (the ones in between only matter to the lines).
layer.setContour({
  thresholds: [100, 300, 500, 700, 900],
  fill: "gradient",
  bands: { colors: interpolateViridis, includeLower: true },
});
layer.getGradient(); // { min, max, stops } for a ramp legend

// Lines only, and opacity — also live, also without a reload.
layer.setContour({ thresholds: [100, 300, 500, 700, 900], fill: "none" });
layer.setOpacity(0.5);
```

The value is read with an exactly typed sampler (`sampler2D`, `usampler2D`
or `isampler2D`), so int16, uint16 and float32 rasters work here, and
interpolated bilinearly in the shader with `texelFetch` — integer textures
cannot be LINEAR-filtered, and this also keeps nodata exact. Bands classify
the value against up to 64 thresholds and look their colour up in a small
texture; the gradient maps the value onto a 256-texel ramp instead; lines
measure the distance to the nearest threshold in screen pixels via `fwidth`,
so they keep a constant width at every zoom and under globe. Colours are hex or `rgb()`/`rgba()` strings, and every contour option
is validated in the `COGLayer` constructor so a misconfiguration fails before
any network request. Output is raster: no labels and no picking.

### Globe

The layer follows whichever projection the map is rendering with, read every
frame from `shaderData.variantName`. MapLibre has two shader variants,
`mercator` and `globe`; the latter also covers the animated globe↔mercator
transition. One program is compiled per variant, and the tile traversal
switches spaces with it:

- Under globe, tile bounding volumes are fitted on MapLibre's unit sphere
  (using the same mercator → sphere formula as its vertex prelude) and culled
  against the side planes of the globe matrix plus MapLibre's horizon plane,
  which is what removes tiles on the far side of the planet. Tiles spanning
  more than 30° are never culled — nine sample points cannot bound that much
  sphere — and their children are tested instead.
- The globe is drawn at the mercator scale of the map centre's latitude, so the
  LOD criterion uses that latitude for every tile (a tile's own latitude, the
  right choice under mercator, would leave lower-latitude tiles blurry), then
  coarsens tiles seen obliquely towards the limb.
- Under globe, `projectTile` maps its input through a non-linear sphere
  conversion before any matrix, so the relative-to-centre precision scheme
  cannot apply: the shader hands it absolute float32 mercator positions,
  exactly as MapLibre's own globe layers do. With the `globe` style projection
  this only runs below z12, where MapLibre switches to flat mercator anyway.

### Precision and GL state

Absolute mercator positions in a float32 vertex pipeline jitter from around
z14. The layer avoids that with a relative-to-centre scheme: mesh positions
are split into float32 high/low halves, the map centre is subtracted in the
vertex shader before MapLibre's `projectTile`, and the translation is folded
into the matrix on the CPU in float64. Every tile in a frame uses the same
origin, so shared vertices stay bit-identical and tile edges cannot crack.

The layer also relies on MapLibre's own bracketing of custom-layer draws
instead of saving and restoring GL state, uses plain `gl.uniform*` rather
than uniform blocks
([maplibre-gl-js#8413](https://github.com/maplibre/maplibre-gl-js/issues/8413)),
and outputs premultiplied alpha. The details, and the reasoning behind each
choice, are in [`docs/internals.md`](docs/internals.md).

## Current limitations

- **Globe precision at high zoom.** Under the `vertical-perspective` style
  projection, which stays a globe at every zoom, positions are absolute
  float32 mercator and jitter from around z14 — the same limit MapLibre's own
  layers have there. The `globe` projection is unaffected: it renders flat
  mercator above z12, where the relative-to-centre path takes over.
- **8-bit unsigned samples only for imagery.** 16/32-bit and signed/float
  rasters throw an explicit error rather than rendering something wrong; they
  need the integer-sampler path for colour output. The contour path already
  reads them through typed samplers.
- **No terrain draping.** MapLibre renders custom layers directly rather than
  through its render-to-texture pass, so with `map.setTerrain` active the raster
  stays flat at z = 0. Same limitation as deck.gl's interleaved mode.
- **Primary world only.** Panning past the antimeridian will not draw a wrapped
  copy of the raster.
- **Nodata edges.** Nodata is a `discard` on an exact value comparison. With
  linear filtering, texels straddling a nodata boundary interpolate away from
  the sentinel, so a one-texel halo can appear. Palette images already use
  nearest filtering; everything else uses linear.
- **Single COG per layer.** No band compositing across files, no mosaics.

## Development

```bash
pnpm install
pnpm build       # tsc --build across both packages
pnpm test        # vitest
pnpm typecheck
pnpm check       # biome lint + format
pnpm dev         # the cog-basic example on :5173
```

Requires Node ≥ 22 and pnpm 12 (pinned via `packageManager`).
`maplibre-gl` ≥ 6.7 is a peer dependency; v5 is not supported.

## Attribution

Substantial parts are ported from
[`deck.gl-raster`](https://github.com/developmentseed/deck.gl-raster) by
Development Seed, under the MIT licence: the tile traversal and tileset
descriptors, the fp64 split, the shader-module GLSL bodies, and the
render-pipeline inference. Every vendored file names its origin in a header
comment. The `@developmentseed/*` packages this repo depends on are used as
published, not vendored.

MIT.
