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
import { projectionFromVariant } from "./projection.js";
import type { RenderPipeline, UniformValue } from "./shader/module.js";
import { collectBindings } from "./shader/module.js";
import { ProgramCache } from "./shader/program.js";
import type { DrawableTile } from "./tile-scheduler.js";
import { TileScheduler } from "./tile-scheduler.js";
import type { RasterTilesetDescriptor } from "./tileset/tileset-interface.js";
import type { Bounds, TileIndex, ZRange } from "./tileset/types.js";
import { createRasterViewport } from "./viewport-shim.js";

const DEFAULT_RETRY_BASE_DELAY = 1000;
const DEFAULT_MAX_RETRIES = 3;

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
  /**
   * Delay before the first retry of a failed load, in milliseconds. Each
   * further failure doubles it.
   *
   * Applies both to opening the source and to individual tile loads, so a
   * transient outage is described by one pair of knobs rather than two.
   *
   * @default 1000
   */
  retryBaseDelay?: number;
  /**
   * How many times to retry a failed load before giving up.
   *
   * @default 3
   */
  maxRetries?: number;
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
 * ## Projections
 *
 * The layer follows whichever projection the map is rendering with, read each
 * frame from `shaderData.variantName`: `"mercator"` and `"globe"` (which also
 * covers the animated globe↔mercator transition) are supported; anything else
 * warns once and draws nothing. Tile culling, LOD and the vertex shader all
 * dispatch on it — see `viewport-shim.ts` and `shader/sources.ts`. The
 * relative-to-centre precision scheme is mercator-only; under globe positions
 * are absolute float32 mercator, as they are for MapLibre's own layers.
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
  private warnedUnsupportedProjection = false;

  opacity: number;
  private readonly maxCacheByteSize: number | undefined;
  private readonly maxCacheSize: number | undefined;
  private readonly retryBaseDelay: number;
  private readonly maxRetries: number;
  private readonly zRange: ZRange | null;

  constructor(props: RasterCustomLayerProps) {
    this.id = props.id;
    this.opacity = props.opacity ?? 1;
    this.maxCacheByteSize = props.maxCacheByteSize;
    this.maxCacheSize = props.maxCacheSize;
    this.retryBaseDelay = props.retryBaseDelay ?? DEFAULT_RETRY_BASE_DELAY;
    this.maxRetries = props.maxRetries ?? DEFAULT_MAX_RETRIES;
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

    void this.openSource(map, gl, controller.signal);
  }

  /**
   * Open the source, retrying on failure with the same backoff the tile loads
   * use.
   *
   * Without this a single transient failure while reading the COG header left
   * the layer permanently empty: nothing retried, and the only trace was one
   * logged rejection. That is a worse outcome than a failed tile, because it
   * takes out the whole layer rather than one tile's footprint.
   */
  private async openSource(
    map: MapLibreMap,
    gl: WebGL2RenderingContext,
    signal: AbortSignal,
  ): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      // Checked here, not only after `createSource`, because `sleep` resolves
      // early when the signal aborts: without this the loop would start one
      // more attempt on a layer that has already been removed.
      if (signal.aborted) {
        return;
      }
      try {
        const source = await this.createSource({ map, gl, signal });
        if (signal.aborted || !source) {
          return;
        }
        this.attachSource(source, map, gl);
        return;
      } catch (error) {
        if (signal.aborted) {
          return;
        }
        if (attempt > this.maxRetries) {
          console.error(
            `[${this.id}] failed to open raster source, giving up`,
            error,
          );
          return;
        }
        console.warn(
          `[${this.id}] failed to open raster source (attempt ${attempt}), retrying`,
          error,
        );
        await sleep(this.retryBaseDelay * 2 ** (attempt - 1), signal);
      }
    }
  }

  /** Wire a resolved source up to a scheduler and ask for the first paint. */
  private attachSource(
    source: RasterSource,
    map: MapLibreMap,
    gl: WebGL2RenderingContext,
  ): void {
    this.scheduler = new TileScheduler<RasterTilePayload>({
      descriptor: source.descriptor,
      wgs84Bounds: source.wgs84Bounds,
      zRange: this.zRange,
      maxCacheByteSize: this.maxCacheByteSize,
      maxCacheSize: this.maxCacheSize,
      retryBaseDelay: this.retryBaseDelay,
      maxRetries: this.maxRetries,
      loadTile: (index, signal) => source.loadTile(index, { gl, signal }),
      destroyTile: (payload) => payload.destroy(gl),
      byteLengthOf: (payload) => payload.byteLength,
      // Repaint when a tile arrives or a retry falls due, never per frame.
      onNeedsRepaint: () => map.triggerRepaint(),
      onTileError: (index, error, { attempt, willRetry }) => {
        const tile = `tile ${index.z}/${index.x}/${index.y}`;
        // A blip that is about to be retried is not a failure yet, so do not
        // report it as one.
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

    const projection = projectionFromVariant(args.shaderData.variantName);
    if (!projection) {
      if (!this.warnedUnsupportedProjection) {
        this.warnedUnsupportedProjection = true;
        console.warn(
          `[${this.id}] unsupported MapLibre shader variant ` +
            `"${args.shaderData.variantName}"; skipping rendering.`,
        );
      }
      return;
    }

    const viewport = createRasterViewport(map, args, gl);
    const drawList = scheduler.update(viewport);
    if (drawList.length === 0) {
      return;
    }

    const frameUniforms =
      projection === "globe"
        ? globeFrameUniforms(args)
        : mercatorFrameUniforms(map, args);
    frameUniforms.u_opacity = this.opacity;

    this.drawTiles(gl, args, drawList, frameUniforms);
  }

  private drawTiles(
    gl: WebGL2RenderingContext,
    args: CustomRenderMethodInput,
    drawList: DrawableTile<RasterTilePayload>[],
    frameUniforms: Record<string, UniformValue>,
  ): void {
    const programs = this.programs!;
    let currentProgram: WebGLProgram | null = null;

    for (const { payload } of drawList) {
      const program = programs.get(args.shaderData, payload.pipeline);

      if (program.program !== currentProgram) {
        gl.useProgram(program.program);
        currentProgram = program.program;
        for (const [name, value] of Object.entries(frameUniforms)) {
          program.setUniform(name, value);
        }
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
 * Per-frame uniforms for the mercator vertex shader: the relative-to-centre
 * scheme described in `shader/sources.ts`.
 *
 * Exported for unit testing.
 */
export function mercatorFrameUniforms(
  map: MapLibreMap,
  args: CustomRenderMethodInput,
): Record<string, UniformValue> {
  const centre = map.getCenter();
  const origin = mercatorFromLngLat(centre.lng, centre.lat);
  const [originXHigh, originXLow] = splitFloat64(origin[0]);
  const [originYHigh, originYLow] = splitFloat64(origin[1]);
  return {
    u_projection_matrix: translateMatrix(
      args.defaultProjectionData.mainMatrix,
      origin[0],
      origin[1],
    ),
    u_origin_high: new Float32Array([originXHigh, originYHigh]),
    u_origin_low: new Float32Array([originXLow, originYLow]),
  };
}

/**
 * Per-frame uniforms for the globe vertex shader: everything MapLibre's globe
 * prelude declares, passed through from `defaultProjectionData` untouched.
 * Positions are absolute under globe, so no translation is folded in.
 *
 * Exported for unit testing.
 */
export function globeFrameUniforms(
  args: CustomRenderMethodInput,
): Record<string, UniformValue> {
  const {
    mainMatrix,
    tileMercatorCoords,
    clippingPlane,
    projectionTransition,
    fallbackMatrix,
  } = args.defaultProjectionData;
  return {
    u_projection_matrix: new Float32Array(mainMatrix),
    u_projection_tile_mercator_coords: new Float32Array(tileMercatorCoords),
    u_projection_clipping_plane: new Float32Array(clippingPlane),
    u_projection_transition: projectionTransition,
    u_projection_fallback_matrix: new Float32Array(fallbackMatrix),
  };
}

/**
 * Wait `ms`, or resolve early if `signal` aborts.
 *
 * Resolving rather than rejecting on abort keeps the retry loop's control flow
 * in one place: the caller re-checks `signal.aborted` and returns.
 */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
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
