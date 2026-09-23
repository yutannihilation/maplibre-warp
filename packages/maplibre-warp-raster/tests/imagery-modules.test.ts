import { describe, expect, it } from "vitest";

import {
  BandTexture,
  BlackIsZero,
  LinearRescale,
} from "../src/gpu-modules/index.js";
import { pipelineKey } from "../src/shader/module.js";
import { buildFragmentSource } from "../src/shader/sources.js";

const texture = { texture: {} as WebGLTexture, target: 0x8c1a };

describe("BandTexture", () => {
  const props = {
    texture,
    channelMap: Int32Array.from([4, 2, 1, -1]),
    nodata: 0,
    alphaMax: 65535,
    nearest: false,
    size: new Float32Array([512, 256]),
    halo: 1,
  };

  it("declares an array sampler per kind and fetches layers", () => {
    for (const [kind, sampler] of [
      ["float", "sampler2DArray"],
      ["uint", "usampler2DArray"],
      ["int", "isampler2DArray"],
    ] as const) {
      const module = BandTexture[kind];
      expect(module.name).toBe(`band-texture-${kind}`);
      expect(module.fsDecl).toContain(`precision highp ${sampler};`);
      expect(module.fsDecl).toContain(`${sampler} u_band_texture`);
      expect(module.fsDecl).toContain("ivec3(i00.x, i00.y, layer)");
      expect(module.fsColor).toContain("color = raw;");
    }
  });

  it("discards on nodata or NaN in a colour band, never for alpha", () => {
    const decl = BandTexture.uint.fsDecl!;
    const body = BandTexture.uint.fsColor!;
    expect(decl.match(/isnan\(v(00|10|01|11)\)/g)).toHaveLength(4);
    expect(decl).toContain("v == u_band_nodata");
    expect(body).toContain("discard");
    // The alpha sample's `bad` flag is not folded into `invalid`.
    expect(body).toMatch(
      /raw\.a = u_band_sample\([^;]*\) \/ u_band_alpha_max;/,
    );
    // Palette mode fetches the one nearest texel, not four.
    expect(decl).toContain("if (u_band_nearest == 1)");
    expect(body).not.toMatch(/raw\.a[^\n]*\n\s*invalid = invalid \|\| bad/);
  });

  it("maps props to uniforms", () => {
    const bindings = BandTexture.uint.getUniforms!(props);
    expect(bindings.textures).toEqual({ u_band_texture: texture });
    expect(bindings.uniforms).toEqual({
      u_band_channels: props.channelMap,
      u_band_has_nodata: 1,
      u_band_nodata: 0,
      u_band_alpha_max: 65535,
      u_band_nearest: 0,
      u_band_size: props.size,
      u_band_halo: 1,
    });
    expect(
      BandTexture.float.getUniforms!({
        ...props,
        nodata: null,
        nearest: true,
        halo: undefined,
      }).uniforms,
    ).toMatchObject({
      u_band_has_nodata: 0,
      u_band_nearest: 1,
      u_band_halo: 0,
    });
  });

  it("rejects malformed props", () => {
    expect(() =>
      BandTexture.int.getUniforms!({
        ...props,
        channelMap: Int32Array.from([0, 1, 2]),
      }),
    ).toThrow(RangeError);
    expect(() => BandTexture.int.getUniforms!({ ...props, halo: 2 })).toThrow(
      RangeError,
    );
    expect(() =>
      BandTexture.int.getUniforms!({ ...props, alphaMax: 0 }),
    ).toThrow(RangeError);
  });
});

describe("LinearRescale", () => {
  it("rescales each colour channel with its own range", () => {
    const min = new Float32Array([300, 400, 300]);
    const max = new Float32Array([1500, 1200, 800]);
    const bindings = LinearRescale.getUniforms!({ min, max });
    expect(bindings.uniforms!.u_rescale_min).toBe(min);
    expect(bindings.uniforms!.u_rescale_max).toBe(max);
    expect(LinearRescale.fsDecl).toContain("uniform vec3 u_rescale_min;");
    expect(LinearRescale.fsColor).toContain("color.rgb = clamp(");
    expect(() =>
      LinearRescale.getUniforms!({ min: new Float32Array(1), max }),
    ).toThrow(RangeError);
  });
});

describe("fragment assembly with imagery modules", () => {
  it("assembles a typed composite chain", () => {
    const pipeline = [
      { module: BandTexture.uint },
      { module: LinearRescale },
      { module: BlackIsZero },
    ];
    const source = buildFragmentSource(pipeline);
    expect(source).toContain("uniform usampler2DArray u_band_texture;");
    expect(source).toContain("uniform vec3 u_rescale_min;");
    expect(pipelineKey("globe", pipeline)).toBe(
      "globe|band-texture-uint,linear-rescale,black-is-zero",
    );
  });
});
