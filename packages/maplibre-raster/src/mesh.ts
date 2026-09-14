/**
 * Adaptive warp-mesh generation and its GPU representation.
 *
 * `RasterReprojector` (Delatin, driven by reprojection error measured in input
 * pixels) produces a triangulation whose vertices carry exact output-CRS
 * positions. Here the output CRS is MapLibre mercator `[0, 1]`, in float64;
 * the positions are then split into float32 high/low halves for the shader's
 * relative-to-centre reconstruction.
 */

import type {
  InitialTriangulation,
  ReprojectionFns,
} from "@developmentseed/raster-reproject";
import { RasterReprojector } from "@developmentseed/raster-reproject";

import { splitFloat64Array } from "./fp64.js";
import {
  ATTRIB_POS_HIGH,
  ATTRIB_POS_LOW,
  ATTRIB_UV,
} from "./shader/sources.js";

/** Default maximum reprojection error, in input pixels. */
export const DEFAULT_MAX_ERROR = 0.125;

/** CPU-side mesh arrays, ready to upload. */
export interface TileMeshData {
  /** `vec2` float32 high halves of the mercator positions. */
  positionsHigh: Float32Array;
  /** `vec2` float32 low halves (residuals). */
  positionsLow: Float32Array;
  /** `vec2` texture coordinates in `[0, 1]`. */
  uvs: Float32Array;
  indices: Uint32Array;
  /** Bytes held by the four arrays, for cache accounting. */
  byteLength: number;
}

/**
 * Generate the warp mesh for one tile.
 *
 * @param width   Width of the decoded tile in pixels (edge tiles may be
 *                narrower than the nominal tile width).
 * @param height  Height of the decoded tile in pixels.
 * @param reprojectionFns  `forwardTransform`/`inverseTransform` map tile-local
 *                pixels ↔ source CRS; `forwardReproject`/`inverseReproject`
 *                map source CRS ↔ mercator `[0, 1]`.
 */
export function buildTileMesh(
  width: number,
  height: number,
  reprojectionFns: ReprojectionFns,
  options: {
    maxError?: number;
    initialTriangulation?: InitialTriangulation;
  } = {},
): TileMeshData {
  const { maxError = DEFAULT_MAX_ERROR, initialTriangulation } = options;

  // The mesh is aligned with pixel *corners*, so a mesh sized to the pixel
  // count would stop one row/column short of the tile's far edge and leave
  // visible gaps between neighbouring tiles. Hence width + 1 / height + 1.
  const reprojector = new RasterReprojector(
    reprojectionFns,
    width + 1,
    height + 1,
    { initialTriangulation },
  );
  reprojector.run(maxError);

  const uvs = new Float32Array(reprojector.uvs);
  const positions = new Float64Array(reprojector.exactOutputPositions);
  const [positionsHigh, positionsLow] = splitFloat64Array(positions);
  const indices = new Uint32Array(reprojector.triangles);

  return {
    positionsHigh,
    positionsLow,
    uvs,
    indices,
    byteLength:
      positionsHigh.byteLength +
      positionsLow.byteLength +
      uvs.byteLength +
      indices.byteLength,
  };
}

/** Buffers and VAO for one tile's mesh. */
export class GpuMesh {
  private readonly buffers: WebGLBuffer[] = [];
  readonly vao: WebGLVertexArrayObject;
  readonly indexCount: number;
  readonly byteLength: number;

  constructor(gl: WebGL2RenderingContext, mesh: TileMeshData) {
    const vao = gl.createVertexArray();
    if (!vao) {
      throw new Error("Failed to create vertex array object");
    }
    this.vao = vao;
    this.indexCount = mesh.indices.length;
    this.byteLength = mesh.byteLength;

    const previousVao = gl.getParameter(
      gl.VERTEX_ARRAY_BINDING,
    ) as WebGLVertexArrayObject | null;
    const previousArrayBuffer = gl.getParameter(
      gl.ARRAY_BUFFER_BINDING,
    ) as WebGLBuffer | null;

    gl.bindVertexArray(vao);

    this.addAttribute(gl, ATTRIB_POS_HIGH, mesh.positionsHigh);
    this.addAttribute(gl, ATTRIB_POS_LOW, mesh.positionsLow);
    this.addAttribute(gl, ATTRIB_UV, mesh.uvs);

    const indexBuffer = gl.createBuffer();
    if (!indexBuffer) {
      throw new Error("Failed to create index buffer");
    }
    this.buffers.push(indexBuffer);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.indices, gl.STATIC_DRAW);

    gl.bindVertexArray(previousVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, previousArrayBuffer);
  }

  private addAttribute(
    gl: WebGL2RenderingContext,
    location: number,
    data: Float32Array,
  ): void {
    const buffer = gl.createBuffer();
    if (!buffer) {
      throw new Error("Failed to create vertex buffer");
    }
    this.buffers.push(buffer);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(location);
    gl.vertexAttribPointer(location, 2, gl.FLOAT, false, 0, 0);
  }

  destroy(gl: WebGL2RenderingContext): void {
    gl.deleteVertexArray(this.vao);
    for (const buffer of this.buffers) {
      gl.deleteBuffer(buffer);
    }
    this.buffers.length = 0;
  }
}
