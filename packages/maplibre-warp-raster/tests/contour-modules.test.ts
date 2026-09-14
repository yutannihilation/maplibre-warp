import { describe, expect, it } from "vitest";

import {
  ClearColor,
  ContourLine,
  Isoband,
  MAX_THRESHOLDS,
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

  it("maps props to uniforms", () => {
    const bindings = ValueTexture.float.getUniforms!({
      texture,
      band: 2,
      nodata: -9999,
      scale: 0.1,
      offset: 5,
      width: 512,
      height: 256,
    });
    expect(bindings.textures).toEqual({ u_value_texture: texture });
    expect(bindings.uniforms).toEqual({
      u_value_band: 2,
      u_value_has_nodata: 1,
      u_value_nodata: -9999,
      u_value_scale: 0.1,
      u_value_offset: 5,
      u_value_size: new Float32Array([512, 256]),
    });
    expect(
      ValueTexture.float.getUniforms!({
        texture,
        band: 0,
        nodata: null,
        width: 1,
        height: 1,
      }).uniforms,
    ).toMatchObject({
      u_value_has_nodata: 0,
      u_value_scale: 1,
      u_value_offset: 0,
    });
  });

  it("rejects bands outside 0..3", () => {
    expect(() =>
      ValueTexture.int.getUniforms!({
        texture,
        band: 4,
        nodata: null,
        width: 1,
        height: 1,
      }),
    ).toThrow(RangeError);
  });
});

describe("Isoband", () => {
  const props = {
    thresholds: [100, 200, 300],
    includeLower: true,
    includeUpper: false,
    colors: texture,
  };

  it("pads thresholds to MAX_THRESHOLDS and passes the flags", () => {
    const bindings = Isoband.getUniforms!(props);
    const thresholds = bindings.uniforms!.u_thresholds as Float32Array;
    expect(thresholds.length).toBe(MAX_THRESHOLDS);
    expect(Array.from(thresholds.subarray(0, 3))).toEqual([100, 200, 300]);
    expect(bindings.uniforms).toMatchObject({
      u_threshold_count: 3,
      u_include_lower: 1,
      u_include_upper: 0,
    });
    expect(bindings.textures).toEqual({ u_band_colors: texture });
  });

  it("rejects more than MAX_THRESHOLDS levels", () => {
    expect(() =>
      Isoband.getUniforms!({
        ...props,
        thresholds: Array.from({ length: MAX_THRESHOLDS + 1 }, (_, i) => i),
      }),
    ).toThrow(RangeError);
  });

  it("reads `value`, discards invalid pixels and looks the band up", () => {
    expect(Isoband.fsColor).toContain("value");
    expect(Isoband.fsColor).toContain("discard");
    expect(Isoband.fsColor).toContain("texelFetch(u_band_colors");
  });
});

describe("ContourLine", () => {
  it("converts colours to vec4 and fills defaults", () => {
    const bindings = ContourLine.getUniforms!({
      thresholds: [10, 20],
      width: 1,
      color: "#ff0000",
      majorEvery: 2,
      majorWidth: 2,
      majorColor: "rgba(0, 0, 255, 0.5)",
    });
    expect(bindings.uniforms).toMatchObject({
      u_threshold_count: 2,
      u_line_width: 1,
      u_line_color: new Float32Array([1, 0, 0, 1]),
      u_major_every: 2,
      u_major_width: 2,
      u_major_color: new Float32Array([0, 0, 1, 128 / 255]),
    });
    const defaults = ContourLine.getUniforms!({
      thresholds: [10],
      width: 1,
      color: "#000",
    });
    // Without `majorEvery`, no line is major.
    expect(defaults.uniforms).toMatchObject({ u_major_every: 0 });
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
