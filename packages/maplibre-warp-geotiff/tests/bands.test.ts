import { Photometric, SampleFormat } from "@cogeotiff/core";
import { describe, expect, it, vi } from "vitest";

import {
  channelMap,
  readExtraSamples,
  resolveBandSelection,
  resolveImageryOptions,
  resolveRescale,
  sampleTypeMax,
  validateBandList,
  validateRescale,
} from "../src/bands.js";

const tags = (
  samplesPerPixel: number,
  photometric = Photometric.MinIsBlack,
  extraSamples: number[] | null = null,
) => ({ samplesPerPixel, photometric, extraSamples });

describe("resolveBandSelection defaults", () => {
  it("draws one band as grey and three as RGB", () => {
    expect(resolveBandSelection(tags(1))).toEqual([0]);
    expect(resolveBandSelection(tags(1, Photometric.Palette))).toEqual([0]);
    expect(resolveBandSelection(tags(3, Photometric.Rgb))).toEqual([0, 1, 2]);
  });

  it("takes a fourth band as alpha only when ExtraSamples says so", () => {
    // NAIP: RGB + near-infrared, ExtraSamples = 0 (unspecified).
    expect(resolveBandSelection(tags(4, Photometric.Rgb, [0]))).toEqual([
      0, 1, 2,
    ]);
    expect(resolveBandSelection(tags(4, Photometric.Rgb, null))).toEqual([
      0, 1, 2,
    ]);
    // RGBA with unassociated (2) or associated (1) alpha.
    expect(resolveBandSelection(tags(4, Photometric.Rgb, [2]))).toEqual([
      0, 1, 2, 3,
    ]);
    expect(resolveBandSelection(tags(4, Photometric.Rgb, [1]))).toEqual([
      0, 1, 2, 3,
    ]);
    // CMYK needs all four channels.
    expect(resolveBandSelection(tags(4, Photometric.Separated))).toEqual([
      0, 1, 2, 3,
    ]);
  });

  it("has no default for two or five-plus bands", () => {
    expect(() => resolveBandSelection(tags(2))).toThrow(/pass `bands`/);
    // Maxar WorldView-3: eight uint16 bands, MinIsBlack.
    expect(() =>
      resolveBandSelection(
        tags(8, Photometric.MinIsBlack, [0, 0, 0, 0, 0, 0, 0]),
      ),
    ).toThrow(/8-band raster/);
  });
});

describe("resolveBandSelection with explicit bands", () => {
  it("accepts grey, RGB and RGBA selections within the file", () => {
    const maxar = tags(8);
    expect(resolveBandSelection(maxar, [4, 2, 1])).toEqual([4, 2, 1]);
    expect(resolveBandSelection(maxar, [6])).toEqual([6]);
    expect(resolveBandSelection(maxar, [6, 4, 2, 7])).toEqual([6, 4, 2, 7]);
    // Duplicates are fine: the same layer can feed several channels.
    expect(resolveBandSelection(maxar, [0, 0, 0])).toEqual([0, 0, 0]);
    // A copy, not the caller's array.
    const bands = [1, 2, 3];
    expect(resolveBandSelection(maxar, bands)).not.toBe(bands);
  });

  it("rejects bands outside the file or of the wrong count", () => {
    expect(() => resolveBandSelection(tags(4), [4])).toThrow(/out of range/);
    expect(() => resolveBandSelection(tags(4), [0, 1])).toThrow(RangeError);
    expect(() => resolveBandSelection(tags(4), [])).toThrow(RangeError);
    expect(() => resolveBandSelection(tags(4), [0, 1, 2, 3, 0])).toThrow(
      RangeError,
    );
    expect(() => resolveBandSelection(tags(4), [-1, 0, 1])).toThrow(RangeError);
    expect(() => resolveBandSelection(tags(4), [0.5])).toThrow(RangeError);
  });

  it("refuses to rearrange channels whose meaning is fixed", () => {
    expect(() =>
      resolveBandSelection(tags(4, Photometric.Separated), [0, 1, 2]),
    ).toThrow(/CMYK or CIELab/);
    expect(() =>
      resolveBandSelection(tags(3, Photometric.Cielab), [2, 1, 0]),
    ).toThrow(/CMYK or CIELab/);
    expect(() =>
      resolveBandSelection(tags(1, Photometric.Palette), [0, 0, 0]),
    ).toThrow(/palette/);
  });
});

describe("channelMap", () => {
  it("maps the selection onto RGBA layers, -1 for none", () => {
    expect(Array.from(channelMap([6]))).toEqual([6, -1, -1, -1]);
    expect(Array.from(channelMap([4, 2, 1]))).toEqual([4, 2, 1, -1]);
    expect(Array.from(channelMap([0, 1, 2, 3]))).toEqual([0, 1, 2, 3]);
    expect(() => channelMap([0, 1])).toThrow(RangeError);
  });
});

describe("validateBandList", () => {
  it("checks only what can be known without the file", () => {
    expect(() => validateBandList([12])).not.toThrow();
    expect(() => validateBandList([0, 1])).toThrow(RangeError);
    expect(() => validateBandList([-1])).toThrow(RangeError);
    expect(() => validateBandList([1.5, 2, 3])).toThrow(RangeError);
  });
});

describe("validateRescale", () => {
  it("normalises a pair or a list of pairs", () => {
    expect(validateRescale([0, 2000])).toEqual([[0, 2000]]);
    expect(
      validateRescale([
        [0, 1],
        [2, 3],
        [4, 5],
      ]),
    ).toHaveLength(3);
  });

  it("rejects malformed stretches", () => {
    expect(() => validateRescale([2000, 0])).toThrow(/max must exceed min/);
    expect(() => validateRescale([0, 0])).toThrow(/max must exceed min/);
    expect(() => validateRescale([0, NaN])).toThrow(/finite/);
    expect(() =>
      validateRescale([
        [0, 1],
        [0, 1],
      ]),
    ).toThrow(/one per colour channel/);
    expect(() =>
      validateRescale([[0, 1, 2] as unknown as [number, number]]),
    ).toThrow(/two finite numbers/);
  });
});

describe("resolveRescale", () => {
  const uint16 = {
    selectedCount: 3,
    bitsPerSample: 16,
    sampleFormat: SampleFormat.Uint,
    normalized: false,
  };

  it("needs no module for 8-bit unsigned samples and demands one otherwise", () => {
    expect(
      resolveRescale(undefined, {
        ...uint16,
        bitsPerSample: 8,
        normalized: true,
      }),
    ).toBeNull();
    expect(() => resolveRescale(undefined, uint16)).toThrow(/needs `rescale`/);
    expect(() =>
      resolveRescale(undefined, {
        ...uint16,
        bitsPerSample: 32,
        sampleFormat: SampleFormat.Float,
      }),
    ).toThrow(/32-bit Float/);
  });

  it("broadcasts one pair to every colour channel", () => {
    const resolved = resolveRescale([0, 2000], uint16)!;
    expect(Array.from(resolved.min)).toEqual([0, 0, 0]);
    expect(Array.from(resolved.max)).toEqual([2000, 2000, 2000]);
  });

  it("keeps per-channel pairs in selection order", () => {
    const resolved = resolveRescale(
      [
        [300, 1500],
        [400, 1200],
        [300, 800],
      ],
      uint16,
    )!;
    expect(Array.from(resolved.min)).toEqual([300, 400, 300]);
    expect(Array.from(resolved.max)).toEqual([1500, 1200, 800]);
  });

  it("expresses the stretch in sampled units for normalised textures", () => {
    const resolved = resolveRescale([51, 204], {
      selectedCount: 1,
      bitsPerSample: 8,
      sampleFormat: SampleFormat.Uint,
      normalized: true,
    })!;
    expect(resolved.min[0]).toBeCloseTo(51 / 255);
    expect(resolved.max[0]).toBeCloseTo(204 / 255);
  });

  it("rejects three pairs for a single grey band", () => {
    expect(() =>
      resolveRescale(
        [
          [0, 1],
          [0, 1],
          [0, 1],
        ],
        { ...uint16, selectedCount: 1 },
      ),
    ).toThrow(/1 colour channel/);
  });
});

describe("sampleTypeMax", () => {
  it("is the largest value of the sample type", () => {
    expect(sampleTypeMax(8, SampleFormat.Uint)).toBe(255);
    expect(sampleTypeMax(16, SampleFormat.Uint)).toBe(65535);
    expect(sampleTypeMax(16, SampleFormat.Int)).toBe(32767);
    expect(sampleTypeMax(32, SampleFormat.Float)).toBe(1);
  });
});

describe("resolveImageryOptions", () => {
  it("resolves selection, channel map and stretch together", () => {
    const resolved = resolveImageryOptions(
      { bands: [4, 2, 1], rescale: [0, 2000] },
      {
        samplesPerPixel: 8,
        photometric: Photometric.MinIsBlack,
        extraSamples: null,
        bitsPerSample: 16,
        sampleFormat: SampleFormat.Uint,
        normalized: false,
      },
    );
    expect(resolved.selection).toEqual([4, 2, 1]);
    expect(Array.from(resolved.channelMap)).toEqual([4, 2, 1, -1]);
    expect(Array.from(resolved.rescale!.max)).toEqual([2000, 2000, 2000]);
  });
});

describe("readExtraSamples", () => {
  const image = (raw: unknown) => ({ fetch: vi.fn(async () => raw) });

  it("normalises the tag to an array or null", async () => {
    expect(await readExtraSamples(image(null) as never)).toBeNull();
    expect(await readExtraSamples(image(undefined) as never)).toBeNull();
    expect(await readExtraSamples(image(0) as never)).toEqual([0]);
    expect(await readExtraSamples(image([2]) as never)).toEqual([2]);
    expect(
      await readExtraSamples(image(Uint16Array.from([0, 0, 0])) as never),
    ).toEqual([0, 0, 0]);
  });
});
