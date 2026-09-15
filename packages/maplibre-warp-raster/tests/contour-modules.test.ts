import { describe, expect, it } from "vitest";

import {
  ClearColor,
  ContourLine,
  colorToVec4,
  Isoband,
  MAX_THRESHOLDS,
  packThresholds,
  ValueGradient,
  ValueTexture,
} from "../src/gpu-modules/index.js";
import { pipelineKey } from "../src/shader/module.js";
import { buildFragmentSource } from "../src/shader/sources.js";

const texture = { texture: {} as WebGLTexture, target: 0x0de1 };

describe("ValueTexture", () => {
  it("declares the sampler kind it was built for and interpolates manually", () => {
    for (const [kind, sampler] of [
      ["float", "sampler2D"],
      ["uint", "usampler2D"],
      ["int", "isampler2D"],
    ] as const) {
      const module = ValueTexture[kind];
      expect(module.name).toContain(kind);
      expect(module.fsDecl).toContain(`${sampler} u_value_texture`);
      expect(module.fsColor).toContain("texelFetch");
      expect(module.fsColor).toContain("value =");
    }
  });

  it("treats non-finite texels as missing, not only the sentinel", () => {
    for (const kind of ["float", "uint", "int"] as const) {
      const body = ValueTexture[kind].fsColor!;
      // Every contributing texel is checked with isnan before it can reach
      // the bilinear mix, since NaN is a common nodata marker in float DEMs.
      expect(body.match(/isnan\(v(00|10|01|11)\)/g)).toHaveLength(4);
    }
  });

  it("maps props to uniforms", () => {
    const size = new Float32Array([512, 256]);
    const bindings = ValueTexture.float.getUniforms!({
      texture,
      band: 2,
      nodata: -9999,
      scale: 0.1,
      offset: 5,
      size,
    });
    expect(bindings.textures).toEqual({ u_value_texture: texture });
    expect(bindings.uniforms).toEqual({
      u_value_band: 2,
      u_value_has_nodata: 1,
      u_value_nodata: -9999,
      u_value_scale: 0.1,
      u_value_offset: 5,
      u_value_size: size,
      u_value_halo: 0,
    });
    expect(
      ValueTexture.float.getUniforms!({
        texture,
        band: 0,
        nodata: null,
        size: new Float32Array([1, 1]),
      }).uniforms,
    ).toMatchObject({
      u_value_has_nodata: 0,
      u_value_scale: 1,
      u_value_offset: 0,
    });
  });

  it("offsets texel lookups into the halo", () => {
    for (const kind of ["float", "uint", "int"] as const) {
      const body = ValueTexture[kind].fsColor!;
      expect(body).toContain("- 0.5 + float(u_value_halo)");
      expect(body).toContain("ivec2(u_value_size) + 2 * u_value_halo - 1");
    }
    expect(
      ValueTexture.float.getUniforms!({
        texture,
        band: 0,
        nodata: null,
        size: new Float32Array([4, 4]),
        halo: 1,
      }).uniforms,
    ).toMatchObject({ u_value_halo: 1 });
    expect(() =>
      ValueTexture.float.getUniforms!({
        texture,
        band: 0,
        nodata: null,
        size: new Float32Array([4, 4]),
        halo: -1,
      }),
    ).toThrow(RangeError);
  });

  it("rejects bands outside 0..3", () => {
    expect(() =>
      ValueTexture.int.getUniforms!({
        texture,
        band: 4,
        nodata: null,
        size: new Float32Array([1, 1]),
      }),
    ).toThrow(RangeError);
  });
});

describe("packThresholds", () => {
  it("pads to MAX_THRESHOLDS and records the count", () => {
    const packed = packThresholds([100, 200, 300]);
    expect(packed.values.length).toBe(MAX_THRESHOLDS);
    expect(Array.from(packed.values.subarray(0, 3))).toEqual([100, 200, 300]);
    expect(packed.count).toBe(3);
  });

  it("rejects more than MAX_THRESHOLDS levels and invalid lists", () => {
    expect(() =>
      packThresholds(Array.from({ length: MAX_THRESHOLDS + 1 }, (_, i) => i)),
    ).toThrow(RangeError);
    expect(() => packThresholds([2, 1])).toThrow(RangeError);
  });
});

describe("Isoband", () => {
  const props = {
    thresholds: packThresholds([100, 200, 300]),
    includeLower: true,
    includeUpper: false,
    colors: texture,
  };

  it("passes the packed thresholds through without re-allocating", () => {
    const bindings = Isoband.getUniforms!(props);
    expect(bindings.uniforms!.u_thresholds).toBe(props.thresholds.values);
    expect(bindings.uniforms).toMatchObject({
      u_threshold_count: 3,
      u_include_lower: 1,
      u_include_upper: 0,
    });
    expect(bindings.textures).toEqual({ u_band_colors: texture });
  });

  it("reads `value`, blanks invalid pixels without discarding, and looks the band up", () => {
    expect(Isoband.fsColor).toContain("value");
    // `discard` would leave derivatives undefined for ContourLine's fwidth in
    // the same quad; a transparent colour is equivalent for a depth-less layer.
    expect(Isoband.fsColor).not.toContain("discard");
    expect(Isoband.fsColor).toContain("texelFetch(u_band_colors");
  });
});

describe("ValueGradient", () => {
  const props = {
    min: 100,
    max: 300,
    includeLower: false,
    includeUpper: true,
    colors: texture,
  };

  it("maps props to uniforms", () => {
    const bindings = ValueGradient.getUniforms!(props);
    expect(bindings.uniforms).toEqual({
      u_gradient_min: 100,
      u_gradient_max: 300,
      u_gradient_include_lower: 0,
      u_gradient_include_upper: 1,
    });
    expect(bindings.textures).toEqual({ u_gradient_colors: texture });
  });

  it("rejects an empty or inverted domain", () => {
    expect(() => ValueGradient.getUniforms!({ ...props, max: 100 })).toThrow(
      RangeError,
    );
    expect(() => ValueGradient.getUniforms!({ ...props, max: NaN })).toThrow(
      RangeError,
    );
  });

  it("samples the ramp by normalised value and never discards", () => {
    expect(ValueGradient.fsColor).toContain("texture(u_gradient_colors");
    expect(ValueGradient.fsColor).toContain("clamp(");
    expect(ValueGradient.fsColor).not.toContain("discard");
  });
});

describe("ContourLine", () => {
  it("passes precomputed colours and thresholds through", () => {
    const thresholds = packThresholds([10, 20]);
    const lineColor = colorToVec4("#ff0000");
    const majorColor = colorToVec4("rgba(0, 0, 255, 0.5)");
    const bindings = ContourLine.getUniforms!({
      thresholds,
      width: 1,
      color: lineColor,
      majorEvery: 2,
      majorWidth: 2,
      majorColor,
    });
    expect(bindings.uniforms!.u_thresholds).toBe(thresholds.values);
    expect(bindings.uniforms!.u_line_color).toBe(lineColor);
    expect(bindings.uniforms!.u_major_color).toBe(majorColor);
    expect(bindings.uniforms).toMatchObject({
      u_threshold_count: 2,
      u_line_width: 1,
      u_major_every: 2,
      u_major_width: 2,
    });
    expect(Array.from(majorColor)).toEqual(
      Array.from(Float32Array.from([0, 0, 1, 128 / 255])),
    );
  });

  it("uses screen-space derivatives for constant pixel width", () => {
    expect(ContourLine.fsColor).toContain("fwidth(value)");
    expect(ContourLine.fsColor).toContain("smoothstep");
  });
});

describe("fragment assembly with contour modules", () => {
  it("declares the shared thresholds once when both modules are present", () => {
    const pipeline = [
      { module: ValueTexture.float },
      { module: Isoband },
      { module: ContourLine },
    ];
    const source = buildFragmentSource(pipeline);
    expect(source).toContain("float value = 0.0;");
    expect(source.match(/uniform float u_thresholds\[/g)).toHaveLength(1);
    expect(source).toContain(`#define MAX_THRESHOLDS ${MAX_THRESHOLDS}`);
    expect(pipelineKey("mercator", pipeline)).toBe(
      "mercator|value-texture-float,isoband,contour-line",
    );
  });

  it("keys a gradient chain apart from a band chain", () => {
    const pipeline = [
      { module: ValueTexture.float },
      { module: ValueGradient },
      { module: ContourLine },
    ];
    expect(pipelineKey("mercator", pipeline)).toBe(
      "mercator|value-texture-float,value-gradient,contour-line",
    );
    const source = buildFragmentSource(pipeline);
    expect(source).toContain("uniform sampler2D u_gradient_colors;");
    expect(source.match(/uniform float u_thresholds\[/g)).toHaveLength(1);
  });

  it("supports a lines-only chain over a transparent base", () => {
    const source = buildFragmentSource([
      { module: ValueTexture.int },
      { module: ClearColor },
      { module: ContourLine },
    ]);
    expect(source).toContain("color = vec4(0.0);");
    expect(source.match(/uniform float u_thresholds\[/g)).toHaveLength(1);
  });
});
