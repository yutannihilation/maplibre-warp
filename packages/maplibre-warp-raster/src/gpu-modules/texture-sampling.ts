/**
 * GLSL shared by the seeds that read a band array texture: sampler types and
 * the manual bilinear tap around `uv`.
 *
 * Integer textures cannot be LINEAR-filtered and float textures need an
 * extension for it, so every seed interpolates by hand with `texelFetch`.
 * That also keeps nodata exact: a tap that is NaN or equals the sentinel
 * invalidates the pixel instead of bleeding into it.
 */

/** Sampler kinds a band texture can be declared with. */
export type ValueSamplerKind = "float" | "uint" | "int";

/**
 * GLSL sampler type per kind, for a 2D array texture. Array samplers have no
 * default precision in GLSL ES 3.00, so every seed declares one.
 */
export const ARRAY_SAMPLER_TYPE: Record<ValueSamplerKind, string> = {
  float: "sampler2DArray",
  uint: "usampler2DArray",
  int: "isampler2DArray",
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
 * A GLSL function `${prefix}_sample(layer, i00, i11, f, out invalid, out
 * gradient)` that reads one layer of `${prefix}_texture` at the taps from
 * {@link BILINEAR_TAPS_GLSL} and mixes them, or — when the `nearest` GLSL
 * expression holds — fetches the nearest texel alone, so a class next to
 * nodata keeps its edge. `invalid` is set for a NaN tap or one equal to
 * `${prefix}_nodata` when `${prefix}_has_nodata` is 1.
 *
 * `gradient` is the bilinear patch's own derivative at `f`, in raw units per
 * texel, from the same four taps (zero for a nearest fetch). It is exact per
 * pixel, which `dFdx`/`dFdy` of the interpolated value are not: those are
 * 2 × 2-quad finite differences of a piecewise bilinear field and jump at
 * every texel edge. A NaN tap yields a NaN gradient alongside `invalid`.
 */
export const BILINEAR_SAMPLE_GLSL = (
  prefix: string,
  nearest: string,
): string => `float ${prefix}_sample(int layer, ivec2 i00, ivec2 i11, vec2 f, out bool invalid, out vec2 gradient) {
  if (${nearest}) {
    ivec2 n = ivec2(f.x < 0.5 ? i00.x : i11.x, f.y < 0.5 ? i00.y : i11.y);
    float v = float(texelFetch(${prefix}_texture, ivec3(n, layer), 0).r);
    invalid = isnan(v) || (${prefix}_has_nodata == 1 && v == ${prefix}_nodata);
    gradient = vec2(0.0);
    return v;
  }
  float v00 = float(texelFetch(${prefix}_texture, ivec3(i00.x, i00.y, layer), 0).r);
  float v10 = float(texelFetch(${prefix}_texture, ivec3(i11.x, i00.y, layer), 0).r);
  float v01 = float(texelFetch(${prefix}_texture, ivec3(i00.x, i11.y, layer), 0).r);
  float v11 = float(texelFetch(${prefix}_texture, ivec3(i11.x, i11.y, layer), 0).r);
  // NaN is a common nodata marker in float rasters and never equals a
  // sentinel, so test it explicitly; a NaN texel would otherwise poison the
  // mix and every comparison downstream.
  invalid = isnan(v00) || isnan(v10) || isnan(v01) || isnan(v11);
  if (${prefix}_has_nodata == 1 &&
      (v00 == ${prefix}_nodata || v10 == ${prefix}_nodata ||
       v01 == ${prefix}_nodata || v11 == ${prefix}_nodata)) {
    invalid = true;
  }
  gradient = vec2(mix(v10 - v00, v11 - v01, f.y), mix(v01 - v00, v11 - v10, f.x));
  return mix(mix(v00, v10, f.x), mix(v01, v11, f.x), f.y);
}`;
