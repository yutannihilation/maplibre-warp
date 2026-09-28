/**
 * Infer a render pipeline from a GeoTIFF's tags.
 *
 * Decision logic ported from @developmentseed/deck.gl-raster (MIT, Development
 * Seed): `packages/deck.gl-geotiff/src/geotiff/render-pipeline.ts`. The
 * differences: textures are raw WebGL2 objects rather than luma.gl `Texture`s;
 * every band of a tile is uploaded as one layer of a `TEXTURE_2D_ARRAY`, so
 * which bands are drawn is a uniform (`bands`, or the contour `band`); and
 * any sample type in the texture table is accepted, read with an exactly
 * typed sampler.
 */

import { Photometric, SampleFormat } from "@cogeotiff/core";
import type {
  DecoderPool,
  GeoTIFF,
  Overview,
  RasterTypedArray,
  Tile,
} from "@developmentseed/geotiff";
import { parseColormap } from "@developmentseed/geotiff";
import type {
  RasterModuleInstance,
  RenderPipeline,
} from "@yutannihilation/maplibre-warp-raster";
import type {
  BandColorImage,
  BandColors,
  ContourBand,
  ContourLineProps,
  IsobandProps,
  LinearRescaleProps,
  PackedThresholds,
  ValueGradientProps,
} from "@yutannihilation/maplibre-warp-raster/gpu-modules";
import {
  BandTexture,
  BlackIsZero,
  bandColorImage,
  bandsFromThresholds,
  CieLabToRGB,
  ClearColor,
  CMYKToRGB,
  Colormap,
  ContourLine,
  colorToVec4,
  gradientColorImage,
  Isoband,
  LinearRescale,
  MaskTexture,
  packThresholds,
  resolveBandColors,
  resolveGradientStops,
  ValueGradient,
  ValueTexture,
  WhiteIsZero,
} from "@yutannihilation/maplibre-warp-raster/gpu-modules";

import type { ColorConversion, ImageryRenderOptions } from "./bands.js";
import {
  resolveImageryOptions,
  sampleTypeMax,
  validateBandIndex,
} from "./bands.js";
import { bandPlanes, toGlView } from "./geotiff-utils.js";
import type { Stitchable } from "./halo.js";
import {
  HALO,
  neighbourCoordinates,
  neighbourIndex,
  stitchHalo,
} from "./halo.js";
import type { GLTextureFormat } from "./texture.js";
import {
  createColormapTexture,
  createTexture2D,
  createTextureArray,
  inferTextureFormat,
} from "./texture.js";
import { DecodedTileCache } from "./tile-cache.js";

/** GPU textures for a single decoded tile. */
export interface GeoTiffTileTextures {
  /** Content width in texels, excluding any halo. */
  width: number;
  /** Content height in texels, excluding any halo. */
  height: number;
  /**
   * Texels of neighbour data padding `texture` on every side, so it is
   * `(width + 2·halo) × (height + 2·halo)`. `mask`, when present, is never
   * padded.
   */
  halo: number;
  /** A `TEXTURE_2D_ARRAY`, one single-channel layer per band of the file. */
  texture: WebGLTexture;
  mask?: WebGLTexture;
  /** GPU bytes held by these textures. */
  byteLength: number;
}

/**
 * One tile's decoded pixels, ready for upload. The CPU-side half of a tile:
 * produced between frames by {@link GeoTiffRenderer.loadTilePixels}, turned
 * into {@link GeoTiffTileTextures} inside MapLibre's GL bracket by
 * {@link GeoTiffRenderer.uploadTileTextures}.
 */
export interface GeoTiffTilePixels {
  /** One `(width + 2·halo) × (height + 2·halo)` plane per band. */
  planes: RasterTypedArray[];
  /** Content size in texels, excluding the halo. */
  width: number;
  height: number;
  halo: number;
  /** Content-sized validity mask, if the image has one. */
  mask: Uint8Array | null;
}

/**
 * Colour configuration for the fill of {@link ContourRenderOptions}, shared
 * by the `"bands"` and `"gradient"` fills.
 */
export interface ContourBandOptions {
  /**
   * For `"bands"`: one CSS colour per emitted band, or an interpolator over
   * `[0, 1]` called once per band. For `"gradient"`: the ramp's stops, at
   * least two, evenly spaced, or an interpolator sampled along the ramp.
   */
  colors: BandColors;
  /**
   * Emit the band below the first threshold; for a gradient, paint values
   * below the first threshold with the first colour instead of leaving them
   * transparent. @default false
   */
  includeLower?: boolean;
  /**
   * Emit the band above the last threshold; for a gradient, paint values at
   * or above the last threshold with the last colour. @default true
   */
  includeUpper?: boolean;
}

/** How the area between contour lines is painted. */
export type ContourFill = "bands" | "gradient" | "none";

/** Line configuration for {@link ContourRenderOptions}. */
export interface ContourLineOptions {
  /** Screen pixels. @default 1 */
  width?: number;
  /** Hex or `rgb()`/`rgba()`. @default "#333333" */
  color?: string;
  /** Every k-th threshold (by index) is drawn as a major line. */
  majorEvery?: number;
  /** @default 2 × width */
  majorWidth?: number;
  /** @default color */
  majorColor?: string;
}

/**
 * Render the raster as contours in the fragment shader instead of as imagery.
 *
 * Lifts the 8-bit restriction: any sample format in the texture table works,
 * because the value is read with an exact-typed sampler and interpolated in
 * the shader. Output is raster — no labels, no picking.
 */
export interface ContourRenderOptions {
  /** Strictly increasing levels in the raster's units (after GDAL scale/offset). */
  thresholds: readonly number[];
  /** Band to contour. @default 0 */
  band?: number;
  /**
   * How the area between lines is painted. `"bands"` classifies the value
   * against the thresholds and fills each band with one colour. `"gradient"`
   * is the raw-raster rendering: `bands.colors` runs continuously from the
   * first threshold to the last, ignoring the thresholds in between, which
   * therefore needs at least two thresholds. `"none"` leaves a transparent
   * base for lines only. Turning off both the fill and the lines is a
   * configuration error.
   * @default "bands"
   */
  fill?: ContourFill;
  /** Fill colours; required unless `fill` is `"none"`. */
  bands?: ContourBandOptions;
  /**
   * Contour lines, on by default; pass `false` for the fill only.
   * @default { width: 1 }
   */
  lines?: ContourLineOptions | false;
}

/** A band of the contour model together with its colour. */
export interface ContourBandWithColor extends ContourBand {
  color: string;
}

/** The band model with colours, or `[]` unless the fill is `"bands"`. */
export function resolveContourBands(
  contour: ContourRenderOptions,
): ContourBandWithColor[] {
  if ((contour.fill ?? "bands") !== "bands" || !contour.bands) {
    return [];
  }
  const model = bandsFromThresholds(contour.thresholds, contour.bands);
  const colors = resolveBandColors(contour.bands.colors, model.length);
  return model.map((band, k) => ({ ...band, color: colors[k]! }));
}

/** The `"gradient"` fill's domain and colour stops, for legends. */
export interface ContourGradient {
  /** The first threshold. */
  min: number;
  /** The last threshold. */
  max: number;
  /** CSS colours, evenly spaced from `min` to `max`. */
  stops: string[];
}

/** Everything derived from {@link ContourRenderOptions} that needs no GL. */
export interface ResolvedContourOptions {
  band: number;
  fill: ContourFill;
  thresholds: PackedThresholds;
  /** With colours; `[]` unless the fill is `"bands"`. */
  bands: ContourBandWithColor[];
  /** Colour lookup row, `null` unless the fill is `"bands"`. */
  bandImage: BandColorImage | null;
  /** Domain, stops and ramp image, `null` unless the fill is `"gradient"`. */
  gradient: (ContourGradient & { image: BandColorImage }) | null;
  includeLower: boolean;
  includeUpper: boolean;
  /** Line props minus nothing GL-specific; `null` when lines are off. */
  lines: Omit<ContourLineProps, "thresholds"> | null;
}

const DEFAULT_LINE_COLOR = "#333333";
const FILLS: readonly ContourFill[] = ["bands", "gradient", "none"];

/**
 * Resolve and validate a contour configuration in one pass: thresholds are
 * packed, colours parsed and the band model built exactly once, and every
 * configuration error surfaces here as a `RangeError`.
 *
 * @param samplesPerPixel  When known (after the header is read), the band
 *                         index is checked against it too.
 */
export function resolveContourOptions(
  contour: ContourRenderOptions,
  samplesPerPixel?: number,
): ResolvedContourOptions {
  const thresholds = packThresholds(contour.thresholds);
  const band = contour.band ?? 0;
  validateBandIndex(band, samplesPerPixel);
  const fill = contour.fill ?? "bands";
  if (!FILLS.includes(fill)) {
    throw new RangeError(
      `fill must be one of ${FILLS.map((f) => `"${f}"`).join(", ")}, got ${JSON.stringify(fill)}`,
    );
  }
  if (fill !== "none" && !contour.bands) {
    throw new RangeError(
      `fill "${fill}" needs \`bands\` with colours; use fill: "none" for lines only`,
    );
  }
  if (fill === "none" && contour.lines === false) {
    throw new RangeError("contour needs a fill, lines or both");
  }

  const bands = resolveContourBands(contour);
  let bandImage: BandColorImage | null = null;
  if (fill === "bands") {
    if (bands.length === 0) {
      throw new RangeError(
        "the thresholds and includeLower/includeUpper settings emit no band",
      );
    }
    // Parses every colour, so an unparsable one fails here.
    bandImage = bandColorImage(bands.map((b) => b.color));
  }

  let gradient: ResolvedContourOptions["gradient"] = null;
  if (fill === "gradient") {
    if (contour.thresholds.length < 2) {
      throw new RangeError(
        "a gradient fill runs from the first threshold to the last, so it needs at least two",
      );
    }
    const stops = resolveGradientStops(contour.bands!.colors);
    gradient = {
      min: contour.thresholds[0]!,
      max: contour.thresholds[contour.thresholds.length - 1]!,
      stops,
      // Parses every stop, so an unparsable one fails here.
      image: gradientColorImage(stops),
    };
  }

  let lines: ResolvedContourOptions["lines"] = null;
  if (contour.lines !== false) {
    const options = contour.lines ?? {};
    const width = options.width ?? 1;
    const majorWidth = options.majorWidth ?? 2 * width;
    for (const [name, w] of [
      ["width", width],
      ["majorWidth", majorWidth],
    ] as const) {
      if (!(Number.isFinite(w) && w >= 0)) {
        throw new RangeError(`lines.${name} must be a non-negative number`);
      }
    }
    const color = options.color ?? DEFAULT_LINE_COLOR;
    lines = {
      width,
      color: colorToVec4(color),
      majorEvery: options.majorEvery,
      majorWidth,
      majorColor: colorToVec4(options.majorColor ?? color),
    };
  }

  return {
    band,
    fill,
    thresholds,
    bands,
    bandImage,
    gradient,
    includeLower: contour.bands?.includeLower ?? false,
    includeUpper: contour.bands?.includeUpper ?? true,
    lines,
  };
}

/**
 * Reject every contour configuration error up front, so a bad option fails
 * at construction instead of surfacing as a retried source-open failure
 * after the COG header has been fetched.
 */
export function validateContourOptions(
  contour: ContourRenderOptions,
  samplesPerPixel?: number,
): void {
  resolveContourOptions(contour, samplesPerPixel);
}

/**
 * How a GeoTIFF's tiles become GPU textures and a module chain.
 *
 * GL is touched only by `prepare`, `uploadTileTextures`, `destroyTileTextures`
 * and `destroy`. The first two must run inside MapLibre's custom-layer bracket
 * (`prerender`/`render`): they set pixel-store state and leave textures bound,
 * and rely on MapLibre's `setDirty()` afterwards. See "GL state" on
 * `RasterCustomLayer`.
 */
export interface GeoTiffRenderer {
  /**
   * Fetch and decode one tile. Asynchronous and GL-free, so it may finish
   * between frames.
   */
  loadTilePixels(
    image: GeoTIFF | Overview,
    options: {
      x: number;
      y: number;
      signal: AbortSignal;
      pool?: DecoderPool;
    },
  ): Promise<GeoTiffTilePixels>;
  /** Upload decoded pixels. Bracket-only. */
  uploadTileTextures(
    gl: WebGL2RenderingContext,
    pixels: GeoTiffTilePixels,
  ): GeoTiffTileTextures;
  /**
   * The module chain for one tile. Needs the layer-wide textures
   * {@link prepare} creates, and throws if it has not run yet.
   */
  buildPipeline(textures: GeoTiffTileTextures): RenderPipeline;
  destroyTileTextures(
    gl: WebGL2RenderingContext,
    textures: GeoTiffTileTextures,
  ): void;
  /**
   * Create or replace the layer-wide GPU resources — a palette's colormap,
   * a contour fill's colour lookup — and apply any change recorded by
   * {@link updateContour}. Cheap when nothing is pending. Bracket-only; run
   * it before {@link uploadTileTextures} and {@link buildPipeline} each
   * frame.
   *
   * Throws if a texture cannot be created. The attempted work is consumed
   * either way, so a failure surfaces once instead of on every frame: a
   * failed re-style keeps the previous style, and a failed first `prepare`
   * leaves {@link buildPipeline} throwing until a later
   * {@link updateContour} is applied successfully.
   */
  prepare(gl: WebGL2RenderingContext): void;
  /** Release layer-wide resources such as the colormap texture. */
  destroy(gl: WebGL2RenderingContext): void;
  /**
   * Re-style contours for every tile already built: any change except the
   * `band` to read, including switching the fill mode or lines on and off.
   * Only the contour renderer has this. Takes options already run through
   * {@link resolveContourOptions} so the caller validates exactly once.
   *
   * GL-free: it validates and records the change, which the next
   * {@link prepare} applies. Until then tiles keep their current, consistent
   * style.
   */
  updateContour?(contour: ResolvedContourOptions): void;
}

export interface InferRenderPipelineOptions extends ImageryRenderOptions {
  /** Render as contours instead of imagery; `bands`/`rescale` are ignored. */
  contour?: ContourRenderOptions;
  /**
   * The primary IFD's `ExtraSamples` tag (see `readExtraSamples`), which
   * decides whether a fourth band is alpha. Absent or `null` means the tag
   * is absent.
   */
  extraSamples?: readonly number[] | null;
}

export function inferRenderPipeline(
  geotiff: GeoTIFF,
  gl: WebGL2RenderingContext,
  options: InferRenderPipelineOptions = {},
): GeoTiffRenderer {
  const { sampleFormat } = geotiff.cachedTags;
  if (sampleFormat === null) {
    throw new Error("SampleFormat tag is required to infer a render pipeline");
  }
  if (options.contour) {
    return createContourRenderer(geotiff, gl, options.contour);
  }
  return createImageryRenderer(geotiff, gl, options);
}

/**
 * The texture format every band is uploaded in — single channel, since each
 * band is its own layer of the tile's texture array — and the unit
 * conversions that follow from it. A normalised texture samples as [0, 1];
 * every other format returns raw texel values. `denorm` takes a sampled
 * value back to raw units, and `nodataSampled` is the sentinel in sampled
 * units.
 */
function bandSampling(
  geotiff: GeoTIFF,
  gl: WebGL2RenderingContext,
): { format: GLTextureFormat; denorm: number; nodataSampled: number | null } {
  const { bitsPerSample, sampleFormat, nodata } = geotiff.cachedTags;
  const format = inferTextureFormat(gl, 1, bitsPerSample, sampleFormat!);
  const denorm = format.normalized ? 2 ** bitsPerSample[0]! - 1 : 1;
  return {
    format,
    denorm,
    nodataSampled: nodata === null ? null : nodata / denorm,
  };
}

/** The mask module for a tile that has a mask texture, else nothing. */
function maskModule(
  gl: WebGL2RenderingContext,
  textures: GeoTiffTileTextures,
): RasterModuleInstance[] {
  return textures.mask
    ? [
        {
          module: MaskTexture,
          props: { mask: { texture: textures.mask, target: gl.TEXTURE_2D } },
        },
      ]
    : [];
}

/**
 * The pipelines a renderer has handed out and not yet destroyed, by their
 * tile's textures, so a re-style can rebuild the module chain of tiles
 * already built. Each rebuild is in place, since the array is the one the
 * tile's payload holds; the program cache compiles any new chain on demand.
 */
interface LivePipelines {
  buildPipeline: GeoTiffRenderer["buildPipeline"];
  destroyTileTextures: GeoTiffRenderer["destroyTileTextures"];
  /** Rebuild every live pipeline from the current style. */
  rebuild(): void;
  /** Forget every pipeline, for the renderer's `destroy`. */
  clear(): void;
}

function livePipelines(
  modulesFor: (textures: GeoTiffTileTextures) => RenderPipeline,
): LivePipelines {
  const live = new Map<GeoTiffTileTextures, RenderPipeline>();
  return {
    buildPipeline: (textures) => {
      const pipeline = modulesFor(textures);
      live.set(textures, pipeline);
      return pipeline;
    },
    destroyTileTextures: (gl, textures) => {
      live.delete(textures);
      destroyTileTextures(gl, textures);
    },
    rebuild: () => {
      for (const [textures, pipeline] of live) {
        pipeline.splice(0, pipeline.length, ...modulesFor(textures));
      }
    },
    clear: () => live.clear(),
  };
}

/**
 * Imagery renderer: `BandTexture` seed → mask → stretch → colour. The bands
 * to draw are `bands`, or follow the tags by default (see
 * `resolveBandSelection`); the colour conversion follows the selection.
 */
function createImageryRenderer(
  geotiff: GeoTIFF,
  gl: WebGL2RenderingContext,
  options: InferRenderPipelineOptions,
): GeoTiffRenderer {
  const {
    bitsPerSample,
    colorMap,
    photometric,
    sampleFormat,
    samplesPerPixel,
  } = geotiff.cachedTags;
  const {
    format: textureFormat,
    denorm,
    nodataSampled,
  } = bandSampling(geotiff, gl);
  const seed = BandTexture[textureFormat.sampler];
  const bits = bitsPerSample[0]!;
  // An alpha band is divided back to [0, 1].
  const alphaMax = textureFormat.normalized
    ? 1
    : sampleTypeMax(bits, sampleFormat![0]!);
  const { channelMap, rescale, color } = resolveImageryOptions(options, {
    samplesPerPixel,
    photometric,
    extraSamples: options.extraSamples ?? null,
    bitsPerSample: bits,
    sampleFormat: sampleFormat![0]!,
    denorm,
  });
  const rescaleModule: {
    module: typeof LinearRescale;
    props: LinearRescaleProps;
  } | null = rescale ? { module: LinearRescale, props: rescale } : null;

  // Palette indices cannot be interpolated — a value halfway between two
  // classes is a third, unrelated class.
  const isPalette = photometric === Photometric.Palette;
  // Parsed now, so a missing or malformed ColorMap fails while the source is
  // opening; the texture itself waits for `prepare`, inside MapLibre's GL
  // bracket, which consumes this.
  let colormap: ImageData | undefined;
  if (isPalette) {
    if (!colorMap) {
      throw new Error(
        "ColorMap tag is required for PhotometricInterpretation Palette",
      );
    }
    colormap = parseColormap(colorMap);
  }
  let colormapTexture: WebGLTexture | undefined;

  const buildPipeline = (textures: GeoTiffTileTextures): RenderPipeline => {
    const colorModule = colorConversionModule(color);
    return [
      {
        module: seed,
        props: {
          texture: { texture: textures.texture, target: gl.TEXTURE_2D_ARRAY },
          channelMap,
          nodata: nodataSampled,
          alphaMax,
          nearest: isPalette,
          size: new Float32Array([textures.width, textures.height]),
          halo: textures.halo,
        },
      },
      ...maskModule(gl, textures),
      ...(rescaleModule ? [rescaleModule] : []),
      ...(colorModule ? [colorModule] : []),
    ];
  };

  return {
    // No halo: see `fetchTilePixels`.
    loadTilePixels: (image, options) =>
      fetchTilePixels(image, options, undefined),
    uploadTileTextures: (glContext, pixels) =>
      uploadTileTextures(glContext, pixels, textureFormat),
    buildPipeline,
    destroyTileTextures,
    prepare: (glContext) => {
      if (!colormap) {
        return;
      }
      // Consumed before the attempt, so a failure is not retried per frame.
      const image = colormap;
      colormap = undefined;
      colormapTexture = createColormapTexture(glContext, image);
    },
    destroy: (glContext) => {
      if (colormapTexture) {
        glContext.deleteTexture(colormapTexture);
        colormapTexture = undefined;
      }
    },
  };

  /**
   * Built per tile rather than once: the palette's module needs the colormap
   * texture, which only exists once `prepare` has run.
   */
  function colorConversionModule(
    conversion: ColorConversion,
  ): RasterModuleInstance | null {
    switch (conversion) {
      case "rgb":
        return null;
      case "gray":
        return { module: BlackIsZero };
      case "gray-inverted":
        return { module: WhiteIsZero };
      case "cmyk":
        return { module: CMYKToRGB };
      case "cielab":
        return { module: CieLabToRGB };
      case "palette":
        if (!colormapTexture) {
          throw new Error(
            "buildPipeline needs the colormap texture: call prepare(gl) first",
          );
        }
        return {
          module: Colormap,
          props: {
            colormap: { texture: colormapTexture, target: gl.TEXTURE_2D_ARRAY },
          },
        };
      default:
        throw new RangeError(
          `unknown colour conversion ${JSON.stringify(conversion satisfies never)}`,
        );
    }
  }
}

/** A decoded tile as band planes. */
interface PlanarTile {
  width: number;
  height: number;
  planes: RasterTypedArray[];
  mask: Uint8Array | null;
}

/**
 * The tile as band planes. A pixel-interleaved tile is converted in place,
 * the first time it is seen: the halo cache hands the same `Tile` object to
 * every load it serves as a neighbour, so this de-interleaves it once, and
 * dropping the interleaved copy keeps the cache's byte budget honest.
 */
function planarTile(tile: Tile): PlanarTile {
  const { array } = tile;
  if (array.layout === "pixel-interleaved") {
    const { width, height, count, mask, transform, crs, nodata } = array;
    tile.array = {
      layout: "band-separate",
      width,
      height,
      count,
      mask,
      transform,
      crs,
      nodata,
      bands: bandPlanes(array),
    };
  }
  const { width, height, mask } = tile.array;
  return { width, height, planes: bandPlanes(tile.array), mask };
}

/** One band of a planar tile, in the shape the halo stitcher reads. */
function plane(tile: PlanarTile, band: number): Stitchable {
  const { width, height, mask } = tile;
  return { width, height, count: 1, data: tile.planes[band]!, mask };
}

/**
 * Fetch one tile's decoded pixels as band planes.
 *
 * With `haloCache`, the tile's in-image neighbours are fetched through the
 * cache too and their edge texels are stitched around each plane (see
 * `halo.ts`). A neighbour that fails to load (sparse, corrupt, or a
 * transient error) is left out of the halo, which clamps that seam the way
 * a tile on the image edge is clamped; only the tile's own failure fails the
 * load. Contours need this: without it every isoline breaks into a step at
 * a seam.
 *
 * Without it, only the tile itself is fetched and the outer half texel
 * clamps to the tile's own edge, as hardware filtering with `CLAMP_TO_EDGE`
 * would. Imagery takes this path: the clamp is hard to see in a picture,
 * and a halo would cost up to eight neighbour fetches and decodes per tile.
 */
async function fetchTilePixels(
  image: GeoTIFF | Overview,
  options: Parameters<GeoTiffRenderer["loadTilePixels"]>[1],
  haloCache: DecodedTileCache | undefined,
): Promise<GeoTiffTilePixels> {
  if (!haloCache) {
    const tile = await image.fetchTile(options.x, options.y, {
      boundless: false,
      pool: options.pool,
      signal: options.signal,
    });
    const { planes, width, height, mask } = planarTile(tile);
    return { planes, width, height, halo: 0, mask };
  }
  const { x: tilesAcross, y: tilesDown } = image.tileCount;
  const neighbours = neighbourCoordinates(
    options.x,
    options.y,
    tilesAcross,
    tilesDown,
  );
  const [own, ...others] = await haloCache.getTiles(
    image,
    [[options.x, options.y], ...neighbours.map((n) => [n.x, n.y] as const)],
    { pool: options.pool, signal: options.signal },
  );
  if (own!.status === "rejected") {
    throw own!.reason;
  }
  const centre = planarTile(own!.value);
  const grid: Array<PlanarTile | undefined> = [];
  neighbours.forEach((neighbour, i) => {
    const result = others[i]!;
    if (result.status === "fulfilled") {
      grid[neighbourIndex(neighbour.offset)] = planarTile(result.value);
    }
  });
  const planes = centre.planes.map((_, band) =>
    stitchHalo(
      plane(centre, band),
      grid.map((n) => n && plane(n, band)),
    ),
  );
  const { width, height, mask } = centre;
  return { planes, width, height, halo: HALO, mask };
}

/**
 * The upload half, shared by every renderer; only the texture format
 * differs. The band planes become a texture array, plus the validity mask.
 * Bracket-only, like everything in `texture.ts`.
 */
function uploadTileTextures(
  gl: WebGL2RenderingContext,
  pixels: GeoTiffTilePixels,
  textureFormat: GLTextureFormat,
): GeoTiffTileTextures {
  const { planes, width, height, halo, mask } = pixels;
  const paddedWidth = width + 2 * halo;
  const paddedHeight = height + 2 * halo;

  const texture = createTextureArray(gl, {
    width: paddedWidth,
    height: paddedHeight,
    planes: planes.map(toGlView),
    format: textureFormat,
  });
  let byteLength =
    paddedWidth * paddedHeight * planes.length * textureFormat.bytesPerPixel;

  let maskTexture: WebGLTexture | undefined;
  if (mask !== null) {
    maskTexture = createTexture2D(gl, {
      width,
      height,
      data: mask,
      format: inferTextureFormat(gl, 1, [8], [SampleFormat.Uint]),
      // Nearest, so a mask edge never interpolates into a half-transparent
      // fringe.
      linear: false,
    });
    byteLength += width * height;
  }

  return { texture, mask: maskTexture, width, height, halo, byteLength };
}

function destroyTileTextures(
  glContext: WebGL2RenderingContext,
  textures: GeoTiffTileTextures,
): void {
  glContext.deleteTexture(textures.texture);
  if (textures.mask) {
    glContext.deleteTexture(textures.mask);
  }
}

/**
 * Contour renderer: `ValueTexture` seed → `Isoband`, `ValueGradient` or
 * `ClearColor` → `ContourLine`, over any sample format the texture table
 * knows.
 */
function createContourRenderer(
  geotiff: GeoTIFF,
  gl: WebGL2RenderingContext,
  contour: ContourRenderOptions,
): GeoTiffRenderer {
  const { samplesPerPixel } = geotiff.cachedTags;
  // Everything a tile's props need is resolved once here: `buildPipeline`
  // runs per tile and `getUniforms` per tile per frame, so no colour parsing
  // or array allocation may live there.
  const resolved = resolveContourOptions(contour, samplesPerPixel);

  const {
    format: textureFormat,
    denorm,
    nodataSampled,
  } = bandSampling(geotiff, gl);
  const seed = ValueTexture[textureFormat.sampler];
  const { band } = resolved;
  const scale = denorm * (geotiff.scales[band] ?? 1);
  const offset = geotiff.offsets[band] ?? 0;

  const colorTexture = (
    glContext: WebGL2RenderingContext,
    image: BandColorImage,
    linear: boolean,
  ): WebGLTexture =>
    createTexture2D(glContext, {
      width: image.width,
      height: image.height,
      data: image.data,
      format: inferTextureFormat(
        glContext,
        4,
        [8, 8, 8, 8],
        [SampleFormat.Uint],
      ),
      linear,
    });

  /**
   * The modules after the seed and mask, with their props. One instance is
   * shared by reference with every tile's pipeline, so `getUniforms` reads
   * precomputed objects and a re-style is a rebuild of this one object.
   */
  interface ContourStyle {
    fill:
      | { module: typeof Isoband; props: IsobandProps }
      | { module: typeof ValueGradient; props: ValueGradientProps }
      | { module: typeof ClearColor; props?: undefined };
    lines?: ContourLineProps;
  }

  const createStyle = (
    glContext: WebGL2RenderingContext,
    options: ResolvedContourOptions,
  ): ContourStyle => {
    // The declared mode is the one discriminant; the images are its
    // payload and `resolveContourOptions` guarantees each is present for
    // its own mode.
    let fill: ContourStyle["fill"];
    switch (options.fill) {
      case "bands":
        fill = {
          module: Isoband,
          props: {
            thresholds: options.thresholds,
            includeLower: options.includeLower,
            includeUpper: options.includeUpper,
            // One texel per band: NEAREST, so a band never bleeds into the next.
            colors: {
              texture: colorTexture(glContext, options.bandImage!, false),
              target: glContext.TEXTURE_2D,
            },
          },
        };
        break;
      case "gradient":
        fill = {
          module: ValueGradient,
          props: {
            min: options.gradient!.min,
            max: options.gradient!.max,
            includeLower: options.includeLower,
            includeUpper: options.includeUpper,
            // A ramp: LINEAR, so the shader interpolates between samples.
            colors: {
              texture: colorTexture(glContext, options.gradient!.image, true),
              target: glContext.TEXTURE_2D,
            },
          },
        };
        break;
      case "none":
        fill = { module: ClearColor };
        break;
      default:
        throw new RangeError(
          `unknown contour fill ${JSON.stringify(options.fill satisfies never)}`,
        );
    }
    return {
      fill,
      lines: options.lines
        ? { thresholds: options.thresholds, ...options.lines }
        : undefined,
    };
  };

  const destroyStyle = (
    glContext: WebGL2RenderingContext,
    style: ContourStyle,
  ): void => {
    if (style.fill.props) {
      glContext.deleteTexture(style.fill.props.colors.texture);
    }
  };

  /**
   * The current style — `undefined` until the first `prepare` has created its
   * textures — and the configuration the next `prepare` applies, initially
   * the one the renderer was created with.
   */
  let style: ContourStyle | undefined;
  let pending: ResolvedContourOptions | null = resolved;

  const modulesFor = (textures: GeoTiffTileTextures): RenderPipeline => {
    if (!style) {
      throw new Error(
        "buildPipeline needs the contour colour textures: call prepare(gl) first",
      );
    }
    return [
      {
        module: seed,
        props: {
          texture: { texture: textures.texture, target: gl.TEXTURE_2D_ARRAY },
          band,
          nodata: nodataSampled,
          scale,
          offset,
          size: new Float32Array([textures.width, textures.height]),
          halo: textures.halo,
        },
      },
      ...maskModule(gl, textures),
      style.fill,
      ...(style.lines ? [{ module: ContourLine, props: style.lines }] : []),
    ];
  };

  const pipelines = livePipelines(modulesFor);
  // Contours interpolate `value` manually, so each tile carries a halo of
  // neighbour texels: without it the outer half texel clamps to the tile's
  // own edge and every isoline breaks into a step at the seam.
  const haloCache = new DecodedTileCache();

  return {
    loadTilePixels: (image, options) =>
      fetchTilePixels(image, options, haloCache),
    uploadTileTextures: (glContext, pixels) =>
      uploadTileTextures(glContext, pixels, textureFormat),
    buildPipeline: pipelines.buildPipeline,
    destroyTileTextures: pipelines.destroyTileTextures,
    prepare: (glContext) => {
      if (!pending) {
        return;
      }
      // Consumed before the attempt, so a failure is reported once rather
      // than rethrown on every frame.
      const next = pending;
      pending = null;
      // Create the new textures before deleting the old: if that fails the
      // tiles keep a live texture and consistent (old) props.
      const nextStyle = createStyle(glContext, next);
      if (style) {
        destroyStyle(glContext, style);
      }
      style = nextStyle;
      pipelines.rebuild();
    },
    destroy: (glContext) => {
      haloCache.clear();
      pipelines.clear();
      if (style) {
        destroyStyle(glContext, style);
        style = undefined;
      }
    },
    updateContour: (next) => {
      // The seed's band is what selects the texture layer; a change would
      // need every tile's props rewritten and, for a multi-band raster, says
      // the caller wants a different layer. Refuse rather than guess.
      if (next.band !== band) {
        throw new RangeError(
          `setContour cannot change the band (${band} → ${next.band}); recreate the layer`,
        );
      }
      pending = next;
    },
  };
}
