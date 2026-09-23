/**
 * Which bands of a multi-band raster make up the picture, and how they are
 * stretched. Pure: the tags come in, uniform-ready values go out.
 */

import type { TiffImage } from "@cogeotiff/core";
import { Photometric, SampleFormat, TiffTag } from "@cogeotiff/core";

/** `[min, max]` in raw sample units, mapped onto `[0, 1]`. */
export type RescalePair = readonly [min: number, max: number];

/**
 * One pair for every colour channel, or one pair per colour channel
 * (`min(bands, 3)` pairs, in `bands` order).
 */
export type Rescale = RescalePair | ReadonlyArray<RescalePair>;

/** How imagery is composed from a raster's bands. */
export interface ImageryRenderOptions {
  /**
   * 0-based file bands to draw: `[gray]`, `[r, g, b]` or `[r, g, b, a]`.
   * Defaults from the TIFF tags, see {@link resolveBandSelection}.
   */
  bands?: readonly number[];
  /**
   * Linear stretch of the colour channels. Required for anything but 8-bit
   * unsigned samples, which default to their full range. The alpha band is
   * never rescaled: it is divided by the sample type's maximum.
   */
  rescale?: Rescale;
}

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

/** Selected band counts a composite can have. */
const SELECTION_LENGTHS: readonly number[] = [1, 3, 4];

/**
 * Check a band list's shape without knowing the file: integers ≥ 0, and one,
 * three or four of them. Range against the band count is checked by
 * {@link resolveBandSelection}.
 */
export function validateBandList(bands: readonly number[]): void {
  if (!SELECTION_LENGTHS.includes(bands.length)) {
    throw new RangeError(
      `bands must list 1 (grey), 3 (RGB) or 4 (RGBA) bands, got ${bands.length}`,
    );
  }
  for (const band of bands) {
    if (!Number.isInteger(band) || band < 0) {
      throw new RangeError(`band must be a non-negative integer, got ${band}`);
    }
  }
}

export interface BandSelectionTags {
  samplesPerPixel: number;
  photometric: Photometric;
  /** The `ExtraSamples` tag, one entry per band beyond the photometric ones. */
  extraSamples: readonly number[] | null;
}

/**
 * The bands to draw, as 0-based file indices.
 *
 * With `bands` given, it is validated against the file. Without it, the
 * default follows the tags: one band as grey, three as RGB, four as RGBA only
 * when the fourth is declared alpha by `ExtraSamples` (or the file is CMYK) —
 * NAIP's fourth band is near-infrared, not alpha. Two bands, or five and
 * more, have no default: the caller must say which bands it wants.
 */
export function resolveBandSelection(
  tags: BandSelectionTags,
  bands?: readonly number[],
): number[] {
  const { samplesPerPixel, photometric, extraSamples } = tags;
  if (bands !== undefined) {
    validateBandList(bands);
    for (const band of bands) {
      if (band >= samplesPerPixel) {
        throw new RangeError(
          `band ${band} is out of range for a ${samplesPerPixel}-band raster`,
        );
      }
    }
    if (
      photometric === Photometric.Separated ||
      photometric === Photometric.Cielab
    ) {
      throw new RangeError(
        "bands cannot be chosen for CMYK or CIELab rasters; their channels have fixed meaning",
      );
    }
    if (photometric === Photometric.Palette && bands.length !== 1) {
      throw new RangeError("a palette raster draws exactly one band");
    }
    return [...bands];
  }
  switch (samplesPerPixel) {
    case 1:
      return [0];
    case 3:
      return [0, 1, 2];
    case 4: {
      const alpha =
        photometric === Photometric.Separated ||
        (extraSamples !== null &&
          ALPHA_EXTRA_SAMPLES.includes(extraSamples[0]!));
      return alpha ? [0, 1, 2, 3] : [0, 1, 2];
    }
    default:
      throw new RangeError(
        `a ${samplesPerPixel}-band raster has no default composite; pass \`bands\``,
      );
  }
}

/**
 * Layer index per output channel `[r, g, b, a]` for the shader, `-1` where
 * the selection has no band: `[k]` → `[k, -1, -1, -1]`,
 * `[r, g, b]` → `[r, g, b, -1]`.
 */
export function channelMap(selection: readonly number[]): Int32Array {
  validateBandList(selection);
  const map = new Int32Array([-1, -1, -1, -1]);
  selection.forEach((band, i) => {
    map[i] = band;
  });
  return map;
}

/** Per-channel stretch, ready for `LinearRescale`. */
export interface ResolvedRescale {
  min: Float32Array;
  max: Float32Array;
}

/** Normalise a {@link Rescale} to a list of pairs, validating each. */
export function validateRescale(rescale: Rescale): RescalePair[] {
  const pairs: RescalePair[] =
    typeof rescale[0] === "number"
      ? [rescale as RescalePair]
      : [...(rescale as ReadonlyArray<RescalePair>)];
  if (pairs.length !== 1 && pairs.length !== 3) {
    throw new RangeError(
      `rescale needs one [min, max] pair or one per colour channel (3), got ${pairs.length}`,
    );
  }
  for (const pair of pairs) {
    if (
      pair.length !== 2 ||
      !Number.isFinite(pair[0]) ||
      !Number.isFinite(pair[1])
    ) {
      throw new RangeError(
        `rescale pairs must be two finite numbers, got ${JSON.stringify(pair)}`,
      );
    }
    if (pair[1] <= pair[0]) {
      throw new RangeError(
        `rescale max must exceed min, got [${pair[0]}, ${pair[1]}]`,
      );
    }
  }
  return pairs;
}

export interface RescaleTags {
  /** Bands in the selection, so a per-channel rescale can be checked. */
  selectedCount: number;
  bitsPerSample: number;
  sampleFormat: SampleFormat;
  /**
   * Whether the texture samples as `[0, 1]` rather than raw values, in which
   * case the stretch is expressed in the same units.
   */
  normalized: boolean;
}

/**
 * The stretch for `LinearRescale`, or `null` for none.
 *
 * Without `rescale`, 8-bit unsigned samples keep their full range and need
 * no module; every other type has no sensible default, so it is an error
 * rather than a guess.
 */
export function resolveRescale(
  rescale: Rescale | undefined,
  tags: RescaleTags,
): ResolvedRescale | null {
  const { selectedCount, bitsPerSample, sampleFormat, normalized } = tags;
  if (rescale === undefined) {
    if (sampleFormat === SampleFormat.Uint && bitsPerSample === 8) {
      return null;
    }
    throw new RangeError(
      `${bitsPerSample}-bit ${SampleFormat[sampleFormat]} imagery needs \`rescale\` ([min, max] in sample units)`,
    );
  }
  const pairs = validateRescale(rescale);
  const colourChannels = Math.min(selectedCount, 3);
  if (pairs.length !== 1 && pairs.length !== colourChannels) {
    throw new RangeError(
      `${pairs.length} rescale pairs given for ${colourChannels} colour channel(s)`,
    );
  }
  const divisor = normalized ? 2 ** bitsPerSample - 1 : 1;
  const min = new Float32Array(3);
  const max = new Float32Array(3);
  for (let c = 0; c < 3; c++) {
    const pair = pairs[pairs.length === 1 ? 0 : Math.min(c, pairs.length - 1)]!;
    min[c] = pair[0] / divisor;
    max[c] = pair[1] / divisor;
  }
  return { min, max };
}

/** The largest value a sample type holds: what an alpha band is divided by. */
export function sampleTypeMax(
  bitsPerSample: number,
  sampleFormat: SampleFormat,
): number {
  switch (sampleFormat) {
    case SampleFormat.Uint:
      return 2 ** bitsPerSample - 1;
    case SampleFormat.Int:
      return 2 ** (bitsPerSample - 1) - 1;
    case SampleFormat.Float:
      return 1;
    default:
      throw new RangeError(`Unsupported SampleFormat ${sampleFormat}`);
  }
}

/** Everything the imagery seed and rescale module need from the options. */
export interface ResolvedImagery {
  selection: number[];
  channelMap: Int32Array;
  rescale: ResolvedRescale | null;
}

export interface ImageryTags extends BandSelectionTags {
  bitsPerSample: number;
  sampleFormat: SampleFormat;
  normalized: boolean;
}

/** Resolve and validate the imagery options in one pass. */
export function resolveImageryOptions(
  options: ImageryRenderOptions,
  tags: ImageryTags,
): ResolvedImagery {
  const selection = resolveBandSelection(tags, options.bands);
  return {
    selection,
    channelMap: channelMap(selection),
    rescale: resolveRescale(options.rescale, {
      selectedCount: selection.length,
      bitsPerSample: tags.bitsPerSample,
      sampleFormat: tags.sampleFormat,
      normalized: tags.normalized,
    }),
  };
}
