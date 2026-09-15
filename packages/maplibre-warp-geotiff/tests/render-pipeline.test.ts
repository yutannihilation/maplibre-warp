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
          return () => 0;
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

describe("inferRenderPipeline without contour", () => {
  it("still rejects non-8-bit rasters", () => {
    expect(() =>
      inferRenderPipeline(
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
    const renderer = inferRenderPipeline(
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
    const renderer = inferRenderPipeline(
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
    const uint = inferRenderPipeline(
      fakeGeoTiff({ sampleFormat: SampleFormat.Uint, bitsPerSample: 16 }),
      stubGl(),
      { contour },
    );
    expect(moduleNames(uint.buildPipeline(textures))[0]).toBe(
      "value-texture-uint",
    );
    const int = inferRenderPipeline(
      fakeGeoTiff({ sampleFormat: SampleFormat.Int, bitsPerSample: 16 }),
      stubGl(),
      { contour },
    );
    expect(moduleNames(int.buildPipeline(textures))[0]).toBe(
      "value-texture-int",
    );
  });

  it("applies GDAL scale/offset and denormalises 8-bit samples", () => {
    const renderer = inferRenderPipeline(
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
    const bandsOnly = inferRenderPipeline(geotiff, stubGl(), {
      contour: { ...contour, lines: false },
    });
    expect(moduleNames(bandsOnly.buildPipeline(textures))).toEqual([
      "value-texture-float",
      "isoband",
    ]);
    const linesOnly = inferRenderPipeline(geotiff, stubGl(), {
      contour: { ...contour, bands: false },
    });
    expect(moduleNames(linesOnly.buildPipeline(textures))).toEqual([
      "value-texture-float",
      "clear-color",
      "contour-line",
    ]);
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
      inferRenderPipeline(
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

  it("rejects a colour count that does not match the bands", () => {
    expect(() =>
      inferRenderPipeline(
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
      const renderer = inferRenderPipeline(geotiff, gl, { contour });
      const built = renderer.buildPipeline(textures);
      const oldColors = (built[1]!.props as { colors: unknown }).colors;

      renderer.updateContour!(
        gl,
        resolveContourOptions({
          thresholds: [10, 20, 30, 40],
          bands: {
            colors: (t) => `rgb(${Math.round(t * 255)}, 0, 0)`,
            includeLower: true,
          },
          lines: { width: 3, color: "#fff" },
        }),
      );

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

    it("refuses what compiled programs and built tiles cannot follow", () => {
      const gl = stubGl();
      const renderer = inferRenderPipeline(geotiff, gl, { contour });
      const update = (options: Parameters<typeof resolveContourOptions>[0]) =>
        renderer.updateContour!(gl, resolveContourOptions(options));
      expect(() => update({ ...contour, bands: false })).toThrow(
        /switch bands/,
      );
      expect(() => update({ ...contour, lines: false })).toThrow(
        /switch lines/,
      );
      expect(() => update({ ...contour, band: 1 })).toThrow(RangeError);
      // Nothing was applied by a refused update.
      expect(renderer.buildPipeline(textures)[1]!.props).toMatchObject({
        thresholds: { count: 3 },
      });
    });

    it("is absent from the imagery renderer", () => {
      const renderer = inferRenderPipeline(
        fakeGeoTiff({ sampleFormat: SampleFormat.Uint, bitsPerSample: 8 }),
        stubGl(),
      );
      expect(renderer.updateContour).toBeUndefined();
    });
  });

  it("selects the requested band of a multi-band raster", () => {
    const renderer = inferRenderPipeline(
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
      validateContourOptions({ thresholds: [1], bands: false }),
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
      validateContourOptions({ thresholds: [1], bands: false, lines: false }),
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
    expect(resolveContourBands({ thresholds: [1], bands: false })).toEqual([]);
    expect(resolveContourBands({ thresholds: [1] })).toEqual([]);
  });
});

describe("contour tile loading", () => {
  const contour = { thresholds: [0.5], lines: { color: "#000" } };

  /** A stub GL plus the uploads it records. */
  function recordingGl() {
    const uploads: Upload[] = [];
    return { gl: stubGl(uploads), uploads };
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
    const renderer = inferRenderPipeline(geotiff, gl, { contour });
    const { image, fetchTiles } = fakeImage();

    const tile = await renderer.loadTileTextures(image, {
      gl,
      x: 0,
      y: 0,
      signal: new AbortController().signal,
    });

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
    const renderer = inferRenderPipeline(geotiff, gl, { contour });
    const { image, fetchTiles } = fakeImage();
    const signal = new AbortController().signal;
    await renderer.loadTileTextures(image, { gl, x: 0, y: 0, signal });
    await renderer.loadTileTextures(image, { gl, x: 1, y: 0, signal });
    // Every tile of the 2 × 2 image was already fetched for the first one.
    expect(fetchTiles).toHaveBeenCalledTimes(1);
  });

  it("renders a tile whose neighbour is missing, clamping that seam", async () => {
    const geotiff = fakeGeoTiff({
      sampleFormat: SampleFormat.Float,
      bitsPerSample: 32,
    });
    const { gl, uploads } = recordingGl();
    const renderer = inferRenderPipeline(geotiff, gl, { contour });
    const { image } = fakeImage(false, [[1, 0]]);
    const tile = await renderer.loadTileTextures(image, {
      gl,
      x: 0,
      y: 0,
      signal: new AbortController().signal,
    });
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
    const renderer = inferRenderPipeline(geotiff, gl, { contour });
    const { image } = fakeImage(false, [[0, 0]]);
    await expect(
      renderer.loadTileTextures(image, {
        gl,
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
    const renderer = inferRenderPipeline(geotiff, gl, { contour });
    const { image } = fakeImage(true);
    const tile = await renderer.loadTileTextures(image, {
      gl,
      x: 1,
      y: 1,
      signal: new AbortController().signal,
    });
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
    const renderer = inferRenderPipeline(geotiff, gl);
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
    const tile = await renderer.loadTileTextures(
      { fetchTile } as unknown as GeoTIFF,
      { gl, x: 0, y: 0, signal: new AbortController().signal },
    );
    expect(tile.halo).toBe(0);
    expect(uploads[0]).toMatchObject({ width: 2, height: 2 });
  });
});
