/**
 * Program compilation, caching and uniform binding.
 *
 * Replaces luma.gl's shader assembler + uniform binder in ~200 lines. Only
 * plain `gl.uniform*` is used — never uniform blocks (MapLibre #8413).
 */

import type { CustomRenderMethodInput } from "maplibre-gl";

import type { ModuleBindings, RenderPipeline, UniformValue } from "./module.js";
import { collectBindings, pipelineKey } from "./module.js";
import {
  ATTRIB_POS_HIGH,
  ATTRIB_POS_LOW,
  ATTRIB_UV,
  buildFragmentSource,
  buildVertexSource,
} from "./sources.js";

interface UniformInfo {
  location: WebGLUniformLocation;
  type: GLenum;
  /** Element count; greater than one for array uniforms. */
  size: number;
}

/** A linked program plus everything needed to feed it. */
export class RasterProgram {
  readonly program: WebGLProgram;
  private readonly uniforms = new Map<string, UniformInfo>();

  constructor(
    private readonly gl: WebGL2RenderingContext,
    vertexSource: string,
    fragmentSource: string,
  ) {
    this.program = linkProgram(gl, vertexSource, fragmentSource);

    const count = gl.getProgramParameter(
      this.program,
      gl.ACTIVE_UNIFORMS,
    ) as number;
    for (let i = 0; i < count; i++) {
      const info = gl.getActiveUniform(this.program, i);
      if (!info) {
        continue;
      }
      // Array uniforms are reported as `name[0]`; store under the bare name.
      const name = info.name.replace(/\[0\]$/, "");
      const location = gl.getUniformLocation(this.program, info.name);
      if (location) {
        this.uniforms.set(name, { location, type: info.type, size: info.size });
      }
    }
  }

  /**
   * Apply scalar/vector uniforms and bind textures.
   *
   * Textures are assigned sequential units starting at 0 in the order they
   * appear in `bindings.textures`.
   *
   * @returns the number of texture units used, so the caller can unbind them.
   */
  bind(bindings: ModuleBindings): number {
    const { gl } = this;

    for (const [name, value] of Object.entries(bindings.uniforms ?? {})) {
      this.setUniform(name, value);
    }

    let unit = 0;
    for (const [name, binding] of Object.entries(bindings.textures ?? {})) {
      const info = this.uniforms.get(name);
      if (!info) {
        // The sampler was optimised out (its module's snippet doesn't use it).
        continue;
      }
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(binding.target, binding.texture);
      gl.uniform1i(info.location, unit);
      unit++;
    }
    return unit;
  }

  setUniform(name: string, value: UniformValue): void {
    const info = this.uniforms.get(name);
    if (!info) {
      return;
    }
    const { gl } = this;
    const { location, type, size } = info;

    if (size > 1) {
      switch (type) {
        case gl.FLOAT:
          gl.uniform1fv(location, asFloat32(value));
          return;
        case gl.FLOAT_VEC4:
          gl.uniform4fv(location, asFloat32(value));
          return;
        case gl.INT:
        case gl.BOOL:
          gl.uniform1iv(location, asInt32(value));
          return;
        default:
          throw new Error(
            `Array uniform "${name}" has unsupported GL type 0x${type.toString(16)}`,
          );
      }
    }

    switch (type) {
      case gl.FLOAT:
        gl.uniform1f(location, value as number);
        return;
      case gl.FLOAT_VEC2:
        gl.uniform2fv(location, value as Float32Array);
        return;
      case gl.FLOAT_VEC3:
        gl.uniform3fv(location, value as Float32Array);
        return;
      case gl.FLOAT_VEC4:
        gl.uniform4fv(location, value as Float32Array);
        return;
      case gl.INT:
      case gl.BOOL:
        gl.uniform1i(location, Number(value));
        return;
      case gl.INT_VEC2:
        gl.uniform2iv(location, value as Int32Array);
        return;
      case gl.INT_VEC3:
        gl.uniform3iv(location, value as Int32Array);
        return;
      case gl.INT_VEC4:
        gl.uniform4iv(location, value as Int32Array);
        return;
      case gl.FLOAT_MAT4:
        gl.uniformMatrix4fv(location, false, value as Float32Array);
        return;
      default:
        throw new Error(
          `Uniform "${name}" has unsupported GL type 0x${type.toString(16)}`,
        );
    }
  }

  destroy(): void {
    this.gl.deleteProgram(this.program);
  }
}

/**
 * Compiles and caches one program per `(MapLibre shader variant, module chain)`
 * pair.
 *
 * MapLibre's `shaderData.variantName` changes whenever the projection prelude
 * changes, which is exactly when the vertex shader must be recompiled.
 */
export class ProgramCache {
  private readonly programs = new Map<string, RasterProgram>();

  constructor(private readonly gl: WebGL2RenderingContext) {}

  get(
    shaderData: CustomRenderMethodInput["shaderData"],
    pipeline: RenderPipeline,
  ): RasterProgram {
    const key = pipelineKey(shaderData.variantName, pipeline);
    let program = this.programs.get(key);
    if (!program) {
      program = new RasterProgram(
        this.gl,
        buildVertexSource(shaderData),
        buildFragmentSource(pipeline),
      );
      this.programs.set(key, program);
    }
    return program;
  }

  destroy(): void {
    for (const program of this.programs.values()) {
      program.destroy();
    }
    this.programs.clear();
  }
}

export { collectBindings };

function compileShader(
  gl: WebGL2RenderingContext,
  type: GLenum,
  source: string,
): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) {
    throw new Error("Failed to create WebGL shader");
  }
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(
      `Failed to compile ${
        type === gl.VERTEX_SHADER ? "vertex" : "fragment"
      } shader: ${log}\n${numberSource(source)}`,
    );
  }
  return shader;
}

function linkProgram(
  gl: WebGL2RenderingContext,
  vertexSource: string,
  fragmentSource: string,
): WebGLProgram {
  const vs = compileShader(gl, gl.VERTEX_SHADER, vertexSource);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
  const program = gl.createProgram();
  if (!program) {
    throw new Error("Failed to create WebGL program");
  }
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);

  // Fixed attribute locations keep a mesh VAO valid across every program.
  gl.bindAttribLocation(program, ATTRIB_POS_HIGH, "a_pos_high");
  gl.bindAttribLocation(program, ATTRIB_POS_LOW, "a_pos_low");
  gl.bindAttribLocation(program, ATTRIB_UV, "a_uv");

  gl.linkProgram(program);
  gl.deleteShader(vs);
  gl.deleteShader(fs);

  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error(`Failed to link WebGL program: ${log}`);
  }
  return program;
}

function asFloat32(value: UniformValue): Float32Array {
  if (value instanceof Float32Array) {
    return value;
  }
  if (Array.isArray(value) || value instanceof Int32Array) {
    return Float32Array.from(value as ArrayLike<number>);
  }
  throw new Error("array uniform needs an array value");
}

function asInt32(value: UniformValue): Int32Array {
  if (value instanceof Int32Array) {
    return value;
  }
  if (Array.isArray(value) || value instanceof Float32Array) {
    return Int32Array.from(value as ArrayLike<number>);
  }
  throw new Error("array uniform needs an array value");
}

/** Prefix each line with its number, so compiler errors are locatable. */
function numberSource(source: string): string {
  return source
    .split("\n")
    .map((line, i) => `${String(i + 1).padStart(4)} | ${line}`)
    .join("\n");
}
