/**
 * The shader-module contract.
 *
 * This replaces luma.gl's `ShaderModule` + shader assembler. A module
 * contributes fragment-shader declarations and a snippet that transforms the
 * running `vec4 color`, plus the uniform values those need.
 *
 * Compared with luma.gl's version:
 *
 * - Snippets operate on `color` and `uv` directly, rather than on
 *   `DECKGL_FILTER_COLOR(color, geometry)`.
 * - Uniforms are plain `gl.uniform*` calls, never uniform blocks. MapLibre
 *   issue #8413: a custom layer that rebinds UBO binding points 0–2 corrupts
 *   every MapLibre layer drawn after it in the same frame.
 * - Textures are declared separately from scalar uniforms so the renderer can
 *   assign texture units itself.
 */

/** A scalar or vector uniform value. */
export type UniformValue =
  | number
  | boolean
  | readonly number[]
  | Float32Array
  | Int32Array;

/** A texture bound to a named sampler uniform. */
export interface TextureBinding {
  texture: WebGLTexture;
  /** `gl.TEXTURE_2D` or `gl.TEXTURE_2D_ARRAY`. */
  target: GLenum;
}

/** What a module contributes at draw time. */
export interface ModuleBindings {
  uniforms?: Record<string, UniformValue>;
  textures?: Record<string, TextureBinding>;
}

/**
 * One step in a render pipeline.
 *
 * `name` is the program-cache key component for this module, so two modules
 * with the same name **must** have identical GLSL.
 */
export interface RasterShaderModule<PropsT = void> {
  name: string;

  /**
   * GLSL inserted at fragment-shader global scope: sampler/uniform
   * declarations and helper functions.
   */
  fsDecl?: string;

  /**
   * Declarations shared between modules, emitted once per `key` however many
   * modules in the pipeline carry them (the contour modules share their
   * threshold uniforms this way).
   */
  fsSharedDecl?: { key: string; glsl: string };

  /**
   * GLSL inserted into `main()`, in pipeline order. Operates on the in-scope
   * `vec4 color` and `vec2 uv`. The first module in a pipeline is responsible
   * for seeding `color`.
   */
  fsColor?: string;

  /** Map props to uniform and texture bindings. */
  getUniforms?(props: PropsT): ModuleBindings;
}

/** A module paired with the props for this particular tile. */
export interface RasterModuleInstance<PropsT = any> {
  module: RasterShaderModule<PropsT>;
  props?: PropsT;
}

/** A full render pipeline: an ordered list of module instances. */
export type RenderPipeline = RasterModuleInstance<any>[];

/** Cache key for a pipeline under a given MapLibre shader variant. */
export function pipelineKey(
  variantName: string,
  pipeline: RenderPipeline,
): string {
  return `${variantName}|${pipeline.map((m) => m.module.name).join(",")}`;
}

/** Collect the bindings for every module in a pipeline. */
export function collectBindings(pipeline: RenderPipeline): ModuleBindings {
  const uniforms: Record<string, UniformValue> = {};
  const textures: Record<string, TextureBinding> = {};
  for (const { module, props } of pipeline) {
    const bindings = module.getUniforms?.(props as never);
    if (!bindings) {
      continue;
    }
    Object.assign(uniforms, bindings.uniforms);
    Object.assign(textures, bindings.textures);
  }
  return { uniforms, textures };
}
