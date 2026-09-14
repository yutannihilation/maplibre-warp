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
import type { RenderPipeline } from "@maplibre-cog-warp/raster";
import {
  BlackIsZero,
  CieLabToRGB,
  CMYKToRGB,
  Colormap,
  CreateTexture,
  FilterNoDataVal,
  MaskTexture,
  WhiteIsZero,
} from "@maplibre-cog-warp/raster/gpu-modules";

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
): GeoTiffRenderer {
  const { sampleFormat, bitsPerSample } = geotiff.cachedTags;
  if (sampleFormat === null) {
    throw new Error("SampleFormat tag is required to infer a render pipeline");
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

  const loadTileTextures = async (
    image: GeoTIFF | Overview,
    options: {
      gl: WebGL2RenderingContext;
      x: number;
      y: number;
      signal: AbortSignal;
      pool?: DecoderPool;
    },
  ): Promise<GeoTiffTileTextures> => {
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

  return {
    loadTileTextures,
    buildPipeline,
    destroyTileTextures: (glContext, textures) => {
      glContext.deleteTexture(textures.texture);
      if (textures.mask) {
        glContext.deleteTexture(textures.mask);
      }
    },
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
