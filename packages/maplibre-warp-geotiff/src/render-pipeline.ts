/**
 * Infer a render pipeline from a GeoTIFF's tags.
 *
 * Decision logic ported from @developmentseed/deck.gl-raster (MIT, Development
 * Seed): `packages/deck.gl-geotiff/src/geotiff/render-pipeline.ts`. The
 * differences: textures are raw WebGL2 objects rather than luma.gl `Texture`s;
 * every band of a tile is uploaded as one layer of a `TEXTURE_2D_ARRAY`, so
 * which bands are drawn is a uniform (`bands`, or the contour `band`) that
 * can change without reloading; and any sample type in the texture table is
 * accepted, read with an exactly typed sampler.
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

import type { ImageryRenderOptions, ResolvedImagery } from "./bands.js";
import { resolveImageryOptions, sampleTypeMax } from "./bands.js";
import { bandPlanes, toGlView } from "./geotiff-utils.js";
import type { NeighbourGrid } from "./halo.js";
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
  /** Layers of `texture`: one per band of the file. */
  bands: number;
  /** A `TEXTURE_2D_ARRAY`, one single-channel layer per band. */
  texture: WebGLTexture;
  mask?: WebGLTexture;
  /** GPU bytes held by these textures. */
  byteLength: number;
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
  if (!Number.isInteger(band) || band < 0) {
    throw new RangeError(`band must be a non-negative integer, got ${band}`);
  }
  if (samplesPerPixel !== undefined && band >= samplesPerPixel) {
    throw new RangeError(
      `band ${band} is out of range for a ${samplesPerPixel}-band raster`,
    );
  }
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

export interface GeoTiffRenderer {
  loadTileTextures(
    image: GeoTIFF | Overview,
    options: {
      gl: WebGL2RenderingContext;
      x: number;
      y: number;
      signal: AbortSignal;
      pool?: DecoderPool;
    },
  ): Promise<GeoTiffTileTextures>;
  buildPipeline(textures: GeoTiffTileTextures): RenderPipeline;
  destroyTileTextures(
    gl: WebGL2RenderingContext,
    textures: GeoTiffTileTextures,
  ): void;
  /** Release layer-wide resources such as the colormap texture. */
  destroy(gl: WebGL2RenderingContext): void;
  /**
   * Re-style contours in place, for every tile already built: any change,
   * including the `band` to read, the fill mode or lines on and off. Only
   * the contour renderer has this. Takes options already run through
   * {@link resolveContourOptions} so the caller validates exactly once.
   */
  updateContour?(
    gl: WebGL2RenderingContext,
    contour: ResolvedContourOptions,
  ): void;
  /**
   * Re-compose imagery in place, for every tile already built: another band
   * selection, another stretch, or both. Only the imagery renderer has this.
   * Validates against the file's tags and throws a `RangeError` before
   * touching any tile.
   */
  updateImagery?(
    gl: WebGL2RenderingContext,
    imagery: ImageryRenderOptions,
  ): void;
}

export interface InferRenderPipelineOptions extends ImageryRenderOptions {
  /** Render as contours instead of imagery; `bands`/`rescale` are ignored. */
  contour?: ContourRenderOptions;
  /**
   * The primary IFD's `ExtraSamples` tag (see `readExtraSamples`), which
   * decides whether a fourth band is alpha. Absent means the tag is absent.
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
  return createImageryRenderer(geotiff, gl, {
    bands: options.bands,
    rescale: options.rescale,
    extraSamples: options.extraSamples ?? null,
  });
}

/**
 * The texture format every band is uploaded in: single channel, since each
 * band is its own layer of the tile's texture array.
 */
function bandTextureFormat(
  geotiff: GeoTIFF,
  gl: WebGL2RenderingContext,
): GLTextureFormat {
  const { bitsPerSample, sampleFormat } = geotiff.cachedTags;
  return inferTextureFormat(gl, 1, bitsPerSample, sampleFormat!);
}

/** Imagery renderer: `BandTexture` seed → mask → stretch → photometric. */
function createImageryRenderer(
  geotiff: GeoTIFF,
  gl: WebGL2RenderingContext,
  options: ImageryRenderOptions & { extraSamples: readonly number[] | null },
): GeoTiffRenderer {
  const {
    bitsPerSample,
    colorMap,
    photometric,
    sampleFormat,
    samplesPerPixel,
    nodata,
  } = geotiff.cachedTags;
  const textureFormat = bandTextureFormat(geotiff, gl);
  const seed = BandTexture[textureFormat.sampler];
  const bits = bitsPerSample[0]!;
  const format = sampleFormat![0]!;

  // A normalised texture samples as [0, 1]; every other format returns raw
  // texel values. The nodata sentinel and the stretch are expressed in the
  // sampled units, and an alpha band is divided back to [0, 1].
  const denorm = textureFormat.normalized ? 2 ** bits - 1 : 1;
  const nodataSampled = nodata === null ? null : nodata / denorm;
  const alphaMax = textureFormat.normalized ? 1 : sampleTypeMax(bits, format);

  // Palette indices cannot be interpolated — a value halfway between two
  // classes is a third, unrelated class.
  const isPalette = photometric === Photometric.Palette;
  let colormapTexture: WebGLTexture | undefined;
  if (isPalette) {
    if (!colorMap) {
      throw new Error(
        "ColorMap tag is required for PhotometricInterpretation Palette",
      );
    }
    colormapTexture = createColormapTexture(gl, parseColormap(colorMap));
  }

  const resolve = (imagery: ImageryRenderOptions): ResolvedImagery =>
    resolveImageryOptions(imagery, {
      samplesPerPixel,
      photometric,
      extraSamples: options.extraSamples,
      bitsPerSample: bits,
      sampleFormat: format,
      normalized: textureFormat.normalized,
    });

  /**
   * The modules after the seed and mask, with their props. One instance is
   * shared by reference with every tile's pipeline, so `getUniforms` reads
   * precomputed objects and a re-style is a rebuild of this one object.
   */
  interface ImageryStyle {
    channelMap: Int32Array;
    rescale: RasterModuleInstance | null;
    color: RasterModuleInstance | null;
  }

  const createStyle = (resolved: ResolvedImagery): ImageryStyle => ({
    channelMap: resolved.channelMap,
    rescale: resolved.rescale
      ? { module: LinearRescale, props: resolved.rescale }
      : null,
    color: photometricModule(resolved.selection.length),
  });

  let style = createStyle(resolve(options));

  // Every pipeline handed out and not yet destroyed, by its tile's textures,
  // so a re-style can rebuild the module chain of tiles already built.
  const live = new Map<GeoTiffTileTextures, RenderPipeline>();

  const modulesFor = (textures: GeoTiffTileTextures): RenderPipeline => {
    const pipeline: RenderPipeline = [
      {
        module: seed,
        props: {
          texture: { texture: textures.texture, target: gl.TEXTURE_2D_ARRAY },
          channelMap: style.channelMap,
          nodata: nodataSampled,
          alphaMax,
          nearest: isPalette,
          size: new Float32Array([textures.width, textures.height]),
          halo: textures.halo,
        },
      },
    ];
    if (textures.mask) {
      pipeline.push({
        module: MaskTexture,
        props: { mask: { texture: textures.mask, target: gl.TEXTURE_2D } },
      });
    }
    if (style.rescale) {
      pipeline.push(style.rescale);
    }
    if (style.color) {
      pipeline.push(style.color);
    }
    return pipeline;
  };

  const haloCache = new DecodedTileCache();

  return {
    loadTileTextures: tileTextureLoader({ textureFormat, haloCache }),
    buildPipeline: (textures) => {
      const pipeline = modulesFor(textures);
      live.set(textures, pipeline);
      return pipeline;
    },
    destroyTileTextures: (glContext, textures) => {
      live.delete(textures);
      destroyTileTextures(glContext, textures);
    },
    destroy: (glContext) => {
      haloCache.clear();
      live.clear();
      if (colormapTexture) {
        glContext.deleteTexture(colormapTexture);
      }
    },
    updateImagery: (_glContext, imagery) => {
      // Resolves (and so validates) before anything is touched.
      style = createStyle(resolve(imagery));
      // In place, since each array is the one its tile's payload holds.
      for (const [textures, pipeline] of live) {
        pipeline.splice(0, pipeline.length, ...modulesFor(textures));
      }
    },
  };

  /**
   * How the composed channels become a colour. Three or four selected bands
   * are RGB(A) as they stand; one band is grey, inverted grey or a colormap
   * lookup by the photometric interpretation. CMYK and CIELab always draw
   * their default selection, so their conversions apply as a whole.
   */
  function photometricModule(
    selectedCount: number,
  ): RasterModuleInstance | null {
    switch (photometric) {
      case Photometric.Separated:
        // cogeotiff calls CMYK "Separated".
        return { module: CMYKToRGB };
      case Photometric.Cielab:
        return { module: CieLabToRGB };
      default:
        break;
    }
    if (selectedCount >= 3) {
      return null;
    }
    switch (photometric) {
      case Photometric.MinIsWhite:
        return { module: WhiteIsZero };
      case Photometric.Palette:
        return {
          module: Colormap,
          props: {
            colormap: {
              texture: colormapTexture!,
              target: gl.TEXTURE_2D_ARRAY,
            },
          },
        };
      default:
        // MinIsBlack, or a single band picked out of an RGB / YCbCr /
        // multispectral file: broadcast it to grey.
        return { module: BlackIsZero };
    }
  }
}

/** One tile's decoded pixels, ready for upload. */
interface TilePlanes {
  /** One `(width + 2·halo) × (height + 2·halo)` plane per band. */
  planes: RasterTypedArray[];
  /** Content size in texels, excluding the halo. */
  width: number;
  height: number;
  halo: number;
  /** Content-sized validity mask, if the image has one. */
  mask: Uint8Array | null;
}

/** The part of a decoded tile the halo stitcher reads, one band at a time. */
interface PlanarTile {
  width: number;
  height: number;
  planes: RasterTypedArray[];
  mask: Uint8Array | null;
}

/**
 * Planes per decoded tile. The halo cache hands the same `Tile` object out
 * to every load it serves as a neighbour, so a pixel-interleaved tile is
 * de-interleaved once rather than up to nine times.
 */
const PLANES = new WeakMap<Tile, RasterTypedArray[]>();

function planarTile(tile: Tile): PlanarTile {
  const { width, height, mask } = tile.array;
  let planes = PLANES.get(tile);
  if (!planes) {
    planes = bandPlanes(tile.array);
    PLANES.set(tile, planes);
  }
  return { width, height, planes, mask };
}

/**
 * Fetch one tile's decoded pixels as band planes. The tile's in-image
 * neighbours are fetched through the cache too and their edge texels are
 * stitched around each plane (see `halo.ts`). A neighbour that fails to
 * load (sparse, corrupt, or a transient error) is left out of the halo,
 * which clamps that seam the way a tile on the image edge is clamped; only
 * the tile's own failure fails the load.
 */
async function fetchTilePlanes(
  image: GeoTIFF | Overview,
  options: Parameters<GeoTiffRenderer["loadTileTextures"]>[1],
  haloCache: DecodedTileCache,
): Promise<TilePlanes> {
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
  const { width, height, mask } = centre;
  const planes = centre.planes.map((plane, band) => {
    const neighbourPlanes: NeighbourGrid<{
      width: number;
      height: number;
      count: 1;
      data: RasterTypedArray;
      mask: Uint8Array | null;
    }> = grid.map(
      (n) =>
        n && {
          width: n.width,
          height: n.height,
          count: 1,
          data: n.planes[band]!,
          mask: n.mask,
        },
    );
    return stitchHalo(
      { width, height, count: 1, data: plane, mask },
      neighbourPlanes,
    );
  });
  return { planes, width, height, halo: HALO, mask };
}

/**
 * Fetch and upload one tile's textures: the band planes as a texture array
 * plus the validity mask. Shared by every renderer; only the texture format
 * differs.
 */
function tileTextureLoader({
  textureFormat,
  haloCache,
}: {
  textureFormat: GLTextureFormat;
  /** Every tile is padded with a halo of neighbour texels fetched through this cache. */
  haloCache: DecodedTileCache;
}): GeoTiffRenderer["loadTileTextures"] {
  return async (image, options) => {
    const { planes, width, height, halo, mask } = await fetchTilePlanes(
      image,
      options,
      haloCache,
    );
    const paddedWidth = width + 2 * halo;
    const paddedHeight = height + 2 * halo;

    const texture = createTextureArray(options.gl, {
      width: paddedWidth,
      height: paddedHeight,
      planes: planes.map(toGlView),
      format: textureFormat,
    });
    let byteLength =
      paddedWidth * paddedHeight * planes.length * textureFormat.bytesPerPixel;

    let maskTexture: WebGLTexture | undefined;
    if (mask !== null) {
      maskTexture = createTexture2D(options.gl, {
        width,
        height,
        data: mask,
        format: inferTextureFormat(options.gl, 1, [8], [SampleFormat.Uint]),
        // Nearest, so a mask edge never interpolates into a half-transparent
        // fringe.
        linear: false,
      });
      byteLength += width * height;
    }

    return {
      texture,
      mask: maskTexture,
      width,
      height,
      halo,
      bands: planes.length,
      byteLength,
    };
  };
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
  const { bitsPerSample, nodata, samplesPerPixel } = geotiff.cachedTags;
  // Everything a tile's props need is resolved once here: `buildPipeline`
  // runs per tile and `getUniforms` per tile per frame, so no colour parsing
  // or array allocation may live there.
  const resolved = resolveContourOptions(contour, samplesPerPixel);

  const textureFormat = bandTextureFormat(geotiff, gl);
  const seed = ValueTexture[textureFormat.sampler];

  // A normalised texture samples as [0, 1]; every other format returns raw
  // texel values. Fold the denormalisation into the seed's scale, and
  // express the nodata sentinel in the same sampled units.
  const denorm = textureFormat.normalized ? 2 ** bitsPerSample[0]! - 1 : 1;
  const nodataSampled = nodata === null ? null : nodata / denorm;

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
   * The band to read and the modules after the seed and mask, with their
   * props. One instance is shared by reference with every tile's pipeline,
   * so `getUniforms` reads precomputed objects and a re-style is a rebuild
   * of this one object.
   */
  interface ContourStyle {
    band: number;
    /** `value = raw · scale + offset`, with GDAL scale/offset for the band. */
    scale: number;
    offset: number;
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
      band: options.band,
      scale: denorm * (geotiff.scales[options.band] ?? 1),
      offset: geotiff.offsets[options.band] ?? 0,
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

  let style = createStyle(gl, resolved);

  // Every pipeline handed out and not yet destroyed, by its tile's textures,
  // so a re-style can rebuild the module chain of tiles already built. The
  // program cache compiles any new chain on demand.
  const live = new Map<GeoTiffTileTextures, RenderPipeline>();

  const modulesFor = (textures: GeoTiffTileTextures): RenderPipeline => {
    const pipeline: RenderPipeline = [
      {
        module: seed,
        props: {
          texture: { texture: textures.texture, target: gl.TEXTURE_2D_ARRAY },
          band: style.band,
          nodata: nodataSampled,
          scale: style.scale,
          offset: style.offset,
          size: new Float32Array([textures.width, textures.height]),
          halo: textures.halo,
        },
      },
    ];
    if (textures.mask) {
      pipeline.push({
        module: MaskTexture,
        props: { mask: { texture: textures.mask, target: gl.TEXTURE_2D } },
      });
    }
    pipeline.push(style.fill);
    if (style.lines) {
      pipeline.push({ module: ContourLine, props: style.lines });
    }
    return pipeline;
  };

  const buildPipeline = (textures: GeoTiffTileTextures): RenderPipeline => {
    const pipeline = modulesFor(textures);
    live.set(textures, pipeline);
    return pipeline;
  };

  const updateContour = (
    glContext: WebGL2RenderingContext,
    next: ResolvedContourOptions,
  ): void => {
    // Create the new textures before deleting the old: if that fails the
    // tiles keep a live texture and consistent (old) props.
    const nextStyle = createStyle(glContext, next);
    destroyStyle(glContext, style);
    style = nextStyle;
    // In place, since each array is the one its tile's payload holds.
    for (const [textures, pipeline] of live) {
      pipeline.splice(0, pipeline.length, ...modulesFor(textures));
    }
  };

  // Contours interpolate `value` manually, so each tile carries a halo of
  // neighbour texels: without it the outer half texel clamps to the tile's
  // own edge and every isoline breaks into a step at the seam.
  const haloCache = new DecodedTileCache();

  return {
    loadTileTextures: tileTextureLoader({ textureFormat, haloCache }),
    buildPipeline,
    destroyTileTextures: (glContext, textures) => {
      live.delete(textures);
      destroyTileTextures(glContext, textures);
    },
    destroy: (glContext) => {
      haloCache.clear();
      live.clear();
      destroyStyle(glContext, style);
    },
    updateContour,
  };
}
