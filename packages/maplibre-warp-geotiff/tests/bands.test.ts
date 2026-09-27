import { Photometric } from "@cogeotiff/core";
import { describe, expect, it, vi } from "vitest";

import {
  channelMap,
  readExtraSamples,
  resolveBandSelection,
  resolveImageryOptions,
  validateBandList,
  validateImageryOptions,
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

  it("has no default for grey + alpha or a five-plus band grey stack", () => {
    expect(() => resolveBandSelection(tags(2))).toThrow(/pass `bands`/);
    expect(() =>
      resolveBandSelection(tags(2, Photometric.MinIsBlack, [2])),
    ).toThrow(/pass `bands`/);
    // Maxar WorldView-3: eight uint16 bands, MinIsBlack.
    expect(() =>
      resolveBandSelection(
        tags(8, Photometric.MinIsBlack, [0, 0, 0, 0, 0, 0, 0]),
      ),
    ).toThrow(/8-band raster/);
  });

  it("counts ExtraSamples from the first band the photometric does not cover", () => {
    // Grey file with three extras: ExtraSamples[2] describes band 3.
    expect(
      resolveBandSelection(tags(4, Photometric.MinIsBlack, [0, 0, 2])),
    ).toEqual([0, 1, 2, 3]);
    // Alpha on band 1 of a grey stack does not make band 3 alpha.
    expect(
      resolveBandSelection(tags(4, Photometric.MinIsBlack, [2, 0, 0])),
    ).toEqual([0, 1, 2]);
    // RGB plus two extras: the colour bands are known, whatever the extras.
    expect(resolveBandSelection(tags(5, Photometric.Rgb, [0, 0]))).toEqual([
      0, 1, 2,
    ]);
    expect(resolveBandSelection(tags(5, Photometric.Rgb, [2, 0]))).toEqual([
      0, 1, 2, 3,
    ]);
    // CMYK with an extra band still draws its four channels.
    expect(resolveBandSelection(tags(5, Photometric.Separated, [0]))).toEqual([
      0, 1, 2, 3,
    ]);
    // Fewer bands than the interpretation needs is a malformed file.
    expect(() => resolveBandSelection(tags(2, Photometric.Rgb))).toThrow(
      /needs 3 bands/,
    );
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

describe("validateImageryOptions", () => {
  it("checks the band list's shape, not its range", () => {
    expect(() => validateImageryOptions({})).not.toThrow();
    expect(() => validateImageryOptions({ bands: [12] })).not.toThrow();
    expect(() => validateImageryOptions({ bands: [0, 1] })).toThrow(RangeError);
  });
});

describe("resolveImageryOptions", () => {
  it("resolves selection, channel map and colour together", () => {
    const resolved = resolveImageryOptions({ bands: [4, 2, 1] }, tags(8));
    expect(resolved.selection).toEqual([4, 2, 1]);
    expect(Array.from(resolved.channelMap)).toEqual([4, 2, 1, -1]);
    expect(resolved.color).toBe("rgb");
  });

  it("names the colour conversion from the photometric and the band count", () => {
    const colour = (
      photometric: Photometric,
      bands: number[],
      samplesPerPixel = 4,
    ) =>
      resolveImageryOptions({ bands }, tags(samplesPerPixel, photometric))
        .color;
    expect(colour(Photometric.MinIsBlack, [6], 8)).toBe("gray");
    expect(colour(Photometric.Rgb, [1])).toBe("gray");
    expect(colour(Photometric.MinIsWhite, [0])).toBe("gray-inverted");
    expect(colour(Photometric.MinIsWhite, [0, 1, 2])).toBe("rgb");
    expect(colour(Photometric.Palette, [0], 1)).toBe("palette");
    expect(
      resolveImageryOptions({}, tags(4, Photometric.Separated)).color,
    ).toBe("cmyk");
    expect(resolveImageryOptions({}, tags(3, Photometric.Cielab)).color).toBe(
      "cielab",
    );
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
