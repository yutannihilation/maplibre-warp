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
  /**
   * Whether sampling yields values normalised to `[0, 1]` (the `*8` unorm
   * formats) rather than raw texel values.
   */
  normalized: boolean;
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
    normalized = false,
  ): GLTextureFormat => ({
    internalFormat,
    format,
    type,
    sampler,
    filterable,
    normalized,
    bytesPerPixel,
  });

  return {
    // 8-bit unsigned, normalised to [0, 1]. The M1 path.
    "1:unorm:8": f(gl.R8, gl.RED, gl.UNSIGNED_BYTE, "float", true, 1, true),
    "2:unorm:8": f(gl.RG8, gl.RG, gl.UNSIGNED_BYTE, "float", true, 2, true),
    "4:unorm:8": f(gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, "float", true, 4, true),

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
    // 32-bit unsigned: `float(texelFetch(...))` is exact to 2^24.
    "1:unorm:32": f(
      gl.R32UI,
      gl.RED_INTEGER,
      gl.UNSIGNED_INT,
      "uint",
      false,
      4,
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
 * The pixel-store parameters a texture upload depends on.
 *
 * These are global GL state, and MapLibre caches its own view of them on its
 * `Context` (`PixelStoreUnpackPremultiplyAlpha.set` returns early when the
 * value it is asked for equals the one it last wrote). MapLibre brackets a
 * custom layer's `render()` with `setCustomLayerDefaults()` and `setDirty()`,
 * so state changed *during a draw* is already handled — but tile uploads
 * happen asynchronously between frames, outside that bracket, where nothing
 * resyncs the cache. So these functions leave the parameters exactly as they
 * found them.
 */
interface PixelStoreState {
  alignment: number;
  flipY: boolean;
  premultiplyAlpha: boolean;
}

/**
 * Configure pixel storage for a raster upload: tightly packed rows, no row
 * flip, no alpha premultiplication. Raster samples are data, not display-ready
 * colour, and must reach the texture byte-for-byte.
 */
function beginPixelUpload(gl: WebGL2RenderingContext): PixelStoreState {
  const saved: PixelStoreState = {
    alignment: gl.getParameter(gl.UNPACK_ALIGNMENT) as number,
    flipY: gl.getParameter(gl.UNPACK_FLIP_Y_WEBGL) as boolean,
    premultiplyAlpha: gl.getParameter(
      gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL,
    ) as boolean,
  };
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  return saved;
}

/** Restore what {@link beginPixelUpload} changed. */
function endPixelUpload(
  gl: WebGL2RenderingContext,
  saved: PixelStoreState,
): void {
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, saved.alignment);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, saved.flipY);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, saved.premultiplyAlpha);
}

/**
 * Create a texture and run `upload` with it bound to `target`, with the
 * pixel-store parameters set for raw data and every piece of GL state this
 * touches — the pixel store, the previous binding of `target` and the active
 * unit — restored afterwards. `binding` is the `TEXTURE_BINDING_*` enum that
 * reads back what is bound to `target`.
 */
function withTextureUpload(
  gl: WebGL2RenderingContext,
  target: GLenum,
  binding: GLenum,
  upload: () => void,
): WebGLTexture {
  const texture = gl.createTexture();
  if (!texture) {
    throw new Error("Failed to create WebGL texture");
  }
  const previousUnit = gl.getParameter(gl.ACTIVE_TEXTURE) as GLenum;
  const previousTexture = gl.getParameter(binding) as WebGLTexture | null;
  const savedPixelStore = beginPixelUpload(gl);

  gl.bindTexture(target, texture);
  upload();

  endPixelUpload(gl, savedPixelStore);
  gl.bindTexture(target, previousTexture);
  gl.activeTexture(previousUnit);
  return texture;
}

/** Filtering and clamping for a texture bound to `target`. */
function setSamplerParameters(
  gl: WebGL2RenderingContext,
  target: GLenum,
  filter: GLenum,
): void {
  gl.texParameteri(target, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(target, gl.TEXTURE_MAG_FILTER, filter);
  gl.texParameteri(target, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(target, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  if (target === gl.TEXTURE_2D_ARRAY) {
    gl.texParameteri(target, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
  }
}

/**
 * Upload a 2D texture.
 */
export function createTexture2D(
  gl: WebGL2RenderingContext,
  options: CreateTextureOptions,
): WebGLTexture {
  const { width, height, data, format, linear } = options;
  return withTextureUpload(gl, gl.TEXTURE_2D, gl.TEXTURE_BINDING_2D, () => {
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
    setSamplerParameters(gl, gl.TEXTURE_2D, filter);
  });
}

export interface CreateTextureArrayOptions {
  width: number;
  height: number;
  /** One `width × height` single-channel plane per layer, in layer order. */
  planes: readonly ArrayBufferView[];
  /** A single-channel format: every plane is one band. */
  format: GLTextureFormat;
}

/** Per-context `MAX_ARRAY_TEXTURE_LAYERS`: a constant, and `getParameter` stalls. */
const MAX_ARRAY_TEXTURE_LAYERS = new WeakMap<WebGL2RenderingContext, number>();

function maxArrayTextureLayers(gl: WebGL2RenderingContext): number {
  let max = MAX_ARRAY_TEXTURE_LAYERS.get(gl);
  if (max === undefined) {
    max = gl.getParameter(gl.MAX_ARRAY_TEXTURE_LAYERS) as number;
    MAX_ARRAY_TEXTURE_LAYERS.set(gl, max);
  }
  return max;
}

/**
 * Upload a band stack as a `TEXTURE_2D_ARRAY`: one single-channel layer per
 * plane, so the shader picks bands by layer index and a change of composite
 * touches no texture. Always NEAREST, since the seeds interpolate with
 * `texelFetch` themselves.
 */
export function createTextureArray(
  gl: WebGL2RenderingContext,
  options: CreateTextureArrayOptions,
): WebGLTexture {
  const { width, height, planes, format } = options;
  const maxLayers = maxArrayTextureLayers(gl);
  if (planes.length === 0) {
    throw new RangeError("a texture array needs at least one plane");
  }
  if (planes.length > maxLayers) {
    throw new Error(
      `${planes.length} bands exceed MAX_ARRAY_TEXTURE_LAYERS (${maxLayers})`,
    );
  }
  return withTextureUpload(
    gl,
    gl.TEXTURE_2D_ARRAY,
    gl.TEXTURE_BINDING_2D_ARRAY,
    () => {
      gl.texStorage3D(
        gl.TEXTURE_2D_ARRAY,
        1,
        format.internalFormat,
        width,
        height,
        planes.length,
      );
      planes.forEach((plane, layer) => {
        gl.texSubImage3D(
          gl.TEXTURE_2D_ARRAY,
          0,
          0,
          0,
          layer,
          width,
          height,
          1,
          format.format,
          format.type,
          plane,
        );
      });
      setSamplerParameters(gl, gl.TEXTURE_2D_ARRAY, gl.NEAREST);
    },
  );
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
  return withTextureUpload(
    gl,
    gl.TEXTURE_2D_ARRAY,
    gl.TEXTURE_BINDING_2D_ARRAY,
    () => {
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
      setSamplerParameters(gl, gl.TEXTURE_2D_ARRAY, gl.NEAREST);
    },
  );
}
