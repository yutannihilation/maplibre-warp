import type { GeoTIFF } from "@developmentseed/geotiff";
import type { ProjectionDefinition } from "@developmentseed/proj";
import type {
  RasterCustomLayerProps,
  RasterSource,
} from "@yutannihilation/maplibre-warp-raster";
import { RasterCustomLayer } from "@yutannihilation/maplibre-warp-raster";
import type { Map as MapLibreMap } from "maplibre-gl";
import type { OpenCogSourceProps } from "./open-cog-source.js";
import { openCogSource } from "./open-cog-source.js";
import type {
  ContourBandWithColor,
  ContourGradient,
  ContourRenderOptions,
  GeoTiffRenderer,
  ResolvedContourOptions,
} from "./render-pipeline.js";
import {
  inferRenderPipeline,
  resolveContourOptions,
} from "./render-pipeline.js";

export interface COGLayerProps
  extends RasterCustomLayerProps,
    OpenCogSourceProps {
  /**
   * Render the raster as contours — filled bands or a continuous gradient,
   * with or without lines — instead of as imagery. See
   * {@link ContourRenderOptions}; {@link COGLayer.setContour} switches
   * between them live.
   */
  contour?: ContourRenderOptions;

  /** Called once the GeoTIFF header has been read and its CRS resolved. */
  onGeoTIFFLoad?(
    geotiff: GeoTIFF,
    info: {
      projection: ProjectionDefinition;
      geographicBounds: {
        west: number;
        south: number;
        east: number;
        north: number;
      };
    },
  ): void;
}

/**
 * Renders a COG as a MapLibre custom layer, reprojecting from the file's own
 * CRS on the GPU.
 *
 * ```ts
 * map.addLayer(
 *   new COGLayer({ id: "cog", geotiff: url }),
 *   "waterway-label", // draw under MapLibre's labels
 * );
 * ```
 */
export class COGLayer extends RasterCustomLayer {
  private readonly props: COGLayerProps;
  /** Current contour options; starts as `props.contour`, see {@link setContour}. */
  private contour?: ContourRenderOptions;
  /** Band model of {@link contour}, resolved once alongside its validation. */
  private contourBands: ContourBandWithColor[] = [];
  /** Gradient model of {@link contour}, likewise. */
  private contourGradient: ContourGradient | null = null;
  private renderer?: GeoTiffRenderer;
  private geotiff?: GeoTIFF;

  constructor(props: COGLayerProps) {
    super(props);
    if (props.contour) {
      // Fail here rather than inside the retried source-open path.
      this.rememberContourModel(resolveContourOptions(props.contour));
    }
    this.props = props;
    this.contour = props.contour;
  }

  private rememberContourModel(resolved: ResolvedContourOptions): void {
    this.contourBands = resolved.bands;
    this.contourGradient = resolved.gradient
      ? {
          min: resolved.gradient.min,
          max: resolved.gradient.max,
          stops: resolved.gradient.stops,
        }
      : null;
  }

  /** The opened GeoTIFF, once the header has been read. */
  get source(): GeoTIFF | undefined {
    return this.geotiff;
  }

  /**
   * The contour band model with colours, for legends. Available before the
   * COG has opened, since it depends only on the options; empty unless the
   * fill is `"bands"`.
   */
  getBands(): ContourBandWithColor[] {
    return this.contourBands.slice();
  }

  /**
   * The gradient fill's domain and colour stops, for legends. Available
   * before the COG has opened; `null` unless the fill is `"gradient"`.
   */
  getGradient(): ContourGradient | null {
    return this.contourGradient
      ? { ...this.contourGradient, stops: this.contourGradient.stops.slice() }
      : null;
  }

  /**
   * Re-style the contours without reloading anything: thresholds, colours,
   * the fill mode (`"bands"`, `"gradient"`, `"none"`), lines on or off and
   * their style. Tiles already on the GPU pick the change up on the next
   * frame; a new module chain is compiled on demand. Takes effect immediately
   * when the layer is on a map, or at `onAdd` otherwise.
   *
   * Refused with a `RangeError`: any option that fails the constructor's
   * validation, a layer created without `contour` (its tiles hold imagery
   * textures, not values), and changing `band`. Recreate the layer for
   * those.
   */
  setContour(contour: ContourRenderOptions): void {
    if (!this.contour) {
      throw new RangeError(
        "setContour needs a layer created with `contour`; imagery cannot be switched to contours in place",
      );
    }
    // Resolved exactly once: this validates, feeds the renderer, and is what
    // `getBands()` hands out afterwards.
    const resolved = resolveContourOptions(
      contour,
      this.geotiff?.cachedTags.samplesPerPixel,
    );
    if (this.renderer && this.gl) {
      if (!this.renderer.updateContour) {
        throw new Error("the active renderer does not support updateContour");
      }
      this.renderer.updateContour(this.gl, resolved);
      this.map?.triggerRepaint();
    }
    this.contour = contour;
    this.rememberContourModel(resolved);
  }

  override onRemove(map: MapLibreMap, gl: WebGL2RenderingContext): void {
    super.onRemove(map, gl);
    this.renderer?.destroy(gl);
    this.renderer = undefined;
    this.geotiff = undefined;
  }

  protected async createSource({
    gl,
    signal,
  }: {
    map: MapLibreMap;
    gl: WebGL2RenderingContext;
    signal: AbortSignal;
  }): Promise<RasterSource | null> {
    // A retry re-runs this method, so release anything a previous attempt
    // managed to allocate before it failed. `inferRenderPipeline` can have
    // uploaded a colormap texture by then.
    this.renderer?.destroy(gl);
    this.renderer = undefined;
    this.geotiff = undefined;

    const source = await openCogSource(this.props, {
      gl,
      signal,
      createRenderer: (geotiff, glContext) => {
        // Set as soon as they exist, not when the open resolves, so a
        // `setContour` that lands during the open reaches the renderer.
        this.geotiff = geotiff;
        const renderer = inferRenderPipeline(geotiff, glContext, {
          contour: this.contour,
        });
        this.renderer = renderer;
        return renderer;
      },
    });
    if (!source) {
      return null;
    }

    this.props.onGeoTIFFLoad?.(source.geotiff, {
      projection: source.projection,
      // The unclamped extent: callers want the dataset's true footprint,
      // while `source.wgs84Bounds` is clamped for tile selection.
      geographicBounds: source.geographicBounds,
    });

    return source;
  }
}
