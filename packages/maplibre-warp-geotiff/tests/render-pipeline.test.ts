import { Photometric, SampleFormat } from "@cogeotiff/core";
import type { GeoTIFF } from "@developmentseed/geotiff";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GeoTiffTileTextures } from "../src/render-pipeline.js";
import {
  inferRenderPipeline,
  resolveContourBands,
  resolveContourOptions,
  validateContourOptions,
} from "../src/render-pipeline.js";

/** A texture upload seen by {@link stubGl}: a 2D image, or one array layer. */
interface Upload {
  width: number;
  height: number;
  /** Set for array layers (`texSubImage3D`). */
  layer?: number;
  data: unknown;
}

/**
 * A GL stub: constants read back as their names, calls are no-ops. Pass
 * `uploads` to record every texImage2D / texSubImage3D call.
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
          return (pname: string) =>
            pname === "MAX_ARRAY_TEXTURE_LAYERS" ? 256 : 0;
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
        if (uploads && name === "texSubImage3D") {
          return (
            _t: unknown,
            _l: unknown,
            _x: unknown,
            _y: unknown,
            layer: number,
            width: number,
            height: number,
            _d: unknown,
            _f: unknown,
            _ty: unknown,
            data: unknown,
          ) => {
            uploads.push({ width, height, layer, data });
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
  photometric?: Photometric;
  colorMap?: Uint16Array;
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
      photometric: tags.photometric ?? Photometric.MinIsBlack,
      colorMap: tags.colorMap,
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

describe("inferRenderPipeline for imagery", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const naip = fakeGeoTiff({
    sampleFormat: SampleFormat.Uint,
    bitsPerSample: 8,
    samplesPerPixel: 4,
    photometric: Photometric.Rgb,
  });
  const maxar = fakeGeoTiff({
    sampleFormat: SampleFormat.Uint,
    bitsPerSample: 16,
    samplesPerPixel: 8,
    nodata: 0,
  });
  const seedProps = (renderer: ReturnType<typeof inferRenderPipeline>) =>
    renderer.buildPipeline(textures)[0]!.props as {
      channelMap: Int32Array;
      nodata: number | null;
      alphaMax: number;
      nearest: boolean;
    };

  it("draws NAIP's RGB and leaves its near-infrared band out", () => {
    const renderer = inferRenderPipeline(naip, stubGl(), {
      extraSamples: [0],
    });
    expect(moduleNames(renderer.buildPipeline(textures))).toEqual([
      "band-texture-float",
    ]);
    expect(Array.from(seedProps(renderer).channelMap)).toEqual([0, 1, 2, -1]);
    // Normalised texture: alpha would already be in [0, 1].
    expect(seedProps(renderer)).toMatchObject({ alphaMax: 1, nearest: false });
  });

  it("composes a uint16 multispectral file with a stretch", () => {
    const renderer = inferRenderPipeline(maxar, stubGl(), {
      bands: [4, 2, 1],
      rescale: [0, 2000],
    });
    const pipeline = renderer.buildPipeline({
      ...textures,
      mask: {} as WebGLTexture,
    });
    expect(moduleNames(pipeline)).toEqual([
      "band-texture-uint",
      "mask-texture",
      "linear-rescale",
    ]);
    expect(Array.from(seedProps(renderer).channelMap)).toEqual([4, 2, 1, -1]);
    expect(seedProps(renderer)).toMatchObject({ nodata: 0, alphaMax: 65535 });
    expect(Array.from(pipeline[2]!.props.max)).toEqual([2000, 2000, 2000]);
  });

  it("broadcasts a single band to grey, whatever the file's photometric", () => {
    const renderer = inferRenderPipeline(maxar, stubGl(), {
      bands: [6],
      rescale: [1000, 3600],
    });
    expect(moduleNames(renderer.buildPipeline(textures))).toEqual([
      "band-texture-uint",
      "linear-rescale",
      "black-is-zero",
    ]);
    const green = inferRenderPipeline(naip, stubGl(), { bands: [1] });
    expect(moduleNames(green.buildPipeline(textures))).toEqual([
      "band-texture-float",
      "black-is-zero",
    ]);
  });

  it("samples palette rasters nearest and looks them up in the colormap", () => {
    // `parseColormap` builds an ImageData, which jsdom does not provide.
    vi.stubGlobal(
      "ImageData",
      class {
        constructor(
          readonly data: Uint8ClampedArray,
          readonly width: number,
          readonly height: number,
        ) {}
      },
    );
    const renderer = inferRenderPipeline(
      fakeGeoTiff({
        sampleFormat: SampleFormat.Uint,
        bitsPerSample: 8,
        photometric: Photometric.Palette,
        colorMap: new Uint16Array(3 * 256),
        nodata: 250,
      }),
      stubGl(),
    );
    const pipeline = renderer.buildPipeline(textures);
    expect(moduleNames(pipeline)).toEqual(["band-texture-float", "colormap"]);
    expect(seedProps(renderer)).toMatchObject({
      nearest: true,
      nodata: 250 / 255,
    });
  });

  it("rejects what the tags cannot support, before any tile is loaded", () => {
    // Eight bands and no selection.
    expect(() => inferRenderPipeline(maxar, stubGl())).toThrow(RangeError);
    // uint16 without a stretch.
    expect(() =>
      inferRenderPipeline(maxar, stubGl(), { bands: [4, 2, 1] }),
    ).toThrow(/needs `rescale`/);
    expect(() =>
      inferRenderPipeline(naip, stubGl(), { bands: [0, 1, 4] }),
    ).toThrow(/out of range/);
  });

  describe("updateImagery", () => {
    it("re-composes tiles that were built before the change", () => {
      const gl = stubGl();
      const renderer = inferRenderPipeline(maxar, gl, {
        bands: [4, 2, 1],
        rescale: [0, 2000],
      });
      const built = renderer.buildPipeline(textures);
      const other = renderer.buildPipeline({ ...textures, width: 64 });

      renderer.updateImagery!(gl, { bands: [6], rescale: [1000, 3600] });

      // Same arrays, re-filled: the payloads keep pointing at them.
      expect(moduleNames(built)).toEqual([
        "band-texture-uint",
        "linear-rescale",
        "black-is-zero",
      ]);
      expect(Array.from(built[0]!.props.channelMap)).toEqual([6, -1, -1, -1]);
      expect(Array.from(built[1]!.props.min)).toEqual([1000, 1000, 1000]);
      // Every tile shares the style objects, but keeps its own size.
      expect(other[0]!.props.channelMap).toBe(built[0]!.props.channelMap);
      expect(other[1]!.props).toBe(built[1]!.props);
      expect(other[0]!.props.size).toEqual(new Float32Array([64, 128]));
      // Tiles built afterwards share them too.
      expect(renderer.buildPipeline(textures)[1]!.props).toBe(built[1]!.props);
    });

    it("updates a same-shaped chain in place, without rebuilding", () => {
      const gl = stubGl();
      const renderer = inferRenderPipeline(maxar, gl, {
        bands: [4, 2, 1],
        rescale: [0, 2000],
      });
      const built = renderer.buildPipeline(textures);
      const seedProps = built[0]!.props;
      const rescaleProps = built[1]!.props;

      // A slider drives this at input rate: only the values move.
      renderer.updateImagery!(gl, { bands: [6, 4, 2], rescale: [0, 900] });
      expect(built[0]!.props).toBe(seedProps);
      expect(built[1]!.props).toBe(rescaleProps);
      expect(Array.from(seedProps.channelMap)).toEqual([6, 4, 2, -1]);
      expect(Array.from(rescaleProps.max)).toEqual([900, 900, 900]);
      // Tiles built later share the same arrays.
      const later = renderer.buildPipeline(textures);
      expect(later[0]!.props.channelMap).toBe(seedProps.channelMap);
      expect(later[1]!.props).toBe(rescaleProps);
    });

    it("validates against the file and leaves tiles alone on failure", () => {
      const gl = stubGl();
      const renderer = inferRenderPipeline(maxar, gl, {
        bands: [4, 2, 1],
        rescale: [0, 2000],
      });
      const built = renderer.buildPipeline(textures);
      expect(() =>
        renderer.updateImagery!(gl, { bands: [8], rescale: [0, 1] }),
      ).toThrow(/out of range/);
      expect(() => renderer.updateImagery!(gl, { bands: [6] })).toThrow(
        /needs `rescale`/,
      );
      expect(Array.from(built[0]!.props.channelMap)).toEqual([4, 2, 1, -1]);
      expect(moduleNames(built)).toEqual([
        "band-texture-uint",
        "linear-rescale",
      ]);
    });

    it("is absent from the contour renderer", () => {
      const renderer = inferRenderPipeline(
        fakeGeoTiff({ sampleFormat: SampleFormat.Float, bitsPerSample: 32 }),
        stubGl(),
        { contour: { thresholds: [1], fill: "none" } },
      );
      expect(renderer.updateImagery).toBeUndefined();
    });
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
      contour: { ...contour, fill: "none" },
    });
    expect(moduleNames(linesOnly.buildPipeline(textures))).toEqual([
      "value-texture-float",
      "clear-color",
      "contour-line",
    ]);
  });

  it("builds value → value-gradient → contour-line for a gradient fill", () => {
    const renderer = inferRenderPipeline(
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
      inferRenderPipeline(geotiff, stubGl(), {
        contour: { thresholds: [1, 2] },
      }),
    ).toThrow(/needs `bands`/);
    expect(() =>
      inferRenderPipeline(geotiff, stubGl(), {
        contour: { thresholds: [1], fill: "gradient", bands: contour.bands },
      }),
    ).toThrow(/at least two/);
    expect(() =>
      inferRenderPipeline(geotiff, stubGl(), {
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
      const renderer = inferRenderPipeline(geotiff, gl, { contour });
      const built = renderer.buildPipeline(textures);
      const other = renderer.buildPipeline({ ...textures, width: 64 });
      const bandTexture = built[1]!.props.colors.texture;
      const update = (options: Parameters<typeof resolveContourOptions>[0]) =>
        renderer.updateContour!(gl, resolveContourOptions(options));

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
      const renderer = inferRenderPipeline(geotiff, gl, { contour });
      const gone = { ...textures };
      const pipeline = renderer.buildPipeline(gone);
      renderer.destroyTileTextures(gl, gone);
      renderer.updateContour!(
        gl,
        resolveContourOptions({ ...contour, fill: "none" }),
      );
      expect(moduleNames(pipeline)).toEqual([
        "value-texture-float",
        "isoband",
        "contour-line",
      ]);
    });

    it("changes the band, with that band's scale and offset", () => {
      const gl = stubGl();
      const multi = fakeGeoTiff({
        sampleFormat: SampleFormat.Float,
        bitsPerSample: 32,
        samplesPerPixel: 8,
        scales: [1, 1, 1, 1, 1, 1, 0.01, 1],
        offsets: [0, 0, 0, 0, 0, 0, -5, 0],
      });
      const renderer = inferRenderPipeline(multi, gl, { contour });
      const built = renderer.buildPipeline(textures);
      renderer.updateContour!(
        gl,
        resolveContourOptions({ ...contour, band: 6 }, 8),
      );
      // Every band is a layer of the tile's texture array, so the seed just
      // reads another layer.
      expect(built[0]!.props).toMatchObject({
        band: 6,
        scale: 0.01,
        offset: -5,
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

  it("de-interleaves a decoded tile once, however many loads it neighbours", async () => {
    const geotiff = fakeGeoTiff({
      sampleFormat: SampleFormat.Uint,
      bitsPerSample: 16,
      samplesPerPixel: 2,
    });
    const { gl, uploads } = recordingGl();
    const renderer = inferRenderPipeline(geotiff, gl, {
      bands: [1],
      rescale: [0, 10],
    });
    const tiles = new Map<string, unknown>();
    const tileAt = (x: number, y: number) => {
      const key = `${x}/${y}`;
      if (!tiles.has(key)) {
        tiles.set(key, {
          x,
          y,
          array: {
            layout: "pixel-interleaved" as const,
            width: 2,
            height: 2,
            count: 2,
            data: new Uint16Array([1, 2, 1, 2, 1, 2, 1, 2]),
            mask: null,
          },
        });
      }
      return tiles.get(key);
    };
    const fetchTiles = vi.fn(async (xy: Array<[number, number]>) =>
      xy.map(([x, y]) => tileAt(x, y)),
    );
    const image = {
      tileCount: { x: 2, y: 1 },
      fetchTiles,
    } as unknown as GeoTIFF;
    const signal = new AbortController().signal;
    await renderer.loadTileTextures(image, { gl, x: 0, y: 0, signal });
    await renderer.loadTileTextures(image, { gl, x: 1, y: 0, signal });
    // Two tiles × two layers, each layer that band's plane.
    expect(uploads.map((u) => u.layer)).toEqual([0, 1, 0, 1]);
    expect(Array.from(uploads[1]!.data as Uint16Array)).toEqual(
      Array(16).fill(2),
    );
    // The same decoded tile served both loads, so the planes came from the
    // cache: identical arrays back the halo of the second load's neighbour.
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

  it("uploads imagery as one layer per band, padded like contours", async () => {
    const geotiff = fakeGeoTiff({
      sampleFormat: SampleFormat.Uint,
      bitsPerSample: 8,
      samplesPerPixel: 3,
      photometric: Photometric.Rgb,
    });
    const { gl, uploads } = recordingGl();
    const renderer = inferRenderPipeline(geotiff, gl);
    // A 1 × 1-tile image, decoded band-separate (PlanarConfiguration = 2).
    const fetchTiles = vi.fn(async (xy: Array<[number, number]>) =>
      xy.map(([x, y]) => ({
        x,
        y,
        array: {
          layout: "band-separate" as const,
          width: 2,
          height: 2,
          count: 3,
          bands: [
            new Uint8Array([1, 1, 1, 1]),
            new Uint8Array([2, 2, 2, 2]),
            new Uint8Array([3, 3, 3, 3]),
          ],
          mask: null,
        },
      })),
    );
    const tile = await renderer.loadTileTextures(
      { tileCount: { x: 1, y: 1 }, fetchTiles } as unknown as GeoTIFF,
      { gl, x: 0, y: 0, signal: new AbortController().signal },
    );
    expect(tile).toMatchObject({ width: 2, height: 2, halo: 1 });
    expect(uploads.map((u) => [u.layer, u.width, u.height])).toEqual([
      [0, 4, 4],
      [1, 4, 4],
      [2, 4, 4],
    ]);
    // Each layer is that band's plane, clamped into the halo on every side.
    expect(Array.from(uploads[1]!.data as Uint8Array)).toEqual(
      Array(16).fill(2),
    );
    expect(tile.byteLength).toBe(4 * 4 * 3);
  });
});
