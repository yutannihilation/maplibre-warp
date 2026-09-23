/**
 * The draw loop shared by the map layer and the headless tile renderer.
 *
 * One `drawElements` per tile, coarsest first; the per-frame uniforms are
 * uploaded whenever the program changes, the per-tile module bindings on
 * every tile.
 */

import type { CustomRenderMethodInput } from "maplibre-gl";

import type { GpuMesh } from "./mesh.js";
import type { RenderPipeline, UniformValue } from "./shader/module.js";
import { collectBindings } from "./shader/module.js";
import type { ProgramCache } from "./shader/program.js";
import type { DrawableTile } from "./tile-scheduler.js";

/** What `drawTiles` needs from a loaded tile. */
export interface DrawablePayload {
  mesh: GpuMesh;
  pipeline: RenderPipeline;
}

/** The projection-dependent shader inputs MapLibre hands a custom layer. */
export type ShaderData = CustomRenderMethodInput["shaderData"];

/**
 * Draw `drawList` in order with the programs `shaderData` selects.
 *
 * Leaves no VAO bound: under MapLibre, `setCustomLayerDefaults` unbinds it
 * only before the *next* custom layer, while MapLibre's own layers in the
 * same frame run first, and a stray binding would capture their
 * `vertexAttribPointer` calls.
 */
export function drawTiles(
  gl: WebGL2RenderingContext,
  programs: ProgramCache,
  shaderData: ShaderData,
  drawList: readonly DrawableTile<DrawablePayload>[],
  frameUniforms: Record<string, UniformValue>,
): void {
  let currentProgram: WebGLProgram | null = null;

  for (const { payload } of drawList) {
    const program = programs.get(shaderData, payload.pipeline);

    if (program.program !== currentProgram) {
      gl.useProgram(program.program);
      currentProgram = program.program;
      for (const [name, value] of Object.entries(frameUniforms)) {
        program.setUniform(name, value);
      }
    }

    program.bind(collectBindings(payload.pipeline));

    gl.bindVertexArray(payload.mesh.vao);
    gl.drawElements(gl.TRIANGLES, payload.mesh.indexCount, gl.UNSIGNED_INT, 0);
  }
  gl.bindVertexArray(null);
}
