import { Photometric, SampleFormat } from "@cogeotiff/core";
import type { GeoTIFF } from "@developmentseed/geotiff";
import { describe, expect, it, vi } from "vitest";
import type { GeoTiffTileTextures } from "../src/render-pipeline.js";
import {
  inferRenderPipeline,
  resolveContourBands,
  resolveContourOptions,
  validateContourOptions,
} from "../src/render-pipeline.js";

/** A texImage2D upload seen by {@link stubGl}. */
interface Upload {
  width: number;
  height: number;
  data: unknown;
}

/**
 * A GL stub: constants read back as their names, calls are no-ops. Pass
 * `uploads` to record every texImage2D call.
 */
function stubGl(uploads?: Upload[]): WebGL2RenderingContext {
  return new Proxy(
    {},
    {
      get: (_target, name: string) => {
        if (name === "createTexture") {
          return () => ({ name: "texture" });
        }
        if (name === "getParameter") {
          return () => {
            throw new Error(
              "getParameter must not be called: GL state is never read back",
            );
          };
        }
        if (uploads && name === "texImage2D") {
          return (
            _t: unknown,
            _l: unknown,
            _if: unknown,
            width: number,
            height: number,
            _b: unknown,
            _f: unknown,
            _ty: unknown,
            data: unknown,
          ) => {
            uploads.push({ width, height, data });
          };
        }
        if (/^[a-z]/.test(name)) {
          return () => {};
        }
        return name;
      },
    },
  ) as unknown as WebGL2RenderingContext;
}

function fakeGeoTiff(tags: {
  sampleFormat: SampleFormat;
  bitsPerSample: number;
  samplesPerPixel?: number;
  nodata?: number | null;
  scales?: number[];
  offsets?: number[];
}): GeoTIFF {
  const samplesPerPixel = tags.samplesPerPixel ?? 1;
  return {
    cachedTags: {
      sampleFormat: Array(samplesPerPixel).fill(tags.sampleFormat),
      bitsPerSample: Uint16Array.from(
        Array(samplesPerPixel).fill(tags.bitsPerSample),
      ),
      samplesPerPixel,
      photometric: Photometric.MinIsBlack,
      colorMap: undefined,
      nodata: tags.nodata ?? null,
    },
    count: samplesPerPixel,
    scales: tags.scales ?? Array(samplesPerPixel).fill(1),
    offsets: tags.offsets ?? Array(samplesPerPixel).fill(0),
  } as unknown as GeoTIFF;
}

const textures: GeoTiffTileTextures = {
  width: 256,
  height: 128,
  halo: 0,
  texture: {} as WebGLTexture,
  byteLength: 0,
};

const moduleNames = (
  pipeline: ReturnType<ReturnType<typeof inferRenderPipeline>["buildPipeline"]>,
) => pipeline.map((m) => m.module.name);

/**
 * A renderer with its layer-wide textures created, as `COGLayer.prerender`
 * does before any tile is built.
 */
function preparedRenderer(
  ...args: Parameters<typeof inferRenderPipeline>
): ReturnType<typeof inferRenderPipeline> {
  const renderer = inferRenderPipeline(...args);
  renderer.prepare(args[1]);
  return renderer;
}

describe("inferRenderPipeline without contour", () => {
  it("still rejects non-8-bit rasters", () => {
    expect(() =>
      preparedRenderer(
        fakeGeoTiff({ sampleFormat: SampleFormat.Float, bitsPerSample: 32 }),
        stubGl(),
      ),
    ).toThrow(/supported so far/);
  });
});

describe("inferRenderPipeline with contour", () => {
  const contour = {
    thresholds: [100, 200, 300],
    bands: { colors: ["#000", "#888", "#fff"], includeLower: false },
    lines: { width: 1, color: "#333", majorEvery: 2 },
  };

  it("builds value → isoband → contour-line for a float32 DEM", () => {
    const renderer = preparedRenderer(
      fakeGeoTiff({
        sampleFormat: SampleFormat.Float,
        bitsPerSample: 32,
        nodata: -9999,
      }),
      stubGl(),
      { contour },
    );
    const pipeline = renderer.buildPipeline(textures);
    expect(moduleNames(pipeline)).toEqual([
      "value-texture-float",
      "isoband",
      "contour-line",
    ]);
    expect(pipeline[0]!.props).toMatchObject({
      band: 0,
      nodata: -9999,
      scale: 1,
      offset: 0,
      size: new Float32Array([256, 128]),
    });
    expect(pipeline[1]!.props).toMatchObject({
      thresholds: { count: 3 },
      includeLower: false,
      includeUpper: true,
    });
    expect(pipeline[2]!.props).toMatchObject({ width: 1, majorEvery: 2 });
    const lineColor = (pipeline[2]!.props as { color: Float32Array }).color;
    expect(Array.from(lineColor)).toEqual(
      Array.from(Float32Array.from([0x33 / 255, 0x33 / 255, 0x33 / 255, 1])),
    );
  });

  it("builds every tile's props from the same precomputed objects", () => {
    const renderer = preparedRenderer(
      fakeGeoTiff({ sampleFormat: SampleFormat.Float, bitsPerSample: 32 }),
      stubGl(),
      { contour },
    );
    const a = renderer.buildPipeline(textures);
    const b = renderer.buildPipeline({ ...textures, width: 64 });
    // No per-tile colour parsing or threshold packing on the render path.
    expect(a[1]!.props.thresholds).toBe(b[1]!.props.thresholds);
    expect(a[2]!.props.color).toBe(b[2]!.props.color);
  });

  it("picks the integer sampler variants for 16-bit data", () => {
    const uint = preparedRenderer(
      fakeGeoTiff({ sampleFormat: SampleFormat.Uint, bitsPerSample: 16 }),
      stubGl(),
      { contour },
    );
    expect(moduleNames(uint.buildPipeline(textures))[0]).toBe(
      "value-texture-uint",
    );
    const int = preparedRenderer(
      fakeGeoTiff({ sampleFormat: SampleFormat.Int, bitsPerSample: 16 }),
      stubGl(),
      { contour },
    );
    expect(moduleNames(int.buildPipeline(textures))[0]).toBe(
      "value-texture-int",
    );
  });

  it("applies GDAL scale/offset and denormalises 8-bit samples", () => {
    const renderer = preparedRenderer(
      fakeGeoTiff({
        sampleFormat: SampleFormat.Uint,
        bitsPerSample: 8,
        nodata: 255,
        scales: [0.5],
        offsets: [10],
      }),
      stubGl(),
      { contour },
    );
    const [seed] = renderer.buildPipeline(textures);
    // An 8-bit texture samples as [0, 1]; the seed must see raw units.
    expect(seed!.props).toMatchObject({
      scale: 255 * 0.5,
      offset: 10,
      nodata: 255 / 255,
    });
  });

  it("supports bands-only and lines-only chains", () => {
    const geotiff = fakeGeoTiff({
      sampleFormat: SampleFormat.Float,
      bitsPerSample: 32,
    });
    const bandsOnly = preparedRenderer(geotiff, stubGl(), {
      contour: { ...contour, lines: false },
    });
    expect(moduleNames(bandsOnly.buildPipeline(textures))).toEqual([
      "value-texture-float",
      "isoband",
    ]);
    const linesOnly = preparedRenderer(geotiff, stubGl(), {
      contour: { ...contour, fill: "none" },
    });
    expect(moduleNames(linesOnly.buildPipeline(textures))).toEqual([
      "value-texture-float",
      "clear-color",
      "contour-line",
    ]);
  });

  it("builds value → value-gradient → contour-line for a gradient fill", () => {
    const renderer = preparedRenderer(
      fakeGeoTiff({ sampleFormat: SampleFormat.Float, bitsPerSample: 32 }),
      stubGl(),
      {
        contour: {
          ...contour,
          fill: "gradient",
          bands: { colors: ["#000", "#fff"], includeLower: true },
        },
      },
    );
    const pipeline = renderer.buildPipeline(textures);
    expect(moduleNames(pipeline)).toEqual([
      "value-texture-float",
      "value-gradient",
      "contour-line",
    ]);
    // The ramp spans the first to the last threshold.
    expect(pipeline[1]!.props).toMatchObject({
      min: 100,
      max: 300,
      includeLower: true,
      includeUpper: true,
    });
  });

  it("requires colours for a fill and two thresholds for a gradient", () => {
    const geotiff = fakeGeoTiff({
      sampleFormat: SampleFormat.Float,
      bitsPerSample: 32,
    });
    expect(() =>
      preparedRenderer(geotiff, stubGl(), {
        contour: { thresholds: [1, 2] },
      }),
    ).toThrow(/needs `bands`/);
    expect(() =>
      preparedRenderer(geotiff, stubGl(), {
        contour: { thresholds: [1], fill: "gradient", bands: contour.bands },
      }),
    ).toThrow(/at least two/);
    expect(() =>
      preparedRenderer(geotiff, stubGl(), {
        contour: {
          thresholds: [1, 2],
          fill: "gradient",
          bands: { colors: ["#000"] },
        },
      }),
    ).toThrow(/at least two colour stops/);
  });

  it("exposes the band model with colours through resolveContourBands", () => {
    expect(resolveContourBands(contour)).toEqual([
      { band: 0, min: 100, max: 200, color: "#000" },
      { band: 1, min: 200, max: 300, color: "#888" },
      { band: 2, min: 300, color: "#fff" },
    ]);
  });

  it("rejects a configuration that emits no band", () => {
    expect(() =>
      preparedRenderer(
        fakeGeoTiff({ sampleFormat: SampleFormat.Float, bitsPerSample: 32 }),
        stubGl(),
        {
          contour: {
            thresholds: [500],
            bands: { colors: [], includeUpper: false },
          },
        },
      ),
    ).toThrow(RangeError);
  });

  it("refuses to build a tile's pipeline before prepare has created the colour textures", () => {
    const renderer = inferRenderPipeline(
      fakeGeoTiff({ sampleFormat: SampleFormat.Float, bitsPerSample: 32 }),
      stubGl(),
      { contour },
    );
    expect(() => renderer.buildPipeline(textures)).toThrow(/prepare\(gl\)/);
  });

  it("rejects a colour count that does not match the bands", () => {
    expect(() =>
      preparedRenderer(
        fakeGeoTiff({ sampleFormat: SampleFormat.Float, bitsPerSample: 32 }),
        stubGl(),
        { contour: { ...contour, bands: { colors: ["#000"] } } },
      ),
    ).toThrow(RangeError);
  });

  describe("updateContour", () => {
    const geotiff = fakeGeoTiff({
      sampleFormat: SampleFormat.Float,
      bitsPerSample: 32,
    });

    it("re-styles tiles that were built before the change", () => {
      const gl = stubGl();
      const renderer = preparedRenderer(geotiff, gl, { contour });
      const built = renderer.buildPipeline(textures);
      const oldColors = (built[1]!.props as { colors: unknown }).colors;

      renderer.updateContour!(
        resolveContourOptions({
          thresholds: [10, 20, 30, 40],
          bands: {
            colors: (t) => `rgb(${Math.round(t * 255)}, 0, 0)`,
            includeLower: true,
          },
          lines: { width: 3, color: "#fff" },
        }),
      );
      renderer.prepare(gl);

      // Same props objects, so the already-built pipeline sees the update…
      expect(built[1]!.props).toMatchObject({
        thresholds: { count: 4 },
        includeLower: true,
      });
      expect(Array.from(built[1]!.props.thresholds.values.slice(0, 4))).toEqual(
        [10, 20, 30, 40],
      );
      // …with a fresh lookup texture, since its width is the band count.
      expect(built[1]!.props.colors).not.toBe(oldColors);
      expect(built[2]!.props).toMatchObject({
        width: 3,
        majorEvery: undefined,
        thresholds: { count: 4 },
      });
      expect(Array.from(built[2]!.props.color)).toEqual([1, 1, 1, 1]);
      // Tiles built afterwards share the same objects still.
      const later = renderer.buildPipeline(textures);
      expect(later[1]!.props).toBe(built[1]!.props);
      expect(later[2]!.props).toBe(built[2]!.props);
    });

    it("switches the fill mode and lines on or off for built tiles", () => {
      const deleted: unknown[] = [];
      // `stubGl` answers every method itself, so intercept in front of it.
      const gl = new Proxy(stubGl(), {
        get: (target, name: string) =>
          name === "deleteTexture"
            ? (texture: unknown) => {
                deleted.push(texture);
              }
            : target[name as keyof WebGL2RenderingContext],
      });
      const renderer = preparedRenderer(geotiff, gl, { contour });
      const built = renderer.buildPipeline(textures);
      const other = renderer.buildPipeline({ ...textures, width: 64 });
      const bandTexture = built[1]!.props.colors.texture;
      const update = (
        options: Parameters<typeof resolveContourOptions>[0],
      ): void => {
        renderer.updateContour!(resolveContourOptions(options));
        renderer.prepare(gl);
      };

      update({ ...contour, fill: "gradient", lines: false });
      // The same arrays, re-filled: the payloads keep pointing at them.
      expect(moduleNames(built)).toEqual([
        "value-texture-float",
        "value-gradient",
      ]);
      expect(moduleNames(other)).toEqual(moduleNames(built));
      expect(built[1]!.props).toMatchObject({ min: 100, max: 300 });
      expect(other[1]!.props).toBe(built[1]!.props);
      // The band lookup texture went with the bands.
      expect(deleted).toContain(bandTexture);
      // The seed still describes its own tile.
      expect(other[0]!.props.size).toEqual(new Float32Array([64, 128]));

      update({ ...contour, fill: "none" });
      expect(moduleNames(built)).toEqual([
        "value-texture-float",
        "clear-color",
        "contour-line",
      ]);

      update(contour);
      expect(moduleNames(built)).toEqual([
        "value-texture-float",
        "isoband",
        "contour-line",
      ]);
      // Tiles built afterwards share the current objects.
      expect(renderer.buildPipeline(textures)[1]!.props).toBe(built[1]!.props);
    });

    it("stops rebuilding a tile once its textures are destroyed", () => {
      const gl = stubGl();
      const renderer = preparedRenderer(geotiff, gl, { contour });
      const gone = { ...textures };
      const pipeline = renderer.buildPipeline(gone);
      renderer.destroyTileTextures(gl, gone);
      renderer.updateContour!(
        resolveContourOptions({ ...contour, fill: "none" }),
      );
      renderer.prepare(gl);
      expect(moduleNames(pipeline)).toEqual([
        "value-texture-float",
        "isoband",
        "contour-line",
      ]);
    });

    it("refuses to change the band", () => {
      const gl = stubGl();
      const renderer = preparedRenderer(geotiff, gl, { contour });
      expect(() =>
        renderer.updateContour!(resolveContourOptions({ ...contour, band: 1 })),
      ).toThrow(RangeError);
      // Nothing was applied by a refused update.
      expect(renderer.buildPipeline(textures)[1]!.props).toMatchObject({
        thresholds: { count: 3 },
      });
    });

    it("defers the change to prepare, so tiles keep a consistent style until then", () => {
      const gl = stubGl();
      const renderer = preparedRenderer(geotiff, gl, { contour });
      const built = renderer.buildPipeline(textures);
      renderer.updateContour!(
        resolveContourOptions({ ...contour, fill: "none" }),
      );
      // Recorded, not applied: `setContour` may be called at any time, but
      // textures are only created inside MapLibre's GL bracket, in `prepare`.
      const before = ["value-texture-float", "isoband", "contour-line"];
      expect(moduleNames(built)).toEqual(before);
      // A tile built meanwhile gets the current style too, not the pending one.
      expect(moduleNames(renderer.buildPipeline({ ...textures }))).toEqual(
        before,
      );

      renderer.prepare(gl);
      expect(moduleNames(built)).toEqual([
        "value-texture-float",
        "clear-color",
        "contour-line",
      ]);
    });

    it("creates textures in prepare only when something is pending", () => {
      let created = 0;
      const gl = new Proxy(stubGl(), {
        get: (target, name: string) =>
          name === "createTexture"
            ? () => {
                created++;
                return { name: "texture" };
              }
            : target[name as keyof WebGL2RenderingContext],
      });
      const renderer = inferRenderPipeline(geotiff, gl, { contour });
      // Nothing at construction: it may run between frames.
      expect(created).toBe(0);
      renderer.prepare(gl);
      expect(created).toBe(1);
      renderer.prepare(gl);
      expect(created).toBe(1);
      renderer.updateContour!(
        resolveContourOptions({ ...contour, lines: false }),
      );
      renderer.prepare(gl);
      expect(created).toBe(2);
    });

    /** A stub GL whose `createTexture` fails while `failing.on` is set. */
    function flakyGl() {
      const failing = { on: false };
      const gl = new Proxy(stubGl(), {
        get: (target, name: string) =>
          name === "createTexture"
            ? () => (failing.on ? null : { name: "texture" })
            : target[name as keyof WebGL2RenderingContext],
      });
      return { gl, failing };
    }

    it("reports a failed re-style once and keeps the previous style", () => {
      const { gl, failing } = flakyGl();
      const renderer = preparedRenderer(geotiff, gl, { contour });
      const built = renderer.buildPipeline(textures);
      const oldFill = built[1]!.props;

      renderer.updateContour!(
        resolveContourOptions({ ...contour, lines: false }),
      );
      failing.on = true;
      expect(() => renderer.prepare(gl)).toThrow(/Failed to create/);
      // Consumed: the next frame's prepare does not throw again.
      expect(() => renderer.prepare(gl)).not.toThrow();
      expect(moduleNames(built)).toEqual([
        "value-texture-float",
        "isoband",
        "contour-line",
      ]);
      expect(built[1]!.props).toBe(oldFill);

      // A later change still applies once textures can be created again.
      failing.on = false;
      renderer.updateContour!(
        resolveContourOptions({ ...contour, lines: false }),
      );
      renderer.prepare(gl);
      expect(moduleNames(built)).toEqual(["value-texture-float", "isoband"]);
    });

    it("reports a failed first prepare once and recovers on the next change", () => {
      const { gl, failing } = flakyGl();
      const renderer = inferRenderPipeline(geotiff, gl, { contour });
      failing.on = true;
      expect(() => renderer.prepare(gl)).toThrow(/Failed to create/);
      expect(() => renderer.prepare(gl)).not.toThrow();
      expect(() => renderer.buildPipeline(textures)).toThrow(/prepare\(gl\)/);

      failing.on = false;
      renderer.updateContour!(resolveContourOptions(contour));
      renderer.prepare(gl);
      expect(moduleNames(renderer.buildPipeline(textures))[1]).toBe("isoband");
    });

    it("is absent from the imagery renderer", () => {
      const renderer = preparedRenderer(
        fakeGeoTiff({ sampleFormat: SampleFormat.Uint, bitsPerSample: 8 }),
        stubGl(),
      );
      expect(renderer.updateContour).toBeUndefined();
    });
  });

  it("selects the requested band of a multi-band raster", () => {
    const renderer = preparedRenderer(
      fakeGeoTiff({
        sampleFormat: SampleFormat.Float,
        bitsPerSample: 32,
        samplesPerPixel: 2,
        scales: [1, 2],
      }),
      stubGl(),
      { contour: { ...contour, band: 1 } },
    );
    expect(renderer.buildPipeline(textures)[0]!.props).toMatchObject({
      band: 1,
      scale: 2,
    });
  });
});

describe("validateContourOptions", () => {
  const base = { thresholds: [1, 2], bands: { colors: ["#000", "#fff"] } };

  it("accepts a valid configuration", () => {
    expect(() => validateContourOptions(base)).not.toThrow();
    expect(() =>
      validateContourOptions({ thresholds: [1], fill: "none" }),
    ).not.toThrow();
    expect(() =>
      validateContourOptions({ ...base, fill: "gradient" }),
    ).not.toThrow();
  });

  it("rejects every configuration error before any I/O", () => {
    expect(() =>
      validateContourOptions({ ...base, thresholds: [2, 1] }),
    ).toThrow(RangeError);
    expect(() =>
      validateContourOptions({
        ...base,
        thresholds: Array.from({ length: 65 }, (_, i) => i),
      }),
    ).toThrow(RangeError);
    expect(() =>
      validateContourOptions({ ...base, bands: { colors: ["red", "#fff"] } }),
    ).toThrow(RangeError);
    expect(() =>
      validateContourOptions({ ...base, bands: { colors: ["#000"] } }),
    ).toThrow(RangeError);
    expect(() =>
      validateContourOptions({ ...base, lines: { color: "blue" } }),
    ).toThrow(RangeError);
    expect(() =>
      validateContourOptions({
        ...base,
        lines: { majorColor: "hsl(0 0% 0%)" },
      }),
    ).toThrow(RangeError);
    expect(() =>
      validateContourOptions({ thresholds: [1], fill: "none", lines: false }),
    ).toThrow(RangeError);
    expect(() =>
      validateContourOptions({
        ...base,
        fill: "solid" as unknown as "bands",
      }),
    ).toThrow(RangeError);
    expect(() =>
      validateContourOptions({
        thresholds: [1],
        bands: { colors: [], includeUpper: false },
      }),
    ).toThrow(RangeError);
    expect(() => validateContourOptions({ ...base, band: -1 })).toThrow(
      RangeError,
    );
    expect(() => validateContourOptions({ ...base, band: 1.5 })).toThrow(
      RangeError,
    );
    expect(() =>
      validateContourOptions({ ...base, lines: { width: -1 } }),
    ).toThrow(RangeError);
  });

  it("checks the band index against the sample count when known", () => {
    expect(() => validateContourOptions({ ...base, band: 2 }, 2)).toThrow(
      RangeError,
    );
    expect(() => validateContourOptions({ ...base, band: 1 }, 2)).not.toThrow();
  });
});

describe("resolveContourBands", () => {
  it("returns the band model with colours, empty without bands", () => {
    expect(
      resolveContourBands({
        thresholds: [1, 2],
        bands: {
          colors: (t) => `rgb(${Math.round(t * 255)}, 0, 0)`,
          includeLower: true,
        },
      }),
    ).toEqual([
      { band: 0, max: 1, color: "rgb(0, 0, 0)" },
      { band: 1, min: 1, max: 2, color: "rgb(128, 0, 0)" },
      { band: 2, min: 2, color: "rgb(255, 0, 0)" },
    ]);
    expect(resolveContourBands({ thresholds: [1], fill: "none" })).toEqual([]);
    expect(resolveContourBands({ thresholds: [1] })).toEqual([]);
    expect(
      resolveContourBands({
        thresholds: [1, 2],
        fill: "gradient",
        bands: { colors: ["#000", "#fff"] },
      }),
    ).toEqual([]);
  });
});

describe("contour tile loading", () => {
  const contour = {
    thresholds: [0.5],
    fill: "none" as const,
    lines: { color: "#000" },
  };

  /** A stub GL plus the uploads it records. */
  function recordingGl() {
    const uploads: Upload[] = [];
    return { gl: stubGl(uploads), uploads };
  }

  /** Decode, then upload — the two halves the loader and `prerender` run. */
  async function loadTile(
    renderer: ReturnType<typeof inferRenderPipeline>,
    gl: WebGL2RenderingContext,
    image: GeoTIFF,
    x: number,
    y: number,
  ) {
    const pixels = await renderer.loadTilePixels(image, {
      x,
      y,
      signal: new AbortController().signal,
    });
    return renderer.uploadTileTextures(gl, pixels);
  }

  /**
   * A 2 × 2-tile image of 2 × 2-pixel float tiles, each filled with 10·x + y.
   * Tiles listed in `failing` are missing, as a sparse COG's would be.
   */
  function fakeImage(withMask = false, failing: Array<[number, number]> = []) {
    const fails = (x: number, y: number) =>
      failing.some(([fx, fy]) => fx === x && fy === y);
    const tileAt = (x: number, y: number) => {
      if (fails(x, y)) {
        throw new Error(`Tile at (${x}, ${y}) not found`);
      }
      return {
        x,
        y,
        array: {
          layout: "pixel-interleaved" as const,
          width: 2,
          height: 2,
          count: 1,
          data: new Float32Array(4).fill(10 * x + y),
          mask: withMask ? new Uint8Array([255, 255, 0, 255]) : null,
        },
      };
    };
    const fetchTiles = vi.fn(async (xy: Array<[number, number]>) =>
      xy.map(([x, y]) => tileAt(x, y)),
    );
    const fetchTile = vi.fn(async (x: number, y: number) => tileAt(x, y));
    return {
      image: {
        tileCount: { x: 2, y: 2 },
        fetchTiles,
        fetchTile,
      } as unknown as GeoTIFF,
      fetchTiles,
      fetchTile,
    };
  }

  it("pads each tile with a halo stitched from its neighbours", async () => {
    const geotiff = fakeGeoTiff({
      sampleFormat: SampleFormat.Float,
      bitsPerSample: 32,
    });
    const { gl, uploads } = recordingGl();
    const renderer = preparedRenderer(geotiff, gl, { contour });
    const { image, fetchTiles } = fakeImage();

    const tile = await loadTile(renderer, gl, image, 0, 0);

    // Content size is reported; the texture itself is padded.
    expect(tile).toMatchObject({ width: 2, height: 2, halo: 1 });
    expect(uploads).toHaveLength(1);
    expect(uploads[0]).toMatchObject({ width: 4, height: 4 });
    expect(tile.byteLength).toBe(4 * 4 * 4);
    // Top-left tile: only right (1,0), bottom (0,1) and diagonal (1,1) exist.
    expect(fetchTiles).toHaveBeenCalledTimes(1);
    expect(fetchTiles.mock.calls[0]![0]).toEqual([
      [0, 0],
      [1, 0],
      [0, 1],
      [1, 1],
    ]);
    // Row 1 of the padded texture: [clamp, 0, 0, right neighbour = 10].
    expect(Array.from(uploads[0]!.data as Float32Array)).toEqual([
      0, 0, 0, 10, 0, 0, 0, 10, 0, 0, 0, 10, 1, 1, 1, 11,
    ]);

    // The pipeline hands the halo to the seed.
    const seed = renderer.buildPipeline(tile)[0]!;
    expect(seed.props).toMatchObject({ halo: 1 });
    expect((seed.props as { size: Float32Array }).size).toEqual(
      new Float32Array([2, 2]),
    );
  });

  it("reuses cached neighbours for the next tile", async () => {
    const geotiff = fakeGeoTiff({
      sampleFormat: SampleFormat.Float,
      bitsPerSample: 32,
    });
    const { gl } = recordingGl();
    const renderer = preparedRenderer(geotiff, gl, { contour });
    const { image, fetchTiles } = fakeImage();
    const signal = new AbortController().signal;
    await renderer.loadTilePixels(image, { x: 0, y: 0, signal });
    await renderer.loadTilePixels(image, { x: 1, y: 0, signal });
    // Every tile of the 2 × 2 image was already fetched for the first one.
    expect(fetchTiles).toHaveBeenCalledTimes(1);
  });

  it("renders a tile whose neighbour is missing, clamping that seam", async () => {
    const geotiff = fakeGeoTiff({
      sampleFormat: SampleFormat.Float,
      bitsPerSample: 32,
    });
    const { gl, uploads } = recordingGl();
    const renderer = preparedRenderer(geotiff, gl, { contour });
    const { image } = fakeImage(false, [[1, 0]]);
    const tile = await loadTile(renderer, gl, image, 0, 0);
    expect(tile).toMatchObject({ width: 2, height: 2, halo: 1 });
    // Right column clamps to the centre (0) where (1,0) would have been 10;
    // the bottom row still comes from (0,1) and the corner from (1,1).
    expect(Array.from(uploads[0]!.data as Float32Array)).toEqual([
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 11,
    ]);
  });

  it("fails the load only when the tile itself is missing", async () => {
    const geotiff = fakeGeoTiff({
      sampleFormat: SampleFormat.Float,
      bitsPerSample: 32,
    });
    const { gl } = recordingGl();
    const renderer = preparedRenderer(geotiff, gl, { contour });
    const { image } = fakeImage(false, [[0, 0]]);
    await expect(
      renderer.loadTilePixels(image, {
        x: 0,
        y: 0,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("Tile at (0, 0) not found");
  });

  it("uploads the mask at content size, unpadded", async () => {
    const geotiff = fakeGeoTiff({
      sampleFormat: SampleFormat.Float,
      bitsPerSample: 32,
    });
    const { gl, uploads } = recordingGl();
    const renderer = preparedRenderer(geotiff, gl, { contour });
    const { image } = fakeImage(true);
    const tile = await loadTile(renderer, gl, image, 1, 1);
    expect(tile.mask).toBeDefined();
    expect(uploads.map((u) => [u.width, u.height])).toEqual([
      [4, 4],
      [2, 2],
    ]);
    expect(tile.byteLength).toBe(4 * 4 * 4 + 2 * 2);
  });

  it("leaves the RGB renderer without a halo", async () => {
    const geotiff = fakeGeoTiff({
      sampleFormat: SampleFormat.Uint,
      bitsPerSample: 8,
      samplesPerPixel: 4,
    });
    const { gl, uploads } = recordingGl();
    const renderer = preparedRenderer(geotiff, gl);
    const fetchTile = vi.fn(async (x: number, y: number) => ({
      x,
      y,
      array: {
        layout: "pixel-interleaved" as const,
        width: 2,
        height: 2,
        count: 4,
        data: new Uint8Array(16),
        mask: null,
      },
    }));
    const tile = await loadTile(
      renderer,
      gl,
      { fetchTile } as unknown as GeoTIFF,
      0,
      0,
    );
    expect(tile.halo).toBe(0);
    expect(uploads[0]).toMatchObject({ width: 2, height: 2 });
  });
});
