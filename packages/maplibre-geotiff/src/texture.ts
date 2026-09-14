/**
 * GeoTIFF sample layout → WebGL2 texture format, and texture upload.
 *
 * The format table is ported from @developmentseed/deck.gl-raster's
 * `deck.gl-geotiff/src/geotiff/texture.ts` (MIT, Development Seed), translated
 * from luma.gl `TextureFormat` strings to the raw WebGL2 triple
 * `(internalFormat, format, type)` plus the sampler kind the fragment shader
 * needs.
 */

import { SampleFormat } from "@cogeotiff/core";

/** How a shader must declare the sampler for a given format. */
export type SamplerKind = "float" | "uint" | "int";

export interface GLTextureFormat {
  /** e.g. `gl.RGBA8` */
  internalFormat: GLenum;
  /** e.g. `gl.RGBA` */
  format: GLenum;
  /** e.g. `gl.UNSIGNED_BYTE` */
  type: GLenum;
  /** `sampler2D`, `usampler2D` or `isampler2D`. */
  sampler: SamplerKind;
  /** Whether `LINEAR` filtering is allowed without an extension. */
  filterable: boolean;
  bytesPerPixel: number;
}

type ScalarKind = "unorm" | "sint" | "float";
type ChannelCount = 1 | 2 | 3 | 4;
type BitWidth = 8 | 16 | 32;
type FormatKey = `${ChannelCount}:${ScalarKind}:${BitWidth}`;

/**
 * Build the format table.
 *
 * A function rather than a constant because the enum values come off the live
 * `WebGL2RenderingContext`.
 */
function formatTable(
  gl: WebGL2RenderingContext,
): Partial<Record<FormatKey, GLTextureFormat>> {
  const f = (
    internalFormat: GLenum,
    format: GLenum,
    type: GLenum,
    sampler: SamplerKind,
    filterable: boolean,
    bytesPerPixel: number,
  ): GLTextureFormat => ({
    internalFormat,
    format,
    type,
    sampler,
    filterable,
    bytesPerPixel,
  });

  return {
    // 8-bit unsigned, normalised to [0, 1]. The M1 path.
    "1:unorm:8": f(gl.R8, gl.RED, gl.UNSIGNED_BYTE, "float", true, 1),
    "2:unorm:8": f(gl.RG8, gl.RG, gl.UNSIGNED_BYTE, "float", true, 2),
    "4:unorm:8": f(gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, "float", true, 4),

    // 16-bit unsigned. WebGL2 has no core normalised 16-bit format (that is
    // EXT_texture_norm16), so these are integer textures and need a
    // `usampler2D` plus an explicit divide by the type's maximum.
    "1:unorm:16": f(
      gl.R16UI,
      gl.RED_INTEGER,
      gl.UNSIGNED_SHORT,
      "uint",
      false,
      2,
    ),
    "2:unorm:16": f(
      gl.RG16UI,
      gl.RG_INTEGER,
      gl.UNSIGNED_SHORT,
      "uint",
      false,
      4,
    ),
    "4:unorm:16": f(
      gl.RGBA16UI,
      gl.RGBA_INTEGER,
      gl.UNSIGNED_SHORT,
      "uint",
      false,
      8,
    ),

    // Signed integer.
    "1:sint:8": f(gl.R8I, gl.RED_INTEGER, gl.BYTE, "int", false, 1),
    "1:sint:16": f(gl.R16I, gl.RED_INTEGER, gl.SHORT, "int", false, 2),
    "1:sint:32": f(gl.R32I, gl.RED_INTEGER, gl.INT, "int", false, 4),

    // Float. Sampling is core WebGL2; LINEAR filtering needs
    // OES_texture_float_linear, so `filterable` is reported false here and the
    // caller falls back to NEAREST unless it has checked for the extension.
    "1:float:32": f(gl.R32F, gl.RED, gl.FLOAT, "float", false, 4),
    "2:float:32": f(gl.RG32F, gl.RG, gl.FLOAT, "float", false, 8),
    "4:float:32": f(gl.RGBA32F, gl.RGBA, gl.FLOAT, "float", false, 16),
  };
}

/** Map a GeoTIFF `SampleFormat` to a scalar kind. */
function inferScalarKind(sampleFormat: SampleFormat[]): ScalarKind {
  const first = sampleFormat[0]!;
  for (let i = 1; i < sampleFormat.length; i++) {
    if (sampleFormat[i] !== first) {
      throw new Error(
        `Unsupported varying SampleFormat ${sampleFormat}. All samples must have the same format.`,
      );
    }
  }
  switch (first) {
    case SampleFormat.Uint:
      return "unorm";
    case SampleFormat.Int:
      return "sint";
    case SampleFormat.Float:
      return "float";
    default:
      throw new Error(`Unsupported SampleFormat ${sampleFormat}`);
  }
}

function verifyChannelCount(samplesPerPixel: number): ChannelCount {
  if (
    samplesPerPixel === 1 ||
    samplesPerPixel === 2 ||
    samplesPerPixel === 3 ||
    samplesPerPixel === 4
  ) {
    return samplesPerPixel;
  }
  throw new Error(
    `Unsupported SamplesPerPixel ${samplesPerPixel}. Only 1, 2, 3 or 4 are supported.`,
  );
}

function verifyBitWidth(bitsPerSample: ArrayLike<number>): BitWidth {
  const first = bitsPerSample[0]!;
  for (let i = 1; i < bitsPerSample.length; i++) {
    if (bitsPerSample[i] !== first) {
      throw new Error(
        `Unsupported varying BitsPerSample ${Array.from(bitsPerSample)}. All samples must have the same bit width.`,
      );
    }
  }
  if (first !== 8 && first !== 16 && first !== 32) {
    throw new Error(
      `Unsupported BitsPerSample ${first}. Only 8, 16 or 32 are supported.`,
    );
  }
  return first;
}

/**
 * Resolve the WebGL2 texture format for a GeoTIFF's sample layout.
 *
 * Three-channel data must be padded to four before upload (WebGL2 has no
 * three-channel colour-renderable/sampleable 8-bit format worth using), so
 * pass `4` for `samplesPerPixel` after padding.
 */
export function inferTextureFormat(
  gl: WebGL2RenderingContext,
  samplesPerPixel: number,
  bitsPerSample: ArrayLike<number>,
  sampleFormat: SampleFormat[],
): GLTextureFormat {
  const channelCount = verifyChannelCount(samplesPerPixel);
  const bitWidth = verifyBitWidth(bitsPerSample);
  const scalarKind = inferScalarKind(sampleFormat);

  const key: FormatKey = `${channelCount}:${scalarKind}:${bitWidth}`;
  const entry = formatTable(gl)[key];
  if (!entry) {
    throw new Error(
      `Unsupported texture format for SamplesPerPixel=${samplesPerPixel}, BitsPerSample=${bitWidth}, SampleFormat=${sampleFormat}`,
    );
  }
  return entry;
}

export interface CreateTextureOptions {
  width: number;
  height: number;
  data: ArrayBufferView;
  format: GLTextureFormat;
  /** Use LINEAR filtering. Silently downgraded when the format forbids it. */
  linear: boolean;
}

/**
 * Upload a 2D texture.
 *
 * Pixel-store state is set explicitly and restored, because MapLibre uploads
 * its own images with `UNPACK_PREMULTIPLY_ALPHA_WEBGL` and
 * `UNPACK_FLIP_Y_WEBGL` set and we must neither inherit nor leak those.
 */
export function createTexture2D(
  gl: WebGL2RenderingContext,
  options: CreateTextureOptions,
): WebGLTexture {
  const { width, height, data, format, linear } = options;
  const texture = gl.createTexture();
  if (!texture) {
    throw new Error("Failed to create WebGL texture");
  }

  const previousUnit = gl.getParameter(gl.ACTIVE_TEXTURE) as GLenum;
  const previousTexture = gl.getParameter(
    gl.TEXTURE_BINDING_2D,
  ) as WebGLTexture | null;
  const previousAlignment = gl.getParameter(gl.UNPACK_ALIGNMENT) as number;

  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);

  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    format.internalFormat,
    width,
    height,
    0,
    format.format,
    format.type,
    data,
  );

  const filter = linear && format.filterable ? gl.LINEAR : gl.NEAREST;
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  gl.pixelStorei(gl.UNPACK_ALIGNMENT, previousAlignment);
  gl.bindTexture(gl.TEXTURE_2D, previousTexture);
  gl.activeTexture(previousUnit);

  return texture;
}

/**
 * Upload a colormap sprite as a single-layer `TEXTURE_2D_ARRAY`.
 *
 * An array texture (rather than a plain 2D one) so that multiple colormaps can
 * be packed into one texture later and selected by layer index — the shape the
 * {@link Colormap} module already expects.
 */
export function createColormapTexture(
  gl: WebGL2RenderingContext,
  image: ImageData,
): WebGLTexture {
  const texture = gl.createTexture();
  if (!texture) {
    throw new Error("Failed to create WebGL texture");
  }

  const previousUnit = gl.getParameter(gl.ACTIVE_TEXTURE) as GLenum;
  const previousTexture = gl.getParameter(
    gl.TEXTURE_BINDING_2D_ARRAY,
  ) as WebGLTexture | null;
  const previousAlignment = gl.getParameter(gl.UNPACK_ALIGNMENT) as number;

  gl.bindTexture(gl.TEXTURE_2D_ARRAY, texture);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);

  gl.texImage3D(
    gl.TEXTURE_2D_ARRAY,
    0,
    gl.RGBA8,
    image.width,
    image.height,
    1,
    0,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    new Uint8Array(
      image.data.buffer,
      image.data.byteOffset,
      image.data.byteLength,
    ),
  );

  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);

  gl.pixelStorei(gl.UNPACK_ALIGNMENT, previousAlignment);
  gl.bindTexture(gl.TEXTURE_2D_ARRAY, previousTexture);
  gl.activeTexture(previousUnit);

  return texture;
}
