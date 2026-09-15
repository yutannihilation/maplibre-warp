/**
 * The band model behind filled contours: thresholds → bands, colours →
 * a lookup image. Pure; shared by the shader modules and legend code.
 */

export interface ContourBand {
  band: number;
  /** Lower bound, absent for the open lower band. */
  min?: number;
  /** Upper bound, absent for the open upper band. */
  max?: number;
}

export interface BandOptions {
  /** Emit the band below the first threshold. @default false */
  includeLower?: boolean;
  /** Emit the band above the last threshold. @default true */
  includeUpper?: boolean;
}

export function validateThresholds(thresholds: readonly number[]): void {
  if (thresholds.length === 0) {
    throw new RangeError("at least one threshold is required");
  }
  for (let k = 0; k < thresholds.length; k++) {
    const t = thresholds[k]!;
    if (!Number.isFinite(t)) {
      throw new RangeError(`threshold ${k} is not finite`);
    }
    if (k > 0 && t <= thresholds[k - 1]!) {
      throw new RangeError("thresholds must be strictly increasing");
    }
  }
}

export function bandsFromThresholds(
  thresholds: readonly number[],
  options: BandOptions,
): ContourBand[] {
  validateThresholds(thresholds);
  const includeLower = options.includeLower ?? false;
  const includeUpper = options.includeUpper ?? true;
  const bands: ContourBand[] = [];
  let index = 0;
  if (includeLower) {
    bands.push({ band: index++, max: thresholds[0]! });
  }
  for (let k = 0; k < thresholds.length; k++, index++) {
    const isLast = k === thresholds.length - 1;
    if (isLast && !includeUpper) {
      break;
    }
    const band: ContourBand = { band: index, min: thresholds[k]! };
    if (!isLast) {
      band.max = thresholds[k + 1]!;
    }
    bands.push(band);
  }
  return bands;
}

/** `t` runs 0..1 across the bands; `index` and `count` are the band position. */
export type BandColorFunction = (
  t: number,
  index: number,
  count: number,
) => string;

export type BandColors = readonly string[] | BandColorFunction;

/** One colour string per band, from an explicit list or an interpolator. */
export function resolveBandColors(colors: BandColors, count: number): string[] {
  if (typeof colors === "function") {
    return Array.from({ length: count }, (_, k) =>
      colors(count === 1 ? 0 : k / (count - 1), k, count),
    );
  }
  if (colors.length !== count) {
    throw new RangeError(
      `${colors.length} colours given for ${count} bands; provide exactly one per band`,
    );
  }
  return [...colors];
}

/** RGBA in 0–255. */
export type Rgba = [number, number, number, number];

const HEX = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const RGB =
  /^rgba?\(\s*([^\s,/]+)\s*[,\s]\s*([^\s,/]+)\s*[,\s]\s*([^\s,/]+)\s*(?:[,/]\s*([^\s)]+)\s*)?\)$/i;

/**
 * Parse `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, `rgb()` and `rgba()` (comma
 * or space separated, numbers or percentages). Anything else is a
 * `RangeError` — no DOM, so no named colours or `hsl()`.
 */
export function parseCssColor(input: string): Rgba {
  const text = input.trim();
  const hex = HEX.exec(text);
  if (hex) {
    let digits = hex[1]!;
    if (digits.length <= 4) {
      digits = digits
        .split("")
        .map((d) => d + d)
        .join("");
    }
    const n = Number.parseInt(digits, 16);
    if (digits.length === 6) {
      return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 255];
    }
    return [(n >>> 24) & 255, (n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const rgb = RGB.exec(text);
  if (rgb) {
    const channel = (s: string): number => {
      const v = s.endsWith("%")
        ? (Number.parseFloat(s) / 100) * 255
        : Number.parseFloat(s);
      if (!Number.isFinite(v)) {
        throw new RangeError(`bad colour channel "${s}" in "${input}"`);
      }
      return Math.round(Math.min(255, Math.max(0, v)));
    };
    const alpha = (s: string | undefined): number => {
      if (s === undefined) {
        return 255;
      }
      const v = s.endsWith("%")
        ? Number.parseFloat(s) / 100
        : Number.parseFloat(s);
      if (!Number.isFinite(v)) {
        throw new RangeError(`bad alpha "${s}" in "${input}"`);
      }
      return Math.round(Math.min(1, Math.max(0, v)) * 255);
    };
    return [
      channel(rgb[1]!),
      channel(rgb[2]!),
      channel(rgb[3]!),
      alpha(rgb[4]),
    ];
  }
  throw new RangeError(
    `unsupported colour "${input}"; use #rgb, #rrggbb(aa), rgb() or rgba()`,
  );
}

export interface BandColorImage {
  width: number;
  height: 1;
  /** RGBA8, one texel per band. */
  data: Uint8Array;
}

export function bandColorImage(colors: readonly string[]): BandColorImage {
  const data = new Uint8Array(colors.length * 4);
  colors.forEach((c, k) => {
    data.set(parseCssColor(c), k * 4);
  });
  return { width: colors.length, height: 1, data };
}

/** Colour as a `vec4` in 0–1, for uniforms. */
export function colorToVec4(color: string): Float32Array {
  return Float32Array.from(parseCssColor(color), (v) => v / 255);
}
