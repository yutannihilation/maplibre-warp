/**
 * Contour shader modules: a scalar seed, filled bands, lines.
 *
 * All three work on the `value`/`valid` variables `buildFragmentSource`
 * declares in `main()`, so bands can recolour `color` while lines still see
 * the underlying sample.
 */

import type { RasterShaderModule, TextureBinding } from "../shader/module.js";
import { validateThresholds } from "./contour-bands.js";

/** Size of the threshold uniform array, and so the most levels per layer. */
export const MAX_THRESHOLDS = 64;

/** Sampler kinds a value texture can be declared with. */
export type ValueSamplerKind = "float" | "uint" | "int";

export interface ValueTextureProps {
  texture: TextureBinding;
  /** Channel to read, 0–3. */
  band: number;
  /** Sentinel that marks missing data, in raw texel units. */
  nodata: number | null;
  /** `value = raw · scale + offset`. @default 1 */
  scale?: number;
  /** @default 0 */
  offset?: number;
  /**
   * Texture size in texels as `[width, height]`, for manual bilinear
   * interpolation. Built once per tile; `getUniforms` runs every frame.
   */
  size: Float32Array;
}

const SAMPLER_TYPE: Record<ValueSamplerKind, string> = {
  float: "sampler2D",
  uint: "usampler2D",
  int: "isampler2D",
};

function valueTextureModule(
  kind: ValueSamplerKind,
): RasterShaderModule<ValueTextureProps> {
  const sampler = SAMPLER_TYPE[kind];
  // Integer samplers have no default precision in GLSL ES 3.00.
  const precision = kind === "float" ? "" : `precision highp ${sampler};\n`;
  return {
    name: `value-texture-${kind}`,
    fsDecl: `${precision}uniform ${sampler} u_value_texture;
uniform int u_value_band;
uniform int u_value_has_nodata;
uniform float u_value_nodata;
uniform float u_value_scale;
uniform float u_value_offset;
uniform vec2 u_value_size;`,
    // Manual bilinear interpolation between the four texel centres around
    // `uv`, so integer textures (which cannot be LINEAR-filtered) and float
    // textures without OES_texture_float_linear behave alike, and nodata is
    // exact: any contributing nodata or NaN texel invalidates the pixel
    // instead of bleeding into it.
    fsColor: `  {
    vec2 p = uv * u_value_size - 0.5;
    vec2 p0 = floor(p);
    vec2 f = p - p0;
    ivec2 maxTexel = ivec2(u_value_size) - 1;
    ivec2 i00 = clamp(ivec2(p0), ivec2(0), maxTexel);
    ivec2 i11 = clamp(ivec2(p0) + 1, ivec2(0), maxTexel);
    float v00 = float(texelFetch(u_value_texture, ivec2(i00.x, i00.y), 0)[u_value_band]);
    float v10 = float(texelFetch(u_value_texture, ivec2(i11.x, i00.y), 0)[u_value_band]);
    float v01 = float(texelFetch(u_value_texture, ivec2(i00.x, i11.y), 0)[u_value_band]);
    float v11 = float(texelFetch(u_value_texture, ivec2(i11.x, i11.y), 0)[u_value_band]);
    // NaN is a common nodata marker in float rasters and never equals a
    // sentinel, so test it explicitly; a NaN texel would otherwise poison the
    // mix and every comparison downstream.
    valid = 1.0;
    if (isnan(v00) || isnan(v10) || isnan(v01) || isnan(v11)) {
      valid = 0.0;
    }
    if (u_value_has_nodata == 1 &&
        (v00 == u_value_nodata || v10 == u_value_nodata ||
         v01 == u_value_nodata || v11 == u_value_nodata)) {
      valid = 0.0;
    }
    float raw = mix(mix(v00, v10, f.x), mix(v01, v11, f.x), f.y);
    value = raw * u_value_scale + u_value_offset;
    color = vec4(value, 0.0, 0.0, valid);
  }`,
    getUniforms: (props) => {
      if (!Number.isInteger(props.band) || props.band < 0 || props.band > 3) {
        throw new RangeError(`band must be 0–3, got ${props.band}`);
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
        },
      };
    },
  };
}

/** Seeds `value`/`valid` from a single-value texture; one variant per sampler kind. */
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

/** A transparent base, for lines without bands. */
export const ClearColor: RasterShaderModule = {
  name: "clear-color",
  fsColor: "  color = vec4(0.0);",
};
