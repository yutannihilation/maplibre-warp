// Adapted from @developmentseed/deck.gl-raster (MIT, Development Seed):
// packages/deck.gl-geotiff/src/geotiff/geotiff.ts

import type {
  ConcurrencyLimiter,
  Priority,
  RasterArrayPixelInterleaved,
  RasterTypedArray,
} from "@developmentseed/geotiff";
import { GeoTIFF } from "@developmentseed/geotiff";

/**
 * Add an alpha channel to an RGB image array.
 *
 * WebGL2 has no usable three-channel 8-bit sampleable format, so 3-band data
 * is padded to RGBA before upload. Returns the input unchanged when it already
 * has four channels.
 */
export function addAlphaChannel(
  rgbImage: RasterArrayPixelInterleaved,
): RasterArrayPixelInterleaved {
  const { height, width } = rgbImage;

  if (rgbImage.data.length === height * width * 4) {
    return rgbImage;
  }
  if (rgbImage.data.length !== height * width * 3) {
    throw new Error(
      `Unexpected number of channels in raster data: ${
        rgbImage.data.length / (height * width)
      }`,
    );
  }

  const rgbaLength = (rgbImage.data.length / 3) * 4;
  const source = rgbImage.data;
  // Keep the input's element type so the padded array still matches the
  // texture format chosen for it; alpha is the type's "fully opaque" value.
  const rgbaArray = allocateLike(source, rgbaLength);
  const maxAlpha = opaqueAlphaFor(source);
  for (let i = 0; i < source.length / 3; ++i) {
    rgbaArray[i * 4] = source[i * 3]!;
    rgbaArray[i * 4 + 1] = source[i * 3 + 1]!;
    rgbaArray[i * 4 + 2] = source[i * 3 + 2]!;
    rgbaArray[i * 4 + 3] = maxAlpha;
  }

  return {
    ...rgbImage,
    count: 4,
    data: rgbaArray,
  };
}

/** A zero-filled typed array of `length` with the same element type as `source`. */
export function allocateLike(
  source: RasterTypedArray,
  length: number,
): RasterTypedArray {
  return new (source.constructor as new (n: number) => RasterTypedArray)(
    length,
  );
}

/** The rejection every aborted tile load carries. */
export function abortError(): DOMException {
  return new DOMException("Tile load aborted", "AbortError");
}

/** The value that reads as fully opaque alpha for a sample type. */
function opaqueAlphaFor(data: RasterTypedArray): number {
  if (data instanceof Float32Array || data instanceof Float64Array) {
    return 1;
  }
  if (data instanceof Int8Array) {
    return 127;
  }
  if (data instanceof Int16Array) {
    return 32767;
  }
  if (data instanceof Int32Array) {
    return 2 ** 31 - 1;
  }
  if (data instanceof Uint16Array) {
    return 65535;
  }
  if (data instanceof Uint32Array) {
    return 2 ** 32 - 1;
  }
  return 255;
}

export async function fetchGeoTIFF(
  input: GeoTIFF | string | URL | ArrayBuffer,
  options: {
    concurrencyLimiter?: ConcurrencyLimiter | null;
    getPriority?: () => Priority;
    signal?: AbortSignal;
  } = {},
): Promise<GeoTIFF> {
  if (typeof input === "string" || input instanceof URL) {
    return await GeoTIFF.fromUrl(input, options);
  }
  if (input instanceof ArrayBuffer) {
    return await GeoTIFF.fromArrayBuffer(input);
  }
  return input;
}

/** Convert a typed array to a plain `ArrayBufferView` WebGL will accept. */
export function toGlView(data: ArrayBufferView): ArrayBufferView {
  // WebGL rejects `Uint8ClampedArray` in some implementations; view the same
  // bytes as a `Uint8Array` instead.
  if (data instanceof Uint8ClampedArray) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  return data;
}
