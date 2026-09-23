/**
 * Built-in shader modules.
 *
 * The GLSL bodies are ported from @developmentseed/deck.gl-raster (MIT,
 * Development Seed), `packages/deck.gl-raster/src/gpu-modules/*`. The wrappers
 * are rewritten for this package's {@link RasterShaderModule} contract:
 * snippets act on the in-scope `color` and `uv` instead of deck.gl's
 * `DECKGL_FILTER_COLOR(color, geometry)`, and uniforms are plain
 * `gl.uniform*` rather than uniform blocks.
 */

import type { RasterShaderModule, TextureBinding } from "../shader/module.js";

/** Props for {@link CreateTexture}. */
export interface CreateTextureProps {
  /** The input image texture to sample. */
  texture: TextureBinding;
}

/**
 * Seeds `color` from a single normalised (`*unorm`) input texture. The first
 * module of most pipelines.
 */
export const CreateTexture: RasterShaderModule<CreateTextureProps> = {
  name: "create-texture-unorm",
  fsDecl: "uniform sampler2D u_texture;",
  fsColor: "  color = texture(u_texture, uv);",
  getUniforms: (props) => ({ textures: { u_texture: props.texture } }),
};

/** Props for {@link FilterNoDataVal}. */
export interface FilterNoDataValProps {
  /**
   * The sentinel nodata value, in the same units as `color.r` after any
   * earlier pipeline modules. For a `*unorm` texture that means the raw nodata
   * value divided by the type's maximum.
   */
  value: number;
}

/**
 * Discards fragments whose red channel exactly equals the nodata value.
 *
 * Exact comparison means this only works on values that survive sampling
 * unchanged. With linear filtering, texels near a nodata boundary interpolate
 * to something that is no longer equal to the sentinel, leaving a one-texel
 * halo of blended data around nodata regions. Nearest filtering, or a separate
 * mask texture, avoids that.
 */
export const FilterNoDataVal: RasterShaderModule<FilterNoDataValProps> = {
  name: "filter-nodata",
  fsDecl: "uniform float u_nodata_value;",
  fsColor: `  if (color.r == u_nodata_value) {
    discard;
  }`,
  getUniforms: (props) => ({ uniforms: { u_nodata_value: props.value } }),
};

/** Props for {@link MaskTexture}. */
export interface MaskTextureProps {
  /** Single-channel mask texture; pixels reading 0 are discarded. */
  mask: TextureBinding;
}

/**
 * Discards fragments where a separate single-channel mask texture reads zero —
 * the GeoTIFF transparency mask stored as a sibling IFD.
 *
 * Compares directly against 0.0, so the mask must be sampled with nearest
 * filtering or interpolated edge values will leak through.
 */
export const MaskTexture: RasterShaderModule<MaskTextureProps> = {
  name: "mask-texture",
  fsDecl: "uniform sampler2D u_mask_texture;",
  fsColor: `  if (texture(u_mask_texture, uv).r == 0.0) {
    discard;
  }`,
  getUniforms: (props) => ({ textures: { u_mask_texture: props.mask } }),
};

/**
 * Single-band grayscale where 0 is black: broadcast the value into RGB.
 * TIFF `PhotometricInterpretation = 1` (MinIsBlack).
 */
export const BlackIsZero: RasterShaderModule = {
  name: "black-is-zero",
  fsColor: "  color = vec4(vec3(color.r), 1.0);",
};

/**
 * Single-band grayscale where 0 is white: broadcast the inverted value.
 * TIFF `PhotometricInterpretation = 0` (MinIsWhite).
 */
export const WhiteIsZero: RasterShaderModule = {
  name: "white-is-zero",
  fsColor: "  color = vec4(vec3(1.0 - color.r), 1.0);",
};

/**
 * CMYK (RGBA channels read as C, M, Y, K) to RGB.
 * TIFF `PhotometricInterpretation = 5` (Separated).
 */
export const CMYKToRGB: RasterShaderModule = {
  name: "cmyk-to-rgb",
  fsDecl: `vec3 cmykToRgb(vec4 cmyk) {
  // cmyk in [0.0, 1.0]
  float invK = 1.0 - cmyk.a;

  return vec3(
      (1.0 - cmyk.r) * invK,
      (1.0 - cmyk.g) * invK,
      (1.0 - cmyk.b) * invK
  );
}`,
  fsColor: "  color = vec4(cmykToRgb(color), 1.0);",
};

/**
 * CIE L\*a\*b\* (RGB channels read as L, a, b on a D65 white point) to sRGB.
 * TIFF `PhotometricInterpretation = 8` (CIELab).
 */
export const CieLabToRGB: RasterShaderModule = {
  name: "cielab-to-rgb",
  fsDecl: `const vec3 D65 = vec3(
    0.95047, // Xn
    1.00000, // Yn
    1.08883 // Zn
);

vec3 cielabToRgb(vec3 labTex) {
  // labTex in [0,1] from RGB8 texture
  float L = labTex.r * 255.0;
  float a = (labTex.g - 0.5) * 255.0;
  float b = (labTex.b - 0.5) * 255.0;

  float y = (L + 16.0) / 116.0;
  float x = (a / 500.0) + y;
  float z = y - (b / 200.0);

  vec3 xyz;
  vec3 v = vec3(x, y, z);
  vec3 v3 = v * v * v;

  xyz = D65 * mix(
    (v - 16.0 / 116.0) / 7.787,
    v3,
    step(0.008856, v3)
  );

  vec3 rgb = mat3(
    3.2406, -1.5372, -0.4986,
    -0.9689, 1.8758, 0.0415,
    0.0557, -0.2040, 1.0570
  ) * xyz;

  // sRGB gamma
  rgb = mix(
    12.92 * rgb,
    1.055 * pow(rgb, vec3(1.0 / 2.4)) - 0.055,
    step(0.0031308, rgb)
  );

  return clamp(rgb, 0.0, 1.0);
}`,
  fsColor: "  color = vec4(cielabToRgb(color.rgb), 1.0);",
};

/** Props for {@link LinearRescale}. */
export interface LinearRescaleProps {
  /** Per-channel input values mapping to 0, as `[r, g, b]`. */
  min: Float32Array;
  /** Per-channel input values mapping to 1, as `[r, g, b]`. */
  max: Float32Array;
}

/**
 * Linearly rescale each colour channel from `[min, max]` to `[0, 1]`,
 * clamping outside. Alpha is left alone.
 */
export const LinearRescale: RasterShaderModule<LinearRescaleProps> = {
  name: "linear-rescale",
  fsDecl: `uniform vec3 u_rescale_min;
uniform vec3 u_rescale_max;`,
  fsColor:
    "  color.rgb = clamp((color.rgb - u_rescale_min) / (u_rescale_max - u_rescale_min), 0.0, 1.0);",
  getUniforms: (props) => {
    if (props.min.length !== 3 || props.max.length !== 3) {
      throw new RangeError("rescale min and max need three entries each");
    }
    return { uniforms: { u_rescale_min: props.min, u_rescale_max: props.max } };
  },
};

/** Props for {@link Colormap}. */
export interface ColormapProps {
  /**
   * The colormap sprite as a 2D array texture: each layer is one 256×1 RGBA8
   * colormap.
   */
  colormap: TextureBinding;
  /** Which layer of the sprite to sample. @default 0 */
  colormapIndex?: number;
  /** Sample the colormap in reverse (matplotlib's `_r`). @default false */
  reversed?: boolean;
}

/** Look `color.r` up in one layer of a 2D-array colormap texture. */
export const Colormap: RasterShaderModule<ColormapProps> = {
  name: "colormap",
  fsDecl: `precision highp sampler2DArray;
uniform sampler2DArray u_colormap_texture;
uniform int u_colormap_index;
uniform float u_colormap_reversed;`,
  fsColor: `  float colormapIdx = mix(color.r, 1.0 - color.r, u_colormap_reversed);
  color = texture(
    u_colormap_texture,
    vec3(colormapIdx, 0.5, float(u_colormap_index))
  );`,
  getUniforms: (props) => ({
    textures: { u_colormap_texture: props.colormap },
    uniforms: {
      u_colormap_index: props.colormapIndex ?? 0,
      u_colormap_reversed: props.reversed ? 1 : 0,
    },
  }),
};

export type { BandTextureProps } from "./band-texture.js";
export { BandTexture } from "./band-texture.js";
export type {
  ContourLineProps,
  IsobandProps,
  PackedThresholds,
  ValueGradientProps,
  ValueSamplerKind,
  ValueTextureProps,
} from "./contour.js";
export {
  ARRAY_SAMPLER_TYPE,
  ClearColor,
  ContourLine,
  Isoband,
  MAX_THRESHOLDS,
  packThresholds,
  ValueGradient,
  ValueTexture,
} from "./contour.js";
export type {
  BandColorFunction,
  BandColorImage,
  BandColors,
  BandOptions,
  ContourBand,
  Rgba,
} from "./contour-bands.js";
export {
  bandColorImage,
  bandsFromThresholds,
  colorToVec4,
  GRADIENT_FUNCTION_STOPS,
  GRADIENT_IMAGE_WIDTH,
  gradientColorImage,
  parseCssColor,
  resolveBandColors,
  resolveGradientStops,
  validateThresholds,
} from "./contour-bands.js";
