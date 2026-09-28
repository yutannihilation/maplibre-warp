/**
 * Contour shader modules: a scalar seed, filled bands, a continuous gradient,
 * lines.
 *
 * All of them work on the `value`/`valid` variables `buildFragmentSource`
 * declares in `main()`, so bands can recolour `color` while lines still see
 * the underlying sample.
 */

import type { RasterShaderModule, TextureBinding } from "../shader/module.js";
import { validateThresholds } from "./contour-bands.js";
import type { ValueSamplerKind } from "./texture-sampling.js";
import {
  ARRAY_SAMPLER_TYPE,
  BILINEAR_SAMPLE_GLSL,
  BILINEAR_TAPS_GLSL,
} from "./texture-sampling.js";

/** Size of the threshold uniform array, and so the most levels per layer. */
export const MAX_THRESHOLDS = 64;

export interface ValueTextureProps {
  /** A `TEXTURE_2D_ARRAY` with one single-channel layer per band. */
  texture: TextureBinding;
  /** Layer (band) to read. */
  band: number;
  /** Sentinel that marks missing data, in raw texel units. */
  nodata: number | null;
  /** `value = raw · scale + offset`. @default 1 */
  scale?: number;
  /** @default 0 */
  offset?: number;
  /**
   * Size of the tile's content in texels as `[width, height]`, excluding any
   * halo, for manual bilinear interpolation. Built once per tile;
   * `getUniforms` runs every frame.
   */
  size: Float32Array;
  /**
   * Texels of padding on every side of the content, filled from the
   * neighbouring tiles: `0` or `1`. `uv` spans the content only; the halo
   * lets the bilinear taps reach across a tile seam instead of clamping at it.
   * @default 0
   */
  halo?: number;
}

function valueTextureModule(
  kind: ValueSamplerKind,
): RasterShaderModule<ValueTextureProps> {
  const sampler = ARRAY_SAMPLER_TYPE[kind];
  return {
    name: `value-texture-${kind}`,
    fsDecl: `precision highp ${sampler};
uniform ${sampler} u_value_texture;
uniform int u_value_band;
uniform int u_value_has_nodata;
uniform float u_value_nodata;
uniform float u_value_scale;
uniform float u_value_offset;
uniform vec2 u_value_size;
uniform int u_value_halo;

${BILINEAR_SAMPLE_GLSL("u_value", "false")}`,
    // The band is a layer of the array; see `texture-sampling.ts` for why the
    // interpolation is manual.
    fsColor: `  {
${BILINEAR_TAPS_GLSL("u_value")}
    bool invalid = false;
    float raw = u_value_sample(u_value_band, i00, i11, f, invalid);
    valid = invalid ? 0.0 : 1.0;
    value = raw * u_value_scale + u_value_offset;
    color = vec4(value, 0.0, 0.0, valid);
  }`,
    getUniforms: (props) => {
      if (!Number.isInteger(props.band) || props.band < 0) {
        throw new RangeError(
          `band must be a non-negative integer, got ${props.band}`,
        );
      }
      const halo = props.halo ?? 0;
      if (halo !== 0 && halo !== 1) {
        throw new RangeError(`halo must be 0 or 1, got ${halo}`);
      }
      return {
        textures: { u_value_texture: props.texture },
        uniforms: {
          u_value_band: props.band,
          u_value_has_nodata: props.nodata === null ? 0 : 1,
          u_value_nodata: props.nodata ?? 0,
          u_value_scale: props.scale ?? 1,
          u_value_offset: props.offset ?? 0,
          u_value_size: props.size,
          u_value_halo: halo,
        },
      };
    },
  };
}

/** Seeds `value`/`valid` from one layer of a band array texture; one variant per sampler kind. */
export const ValueTexture: Record<
  ValueSamplerKind,
  RasterShaderModule<ValueTextureProps>
> = {
  float: valueTextureModule("float"),
  uint: valueTextureModule("uint"),
  int: valueTextureModule("int"),
};

/** Thresholds packed for the `float u_thresholds[MAX_THRESHOLDS]` uniform. */
export interface PackedThresholds {
  /** Length `MAX_THRESHOLDS`, first `count` entries used. */
  values: Float32Array;
  count: number;
}

/**
 * Validate and pack thresholds once per layer, so per-tile `getUniforms`
 * calls hand the same array to the GPU without re-allocating.
 */
export function packThresholds(
  thresholds: readonly number[],
): PackedThresholds {
  validateThresholds(thresholds);
  if (thresholds.length > MAX_THRESHOLDS) {
    throw new RangeError(
      `${thresholds.length} thresholds exceed MAX_THRESHOLDS (${MAX_THRESHOLDS})`,
    );
  }
  const values = new Float32Array(MAX_THRESHOLDS);
  values.set(thresholds);
  return { values, count: thresholds.length };
}

const THRESHOLD_DECLS = {
  key: "contour-thresholds",
  glsl: `#define MAX_THRESHOLDS ${MAX_THRESHOLDS}
uniform float u_thresholds[MAX_THRESHOLDS];
uniform int u_threshold_count;`,
};

function thresholdUniforms(packed: PackedThresholds): {
  u_thresholds: Float32Array;
  u_threshold_count: number;
} {
  return { u_thresholds: packed.values, u_threshold_count: packed.count };
}

export interface IsobandProps {
  thresholds: PackedThresholds;
  includeLower: boolean;
  includeUpper: boolean;
  /** `n × 1` RGBA8 texture, one texel per emitted band, NEAREST. */
  colors: TextureBinding;
}

/**
 * Filled contour bands: classify `value` against the thresholds and look the
 * band's colour up. Invalid pixels and switched-off open bands become
 * transparent rather than discarded: a following {@link ContourLine} can
 * still draw the boundary line over an open band, and `discard` would leave
 * `fwidth` undefined for the other fragments of the quad. For a layer that
 * writes no depth, premultiplied transparent output is a no-op under
 * MapLibre's `(ONE, ONE_MINUS_SRC_ALPHA)` blend, exactly like discard.
 */
export const Isoband: RasterShaderModule<IsobandProps> = {
  name: "isoband",
  fsSharedDecl: THRESHOLD_DECLS,
  fsDecl: `uniform int u_include_lower;
uniform int u_include_upper;
uniform sampler2D u_band_colors;`,
  fsColor: `  if (valid == 0.0) {
    color = vec4(0.0);
  } else {
    int k = 0;
    for (int i = 0; i < MAX_THRESHOLDS; i++) {
      if (i >= u_threshold_count) {
        break;
      }
      if (value >= u_thresholds[i]) {
        k = i + 1;
      }
    }
    if ((k == 0 && u_include_lower == 0) ||
        (k == u_threshold_count && u_include_upper == 0)) {
      color = vec4(0.0);
    } else {
      int idx = u_include_lower == 1 ? k : k - 1;
      color = texelFetch(u_band_colors, ivec2(idx, 0), 0);
    }
  }`,
  getUniforms: (props) => ({
    textures: { u_band_colors: props.colors },
    uniforms: {
      ...thresholdUniforms(props.thresholds),
      u_include_lower: props.includeLower ? 1 : 0,
      u_include_upper: props.includeUpper ? 1 : 0,
    },
  }),
};

export interface ContourLineProps {
  thresholds: PackedThresholds;
  /** Line width in screen pixels. */
  width: number;
  /** Straight-alpha RGBA in 0–1 (see `colorToVec4`), resolved once per layer. */
  color: Float32Array;
  /** Every k-th threshold (by index) is a major line. Omit for none. */
  majorEvery?: number;
  /** @default 2 × width */
  majorWidth?: number;
  /** @default color */
  majorColor?: Float32Array;
}

/**
 * Anti-aliased contour lines of constant screen width, composited over
 * whatever `color` holds (bands, or {@link ClearColor}'s transparent base).
 * Distance to the nearest threshold in pixels is `|value − t| / fwidth(value)`.
 */
export const ContourLine: RasterShaderModule<ContourLineProps> = {
  name: "contour-line",
  fsSharedDecl: THRESHOLD_DECLS,
  fsDecl: `uniform float u_line_width;
uniform vec4 u_line_color;
uniform int u_major_every;
uniform float u_major_width;
uniform vec4 u_major_color;`,
  // `fwidth` is evaluated in uniform control flow, before any branch.
  fsColor: `  float contourFw = fwidth(value);
  if (valid != 0.0 && contourFw > 0.0) {
    int nearest = -1;
    float best = 0.0;
    for (int i = 0; i < MAX_THRESHOLDS; i++) {
      if (i >= u_threshold_count) {
        break;
      }
      float d = abs(value - u_thresholds[i]);
      if (nearest < 0 || d < best) {
        best = d;
        nearest = i;
      }
    }
    if (nearest >= 0) {
      bool major = u_major_every > 0 && (nearest % u_major_every) == 0;
      float halfWidth = 0.5 * (major ? u_major_width : u_line_width);
      vec4 line = major ? u_major_color : u_line_color;
      float px = best / contourFw;
      float a = (1.0 - smoothstep(halfWidth - 0.5, halfWidth + 0.5, px)) * line.a;
      // Straight-alpha "over": the line on top of the current colour.
      float outA = a + color.a * (1.0 - a);
      if (outA > 0.0) {
        color = vec4((line.rgb * a + color.rgb * color.a * (1.0 - a)) / outA, outA);
      }
    }
  }`,
  getUniforms: (props) => ({
    uniforms: {
      ...thresholdUniforms(props.thresholds),
      u_line_width: props.width,
      u_line_color: props.color,
      u_major_every: props.majorEvery ?? 0,
      u_major_width: props.majorWidth ?? 2 * props.width,
      u_major_color: props.majorColor ?? props.color,
    },
  }),
};

export interface ValueGradientProps {
  /** `value` painted with the ramp's first colour. */
  min: number;
  /** `value` painted with the ramp's last colour; must exceed `min`. */
  max: number;
  /**
   * Paint values below `min` with the first colour rather than leaving them
   * transparent — the gradient's reading of the open lower band.
   */
  includeLower: boolean;
  /** Paint values at or above `max` with the last colour. */
  includeUpper: boolean;
  /** `n × 1` RGBA8 ramp, LINEAR, CLAMP_TO_EDGE. */
  colors: TextureBinding;
}

/**
 * Continuous colour ramp over `value` — the "raw raster" rendering of a
 * scalar band. Maps `[min, max]` onto the ramp texture, clamped at the ends;
 * outside that range the pixel is painted with the end colour or left
 * transparent according to `includeLower`/`includeUpper`, mirroring
 * {@link Isoband}'s open bands so a following {@link ContourLine} still
 * draws there. Never discards, for the same `fwidth` reason as `Isoband`.
 */
export const ValueGradient: RasterShaderModule<ValueGradientProps> = {
  name: "value-gradient",
  fsDecl: `uniform float u_gradient_min;
uniform float u_gradient_max;
uniform int u_gradient_include_lower;
uniform int u_gradient_include_upper;
uniform sampler2D u_gradient_colors;`,
  fsColor: `  if (valid == 0.0 ||
      (value < u_gradient_min && u_gradient_include_lower == 0) ||
      (value >= u_gradient_max && u_gradient_include_upper == 0)) {
    color = vec4(0.0);
  } else {
    float t = clamp((value - u_gradient_min) / (u_gradient_max - u_gradient_min), 0.0, 1.0);
    color = texture(u_gradient_colors, vec2(t, 0.5));
  }`,
  getUniforms: (props) => {
    if (!(Number.isFinite(props.min) && Number.isFinite(props.max))) {
      throw new RangeError("gradient min and max must be finite");
    }
    if (props.max <= props.min) {
      throw new RangeError(
        `gradient max must exceed min, got [${props.min}, ${props.max}]`,
      );
    }
    return {
      textures: { u_gradient_colors: props.colors },
      uniforms: {
        u_gradient_min: props.min,
        u_gradient_max: props.max,
        u_gradient_include_lower: props.includeLower ? 1 : 0,
        u_gradient_include_upper: props.includeUpper ? 1 : 0,
      },
    };
  },
};

/** A transparent base, for lines without a fill. */
export const ClearColor: RasterShaderModule = {
  name: "clear-color",
  fsColor: "  color = vec4(0.0);",
};
