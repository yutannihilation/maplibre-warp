/**
 * Shader source assembly.
 *
 * The vertex shader is built around MapLibre's own `projectTile` prelude, so
 * the layer projects exactly the way every built-in MapLibre layer does.
 */

import type { RenderPipeline } from "./module.js";

/** Attribute locations, bound explicitly so VAOs work with any program. */
export const ATTRIB_POS_HIGH = 0;
export const ATTRIB_POS_LOW = 1;
export const ATTRIB_UV = 2;

/**
 * Vertex shader.
 *
 * ## Precision
 *
 * Mesh vertices are absolute mercator `[0, 1]` positions, split into float32
 * high and low halves (`splitFloat64Array`). A single **per-frame** origin `O`
 * — the map centre in mercator — is split the same way and uploaded as
 * `u_origin_high` / `u_origin_low`.
 *
 * ```glsl
 * vec2 rel = (a_pos_high - u_origin_high) + (a_pos_low - u_origin_low);
 * ```
 *
 * Both subtractions are exact (Sterbenz) whenever `a_pos_high` is within a
 * factor of two of `u_origin_high`, which holds for anything on screen. `rel`
 * is then small, so float32 resolves it far below a pixel even at z22.
 *
 * `u_projection_matrix` is uploaded as `mainMatrix · translate(O)`, computed
 * on the CPU in float64, so `projectTile(rel)` is `mainMatrix · (rel + O)`.
 *
 * The key property is that **every tile in a frame uses the same `O`**. A
 * vertex shared by two adjacent tiles therefore goes through bit-identical
 * arithmetic in both, so tile edges cannot crack apart — which is exactly what
 * per-tile local origins get wrong.
 */
export function buildVertexSource(shaderData: {
  vertexShaderPrelude: string;
  define: string;
}): string {
  return `#version 300 es
${shaderData.vertexShaderPrelude}
${shaderData.define}

in vec2 a_pos_high;
in vec2 a_pos_low;
in vec2 a_uv;

uniform vec2 u_origin_high;
uniform vec2 u_origin_low;

out vec2 v_uv;

void main() {
  v_uv = a_uv;
  vec2 rel = (a_pos_high - u_origin_high) + (a_pos_low - u_origin_low);
  gl_Position = projectTile(rel);
}
`;
}

/**
 * Fragment shader: the module chain, then premultiplied output.
 *
 * MapLibre enters custom layers with `blendFunc(ONE, ONE_MINUS_SRC_ALPHA)`, so
 * colour must be premultiplied by alpha.
 */
export function buildFragmentSource(pipeline: RenderPipeline): string {
  const decls = pipeline
    .map(({ module }) => module.fsDecl)
    .filter((s): s is string => Boolean(s))
    .join("\n");

  const body = pipeline
    .map(({ module }) =>
      module.fsColor ? `  // ${module.name}\n${module.fsColor}` : "",
    )
    .filter(Boolean)
    .join("\n");

  return `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;

in vec2 v_uv;
out vec4 fragColor;

uniform float u_opacity;

${decls}

void main() {
  vec2 uv = v_uv;
  vec4 color = vec4(0.0);

${body}

  fragColor = vec4(color.rgb * color.a * u_opacity, color.a * u_opacity);
}
`;
}
