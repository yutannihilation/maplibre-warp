import { describe, expect, it, vi } from "vitest";

import { RasterProgram } from "../src/shader/program.js";

const GL = {
  FLOAT: 0x1406,
  INT: 0x1404,
  BOOL: 0x8b56,
  FLOAT_VEC2: 0x8b50,
  FLOAT_VEC3: 0x8b51,
  FLOAT_VEC4: 0x8b52,
  INT_VEC2: 0x8b53,
  INT_VEC3: 0x8b54,
  INT_VEC4: 0x8b55,
  FLOAT_MAT4: 0x8b5c,
  VERTEX_SHADER: 0x8b31,
  FRAGMENT_SHADER: 0x8b30,
  COMPILE_STATUS: 0x8b81,
  LINK_STATUS: 0x8b82,
  ACTIVE_UNIFORMS: 0x8b86,
  TEXTURE0: 0x84c0,
};

interface ActiveUniform {
  name: string;
  type: number;
  size: number;
}

/** A fake context that links anything and reports the given uniforms. */
function fakeGl(uniforms: ActiveUniform[]) {
  const calls: Array<[string, unknown[]]> = [];
  const record =
    (name: string) =>
    (...args: unknown[]) => {
      calls.push([name, args]);
    };
  const gl = {
    ...GL,
    createShader: () => ({}),
    shaderSource: () => {},
    compileShader: () => {},
    getShaderParameter: () => true,
    createProgram: () => ({}),
    attachShader: () => {},
    bindAttribLocation: () => {},
    linkProgram: () => {},
    deleteShader: () => {},
    getProgramParameter: (_p: unknown, param: number) =>
      param === GL.ACTIVE_UNIFORMS ? uniforms.length : true,
    getActiveUniform: (_p: unknown, i: number) => uniforms[i] ?? null,
    getUniformLocation: (_p: unknown, name: string) => ({ name }),
    uniform1f: vi.fn(record("uniform1f")),
    uniform1fv: vi.fn(record("uniform1fv")),
    uniform1i: vi.fn(record("uniform1i")),
    uniform1iv: vi.fn(record("uniform1iv")),
    uniform4fv: vi.fn(record("uniform4fv")),
    uniform2fv: vi.fn(record("uniform2fv")),
  };
  return { gl: gl as unknown as WebGL2RenderingContext, calls };
}

describe("RasterProgram array uniforms", () => {
  it("uploads float arrays with uniform1fv and reports them under the bare name", () => {
    const { gl, calls } = fakeGl([
      { name: "u_thresholds[0]", type: GL.FLOAT, size: 64 },
      { name: "u_opacity", type: GL.FLOAT, size: 1 },
    ]);
    const program = new RasterProgram(gl, "", "");
    const values = new Float32Array(64);
    values[0] = 100;
    program.setUniform("u_thresholds", values);
    program.setUniform("u_opacity", 0.5);
    expect(calls).toEqual([
      ["uniform1fv", [{ name: "u_thresholds[0]" }, values]],
      ["uniform1f", [{ name: "u_opacity" }, 0.5]],
    ]);
  });

  it("uploads int and vec4 arrays", () => {
    const { gl, calls } = fakeGl([
      { name: "u_flags[0]", type: GL.INT, size: 4 },
      { name: "u_colors[0]", type: GL.FLOAT_VEC4, size: 2 },
    ]);
    const program = new RasterProgram(gl, "", "");
    const flags = new Int32Array([1, 0, 1, 0]);
    const colors = new Float32Array(8);
    program.setUniform("u_flags", flags);
    program.setUniform("u_colors", colors);
    expect(calls.map(([name]) => name)).toEqual(["uniform1iv", "uniform4fv"]);
  });

  it("accepts plain number arrays for float arrays", () => {
    const { gl, calls } = fakeGl([
      { name: "u_thresholds[0]", type: GL.FLOAT, size: 3 },
    ]);
    new RasterProgram(gl, "", "").setUniform("u_thresholds", [1, 2, 3]);
    expect(calls[0]![0]).toBe("uniform1fv");
    expect(Array.from(calls[0]![1][1] as Float32Array)).toEqual([1, 2, 3]);
  });
});
