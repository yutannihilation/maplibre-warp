/**
 * Renders warped tiles into an `OffscreenCanvas` of its own, outside any map.
 *
 * The vertex shader is the same relative-to-centre shader the map layer
 * uses; only MapLibre's `projectTile` prelude is replaced by a plain matrix
 * multiply, which is exactly what MapLibre's own mercator prelude does. The
 * program cache, module chain and draw loop are shared with the layer.
 */

import type { DrawablePayload, ShaderData } from "../draw.js";
import { drawTiles } from "../draw.js";
import { mercatorFrameUniformsAt } from "../raster-custom-layer.js";
import type { UniformValue } from "../shader/module.js";
import { ProgramCache } from "../shader/program.js";
import type { DrawableTile } from "../tile-scheduler.js";
import type { Point } from "../tileset/types.js";

/**
 * A `projectTile` that is the mercator → clip matrix and nothing else. The
 * `PI` constant mirrors MapLibre's prelude, which declares it before the
 * projection code.
 */
export const HEADLESS_MERCATOR_PRELUDE = `const float PI = 3.141592653589793;
uniform mat4 u_projection_matrix;
vec4 projectTile(vec2 p) {
  return u_projection_matrix * vec4(p, 0.0, 1.0);
}`;

/** `shaderData` for the headless mercator program. */
export const HEADLESS_SHADER_DATA: ShaderData = {
  variantName: "mercator",
  vertexShaderPrelude: HEADLESS_MERCATOR_PRELUDE,
  define: "",
};

/** Straight RGB in `[0, 1]`. */
export type ClearColor = readonly [r: number, g: number, b: number];

export class HeadlessTileRenderer {
  private readonly programs: ProgramCache;

  /**
   * Create a `tileSize`-square WebGL2 canvas. Throws when `OffscreenCanvas`
   * or WebGL2 is unavailable: there is no slower path to fall back to.
   */
  static create(tileSize: number): HeadlessTileRenderer {
    if (typeof OffscreenCanvas === "undefined") {
      throw new Error(
        "OffscreenCanvas is not available in this environment; headless tile rendering needs it",
      );
    }
    const canvas = new OffscreenCanvas(tileSize, tileSize);
    // Opaque, unpremultiplied: the output is data, not display colour, and
    // `transferToImageBitmap` must hand the bytes on untouched.
    const gl = canvas.getContext("webgl2", {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: false,
    }) as WebGL2RenderingContext | null;
    if (!gl) {
      throw new Error("WebGL2 is not available on an OffscreenCanvas");
    }
    return new HeadlessTileRenderer(gl, canvas, tileSize);
  }

  constructor(
    readonly gl: WebGL2RenderingContext,
    private readonly canvas: OffscreenCanvas,
    readonly tileSize: number,
  ) {
    this.programs = new ProgramCache(gl);
  }

  /**
   * Draw `drawList` through `matrix` (mercator → clip) with the
   * relative-to-centre origin `origin`, over `clearColor`, and return the
   * canvas as an `ImageBitmap`.
   *
   * Blending is off: later tiles overwrite earlier ones outright, and the
   * fragment shader's alpha is `1` throughout. Everything happens
   * synchronously, so the drawing buffer cannot be cleared between the draw
   * and the transfer.
   */
  render(
    drawList: readonly DrawableTile<DrawablePayload>[],
    matrix: ArrayLike<number>,
    origin: Point,
    clearColor: ClearColor,
  ): ImageBitmap {
    const { gl, tileSize } = this;
    // A lost context (GPU reset, the browser reclaiming a background tab's
    // context, or `destroy()`) turns every GL call into a silent no-op and
    // would hand back a blank tile; say so instead. Nothing here restores a
    // context: the owner has to recreate the renderer.
    if (gl.isContextLost()) {
      throw new Error(
        "the headless WebGL2 context is lost; destroy and recreate the renderer",
      );
    }
    gl.viewport(0, 0, tileSize, tileSize);
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.SCISSOR_TEST);
    gl.clearColor(clearColor[0], clearColor[1], clearColor[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT);

    const frameUniforms: Record<string, UniformValue> = mercatorFrameUniformsAt(
      matrix,
      origin,
    );
    frameUniforms.u_opacity = 1;
    drawTiles(gl, this.programs, HEADLESS_SHADER_DATA, drawList, frameUniforms);

    return this.canvas.transferToImageBitmap();
  }

  /** Whether the context has been lost, or released by {@link destroy}. */
  get isContextLost(): boolean {
    return this.gl.isContextLost();
  }

  /** Free the programs and release the context. */
  destroy(): void {
    this.programs.destroy();
    this.gl.getExtension("WEBGL_lose_context")?.loseContext();
  }
}
