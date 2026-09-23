# Internals: from COG bytes to warped pixels

This document explains how maplibre-warp gets a Cloud-Optimized GeoTIFF onto
the GPU and draws it reprojected inside a MapLibre GL JS map. It covers three
things:

1. The MapLibre API the package plugs into, and what MapLibre promises a
   custom layer.
2. How a tile of the image is fetched, decoded and uploaded as a texture.
3. How that texture is warped from the file's CRS into the map's projection.

Paths to this repository's source files are given relative to `packages/`;
MapLibre's own files are named by their file name only. The two packages split along
the source-format boundary: `maplibre-warp-raster` knows nothing about
GeoTIFF, `maplibre-warp-geotiff` knows nothing about MapLibre beyond the base
class it extends.

## 1. The MapLibre side: `CustomLayerInterface`

MapLibre lets you insert a layer that draws straight into the map's WebGL2
context, between any two style layers, with the map's camera. That is
`CustomLayerInterface` (`maplibre-gl.d.ts`), and it is a specification to
implement rather than a class to extend:

| Member | Contract |
| --- | --- |
| `id`, `type: "custom"` | Identity; `type` must be the literal `"custom"`. |
| `renderingMode` | `"2d"` (default) gets read-only depth; `"3d"` shares the depth buffer. |
| `onAdd(map, gl)` | Called by `map.addLayer`. Create GL resources, register listeners. |
| `render(gl, args)` | Called every frame during the translucent pass. Draw into the default framebuffer. |
| `prerender(gl, args)` | Optional, called in the offscreen pass. For render-to-texture; unused here. |
| `onRemove(map, gl)` | Called by `map.removeLayer`. Free everything. |

`map.triggerRepaint()` is the only way to ask for a frame outside of camera
movement.

### What `render` receives

`args` is a `CustomRenderMethodInput`. The two fields this package uses are:

**`shaderData`** — how to write a vertex shader that projects the way
MapLibre's own layers do:

- `variantName`: a string that changes whenever the projection shader code
  changes (`"mercator"` or `"globe"`). MapLibre documents it as a cache key
  for compiled programs.
- `vertexShaderPrelude`: GLSL that declares `uniform mat4 u_projection_matrix`
  and a `vec4 projectTile(vec2)` function, plus the globe uniforms under the
  globe variant.
- `define`: `#define`s to paste in (`#define GLOBE` under globe).

**`defaultProjectionData`** — the uniform values that make `projectTile`
accept a `vec2` in **spherical mercator `[0, 1]`**, `[0, 0]` being the
top-left of the world (this is `MercatorCoordinate` space). MapLibre builds it
from the zoom-0 tile's matrix scaled by `EXTENT`, so under mercator
`mainMatrix` is simply "mercator `[0, 1]` → clip space". The custom-layer
variant of this type allows `mainMatrix` to be a **`Float64Array`**, and
MapLibre documents why: so a layer can do CPU-side arithmetic on it before
converting to float32 for upload. Section 3.3 relies on exactly that. Under
globe there are four more values (`tileMercatorCoords`,
`clippingPlane`, `projectionTransition`, `fallbackMatrix`), each with a fixed
uniform name.

### What MapLibre does around the call

`drawCustom` in MapLibre 6 wraps every `render` like this:

```
painter.setCustomLayerDefaults()   // unbind VAO; reset cull face, active
                                   // texture unit and UNPACK_* pixel store
context.setColorMode(...)          // blendFunc(ONE, ONE_MINUS_SRC_ALPHA)
context.setStencilMode(disabled)
context.setDepthMode(readOnly)     // for renderingMode "2d"
implementation.render(gl, args)
context.setDirty()                 // forget every cached GL state value
```

Two consequences shape the implementation. Output must be **premultiplied
alpha**, because of the blend function. And `render` need not save and restore
GL state: the state on entry is known, and `setDirty()` means MapLibre re-binds
whatever it needs before its next draw. Anything that runs *outside* this
bracket, such as an asynchronous texture upload between frames, does have to
restore what it touches, because MapLibre's cached view of GL state is not
invalidated there.

One caveat: `drawCustom` has no `try`/`finally`, so if `render` throws,
`setDirty()` is skipped and MapLibre's cached state stays stale for the rest
of the frame. The exception also propagates out of MapLibre's render loop, so
that frame is broken regardless. The one thing in `render` that can throw is
program compilation, which happens lazily at a tile's first draw; a shader
that fails to compile therefore fails the whole frame, not just the tile.

One MapLibre-specific hazard: a custom layer that binds uniform buffer objects
to binding points 0–2 corrupts every MapLibre layer drawn after it in the same
frame ([maplibre-gl-js#8413](https://github.com/maplibre/maplibre-gl-js/issues/8413)).
This package uses plain `gl.uniform*` calls only.

### Our implementation

`RasterCustomLayer` (`maplibre-warp-raster/src/raster-custom-layer.ts`) is the
abstract base that implements the interface; `COGLayer`
(`maplibre-warp-geotiff/src/cog-layer.ts`) subclasses it and supplies the
GeoTIFF-specific `createSource`.

```
                 map.addLayer(new COGLayer({ geotiff }))
                                │
                                ▼
RasterCustomLayer.onAdd ──► ProgramCache, AbortController, "zoomend" listener
                                │
                                ▼  (async, retried with backoff)
COGLayer.createSource   ──► open COG, resolve CRS, build tileset descriptor,
                            infer render pipeline, return { descriptor,
                            wgs84Bounds, loadTile }
                                │
                                ▼
attachSource            ──► new TileScheduler({ loadTile, destroyTile, … })
                            map.triggerRepaint()

every frame:
RasterCustomLayer.render ─► viewport from args ─► scheduler.update()
                            ─► draw list ─► one drawElements per tile
```

`onAdd` allocates nothing but a program cache and starts opening the source;
until the source resolves, `render` returns immediately and draws nothing.
`onRemove` aborts the open, destroys the scheduler (which frees every tile's
GPU resources) and the program cache.

`render` does exactly the work the frame needs and no more:

1. Map `args.shaderData.variantName` to `"mercator"` or `"globe"`; warn once
   and skip if it is anything else.
2. Build a `RasterViewport` from the map and `args`
   (`viewport-shim.ts`): frustum planes extracted from `mainMatrix`, zoom,
   centre, bounds, framebuffer pixel ratio.
3. `scheduler.update(viewport)` selects tiles, starts loads, and returns the
   loaded tiles to draw, coarsest first. Loads are suspended while
   `map.isZooming()`; the `zoomend` listener repaints once the zoom settles.
4. Compute the per-frame uniforms (section 3.3) and draw each tile.

Repaints are requested on events, never per frame: when a tile finishes
loading or a failed tile's retry falls due (the scheduler's `onNeedsRepaint`),
when the source attaches, when a zoom animation ends, and when `setOpacity`
or `COGLayer.setContour` changes a per-frame uniform or module chain.

## 2. Loading: from COG to texture

### 2.1 Opening the file

`COGLayer.createSource` runs once per layer (and again on retry):

1. **Fetch the header.** `fetchGeoTIFF` wraps `@developmentseed/geotiff`'s
   `GeoTIFF.fromUrl`, which reads the IFDs over HTTP range requests. Requests
   go through a `PerOriginSemaphore` capped at six, matching the browser's
   HTTP/1.1 per-origin connection limit.
2. **Resolve the CRS.** The GeoTIFF's CRS is either an EPSG code (resolved
   through `epsg.io` by default, cached) or WKT (parsed locally). proj4 builds
   two converters, source ↔ EPSG:4326 and source ↔ EPSG:3857. The 3857
   forward is wrapped in `makeClampedForwardTo3857` because proj4 returns
   `NaN` at the poles.
3. **Build the tileset descriptor.** `geoTiffToDescriptor`
   (`geotiff-tileset.ts`) makes one `AffineTilesetLevel` per image: the
   overviews coarsest-first, then the full-resolution image as the finest
   level. Each level holds the image's affine geotransform, pixel dimensions
   and tile size, and derives `metersPerPixel` (geometric mean of the pixel
   edges times metres-per-CRS-unit) for LOD selection. Because each level is
   an arbitrary affine, rotated and skewed geotransforms work unchanged. Note
   that a COG pyramid is a stack of independent grids, not a quadtree; the
   traversal finds children by mapping a tile's CRS bounds into the next
   level's grid.
4. **Infer the render pipeline.** `inferRenderPipeline`
   (`render-pipeline.ts`) reads `SampleFormat`, `BitsPerSample`,
   `SamplesPerPixel`, `PhotometricInterpretation`, `ColorMap` and nodata from
   the tags and returns a `GeoTiffRenderer`: a texture loader plus a function
   that builds the shader module chain for a tile. A palette image uploads
   its colormap as a texture here, once for the layer.

The `RasterSource` returned to the base class is three things: the descriptor,
the dataset's WGS84 bounds (for culling), and a `loadTile(index, { gl, signal })`
closure that does everything in the next two subsections.

### 2.2 Deciding which tiles to load

Every frame, `TileScheduler.update` (`tile-scheduler.ts`) calls
`getTileIndices` (`tileset/traversal.ts`), a frustum-culling walk of the
pyramid ported from deck.gl-raster. For each tile it:

1. Fits an oriented bounding box to nine reference points of the tile
   reprojected into common space (or onto the unit sphere under globe), cached
   across frames.
2. Culls it against the frustum planes.
3. Selects it if one source pixel is at most `2^lodBias` framebuffer pixels on
   screen, or if it is already at the finest level (or has no children at
   the next level); otherwise recurses into its children. The second case is
   why zooming far past the native resolution keeps drawing full-resolution
   tiles, magnified, instead of nothing.

Selected tiles that are not loaded are requested centre-out. Loaded ancestors
and near descendants stand in for them until they arrive. The README's "Tile
loading" section describes the pruning, retry and eviction policies.

### 2.3 Fetching and decoding one tile

`GeoTiffRenderer.loadTileTextures` → `fetchTilePixels` (`render-pipeline.ts`):

- `image.fetchTile(x, y, { boundless: false, pool, signal })` fetches the
  tile's byte range and decodes it in `@developmentseed/geotiff`'s worker
  `DecoderPool`. `boundless: false` means edge tiles come back clipped to the
  image, so the decoded width and height can be smaller than the nominal tile
  size; everything downstream uses the decoded size.
- The result is a pixel-interleaved typed array (`Uint8Array`,
  `Uint16Array`, `Float32Array`, …) plus an optional validity mask from the
  GeoTIFF's mask IFD. Band-separate layouts are rejected.
- Three-sample data is padded to four with an opaque alpha
  (`addAlphaChannel`), because WebGL2 has no three-channel 8-bit format worth
  sampling from.
- In contour mode the tile's eight neighbours are fetched too, through a
  shared `DecodedTileCache`, and their edge texels are stitched around it as
  a one-texel halo (`halo.ts`). Imagery does not do this.

### 2.4 Choosing the texture format

`inferTextureFormat` (`texture.ts`) maps `(channels, scalar kind, bit width)`
to a WebGL2 `(internalFormat, format, type)` triple and records what that
implies for the shader:

| Sample layout | Internal format | Sampler | Filterable | Sampled as |
| --- | --- | --- | --- | --- |
| 1/2/4 × uint8 | `R8` / `RG8` / `RGBA8` | `sampler2D` | yes | normalised `[0, 1]` |
| 1/2/4 × uint16 | `R16UI` / `RG16UI` / `RGBA16UI` | `usampler2D` | no | raw integers |
| 1 × int8/16/32 | `R8I` / `R16I` / `R32I` | `isampler2D` | no | raw integers |
| 1/2/4 × float32 | `R32F` / `RG32F` / `RGBA32F` | `sampler2D` | no¹ | raw floats |

¹ Linear filtering of float textures needs `OES_texture_float_linear`; the
table reports it as unavailable and the loader falls back to `NEAREST`.

The imagery path currently accepts only 8-bit unsigned samples and throws for
the rest. The contour path accepts every row of the table, because it reads
values with an exact-typed sampler and interpolates in the shader.

### 2.5 Uploading

`createTexture2D` (`texture.ts`) is one `texImage2D` with tightly packed rows,
no Y flip and no alpha premultiplication, because raster samples are data and
must reach the texture byte-for-byte. Filtering is `LINEAR` only for 8-bit
continuous imagery. Palette indices and masks are `NEAREST` by choice, and
every integer and float32 format is `NEAREST` because the format table marks
them non-filterable, so `createTexture2D` downgrades the request silently.
Wrap is `CLAMP_TO_EDGE`.

Uploads happen between frames, outside MapLibre's state bracket, so the
function saves and restores the active texture unit, the texture binding and
the three `UNPACK_*` pixel-store parameters around itself. A tile whose load
was aborted while its texture was already uploaded has that texture deleted
immediately.

The mask, when present, becomes a second `R8` texture at the unpadded tile
size with `NEAREST` filtering, so its edges never interpolate into a
half-transparent fringe.

## 3. Warping: from source pixels to the map

### 3.1 The idea

A conventional warp (GDAL, a tile server) resamples the image on the CPU into
the target grid, then serves the result. maplibre-warp never resamples pixels.
The tile stays in its native pixel grid as a texture, and the **geometry** is
deformed instead: a triangle mesh whose vertices carry both a texture
coordinate in the tile and a position in MapLibre mercator space. The GPU
rasteriser interpolates the texture coordinate linearly across each triangle,
which is exactly a piecewise-linear approximation of the inverse projection,
evaluated per fragment at texture-sampling cost.

The approximation error is controlled by triangle density. Where the
projection is nearly affine (most of a UTM tile at moderate latitude) a tile
needs a handful of triangles; where it curves, more are added until the error
is below a threshold.

### 3.2 Building the mesh on the CPU

`loadTile` in `cog-layer.ts`, after the textures are ready, composes four
functions and hands them to the reprojector:

```
tile pixel (px, py)
   │  forwardTransform: the level's affine, offset to this tile
   ▼
source CRS (x, y)
   │  forwardReproject: proj4 source → EPSG:3857 (pole-clamped),
   │                    then mercatorFromEPSG3857
   ▼
MapLibre mercator [0, 1]  (Y increasing south)
```

with `inverseTransform` and `inverseReproject` for the other direction.

`buildTileMesh` (`maplibre-warp-raster/src/mesh.ts`) then runs
`RasterReprojector` from `@developmentseed/raster-reproject`. It is a Delatin
refinement: start from a triangulation of the tile, measure at each candidate
point how far the mesh's linear interpolation lands from the true reprojection
(in **source pixels**), insert the worst point, repeat until the maximum error
is below `maxError` (default 0.125 px). Two details:

- The grid is `(width + 1) × (height + 1)`, because vertices sit on pixel
  **corners**. A mesh sized to the pixel count would stop one row short of the
  tile's far edge and leave gaps between neighbouring tiles.
- The initial triangulation comes from
  `createInitialWebMercatorTriangulation`, fed the latitudes of the decoded
  tile's four corners. For a tile that crosses the ±85.05° Web Mercator limit
  it restricts the starting mesh to the representable latitude band, so the
  polar rows, whose clamped vertices would all collapse onto one Y and never
  converge, are never meshed at all. It applies only when the tile's rows are
  constant-latitude (north-up or south-up geographic grids); any other tile
  starts from the full rectangle.

The output is `uvs` (float32, `[0, 1]` across the decoded tile), triangle
indices, and `exactOutputPositions` in mercator `[0, 1]` as **float64**. Those
positions are then split with `splitFloat64Array` (`fp64.ts`) into two
float32 arrays, `high = fround(v)` and `low = v - high`, which together carry
about 48 bits of mantissa.

`GpuMesh` (`mesh.ts`) uploads the four arrays into a VAO: three `vec2`
attributes at fixed locations 0 (`a_pos_high`), 1 (`a_pos_low`) and 2
(`a_uv`), plus a `Uint32` element buffer. Locations are fixed with
`bindAttribLocation` in every program, so one VAO works with any program the
tile may be drawn with.

Everything in this subsection runs on the main thread, in float64, once per
tile. The mesh and the textures together form the `RasterTilePayload` the
scheduler caches and the layer draws.

### 3.3 The vertex shader

`buildVertexSource` (`shader/sources.ts`) wraps MapLibre's prelude:

```glsl
#version 300 es
${shaderData.vertexShaderPrelude}   // declares u_projection_matrix, projectTile()
${shaderData.define}

in vec2 a_pos_high;
in vec2 a_pos_low;
in vec2 a_uv;
uniform vec2 u_origin_high;          // mercator variant only
uniform vec2 u_origin_low;
out vec2 v_uv;

void main() {
  v_uv = a_uv;
  vec2 rel = (a_pos_high - u_origin_high) + (a_pos_low - u_origin_low);
  gl_Position = projectTile(rel);
}
```

Using `projectTile` rather than our own matrix multiply means the layer
projects bit-for-bit the way MapLibre's own layers do under whichever
projection the map is rendering with, and picks up the globe transition for
free.

**Precision.** MapLibre uploads the matrix as float32, and absolute mercator
positions in float32 start to jitter around zoom 14. The scheme is
relative-to-centre, computed in `mercatorFrameUniforms`
(`raster-custom-layer.ts`) once per frame:

- `O` = the map centre in mercator `[0, 1]`, float64.
- `u_projection_matrix` = `mainMatrix · translate(O)`, multiplied in float64
  (`translateMatrix`) and converted to float32 only at the end. Its
  translation column is now small.
- `O` is split high/low exactly like the vertices and uploaded as
  `u_origin_high` / `u_origin_low`.

In the shader both subtractions are exact by Sterbenz's lemma whenever the
vertex is within a factor of two of the origin. At low zoom the screen spans
more than that (at zoom 0 it spans the whole `[0, 1]` world), so far-off
vertices do round, but there float32 is already sub-pixel and the rounding is
invisible. At the zooms where precision matters, roughly zoom 12 and above,
the whole screen sits well inside that band, and `rel` is small enough that
float32 resolves it far below a pixel even at zoom 22. `projectTile(rel)` then
computes `mainMatrix · (rel + O)`, the absolute position, but with the large
part of the sum done on the CPU in float64.

The property that matters most is that **every tile in a frame uses the same
`O`**. A vertex shared by two adjacent tiles goes through bit-identical
arithmetic in both, so seams cannot crack. Per-tile local origins, the other
common precision fix, get exactly this wrong.

**Globe.** Under the `"globe"` variant, MapLibre's `projectTile` runs its
input through a non-linear mercator-to-sphere conversion before any matrix,
so the translation cannot be folded into the matrix. The shader instead passes
`a_pos_high + a_pos_low`, an absolute float32 mercator position, and the layer
forwards the prelude's globe uniforms from `defaultProjectionData` untouched
(`globeFrameUniforms`). This has the same precision limit as MapLibre's own
globe layers; with the `globe` style projection it only runs below zoom 12,
where MapLibre switches to flat mercator and the relative scheme takes over.

### 3.4 The fragment shader

`buildFragmentSource` (`shader/sources.ts`) concatenates a chain of **shader
modules** (`shader/module.ts`, `gpu-modules/`). A module contributes
global-scope declarations (samplers, uniforms, helper functions) and a
snippet for `main()` that operates on the in-scope `vec4 color` and `vec2 uv`.
The first module seeds `color` from the tile texture; later ones discard
nodata, apply the mask, convert photometric interpretations or look up a
colormap. The end of `main()` is fixed:

```glsl
fragColor = vec4(color.rgb * color.a * u_opacity, color.a * u_opacity);
```

which is the premultiplied form MapLibre's blend function expects.

The chain for a tile is decided by `GeoTiffRenderer.buildPipeline`. For an
8-bit RGB COG with nodata it is `CreateTexture → FilterNoDataVal`; for a
palette image `CreateTexture → Colormap`; for a single-band grayscale
`CreateTexture → BlackIsZero`. Each module instance carries the props (a
texture binding, a nodata value) that `getUniforms` turns into uniform values
at draw time.

### 3.5 Programs and the draw loop

`ProgramCache` (`shader/program.ts`) compiles one program per distinct
`(variantName, module names)` key and keeps it for the life of the layer.
Recompilation happens only when MapLibre changes projection variant or a tile
needs a module chain no earlier tile has used. `RasterProgram` introspects the
linked program's active uniforms once and dispatches `gl.uniform*` by GL type;
samplers are assigned texture units sequentially as they are bound.

`drawTiles` (`raster-custom-layer.ts`) then, per tile in coarse-to-fine order:

1. `programs.get(shaderData, payload.pipeline)`; on a program change,
   `useProgram` and upload the per-frame uniforms (`u_projection_matrix`,
   origin halves or globe uniforms, `u_opacity`).
2. `program.bind(collectBindings(pipeline))`: the module uniforms and
   textures for this tile.
3. `gl.bindVertexArray(payload.mesh.vao)` and
   `gl.drawElements(TRIANGLES, indexCount, UNSIGNED_INT, 0)`.

After the loop the VAO is unbound. MapLibre's `setCustomLayerDefaults` would
unbind it before the *next* custom layer, but MapLibre's own layers in the
same frame run first, and a stray VAO binding would capture their
`vertexAttribPointer` calls.

## 4. Coordinate spaces, in one place

Five spaces appear above. Only MapLibre mercator crosses into the shader as
vertex data; the unit sphere is what MapLibre's globe prelude converts it into.

| Space | Range | Y axis | Used by |
| --- | --- | --- | --- |
| Source CRS | file units | as the CRS | tileset levels, tile footprints, mesh input |
| EPSG:3857 metres | ±20 037 508 | north-up | proj4 output, intermediate only |
| Common space | `[0, 512]²` | north-up | tile traversal, bounding volumes and frustum planes under mercator (inherited from deck.gl) |
| Unit sphere | radius 1 | `+Y` north pole | bounding volumes, frustum side planes and the horizon plane under globe (`globe.ts`) |
| MapLibre mercator | `[0, 1]²` | **south-down** | mesh vertices, `projectTile`, frame origin |

`mercator.ts` holds the conversions. The Y flip between common space and
MapLibre mercator is confined to `viewport-shim.ts` (frustum planes) and the
mesh output, so the vendored traversal needed no coordinate rework.
