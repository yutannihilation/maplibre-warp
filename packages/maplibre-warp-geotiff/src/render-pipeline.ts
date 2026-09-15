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
import type { DecoderPool, GeoTIFF, Overview } from "@developmentseed/geotiff";
import { parseColormap } from "@developmentseed/geotiff";
import type { RenderPipeline } from "@yutannihilation/maplibre-warp-raster";
import type {
  BandColorImage,
  BandColors,
  ContourBand,
  ContourLineProps,
  IsobandProps,
  PackedThresholds,
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
  FilterNoDataVal,
  Isoband,
  MaskTexture,
  packThresholds,
  resolveBandColors,
  ValueTexture,
  WhiteIsZero,
} from "@yutannihilation/maplibre-warp-raster/gpu-modules";

import { addAlphaChannel, toGlView } from "./geotiff-utils.js";
import {
  createColormapTexture,
  createTexture2D,
  inferTextureFormat,
} from "./texture.js";

/** GPU textures for a single decoded tile. */
export interface GeoTiffTileTextures {
  width: number;
  height: number;
  texture: WebGLTexture;
  mask?: WebGLTexture;
  /** GPU bytes held by these textures. */
  byteLength: number;
}

/** Filled-band configuration for {@link ContourRenderOptions}. */
export interface ContourBandOptions {
  /** One CSS colour per emitted band, or an interpolator over `[0, 1]`. */
  colors: BandColors;
  /** Emit the band below the first threshold. @default false */
  includeLower?: boolean;
  /** Emit the band above the last threshold. @default true */
  includeUpper?: boolean;
}

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
  /** Filled bands. Omit or pass `false` for lines only. */
  bands?: ContourBandOptions | false;
  /**
   * Contour lines, on by default; pass `false` for bands only. Disabling
   * both is a configuration error.
   * @default { width: 1 }
   */
  lines?: ContourLineOptions | false;
}

/** A band of the contour model together with its colour. */
export interface ContourBandWithColor extends ContourBand {
  color: string;
}

/** The band model with colours, or `[]` when bands are off. */
export function resolveContourBands(
  contour: ContourRenderOptions,
): ContourBandWithColor[] {
  if (!contour.bands) {
    return [];
  }
  const model = bandsFromThresholds(contour.thresholds, contour.bands);
  const colors = resolveBandColors(contour.bands.colors, model.length);
  return model.map((band, k) => ({ ...band, color: colors[k]! }));
}

/** Everything derived from {@link ContourRenderOptions} that needs no GL. */
export interface ResolvedContourOptions {
  band: number;
  thresholds: PackedThresholds;
  /** With colours; `[]` when bands are off. */
  bands: ContourBandWithColor[];
  /** Colour lookup row, `null` when bands are off. */
  bandImage: BandColorImage | null;
  includeLower: boolean;
  includeUpper: boolean;
  /** Line props minus nothing GL-specific; `null` when lines are off. */
  lines: Omit<ContourLineProps, "thresholds"> | null;
}

const DEFAULT_LINE_COLOR = "#333333";

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
  if (contour.bands === false && contour.lines === false) {
    throw new RangeError("contour needs bands, lines or both");
  }

  const bands = resolveContourBands(contour);
  let bandImage: BandColorImage | null = null;
  if (contour.bands) {
    if (bands.length === 0) {
      throw new RangeError(
        "the thresholds and includeLower/includeUpper settings emit no band",
      );
    }
    // Parses every colour, so an unparsable one fails here.
    bandImage = bandColorImage(bands.map((b) => b.color));
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
    thresholds,
    bands,
    bandImage,
    includeLower: contour.bands ? (contour.bands.includeLower ?? false) : false,
    includeUpper: contour.bands ? (contour.bands.includeUpper ?? true) : true,
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
function tileTextureLoader({
  samplesPerPixel,
  textureFormat,
  linearFilter,
}: {
  samplesPerPixel: number;
  textureFormat: ReturnType<typeof inferTextureFormat>;
  linearFilter: boolean;
}): GeoTiffRenderer["loadTileTextures"] {
  return async (image, options) => {
    const tile = await image.fetchTile(options.x, options.y, {
      boundless: false,
      pool: options.pool,
      signal: options.signal,
    });

    let { array } = tile;
    const { width, height, mask } = array;

    if (array.layout === "band-separate") {
      throw new Error("Band-separate images not yet implemented.");
    }
    if (samplesPerPixel === 3) {
      array = addAlphaChannel(array);
    }

    const texture = createTexture2D(options.gl, {
      width,
      height,
      data: toGlView(array.data),
      format: textureFormat,
      linear: linearFilter,
    });
    let byteLength = width * height * textureFormat.bytesPerPixel;

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

    return { texture, mask: maskTexture, width, height, byteLength };
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
 * Contour renderer: `ValueTexture` seed → `Isoband` or `ClearColor` →
 * `ContourLine`, over any sample format the texture table knows.
 */
function createContourRenderer(
  geotiff: GeoTIFF,
  gl: WebGL2RenderingContext,
  contour: ContourRenderOptions,
): GeoTiffRenderer {
  const { bitsPerSample, sampleFormat, samplesPerPixel, nodata } =
    geotiff.cachedTags;
  // Everything a tile's props need is resolved once here: `buildPipeline`
  // runs per tile and `getUniforms` per tile per frame, so no colour parsing
  // or array allocation may live there.
  const resolved = resolveContourOptions(contour, samplesPerPixel);
  const { band, thresholds } = resolved;

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

  let bandColorTexture: WebGLTexture | undefined;
  let isobandProps: IsobandProps | undefined;
  if (resolved.bandImage) {
    bandColorTexture = createTexture2D(gl, {
      width: resolved.bandImage.width,
      height: resolved.bandImage.height,
      data: resolved.bandImage.data,
      format: inferTextureFormat(gl, 4, [8, 8, 8, 8], [SampleFormat.Uint]),
      linear: false,
    });
    isobandProps = {
      thresholds,
      includeLower: resolved.includeLower,
      includeUpper: resolved.includeUpper,
      colors: { texture: bandColorTexture, target: gl.TEXTURE_2D },
    };
  }
  const lineProps: ContourLineProps | undefined = resolved.lines
    ? { thresholds, ...resolved.lines }
    : undefined;

  const buildPipeline = (textures: GeoTiffTileTextures): RenderPipeline => {
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
        },
      },
    ];
    if (textures.mask) {
      pipeline.push({
        module: MaskTexture,
        props: { mask: { texture: textures.mask, target: gl.TEXTURE_2D } },
      });
    }
    if (isobandProps) {
      pipeline.push({ module: Isoband, props: isobandProps });
    } else {
      pipeline.push({ module: ClearColor });
    }
    if (lineProps) {
      pipeline.push({ module: ContourLine, props: lineProps });
    }
    return pipeline;
  };

  return {
    // Filtering is irrelevant: the seed interpolates with texelFetch.
    loadTileTextures: tileTextureLoader({
      samplesPerPixel,
      textureFormat,
      linearFilter: false,
    }),
    buildPipeline,
    destroyTileTextures,
    destroy: (glContext) => {
      if (bandColorTexture) {
        glContext.deleteTexture(bandColorTexture);
      }
    },
  };
}
