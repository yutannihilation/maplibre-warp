import { describe, expect, it } from "vitest";

import {
  DEM_ENCODINGS,
  DemEncode,
  decodeDem,
  demClearColor,
  encodeDem,
  validateDemEncoding,
} from "../src/gpu-modules/dem-encode.js";
import { buildFragmentSource } from "../src/shader/sources.js";

describe("DEM encodings", () => {
  it("match MapLibre's DEMData unpack factors", () => {
    expect(DEM_ENCODINGS.terrarium).toMatchObject({
      redFactor: 256,
      greenFactor: 1,
      blueFactor: 1 / 256,
      baseShift: 32768,
    });
    expect(DEM_ENCODINGS.mapbox).toMatchObject({
      redFactor: 6553.6,
      greenFactor: 25.6,
      blueFactor: 0.1,
      baseShift: 10000,
    });
    expect(validateDemEncoding("terrarium")).toBe("terrarium");
    expect(() => validateDemEncoding("png")).toThrow(RangeError);
  });

  it("round-trips within the encoding's precision", () => {
    for (const v of [-100, 0, 1234.567, 4807.8, 32767]) {
      expect(decodeDem(encodeDem(v, "terrarium"), "terrarium")).toBeCloseTo(
        v,
        2,
      );
      expect(
        Math.abs(decodeDem(encodeDem(v, "mapbox"), "mapbox") - v),
      ).toBeLessThanOrEqual(0.05 + 1e-9);
    }
  });

  it("produces integer bytes and clamps at both ends", () => {
    expect(encodeDem(0, "terrarium")).toEqual([128, 0, 0]);
    expect(encodeDem(-40000, "terrarium")).toEqual([0, 0, 0]);
    expect(encodeDem(40000, "terrarium")).toEqual([255, 255, 255]);
    expect(encodeDem(-20000, "mapbox")).toEqual([0, 0, 0]);
    expect(demClearColor(0, "terrarium")).toEqual([128 / 255, 0, 0]);
  });
});

describe("DemEncode module", () => {
  it("exposes the encoding through uniforms and never discards", () => {
    const bindings = DemEncode.getUniforms!({
      encoding: "mapbox",
      fillValue: -5,
    });
    expect(bindings.uniforms).toEqual({
      u_dem_step: 10,
      u_dem_base_shift: 10000,
      u_dem_fill_value: -5,
    });
    expect(DemEncode.fsColor).not.toContain("discard");
    expect(() =>
      DemEncode.getUniforms!({ encoding: "terrarium", fillValue: NaN }),
    ).toThrow(RangeError);
  });

  it("assembles into a fragment shader that writes the value", () => {
    const source = buildFragmentSource([{ module: DemEncode }]);
    expect(source).toContain("u_dem_fill_value");
    expect(source).toContain("color = vec4(r, g, b, 255.0) / 255.0;");
  });
});
