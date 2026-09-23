/**
 * Infer a render pipeline from a GeoTIFF's tags.
 *
 * Decision logic ported from @developmentseed/deck.gl-raster (MIT, Development
 * Seed): `packages/deck.gl-geotiff/src/geotiff/render-pipeline.ts`. The
 * differences are that textures are raw WebGL2 objects rather than luma.gl
 * `Texture`s, and that the supported set is narrowed to what milestone 1
 * claims — 8-bit unsigned samples — with an explicit error for the rest rather
 * than a silent wrong-looking render.
 */

import { Photometric, SampleFormat } from "@cogeotiff/core";
import type {
  DecoderPool,
  GeoTIFF,
  Overview,
  RasterArray,
  RasterArrayPixelInterleaved,
  RasterTypedArray,
} from "@developmentseed/geotiff";
import { parseColormap } from "@developmentseed/geotiff";
import type { RenderPipeline } from "@yutannihilation/maplibre-warp-raster";
import type {
  BandColorImage,
  BandColors,
  ContourBand,
  ContourLineProps,
  DemEncoding,
  IsobandProps,
  PackedThresholds,
  ValueGradientProps,
} from "@yutannihilation/maplibre-warp-raster/gpu-modules";
import {
  BlackIsZero,
  bandColorImage,
  bandsFromThresholds,
  CieLabToRGB,
  ClearColor,
  CMYKToRGB,
  Colormap,
  ContourLine,
  CreateTexture,
  colorToVec4,
  DemEncode,
  FilterNoDataVal,
  gradientColorImage,
  Isoband,
  MaskTexture,
  packThresholds,
  resolveBandColors,
  resolveGradientStops,
  ValueGradient,
  ValueTexture,
  validateDemEncoding,
  WhiteIsZero,
} from "@yutannihilation/maplibre-warp-raster/gpu-modules";

import { addAlphaChannel, toGlView } from "./geotiff-utils.js";
import {
  HALO,
  neighbourCoordinates,
  neighbourIndex,
  stitchHalo,
} from "./halo.js";
import {
  createColormapTexture,
  createTexture2D,
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
   * Re-style contours in place, for every tile already built: any change
   * except the `band` to read, including switching the fill mode or lines
   * on and off. Only the contour renderer has this. Takes options already
   * run through {@link resolveContourOptions} so the caller validates
   * exactly once.
   */
  updateContour?(
    gl: WebGL2RenderingContext,
    contour: ResolvedContourOptions,
  ): void;
}

export function inferRenderPipeline(
  geotiff: GeoTIFF,
  gl: WebGL2RenderingContext,
  options: { contour?: ContourRenderOptions } = {},
): GeoTiffRenderer {
  const { sampleFormat, bitsPerSample } = geotiff.cachedTags;
  if (sampleFormat === null) {
    throw new Error("SampleFormat tag is required to infer a render pipeline");
  }
  if (options.contour) {
    return createContourRenderer(geotiff, gl, options.contour);
  }
  if (sampleFormat[0] !== SampleFormat.Uint) {
    throw new Error(
      `Only unsigned-integer samples are supported so far; found SampleFormat ${sampleFormat}. ` +
        "Signed and floating-point rasters need the integer-sampler pipeline (milestone 2).",
    );
  }
  if (bitsPerSample[0] !== 8) {
    throw new Error(
      `Only 8-bit samples are supported so far; found BitsPerSample ${bitsPerSample[0]}. ` +
        "16- and 32-bit rasters need the integer-sampler pipeline (milestone 2).",
    );
  }

  return createUnormRenderer(geotiff, gl);
}

function createUnormRenderer(
  geotiff: GeoTIFF,
  gl: WebGL2RenderingContext,
): GeoTiffRenderer {
  const {
    bitsPerSample,
    colorMap,
    photometric,
    sampleFormat,
    samplesPerPixel,
    nodata,
  } = geotiff.cachedTags;

  // WebGL2 has no usable 3-channel 8-bit sampleable format, so RGB is padded
  // to RGBA on the CPU before upload.
  const uploadedSamples = samplesPerPixel === 3 ? 4 : samplesPerPixel;
  const textureFormat = inferTextureFormat(
    gl,
    uploadedSamples,
    bitsPerSample,
    sampleFormat!,
  );

  const isPalette = photometric === Photometric.Palette;
  // Palette indices cannot be interpolated — a value halfway between two
  // classes is a third, unrelated class.
  const linearFilter = !isPalette;

  let colormapTexture: WebGLTexture | undefined;
  if (isPalette) {
    if (!colorMap) {
      throw new Error(
        "ColorMap tag is required for PhotometricInterpretation Palette",
      );
    }
    colormapTexture = createColormapTexture(gl, parseColormap(colorMap));
  }

  const buildPipeline = (textures: GeoTiffTileTextures): RenderPipeline => {
    const pipeline: RenderPipeline = [
      {
        module: CreateTexture,
        props: {
          texture: { texture: textures.texture, target: gl.TEXTURE_2D },
        },
      },
    ];

    if (nodata !== null) {
      // `*unorm` sampling yields [0, 1], so the sentinel has to be scaled the
      // same way.
      const maxVal = 2 ** bitsPerSample[0]! - 1;
      pipeline.push({
        module: FilterNoDataVal,
        props: { value: nodata / maxVal },
      });
    }

    if (textures.mask) {
      pipeline.push({
        module: MaskTexture,
        props: { mask: { texture: textures.mask, target: gl.TEXTURE_2D } },
      });
    }

    const colorModule = photometricModule({
      samplesPerPixel,
      photometric,
      colormapTexture,
      gl,
    });
    if (colorModule) {
      pipeline.push(colorModule);
    }

    return pipeline;
  };

  const loadTileTextures = tileTextureLoader({
    samplesPerPixel,
    textureFormat,
    linearFilter,
  });

  return {
    loadTileTextures,
    buildPipeline,
    destroyTileTextures,
    destroy: (glContext) => {
      if (colormapTexture) {
        glContext.deleteTexture(colormapTexture);
      }
    },
  };

  function photometricModule({
    samplesPerPixel: count,
    photometric: interpretation,
    colormapTexture: cmap,
    gl: glContext,
  }: {
    samplesPerPixel: number;
    photometric: Photometric;
    colormapTexture?: WebGLTexture;
    gl: WebGL2RenderingContext;
  }): RenderPipeline[number] | null {
    if (count === 3 || count === 4) {
      // Always interpret 3- or 4-band images as RGB/RGBA.
      return null;
    }

    switch (interpretation) {
      case Photometric.MinIsWhite:
        return { module: WhiteIsZero };
      case Photometric.MinIsBlack:
        return { module: BlackIsZero };
      case Photometric.Rgb:
        return null;
      case Photometric.Palette: {
        if (!cmap) {
          throw new Error(
            "ColorMap is required for PhotometricInterpretation Palette",
          );
        }
        return {
          module: Colormap,
          props: {
            colormap: { texture: cmap, target: glContext.TEXTURE_2D_ARRAY },
          },
        };
      }
      // cogeotiff calls CMYK "Separated".
      case Photometric.Separated:
        return { module: CMYKToRGB };
      case Photometric.Ycbcr:
        // @developmentseed/geotiff decodes JPEG-compressed YCbCr through the
        // browser's image decoder, which has already converted to RGB.
        return null;
      case Photometric.Cielab:
        return { module: CieLabToRGB };
      default:
        throw new Error(
          `Unsupported PhotometricInterpretation ${interpretation}`,
        );
    }
  }
}

/**
 * Fetch and upload one tile's textures. Shared by every renderer; only the
 * texture format and filtering differ.
 */
/** One tile's decoded pixels, ready for upload. */
interface TilePixels {
  /** `(width + 2·halo) × (height + 2·halo)` texels, `samplesPerPixel` each. */
  data: RasterTypedArray;
  /** Content size in texels, excluding the halo. */
  width: number;
  height: number;
  halo: number;
  /** Content-sized validity mask, if the image has one. */
  mask: Uint8Array | null;
}

/**
 * Fetch one tile's decoded pixels. With `haloCache`, the tile's in-image
 * neighbours are fetched through the cache too and their edge texels are
 * stitched around it (see `halo.ts`). A neighbour that fails to load
 * (sparse, corrupt, or a transient error) is left out of the halo, which
 * clamps that seam the way a tile on the image edge is clamped; only the
 * tile's own failure fails the load. Three-sample data is padded to four.
 */
async function fetchTilePixels(
  image: GeoTIFF | Overview,
  options: Parameters<GeoTiffRenderer["loadTileTextures"]>[1],
  haloCache: DecodedTileCache | undefined,
  samplesPerPixel: number,
): Promise<TilePixels> {
  const upload = (array: RasterArrayPixelInterleaved): RasterTypedArray =>
    samplesPerPixel === 3 ? addAlphaChannel(array).data : array.data;

  if (!haloCache) {
    const tile = await image.fetchTile(options.x, options.y, {
      boundless: false,
      pool: options.pool,
      signal: options.signal,
    });
    const array = interleaved(tile.array);
    const { width, height, mask } = array;
    return { data: upload(array), width, height, halo: 0, mask };
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
  const centre = interleaved(own!.value.array);
  const grid: Array<RasterArrayPixelInterleaved | undefined> = [];
  neighbours.forEach((neighbour, i) => {
    const result = others[i]!;
    if (result.status === "fulfilled") {
      grid[neighbourIndex(neighbour.offset)] = interleaved(result.value.array);
    }
  });
  const { width, height, mask } = centre;
  const padded: RasterArrayPixelInterleaved = {
    ...centre,
    width: width + 2 * HALO,
    height: height + 2 * HALO,
    data: stitchHalo(centre, grid),
  };
  return { data: upload(padded), width, height, halo: HALO, mask };
}

function interleaved(array: RasterArray): RasterArrayPixelInterleaved {
  if (array.layout === "band-separate") {
    throw new Error("Band-separate images not yet implemented.");
  }
  return array;
}

function tileTextureLoader({
  samplesPerPixel,
  textureFormat,
  linearFilter,
  haloCache,
}: {
  samplesPerPixel: number;
  textureFormat: ReturnType<typeof inferTextureFormat>;
  linearFilter: boolean;
  /** Pad every tile with a halo of neighbour texels, fetched through this cache. */
  haloCache?: DecodedTileCache;
}): GeoTiffRenderer["loadTileTextures"] {
  return async (image, options) => {
    const { data, width, height, halo, mask } = await fetchTilePixels(
      image,
      options,
      haloCache,
      samplesPerPixel,
    );
    const paddedWidth = width + 2 * halo;
    const paddedHeight = height + 2 * halo;

    const texture = createTexture2D(options.gl, {
      width: paddedWidth,
      height: paddedHeight,
      data: toGlView(data),
      format: textureFormat,
      linear: linearFilter,
    });
    let byteLength = paddedWidth * paddedHeight * textureFormat.bytesPerPixel;

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

    return { texture, mask: maskTexture, width, height, halo, byteLength };
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
 * The value-reading front of a scalar pipeline: how a tile's samples are
 * uploaded, and the modules that seed `value`/`valid` from them.
 *
 * Shared by every renderer that works on a sample rather than a colour: the
 * contour renderer paints it, the DEM renderer packs it.
 */
interface ValueSeed {
  loadTileTextures: GeoTiffRenderer["loadTileTextures"];
  /** The seed module for a tile, followed by the mask when it has one. */
  seedModules(textures: GeoTiffTileTextures): RenderPipeline;
  /** Release the shared decoded-tile cache. */
  destroy(): void;
}

/**
 * Build the value seed for `band`, over any sample format the texture table
 * knows. `band` must already be validated against the raster.
 */
function createValueSeed(
  geotiff: GeoTIFF,
  gl: WebGL2RenderingContext,
  band: number,
): ValueSeed {
  const { bitsPerSample, sampleFormat, samplesPerPixel, nodata } =
    geotiff.cachedTags;
  const uploadedSamples = samplesPerPixel === 3 ? 4 : samplesPerPixel;
  const textureFormat = inferTextureFormat(
    gl,
    uploadedSamples,
    bitsPerSample,
    sampleFormat!,
  );
  const seed = ValueTexture[textureFormat.sampler];

  // A normalised texture samples as [0, 1]; every other format returns raw
  // texel values. Fold the denormalisation into the seed's scale, and
  // express the nodata sentinel in the same sampled units.
  const denorm = textureFormat.normalized ? 2 ** bitsPerSample[0]! - 1 : 1;
  const scale = denorm * (geotiff.scales[band] ?? 1);
  const offset = geotiff.offsets[band] ?? 0;
  const nodataSampled = nodata === null ? null : nodata / denorm;

  // The value is interpolated manually, so each tile carries a halo of
  // neighbour texels: without it the outer half texel clamps to the tile's
  // own edge and every isoline (or terrain slope) breaks into a step at the
  // seam.
  const haloCache = new DecodedTileCache();

  return {
    // Filtering is irrelevant: the seed interpolates with texelFetch.
    loadTileTextures: tileTextureLoader({
      samplesPerPixel,
      textureFormat,
      linearFilter: false,
      haloCache,
    }),
    seedModules: (textures) => {
      const pipeline: RenderPipeline = [
        {
          module: seed,
          props: {
            texture: { texture: textures.texture, target: gl.TEXTURE_2D },
            band,
            nodata: nodataSampled,
            scale,
            offset,
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
      return pipeline;
    },
    destroy: () => haloCache.clear(),
  };
}

/** How a scalar band is packed into `raster-dem` RGB. */
export interface DemRenderOptions {
  /** Band to read. @default 0 */
  band?: number;
  /** @default "terrarium" */
  encoding?: DemEncoding;
  /** Metres written where the raster has no data. @default 0 */
  fillValue?: number;
}

/**
 * DEM renderer: `ValueTexture` seed → `DemEncode`. The output is data for
 * MapLibre's `raster-dem` decoder, not an image: opaque, unblended, with the
 * elevation packed into RGB per {@link DemEncoding}.
 */
export function createDemRenderer(
  geotiff: GeoTIFF,
  gl: WebGL2RenderingContext,
  options: DemRenderOptions = {},
): GeoTiffRenderer {
  const { samplesPerPixel } = geotiff.cachedTags;
  const band = options.band ?? 0;
  if (!Number.isInteger(band) || band < 0 || band >= samplesPerPixel) {
    throw new RangeError(
      `band must be an integer in [0, ${samplesPerPixel}), got ${band}`,
    );
  }
  const encoding = validateDemEncoding(options.encoding ?? "terrarium");
  const fillValue = options.fillValue ?? 0;
  if (!Number.isFinite(fillValue)) {
    throw new RangeError(`fillValue must be finite, got ${fillValue}`);
  }

  const seed = createValueSeed(geotiff, gl, band);
  // One instance shared by every tile: `getUniforms` reads it per tile.
  const encode: RenderPipeline[number] = {
    module: DemEncode,
    props: { encoding, fillValue },
  };

  return {
    loadTileTextures: seed.loadTileTextures,
    buildPipeline: (textures) => [...seed.seedModules(textures), encode],
    destroyTileTextures,
    destroy: () => seed.destroy(),
  };
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
  const { band } = resolved;
  const seed = createValueSeed(geotiff, gl, band);

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

  let style = createStyle(gl, resolved);

  // Every pipeline handed out and not yet destroyed, by its tile's textures,
  // so a re-style can rebuild the module chain of tiles already built. The
  // program cache compiles any new chain on demand.
  const live = new Map<GeoTiffTileTextures, RenderPipeline>();

  const modulesFor = (textures: GeoTiffTileTextures): RenderPipeline => {
    const pipeline = seed.seedModules(textures);
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
    // The seed's band index is what selects the texture channel; a change
    // would need every tile's props rewritten and, for a multi-band raster,
    // says the caller wants a different layer. Refuse rather than guess.
    if (next.band !== band) {
      throw new RangeError(
        `setContour cannot change the band (${band} → ${next.band}); recreate the layer`,
      );
    }
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

  return {
    loadTileTextures: seed.loadTileTextures,
    buildPipeline,
    destroyTileTextures: (glContext, textures) => {
      live.delete(textures);
      destroyTileTextures(glContext, textures);
    },
    destroy: (glContext) => {
      seed.destroy();
      live.clear();
      destroyStyle(glContext, style);
    },
    updateContour,
  };
}
