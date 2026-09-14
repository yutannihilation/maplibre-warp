/**
 * The MapLibre custom layer: tile scheduling plus the draw loop.
 */

import type {
  CustomLayerInterface,
  CustomRenderMethodInput,
  Map as MapLibreMap,
} from "maplibre-gl";

import { splitFloat64 } from "./fp64.js";
import { mercatorFromLngLat } from "./mercator.js";
import type { GpuMesh } from "./mesh.js";
import type { RenderPipeline } from "./shader/module.js";
import { collectBindings } from "./shader/module.js";
import { ProgramCache } from "./shader/program.js";
import type { DrawableTile } from "./tile-scheduler.js";
import { TileScheduler } from "./tile-scheduler.js";
import type { RasterTilesetDescriptor } from "./tileset/tileset-interface.js";
import type { Bounds, TileIndex, ZRange } from "./tileset/types.js";
import { createRasterViewport, isMercatorVariant } from "./viewport-shim.js";

/** Everything the layer needs to draw one loaded tile. */
export interface RasterTilePayload {
  mesh: GpuMesh;
  pipeline: RenderPipeline;
  /** Bytes of GPU memory this tile holds (textures + mesh buffers). */
  byteLength: number;
  /** Release every GPU resource this payload owns. */
  destroy(gl: WebGL2RenderingContext): void;
}

/** A resolved raster source: a tile pyramid plus how to load a tile from it. */
export interface RasterSource {
  descriptor: RasterTilesetDescriptor;
  /** Dataset extent in WGS84 degrees, `[west, south, east, north]`. */
  wgs84Bounds: Bounds;
  loadTile(
    index: TileIndex,
    context: { gl: WebGL2RenderingContext; signal: AbortSignal },
  ): Promise<RasterTilePayload>;
}

export interface RasterCustomLayerProps {
  /** Unique layer id. */
  id: string;
  /** Layer opacity in `[0, 1]`. @default 1 */
  opacity?: number;
  /** Soft cap on retained GPU bytes. @default 256 MiB */
  maxCacheByteSize?: number;
  /** Soft cap on the number of retained tiles. @default 512 */
  maxCacheSize?: number;
  /** Elevation range in metres, or null for a flat raster. @default null */
  zRange?: ZRange | null;
}

/**
 * Base class for raster custom layers.
 *
 * Subclasses implement {@link createSource}, which resolves asynchronously
 * (opening a COG, for instance). Until it resolves the layer draws nothing.
 *
 * `renderingMode` is `"2d"`: MapLibre then gives the layer read-only depth,
 * which is what a flat raster wants.
 *
 * ## GL state
 *
 * {@link render} deliberately does **not** save and restore GL state, because
 * MapLibre 6 brackets every custom-layer draw itself (`draw_custom.ts`):
 *
 * - Before the call, `painter.setCustomLayerDefaults()` unbinds the vertex
 *   array and resets cull face (to disabled), the active texture unit (to
 *   `TEXTURE0`) and all three `UNPACK_*` pixel-store parameters to their
 *   defaults. So the incoming state is known, and the layer does not need to
 *   disable face culling itself even though a south-up source geotransform
 *   flips its mesh winding.
 * - After the call, `context.setDirty()` marks *every* value MapLibre caches
 *   as dirty, including the program, the active texture unit, the texture,
 *   array-buffer, element-buffer and vertex-array bindings, and cull face. So
 *   anything left bound here is re-bound by MapLibre before it is next used.
 *
 * Restoring would therefore only duplicate work MapLibre has already
 * committed to, at the cost of a `gl.getParameter` round trip per value per
 * frame — and `getParameter` stalls the pipeline on many drivers.
 *
 * The one caveat is that `drawCustom` has no `try`/`finally`, so a throw out
 * of {@link render} skips `setDirty()`. That path leaves the frame broken
 * regardless, since the exception propagates out of MapLibre's render loop.
 *
 * This does **not** extend to tile uploads: those run asynchronously between
 * frames, outside MapLibre's bracket, and restore the state they touch
 * themselves.
 */
export abstract class RasterCustomLayer implements CustomLayerInterface {
  readonly id: string;
  readonly type = "custom" as const;
  readonly renderingMode = "2d" as const;

  protected map?: MapLibreMap;
  protected gl?: WebGL2RenderingContext;

  private programs?: ProgramCache;
  private scheduler?: TileScheduler<RasterTilePayload>;
  private sourceController?: AbortController;
  private warnedNonMercator = false;

  opacity: number;
  private readonly maxCacheByteSize: number | undefined;
  private readonly maxCacheSize: number | undefined;
  private readonly zRange: ZRange | null;

  constructor(props: RasterCustomLayerProps) {
    this.id = props.id;
    this.opacity = props.opacity ?? 1;
    this.maxCacheByteSize = props.maxCacheByteSize;
    this.maxCacheSize = props.maxCacheSize;
    this.zRange = props.zRange ?? null;
  }

  /**
   * Resolve the tile pyramid and the tile loader.
   *
   * Called once from {@link onAdd}. Return `null` to leave the layer empty.
   * Implementations should respect `signal` and return `null` when aborted.
   */
  protected abstract createSource(context: {
    map: MapLibreMap;
    gl: WebGL2RenderingContext;
    signal: AbortSignal;
  }): Promise<RasterSource | null>;

  /** Called after {@link createSource} resolves successfully. */
  protected onSourceReady?(source: RasterSource): void;

  onAdd(map: MapLibreMap, gl: WebGL2RenderingContext): void {
    this.map = map;
    this.gl = gl;
    this.programs = new ProgramCache(gl);

    const controller = new AbortController();
    this.sourceController = controller;

    void this.createSource({ map, gl, signal: controller.signal })
      .then((source) => {
        if (!source || controller.signal.aborted) {
          return;
        }
        this.scheduler = new TileScheduler<RasterTilePayload>({
          descriptor: source.descriptor,
          wgs84Bounds: source.wgs84Bounds,
          zRange: this.zRange,
          maxCacheByteSize: this.maxCacheByteSize,
          maxCacheSize: this.maxCacheSize,
          loadTile: (index, signal) => source.loadTile(index, { gl, signal }),
          destroyTile: (payload) => payload.destroy(gl),
          byteLengthOf: (payload) => payload.byteLength,
          // Repaint when a tile arrives or a retry falls due, never per frame.
          onNeedsRepaint: () => map.triggerRepaint(),
          onTileError: (index, error, { attempt, willRetry }) => {
            const tile = `tile ${index.z}/${index.x}/${index.y}`;
            // A blip that is about to be retried is not a failure yet, so do
            // not report it as one.
            if (willRetry) {
              console.warn(
                `[${this.id}] ${tile} failed (attempt ${attempt}), retrying`,
                error,
              );
            } else {
              console.error(`[${this.id}] ${tile} failed, giving up`, error);
            }
          },
        });
        this.onSourceReady?.(source);
        map.triggerRepaint();
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) {
          return;
        }
        console.error(`[${this.id}] failed to open raster source`, error);
      });
  }

  onRemove(_map: MapLibreMap, _gl: WebGL2RenderingContext): void {
    this.sourceController?.abort();
    this.scheduler?.destroy();
    this.programs?.destroy();
    this.scheduler = undefined;
    this.programs = undefined;
    this.map = undefined;
    this.gl = undefined;
  }

  render(gl: WebGL2RenderingContext, args: CustomRenderMethodInput): void {
    const { scheduler, programs, map } = this;
    if (!scheduler || !programs || !map) {
      return;
    }

    if (!isMercatorVariant(args.shaderData.variantName)) {
      if (!this.warnedNonMercator) {
        this.warnedNonMercator = true;
        console.warn(
          `[${this.id}] only the mercator projection is supported; ` +
            `skipping rendering under "${args.shaderData.variantName}".`,
        );
      }
      return;
    }

    const viewport = createRasterViewport(map, args, gl);
    const drawList = scheduler.update(viewport);
    if (drawList.length === 0) {
      return;
    }

    const centre = map.getCenter();
    const origin = mercatorFromLngLat(centre.lng, centre.lat);
    const [originXHigh, originXLow] = splitFloat64(origin[0]);
    const [originYHigh, originYLow] = splitFloat64(origin[1]);
    const projectionMatrix = translateMatrix(
      args.defaultProjectionData.mainMatrix,
      origin[0],
      origin[1],
    );

    this.drawTiles(gl, args, drawList, {
      projectionMatrix,
      originHigh: new Float32Array([originXHigh, originYHigh]),
      originLow: new Float32Array([originXLow, originYLow]),
    });
  }

  private drawTiles(
    gl: WebGL2RenderingContext,
    args: CustomRenderMethodInput,
    drawList: DrawableTile<RasterTilePayload>[],
    frame: {
      projectionMatrix: Float32Array;
      originHigh: Float32Array;
      originLow: Float32Array;
    },
  ): void {
    const programs = this.programs!;
    let currentProgram: WebGLProgram | null = null;

    for (const { payload } of drawList) {
      const program = programs.get(args.shaderData, payload.pipeline);

      if (program.program !== currentProgram) {
        gl.useProgram(program.program);
        currentProgram = program.program;
        program.setUniform("u_projection_matrix", frame.projectionMatrix);
        program.setUniform("u_origin_high", frame.originHigh);
        program.setUniform("u_origin_low", frame.originLow);
        program.setUniform("u_opacity", this.opacity);
      }

      program.bind(collectBindings(payload.pipeline));

      gl.bindVertexArray(payload.mesh.vao);
      gl.drawElements(
        gl.TRIANGLES,
        payload.mesh.indexCount,
        gl.UNSIGNED_INT,
        0,
      );
    }
    // Leave no VAO bound: `setCustomLayerDefaults` unbinds it for the *next*
    // custom layer, but MapLibre's own layers in this frame run first, and a
    // stray binding would capture their `vertexAttribPointer` calls.
    gl.bindVertexArray(null);
  }
}

/**
 * Right-multiply a column-major 4×4 matrix by a translation of `(tx, ty, 0)`,
 * in float64, and return the float32 result.
 *
 * Only the fourth column changes: `col3' = tx·col0 + ty·col1 + col3`. Doing it
 * here rather than in the shader is what keeps the uploaded matrix's
 * translation small, so float32 does not lose the map centre's precision.
 */
export function translateMatrix(
  matrix: ArrayLike<number>,
  tx: number,
  ty: number,
): Float32Array {
  const out = new Float32Array(16);
  for (let i = 0; i < 12; i++) {
    out[i] = matrix[i]!;
  }
  for (let row = 0; row < 4; row++) {
    out[12 + row] =
      matrix[row]! * tx + matrix[4 + row]! * ty + matrix[12 + row]!;
  }
  return out;
}
