/**
 * Which bands of a multi-band raster make up the picture. Pure: the tags come
 * in, uniform-ready values go out.
 */

import type { TiffImage } from "@cogeotiff/core";
import { Photometric, TiffTag } from "@cogeotiff/core";

/** TIFF `ExtraSamples` values that mark a band as alpha. */
const ALPHA_EXTRA_SAMPLES: readonly number[] = [
  1, // associated (premultiplied) alpha
  2, // unassociated alpha
];

/**
 * The `ExtraSamples` tag of an IFD as an array, or `null` when absent. The
 * installed geotiff library does not prefetch it, and cogeotiff hands it
 * back as a bare number when there is one extra sample.
 */
export async function readExtraSamples(
  image: Pick<TiffImage, "fetch">,
): Promise<number[] | null> {
  const raw = (await image.fetch(TiffTag.ExtraSamples)) as
    | number
    | ArrayLike<number>
    | null
    | undefined;
  if (raw === null || raw === undefined) {
    return null;
  }
  return typeof raw === "number" ? [raw] : Array.from(raw);
}

/**
 * Check one 0-based band index: a non-negative integer and, when the file's
 * band count is known, inside it.
 */
export function validateBandIndex(
  band: number,
  samplesPerPixel?: number,
): void {
  if (!Number.isInteger(band) || band < 0) {
    throw new RangeError(`band must be a non-negative integer, got ${band}`);
  }
  if (samplesPerPixel !== undefined && band >= samplesPerPixel) {
    throw new RangeError(
      `band ${band} is out of range for a ${samplesPerPixel}-band raster`,
    );
  }
}

export interface BandSelectionTags {
  samplesPerPixel: number;
  photometric: Photometric;
  /** The `ExtraSamples` tag, one entry per band beyond the photometric ones. */
  extraSamples: readonly number[] | null;
}

/**
 * How many leading bands the photometric interpretation itself describes;
 * `ExtraSamples` has one entry for each band after them.
 */
function photometricBandCount(photometric: Photometric): number {
  switch (photometric) {
    case Photometric.Rgb:
    case Photometric.Ycbcr:
    case Photometric.Cielab:
      return 3;
    case Photometric.Separated:
      return 4;
    default:
      return 1;
  }
}

/** The first band `ExtraSamples` declares alpha, or `-1` when there is none. */
function alphaBand(tags: BandSelectionTags): number {
  const index =
    tags.extraSamples?.findIndex((v) => ALPHA_EXTRA_SAMPLES.includes(v)) ?? -1;
  return index < 0 ? -1 : photometricBandCount(tags.photometric) + index;
}

/**
 * The bands to draw, as 0-based file indices, by the tags: a palette draws
 * its index band; CMYK its four channels; an RGB-like interpretation its
 * three colour bands, plus the fourth when `ExtraSamples` declares that band
 * alpha; grey files with one band draw grey, with three or four bands they
 * draw as RGB(A) by the same alpha rule — NAIP's fourth band is
 * near-infrared, not alpha. Anything else (grey + alpha, a five-band grey
 * stack) has no default and is refused with a `RangeError`.
 */
export function resolveBandSelection(tags: BandSelectionTags): number[] {
  const { samplesPerPixel, photometric } = tags;
  const base = photometricBandCount(photometric);
  if (samplesPerPixel < base) {
    throw new RangeError(
      `PhotometricInterpretation ${photometric} needs ${base} bands, the file has ${samplesPerPixel}`,
    );
  }
  if (photometric === Photometric.Palette) {
    return [0];
  }
  if (photometric === Photometric.Separated) {
    return [0, 1, 2, 3];
  }
  const rgba = (): number[] =>
    alphaBand(tags) === 3 ? [0, 1, 2, 3] : [0, 1, 2];
  if (base === 3) {
    return rgba();
  }
  switch (samplesPerPixel) {
    case 1:
      return [0];
    case 3:
    case 4:
      return rgba();
    default:
      throw new RangeError(
        `a ${samplesPerPixel}-band raster has no default composite`,
      );
  }
}

/**
 * Layer index per output channel `[r, g, b, a]` for the shader, `-1` where
 * the selection has no band: `[k]` → `[k, -1, -1, -1]`,
 * `[r, g, b]` → `[r, g, b, -1]`. Takes a selection from
 * {@link resolveBandSelection}, so its shape is not checked again.
 */
export function channelMap(selection: readonly number[]): Int32Array {
  const map = new Int32Array([-1, -1, -1, -1]);
  selection.forEach((band, i) => {
    map[i] = band;
  });
  return map;
}

/**
 * How the composed channels become a colour: three or four selected bands
 * are RGB(A) as they stand; one band is grey, inverted grey or a colormap
 * lookup by the photometric interpretation; CMYK and CIELab always draw
 * their default selection, so their conversions apply as a whole.
 */
export type ColorConversion =
  | "rgb"
  | "gray"
  | "gray-inverted"
  | "palette"
  | "cmyk"
  | "cielab";

function colorConversion(
  photometric: Photometric,
  selectedCount: number,
): ColorConversion {
  switch (photometric) {
    case Photometric.Separated:
      return "cmyk";
    case Photometric.Cielab:
      return "cielab";
    default:
      break;
  }
  if (selectedCount >= 3) {
    return "rgb";
  }
  switch (photometric) {
    case Photometric.MinIsWhite:
      return "gray-inverted";
    case Photometric.Palette:
      return "palette";
    default:
      // MinIsBlack, or a single band picked out of an RGB / YCbCr /
      // multispectral file: broadcast it to grey.
      return "gray";
  }
}

/** Everything the imagery seed and its follow-up modules need from the tags. */
export interface ResolvedImagery {
  selection: number[];
  channelMap: Int32Array;
  color: ColorConversion;
}

/** Resolve the bands to draw and how they become a colour, in one pass. */
export function resolveImagery(tags: BandSelectionTags): ResolvedImagery {
  const selection = resolveBandSelection(tags);
  return {
    selection,
    channelMap: channelMap(selection),
    color: colorConversion(tags.photometric, selection.length),
  };
}
