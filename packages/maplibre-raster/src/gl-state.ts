/**
 * Save and restore the GL state a custom layer touches.
 *
 * MapLibre's contract is that a custom layer "cannot make any assumptions about
 * the current GL state" — but it also draws its own layers after ours in the
 * same frame, so anything we leave bound leaks into them. MapLibre issue #8413
 * is the well-known instance of this (a custom layer rebinding UBO binding
 * points corrupts every later layer); we avoid UBOs entirely and restore
 * everything else we touch.
 *
 * Deliberately *not* saved: blend state, depth state, viewport and scissor.
 * MapLibre sets those per draw and we leave them exactly as handed to us —
 * the layer outputs premultiplied alpha into the blend mode MapLibre
 * configured.
 */

/** How many texture units {@link saveGlState} preserves. */
export const MAX_TEXTURE_UNITS = 8;

export interface SavedGlState {
  program: WebGLProgram | null;
  vertexArray: WebGLVertexArrayObject | null;
  arrayBuffer: WebGLBuffer | null;
  activeTexture: GLenum;
  cullFace: boolean;
  textures2D: (WebGLTexture | null)[];
  textures2DArray: (WebGLTexture | null)[];
}

export function saveGlState(gl: WebGL2RenderingContext): SavedGlState {
  const textures2D: (WebGLTexture | null)[] = [];
  const textures2DArray: (WebGLTexture | null)[] = [];
  const activeTexture = gl.getParameter(gl.ACTIVE_TEXTURE) as GLenum;

  for (let unit = 0; unit < MAX_TEXTURE_UNITS; unit++) {
    gl.activeTexture(gl.TEXTURE0 + unit);
    textures2D.push(
      gl.getParameter(gl.TEXTURE_BINDING_2D) as WebGLTexture | null,
    );
    textures2DArray.push(
      gl.getParameter(gl.TEXTURE_BINDING_2D_ARRAY) as WebGLTexture | null,
    );
  }
  gl.activeTexture(activeTexture);

  return {
    program: gl.getParameter(gl.CURRENT_PROGRAM) as WebGLProgram | null,
    vertexArray: gl.getParameter(
      gl.VERTEX_ARRAY_BINDING,
    ) as WebGLVertexArrayObject | null,
    arrayBuffer: gl.getParameter(gl.ARRAY_BUFFER_BINDING) as WebGLBuffer | null,
    activeTexture,
    cullFace: gl.isEnabled(gl.CULL_FACE),
    textures2D,
    textures2DArray,
  };
}

export function restoreGlState(
  gl: WebGL2RenderingContext,
  saved: SavedGlState,
): void {
  for (let unit = 0; unit < MAX_TEXTURE_UNITS; unit++) {
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, saved.textures2D[unit] ?? null);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, saved.textures2DArray[unit] ?? null);
  }
  gl.activeTexture(saved.activeTexture);

  gl.bindVertexArray(saved.vertexArray);
  gl.bindBuffer(gl.ARRAY_BUFFER, saved.arrayBuffer);
  gl.useProgram(saved.program);

  if (saved.cullFace) {
    gl.enable(gl.CULL_FACE);
  } else {
    gl.disable(gl.CULL_FACE);
  }
}
