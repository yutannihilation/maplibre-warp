/**
 * GLSL shared by the seeds that read a raster texture by hand: sampler types
 * and the manual bilinear tap around `uv`.
 *
 * Integer textures cannot be LINEAR-filtered and float textures need an
 * extension for it, so every seed interpolates by hand with `texelFetch`.
 * That also keeps nodata exact: a tap that is NaN or equals the sentinel
 * invalidates the pixel instead of bleeding into it.
 */

/** Sampler kinds a value texture can be declared with. */
export type ValueSamplerKind = "float" | "uint" | "int";

/** GLSL sampler type per kind, for a 2D texture. */
export const SAMPLER_TYPE: Record<ValueSamplerKind, string> = {
  float: "sampler2D",
  uint: "usampler2D",
  int: "isampler2D",
};

/**
 * Tap positions around `uv` for a seed whose uniforms are `${prefix}_size`
 * and `${prefix}_halo`: `i00`/`i11` are the texel corners and `f` the
 * fraction between them. `uv` maps onto the content; the halo shifts texel
 * indices into the padded texture, so the outer half texel of the content
 * interpolates towards the neighbouring tile's edge rather than clamping to
 * its own.
 */
export const BILINEAR_TAPS_GLSL = (
  prefix: string,
): string => `    vec2 p = uv * ${prefix}_size - 0.5 + float(${prefix}_halo);
    vec2 p0 = floor(p);
    vec2 f = p - p0;
    ivec2 maxTexel = ivec2(${prefix}_size) + 2 * ${prefix}_halo - 1;
    ivec2 i00 = clamp(ivec2(p0), ivec2(0), maxTexel);
    ivec2 i11 = clamp(ivec2(p0) + 1, ivec2(0), maxTexel);`;

/**
 * A GLSL function `${prefix}_sample(channel, i00, i11, f, out invalid)` that
 * reads one channel of `${prefix}_texture` at the taps from
 * {@link BILINEAR_TAPS_GLSL} and mixes them. `invalid` is set for a NaN tap
 * or one equal to `${prefix}_nodata` when `${prefix}_has_nodata` is 1.
 */
export const BILINEAR_SAMPLE_GLSL = (
  prefix: string,
): string => `float ${prefix}_sample(int channel, ivec2 i00, ivec2 i11, vec2 f, out bool invalid) {
  float v00 = float(texelFetch(${prefix}_texture, ivec2(i00.x, i00.y), 0)[channel]);
  float v10 = float(texelFetch(${prefix}_texture, ivec2(i11.x, i00.y), 0)[channel]);
  float v01 = float(texelFetch(${prefix}_texture, ivec2(i00.x, i11.y), 0)[channel]);
  float v11 = float(texelFetch(${prefix}_texture, ivec2(i11.x, i11.y), 0)[channel]);
  // NaN is a common nodata marker in float rasters and never equals a
  // sentinel, so test it explicitly; a NaN texel would otherwise poison the
  // mix and every comparison downstream.
  invalid = isnan(v00) || isnan(v10) || isnan(v01) || isnan(v11);
  if (${prefix}_has_nodata == 1 &&
      (v00 == ${prefix}_nodata || v10 == ${prefix}_nodata ||
       v01 == ${prefix}_nodata || v11 == ${prefix}_nodata)) {
    invalid = true;
  }
  return mix(mix(v00, v10, f.x), mix(v01, v11, f.x), f.y);
}`;
