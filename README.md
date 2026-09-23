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

`examples/cog-basic` is a Vite app with eight datasets that exercise different
paths: swisstopo PK1000 (EPSG:2056 oblique Mercator, RGB), NLCD land cover
(Albers Equal Area, palette + nodata), a Tennessee orthophoto (EPSG:2274
State Plane in US survey feet, grayscale + nodata), NAIP (EPSG:26913, four
uint8 bands where the fourth is near-infrared), a Maxar WorldView-3 scene
(EPSG:32646, eight uint16 bands plus a mask, composed live from a preset
selector and a stretch slider), two float32 DEMs (swissALTI3D in EPSG:2056,
USGS 3DEP in EPSG:4326) and a uint16 Sentinel-2 band (EPSG:32636), the last
three drawn as shader contours with a legend. A projection selector switches
the map between mercator, globe and vertical-perspective.

```bash
pnpm install
pnpm dev
```

## How it works

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
band seed, mask discard, stretch, photometric conversion, colormap — and one
program is compiled per distinct module chain.

### Bands

Every band of a tile is uploaded once, as one single-channel layer of a
`TEXTURE_2D_ARRAY`, whatever the file's `PlanarConfiguration`. Which bands
make the picture is then a uniform, so a composite or a stretch changes
without reloading a tile:

```ts
// WorldView-3: eight uint16 bands. Bands are 0-based file indices;
// non-8-bit imagery needs a stretch, in sample units.
const layer = new COGLayer({
  id: "wv3",
  geotiff: "https://example.com/scene-ms.tif",
  bands: [4, 2, 1], // red, green, blue
  rescale: [0, 1800], // or one [min, max] per colour channel
});

// Live: false-colour infrared, then a different stretch.
layer.setBands([6, 4, 2]);
layer.setRescale([[300, 3600], [300, 1500], [300, 1200]]);

// One band as grey.
layer.setBands([6]);
```

Without `bands`, one band draws as grey, three as RGB, and four as RGBA only
when `ExtraSamples` declares the fourth alpha (or the file is CMYK) — NAIP's
fourth band is near-infrared and is left out. Two bands, or five and more,
have no default and need `bands`. Every sample type in the texture table is
read with an exactly typed sampler (`sampler2DArray`, `usampler2DArray`,
`isampler2DArray`), interpolated bilinearly in the shader from a one-texel
halo of neighbour tiles, so seams and nodata are exact: a pixel is nodata
when any of its colour bands is (palette rasters take the nearest texel
instead). 8-bit unsigned samples default to their full range; anything else
without `rescale` is a `RangeError` rather than a guessed stretch. The
contour `band` is the same layer index and may change through `setContour`.

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

The value is read from the band array with an exactly typed sampler, so
int16, uint16 and float32 rasters work here, and interpolated bilinearly in
the shader with `texelFetch` — integer textures cannot be LINEAR-filtered,
and this also keeps nodata exact. Bands classify
the value against up to 64 thresholds and look their colour up in a small
texture; the gradient maps the value onto a 256-texel ramp instead; lines
measure the distance to the nearest threshold in screen pixels via `fwidth`,
so they keep a constant width at every zoom and under globe. Colours are hex or `rgb()`/`rgba()` strings, and every contour option
is validated in the `COGLayer` constructor so a misconfiguration fails before
any network request. Output is raster: no labels and no picking. See
`docs/adr/0003-shader-contours.md`.

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
  below cannot apply: the shader hands it absolute float32 mercator positions,
  exactly as MapLibre's own globe layers do. With the `globe` style projection
  this only runs below z12, where MapLibre switches to flat mercator anyway.

### Precision

MapLibre hands custom layers a float32 matrix, and absolute mercator positions
in float32 start to jitter around z14. The fix is relative-to-centre:

- On the CPU, in float64: `O` = the map centre in mercator `[0, 1]`, and the
  uploaded matrix is `mainMatrix · translate(O)` — whose translation column is
  now small.
- Mesh positions are split into float32 high/low halves; `O` is split the same
  way and uploaded as two `vec2` uniforms.
- The vertex shader computes
  `rel = (a_pos_high - u_origin_high) + (a_pos_low - u_origin_low)` and feeds
  that to MapLibre's own `projectTile` prelude.

Both subtractions are exact (Sterbenz) for anything on screen, and — the part
that matters — **every tile in a frame uses the same origin**, so a vertex
shared by two adjacent tiles goes through bit-identical arithmetic in both.
Per-tile local origins are what produce cracks along tile edges.

### Playing nicely with MapLibre

MapLibre brackets every custom-layer draw itself: `setCustomLayerDefaults()`
before (which unbinds the VAO and resets cull face, the active texture unit and
the `UNPACK_*` pixel-store parameters) and `context.setDirty()` after (which
invalidates its entire cached view of GL state, so anything left bound is
re-bound before MapLibre next uses it). The layer therefore does **not** save
and restore state around a draw — that would only duplicate work MapLibre has
already committed to, at a `gl.getParameter` stall per value per frame.
Asynchronous tile uploads are a different matter: they run between frames,
outside that bracket, and restore the pixel-store parameters they touch.

The layer uses **plain `gl.uniform*`, never uniform blocks** — a custom layer that rebinds UBO binding
points 0–2 corrupts every MapLibre layer drawn after it
([maplibre-gl-js#8413](https://github.com/maplibre/maplibre-gl-js/issues/8413)).
Output is premultiplied alpha, matching the `blendFunc(ONE, ONE_MINUS_SRC_ALPHA)`
MapLibre configures. `map.triggerRepaint()` is called only when a tile finishes
loading, never per frame.

## Current limitations

- **Globe precision at high zoom.** Under the `vertical-perspective` style
  projection, which stays a globe at every zoom, positions are absolute
  float32 mercator and jitter from around z14 — the same limit MapLibre's own
  layers have there. The `globe` projection is unaffected: it renders flat
  mercator above z12, where the relative-to-centre path takes over.
- **Every band is uploaded.** A tile costs `width × height × bands × bytes`
  on the GPU whether one band or four are drawn; a 13-band uint16 stack is
  26 bytes per pixel. That is what makes `setBands` free of reloads.
- **No terrain draping.** MapLibre renders custom layers directly rather than
  through its render-to-texture pass, so with `map.setTerrain` active the raster
  stays flat at z = 0. Same limitation as deck.gl's interleaved mode.
- **Primary world only.** Panning past the antimeridian will not draw a wrapped
  copy of the raster.
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
