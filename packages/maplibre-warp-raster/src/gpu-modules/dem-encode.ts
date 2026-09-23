/**
 * Pack an elevation into the RGB bytes MapLibre's `raster-dem` source reads.
 *
 * MapLibre's `DEMData` holds each texel as packed RGBA and unpacks it as
 * `r·redFactor + g·greenFactor + b·blueFactor − baseShift`; it has no float
 * path. Both built-in encodings are the 24-bit integer
 * `(elevation + baseShift) · step` split big-endian into `r, g, b`, differing
 * only in `step` (units per metre) and `baseShift`.
 */

import type { RasterShaderModule } from "../shader/module.js";

export type DemEncoding = "terrarium" | "mapbox";

/** The unpack factors MapLibre applies for an encoding (`DEMData`). */
export interface DemEncodingFactors {
  redFactor: number;
  greenFactor: number;
  blueFactor: number;
  baseShift: number;
  /** Encoded units per metre: `1 / blueFactor`. */
  step: number;
}

export const DEM_ENCODINGS: Record<DemEncoding, DemEncodingFactors> = {
  // 1/256 m over [-32768, 32767] m.
  terrarium: {
    redFactor: 256,
    greenFactor: 1,
    blueFactor: 1 / 256,
    baseShift: 32768,
    step: 256,
  },
  // 0.1 m over [-10000, 1667721] m.
  mapbox: {
    redFactor: 6553.6,
    greenFactor: 25.6,
    blueFactor: 0.1,
    baseShift: 10000,
    step: 10,
  },
};

const MAX_ENCODED = 2 ** 24 - 1;

export function validateDemEncoding(encoding: string): DemEncoding {
  if (!Object.hasOwn(DEM_ENCODINGS, encoding)) {
    throw new RangeError(
      `unknown DEM encoding ${JSON.stringify(encoding)}; expected one of ${Object.keys(DEM_ENCODINGS).join(", ")}`,
    );
  }
  return encoding as DemEncoding;
}

/** Encode `value` metres as integer bytes, clamped to the encoding's range. */
export function encodeDem(
  value: number,
  encoding: DemEncoding,
): [r: number, g: number, b: number] {
  const { baseShift, step } = DEM_ENCODINGS[encoding];
  const v = Math.min(
    MAX_ENCODED,
    Math.max(0, Math.round((value + baseShift) * step)),
  );
  return [v >>> 16, (v >>> 8) & 255, v & 255];
}

/** MapLibre's unpack of `[r, g, b]`, in metres. */
export function decodeDem(
  [r, g, b]: readonly [number, number, number],
  encoding: DemEncoding,
): number {
  const { redFactor, greenFactor, blueFactor, baseShift } =
    DEM_ENCODINGS[encoding];
  return r * redFactor + g * greenFactor + b * blueFactor - baseShift;
}

/** `encodeDem` as a GL clear colour in `[0, 1]`. */
export function demClearColor(
  value: number,
  encoding: DemEncoding,
): [r: number, g: number, b: number] {
  const [r, g, b] = encodeDem(value, encoding);
  return [r / 255, g / 255, b / 255];
}

export interface DemEncodeProps {
  encoding: DemEncoding;
  /** Metres written where the raster has no data. Must be finite. */
  fillValue: number;
}

/**
 * Terminal module: `value`/`valid` → packed RGB, alpha `1`.
 *
 * Never discards, so the output is defined for every fragment the mesh
 * covers; pixels the mesh does not cover keep the frame's clear colour,
 * which the renderer sets to the same encoding of `fillValue`.
 */
export const DemEncode: RasterShaderModule<DemEncodeProps> = {
  name: "dem-encode",
  fsDecl: `uniform float u_dem_step;
uniform float u_dem_base_shift;
uniform float u_dem_fill_value;`,
  fsColor: `  {
    float e = valid == 0.0 ? u_dem_fill_value : value;
    float v = clamp(floor((e + u_dem_base_shift) * u_dem_step + 0.5), 0.0, 16777215.0);
    float r = floor(v / 65536.0);
    float g = floor((v - r * 65536.0) / 256.0);
    float b = v - r * 65536.0 - g * 256.0;
    color = vec4(r, g, b, 255.0) / 255.0;
  }`,
  getUniforms: (props) => {
    const factors = DEM_ENCODINGS[validateDemEncoding(props.encoding)];
    if (!Number.isFinite(props.fillValue)) {
      throw new RangeError(`fillValue must be finite, got ${props.fillValue}`);
    }
    return {
      uniforms: {
        u_dem_step: factors.step,
        u_dem_base_shift: factors.baseShift,
        u_dem_fill_value: props.fillValue,
      },
    };
  },
};
