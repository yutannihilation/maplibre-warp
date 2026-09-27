/**
 * Imagery seed over a band array texture: pick up to four layers (bands) of a
 * `TEXTURE_2D_ARRAY` and compose them into `color`, in raw sample units.
 *
 * Every band of a raster is uploaded once, as its own layer, so which bands
 * make up the picture is a uniform rather than a texture layout: changing
 * the composite never reloads a tile.
 */

import type { RasterShaderModule, TextureBinding } from "../shader/module.js";
import type { ValueSamplerKind } from "./texture-sampling.js";
import {
  ARRAY_SAMPLER_TYPE,
  BILINEAR_SAMPLE_GLSL,
  BILINEAR_TAPS_GLSL,
} from "./texture-sampling.js";

export interface BandTextureProps {
  /** A `TEXTURE_2D_ARRAY` with one single-channel layer per band. */
  texture: TextureBinding;
  /**
   * Layer to read for each output channel `[r, g, b, a]`; `-1` leaves a
   * colour channel at 0 and alpha at 1. Built once per style; `getUniforms`
   * runs every frame.
   */
  channelMap: Int32Array;
  /** Sentinel that marks missing data, in raw texel units. */
  nodata: number | null;
  /**
   * What a mapped alpha layer is divided by to reach `[0, 1]`: the sample
   * type's maximum, or 1 for a normalised texture.
   */
  alphaMax: number;
  /**
   * Take the nearest texel instead of interpolating. Palette indices must
   * not be interpolated: a value between two classes is a third class.
   */
  nearest: boolean;
  /** Content size in texels as `[width, height]`, excluding any halo. */
  size: Float32Array;
  /** Texels of neighbour padding on every side: `0` or `1`. @default 0 */
  halo?: number;
}

function bandTextureModule(
  kind: ValueSamplerKind,
): RasterShaderModule<BandTextureProps> {
  const sampler = ARRAY_SAMPLER_TYPE[kind];
  return {
    name: `band-texture-${kind}`,
    fsDecl: `precision highp ${sampler};
uniform ${sampler} u_band_texture;
uniform ivec4 u_band_channels;
uniform int u_band_has_nodata;
uniform float u_band_nodata;
uniform float u_band_alpha_max;
uniform int u_band_nearest;
uniform vec2 u_band_size;
uniform int u_band_halo;

${BILINEAR_SAMPLE_GLSL("u_band", "u_band_nearest == 1")}`,
    // The taps are shared by every mapped layer. A pixel is nodata when any
    // colour band is (rio-tiler's rule); the alpha band is never a sentinel.
    fsColor: `  {
${BILINEAR_TAPS_GLSL("u_band")}
    bool invalid = false;
    bool bad = false;
    vec4 raw = vec4(0.0, 0.0, 0.0, 1.0);
    for (int c = 0; c < 3; c++) {
      int layer = u_band_channels[c];
      if (layer >= 0) {
        raw[c] = u_band_sample(layer, i00, i11, f, bad);
        invalid = invalid || bad;
      }
    }
    if (u_band_channels.a >= 0) {
      raw.a = u_band_sample(u_band_channels.a, i00, i11, f, bad) / u_band_alpha_max;
    }
    if (invalid) {
      discard;
    }
    color = raw;
  }`,
    getUniforms: (props) => {
      if (props.channelMap.length !== 4) {
        throw new RangeError(
          `channelMap needs four entries, got ${props.channelMap.length}`,
        );
      }
      const halo = props.halo ?? 0;
      if (halo !== 0 && halo !== 1) {
        throw new RangeError(`halo must be 0 or 1, got ${halo}`);
      }
      if (!(props.alphaMax > 0)) {
        throw new RangeError(
          `alphaMax must be positive, got ${props.alphaMax}`,
        );
      }
      return {
        textures: { u_band_texture: props.texture },
        uniforms: {
          u_band_channels: props.channelMap,
          u_band_has_nodata: props.nodata === null ? 0 : 1,
          u_band_nodata: props.nodata ?? 0,
          u_band_alpha_max: props.alphaMax,
          u_band_nearest: props.nearest ? 1 : 0,
          u_band_size: props.size,
          u_band_halo: halo,
        },
      };
    },
  };
}

/** Seeds `color` from up to four layers of a band array texture; one variant per sampler kind. */
export const BandTexture: Record<
  ValueSamplerKind,
  RasterShaderModule<BandTextureProps>
> = {
  float: bandTextureModule("float"),
  uint: bandTextureModule("uint"),
  int: bandTextureModule("int"),
};
