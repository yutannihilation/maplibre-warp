// Adapted from @developmentseed/deck.gl-raster (MIT, Development Seed):
// packages/deck.gl-geotiff/src/geotiff/geotiff.ts

import type {
  ConcurrencyLimiter,
  Priority,
  RasterArray,
} from "@developmentseed/geotiff";
import { GeoTIFF } from "@developmentseed/geotiff";
import type { Converter } from "proj4";

/**
 * Add an alpha channel to an RGB image array.
 *
 * WebGL2 has no usable three-channel 8-bit sampleable format, so 3-band data
 * is padded to RGBA before upload. Returns the input unchanged when it already
 * has four channels.
 */
export function addAlphaChannel(rgbImage: RasterArray): RasterArray {
  const { height, width } = rgbImage;

  if (rgbImage.layout === "band-separate") {
    throw new Error("Band-separate images not yet implemented.");
  }

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
  const isUint16 = rgbImage.data instanceof Uint16Array;
  const rgbaArray = isUint16
    ? new Uint16Array(rgbaLength)
    : new Uint8ClampedArray(rgbaLength);
  const maxAlpha = isUint16 ? 65535 : 255;
  for (let i = 0; i < rgbImage.data.length / 3; ++i) {
    rgbaArray[i * 4] = rgbImage.data[i * 3]!;
    rgbaArray[i * 4 + 1] = rgbImage.data[i * 3 + 1]!;
    rgbaArray[i * 4 + 2] = rgbImage.data[i * 3 + 2]!;
    rgbaArray[i * 4 + 3] = maxAlpha;
  }

  return {
    ...rgbImage,
    count: 4,
    data: rgbaArray,
  };
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

/**
 * WGS84 bounding box of a GeoTIFF, computed from all four CRS corners so
 * rotation and skew are handled.
 */
export function getGeographicBounds(
  geotiff: GeoTIFF,
  converter: Converter,
): { west: number; south: number; east: number; north: number } {
  const [minX, minY, maxX, maxY] = geotiff.bbox;

  const corners: [number, number][] = [
    converter.forward([minX, minY]),
    converter.forward([maxX, minY]),
    converter.forward([maxX, maxY]),
    converter.forward([minX, maxY]),
  ];

  const lons = corners.map((c) => c[0]);
  const lats = corners.map((c) => c[1]);

  return {
    west: Math.min(...lons),
    south: Math.min(...lats),
    east: Math.max(...lons),
    north: Math.max(...lats),
  };
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
