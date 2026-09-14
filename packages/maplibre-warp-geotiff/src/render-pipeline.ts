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
  BandColors,
  ContourBand,
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
  FilterNoDataVal,
  Isoband,
  MAX_THRESHOLDS,
  MaskTexture,
  resolveBandColors,
  ValueTexture,
  validateThresholds,
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
  /** Filled bands, or `false` for lines only. Required unless `lines` is set. */
  bands?: ContourBandOptions | false;
  /** Contour lines, or `false` for bands only. @default { width: 1 } */
  lines?: ContourLineOptions | false;
}

/** A band of the contour model together with its colour. */
export interface ContourBandWithColor extends ContourBand {
  color: string;
}

export interface GeoTiffRenderer {
  /** The contour band model with colours; empty when not contouring. */
  bands: ContourBandWithColor[];
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
    bands: [],
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
  validateThresholds(contour.thresholds);
  if (contour.thresholds.length > MAX_THRESHOLDS) {
    throw new RangeError(
      `${contour.thresholds.length} thresholds exceed the limit of ${MAX_THRESHOLDS}`,
    );
  }
  const band = contour.band ?? 0;
  if (!Number.isInteger(band) || band < 0 || band >= samplesPerPixel) {
    throw new RangeError(
      `band ${band} is out of range for a ${samplesPerPixel}-band raster`,
    );
  }
  if (contour.bands === false && contour.lines === false) {
    throw new RangeError("contour needs bands, lines or both");
  }

  const uploadedSamples = samplesPerPixel === 3 ? 4 : samplesPerPixel;
  const textureFormat = inferTextureFormat(
    gl,
    uploadedSamples,
    bitsPerSample,
    sampleFormat!,
  );
  const seed = ValueTexture[textureFormat.sampler];

  // An 8-bit unsigned texture samples as [0, 1]; every other format returns
  // raw texel values. Fold the denormalisation into the seed's scale, and
  // express the nodata sentinel in the same sampled units.
  const denorm =
    textureFormat.sampler === "float" && sampleFormat![0] === SampleFormat.Uint
      ? 2 ** bitsPerSample[0]! - 1
      : 1;
  const scale = denorm * (geotiff.scales[band] ?? 1);
  const offset = geotiff.offsets[band] ?? 0;
  const nodataSampled = nodata === null ? null : nodata / denorm;

  let bands: ContourBandWithColor[] = [];
  let bandColorTexture: WebGLTexture | undefined;
  const bandOptions = contour.bands === false ? null : contour.bands;
  const includeLower = bandOptions?.includeLower ?? false;
  const includeUpper = bandOptions?.includeUpper ?? true;
  if (bandOptions) {
    const model = bandsFromThresholds(contour.thresholds, {
      includeLower,
      includeUpper,
    });
    const colors = resolveBandColors(bandOptions.colors, model.length);
    bands = model.map((b, k) => ({ ...b, color: colors[k]! }));
    const image = bandColorImage(colors);
    bandColorTexture = createTexture2D(gl, {
      width: image.width,
      height: image.height,
      data: image.data,
      format: inferTextureFormat(gl, 4, [8, 8, 8, 8], [SampleFormat.Uint]),
      linear: false,
    });
  }
  const lineOptions = contour.lines === false ? null : (contour.lines ?? {});

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
          width: textures.width,
          height: textures.height,
        },
      },
    ];
    if (textures.mask) {
      pipeline.push({
        module: MaskTexture,
        props: { mask: { texture: textures.mask, target: gl.TEXTURE_2D } },
      });
    }
    if (bandColorTexture) {
      pipeline.push({
        module: Isoband,
        props: {
          thresholds: contour.thresholds,
          includeLower,
          includeUpper,
          colors: { texture: bandColorTexture, target: gl.TEXTURE_2D },
        },
      });
    } else {
      pipeline.push({ module: ClearColor });
    }
    if (lineOptions) {
      pipeline.push({
        module: ContourLine,
        props: {
          thresholds: contour.thresholds,
          width: lineOptions.width ?? 1,
          color: lineOptions.color ?? "#333333",
          majorEvery: lineOptions.majorEvery,
          majorWidth: lineOptions.majorWidth,
          majorColor: lineOptions.majorColor,
        },
      });
    }
    return pipeline;
  };

  return {
    bands,
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
