// Adapted from @developmentseed/deck.gl-raster (MIT, Development Seed):
// packages/deck.gl-geotiff/src/geotiff/geotiff.ts (fetchGeoTIFF)

import type {
  ConcurrencyLimiter,
  Priority,
  RasterArray,
  RasterTypedArray,
} from "@developmentseed/geotiff";
import { GeoTIFF } from "@developmentseed/geotiff";

/**
 * One `width × height` plane per band, whichever layout the tile was decoded
 * in. A band-separate array already is that, and is returned without a copy;
 * a pixel-interleaved one is de-interleaved in a single pass. These planes are
 * the layers of the tile's `TEXTURE_2D_ARRAY`.
 */
export function bandPlanes(array: RasterArray): RasterTypedArray[] {
  const { width, height, count } = array;
  const size = width * height;
  if (array.layout === "band-separate") {
    if (array.bands.length !== count) {
      throw new RangeError(
        `band-separate array has ${array.bands.length} planes, count says ${count}`,
      );
    }
    for (const [b, plane] of array.bands.entries()) {
      if (plane.length !== size) {
        throw new RangeError(
          `plane ${b} has ${plane.length} samples, expected ${width}×${height}`,
        );
      }
    }
    return array.bands;
  }
  const { data } = array;
  if (data.length !== size * count) {
    throw new RangeError(
      `pixel-interleaved array has ${data.length} samples, expected ${width}×${height}×${count}`,
    );
  }
  const planes = Array.from({ length: count }, () => allocateLike(data, size));
  for (let i = 0; i < size; i++) {
    const base = i * count;
    for (let b = 0; b < count; b++) {
      planes[b]![i] = data[base + b]!;
    }
  }
  return planes;
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
