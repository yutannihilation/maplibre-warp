import { Photometric, SampleFormat } from "@cogeotiff/core";
import type { GeoTIFF } from "@developmentseed/geotiff";
import { describe, expect, it } from "vitest";
import type { GeoTiffTileTextures } from "../src/render-pipeline.js";
import {
  inferRenderPipeline,
  resolveContourBands,
  resolveContourOptions,
  validateContourOptions,
} from "../src/render-pipeline.js";

/** A GL stub: constants read back as their names, calls are no-ops. */
function stubGl(): WebGL2RenderingContext {
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
