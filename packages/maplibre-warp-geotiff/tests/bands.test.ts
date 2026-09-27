import { Photometric } from "@cogeotiff/core";
import { describe, expect, it, vi } from "vitest";

import {
  channelMap,
  readExtraSamples,
  resolveBandSelection,
  resolveImagery,
  validateBandIndex,
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
    expect(() => resolveBandSelection(tags(2))).toThrow(/no default/);
    expect(() =>
      resolveBandSelection(tags(2, Photometric.MinIsBlack, [2])),
    ).toThrow(/no default/);
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

describe("channelMap", () => {
  it("maps the selection onto RGBA layers, -1 for none", () => {
    expect(Array.from(channelMap([6]))).toEqual([6, -1, -1, -1]);
    expect(Array.from(channelMap([4, 2, 1]))).toEqual([4, 2, 1, -1]);
    expect(Array.from(channelMap([0, 1, 2, 3]))).toEqual([0, 1, 2, 3]);
  });
});

describe("validateBandIndex", () => {
  it("checks the index, and the file's band count when known", () => {
    expect(() => validateBandIndex(12)).not.toThrow();
    expect(() => validateBandIndex(3, 4)).not.toThrow();
    expect(() => validateBandIndex(4, 4)).toThrow(/out of range/);
    for (const band of [-1, 1.5]) {
      expect(() => validateBandIndex(band)).toThrow(RangeError);
    }
  });
});

describe("resolveImagery", () => {
  it("resolves selection, channel map and colour together", () => {
    const resolved = resolveImagery(tags(4, Photometric.Rgb, [0]));
    expect(resolved.selection).toEqual([0, 1, 2]);
    expect(Array.from(resolved.channelMap)).toEqual([0, 1, 2, -1]);
    expect(resolved.color).toBe("rgb");
  });

  it("names the colour conversion from the photometric and the band count", () => {
    const colour = (...args: Parameters<typeof tags>) =>
      resolveImagery(tags(...args)).color;
    expect(colour(1)).toBe("gray");
    expect(colour(1, Photometric.MinIsWhite)).toBe("gray-inverted");
    expect(colour(3, Photometric.MinIsWhite)).toBe("rgb");
    expect(colour(1, Photometric.Palette)).toBe("palette");
    expect(colour(4, Photometric.Separated)).toBe("cmyk");
    expect(colour(3, Photometric.Cielab)).toBe("cielab");
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
