/**
 * The boundary between the main-thread source and wherever tiles are made.
 *
 * A backend owns an opened COG and turns tile requests into encoded MVT
 * bytes. {@link LocalBackend} does so in the calling thread; the worker
 * backend forwards the same calls to a module worker running a
 * {@link LocalBackend}.
 */

import type { ContourOptions } from "./generate.js";

/** Header-derived facts the source needs to describe itself to MapLibre. */
export interface ContourMeta {
  /** Coarsest first. */
  levelMetersPerPixel: number[];
  /** Nominal source tile width, for the source-tile budget. */
  sourceTileWidth: number;
  /** Dataset extent in WGS84 degrees, clamped to the Web Mercator range. */
  wgs84Bounds: [number, number, number, number];
}

export type GeoTIFFInput = string | URL | ArrayBuffer;

export interface BackendInit {
  geotiff: GeoTIFFInput;
  options: ContourOptions;
}

export interface ContourBackend {
  open(signal?: AbortSignal): Promise<ContourMeta>;
  tile(
    z: number,
    x: number,
    y: number,
    signal: AbortSignal,
  ): Promise<Uint8Array | null>;
  destroy(): void;
}
