import type {
  ContourFill,
  ContourRenderOptions,
  Rescale,
} from "@yutannihilation/maplibre-warp-geotiff";
import { MAX_THRESHOLDS } from "@yutannihilation/maplibre-warp-raster/gpu-modules";
import {
  interpolateCividis,
  interpolateInferno,
  interpolateMagma,
  interpolatePlasma,
  interpolateSpectral,
  interpolateTurbo,
  interpolateViridis,
  interpolateYlGnBu,
} from "d3-scale-chromatic";

/**
 * Band colours come from d3-scale-chromatic. `bands.colors` accepts either a
 * continuous interpolator — called once per band with `t` in [0, 1] (plus the
 * band index and count) — or a discrete scheme, an array whose length must
 * equal the band count (`schemeBlues[5]` for five bands, say). The picker
 * below sticks to interpolators so that any bin count works.
 */
export const SCHEMES = {
  viridis: interpolateViridis,
  inferno: interpolateInferno,
  magma: interpolateMagma,
  plasma: interpolatePlasma,
  cividis: interpolateCividis,
  turbo: interpolateTurbo,
  spectral: interpolateSpectral,
  YlGnBu: interpolateYlGnBu,
} as const;

export type SchemeId = keyof typeof SCHEMES;

/** How a dataset is contoured; the UI supplies the scheme and may override `bins`. */
export interface ContourSpec {
  /** First and last threshold, in the raster's units. */
  domain: [min: number, max: number];
  /** Band count when the dataset is selected. */
  bins: number;
  /** Also fill the open band below `domain[0]`. */
  includeLower?: boolean;
  /** Default d3 scheme; the UI may pick another. */
  scheme: SchemeId;
  /** Line style, or `false` to start with lines off; the UI may toggle them. */
  lines: ContourRenderOptions["lines"];
}

/** What the contour controls describe, independent of the dataset. */
export interface ContourStyle {
  scheme: SchemeId;
  bins: number;
  fill: ContourFill;
  /** Draw lines, with the dataset's style or the default when it has none. */
  lines: boolean;
}

/** A named band composite of a multi-band dataset. */
export interface BandPreset {
  label: string;
  /** 0-based file bands: `[gray]`, `[r, g, b]` or `[r, g, b, a]`. */
  bands: number[];
}

/** How a multi-band dataset is composed; the UI picks the preset and stretch. */
export interface ImagerySpec {
  presets: BandPreset[];
  /**
   * Stretch range the slider spans, in sample units, and its initial upper
   * end. Omit for 8-bit data drawn at full range.
   */
  stretch?: { max: number; initial: number };
}

export interface Dataset {
  id: string;
  label: string;
  url: string;
  /** Where to fly when this dataset is selected. */
  center: [lng: number, lat: number];
  zoom: number;
  /** What this dataset is meant to exercise. */
  note: string;
  /** Render as shader contours instead of imagery. */
  contour?: ContourSpec;
  /** Band presets and stretch for multi-band imagery. */
  imagery?: ImagerySpec;
}

/** The stretch the slider describes: `[0, value]` on every colour channel. */
export function stretchRescale(
  spec: ImagerySpec,
  value: number,
): Rescale | undefined {
  if (!spec.stretch) {
    return undefined;
  }
  if (!(value > 0 && value <= spec.stretch.max)) {
    throw new RangeError(`stretch must be in (0, ${spec.stretch.max}]`);
  }
  return [0, value];
}

/** Fewest bands the UI offers: one threshold plus the open upper band. */
export const MIN_BINS = 2;
/**
 * Most bands the UI offers. Without `includeLower` every band needs its own
 * threshold, so this is the layer's threshold cap; the range input's bounds
 * are set from here rather than in the HTML.
 */
export const MAX_BINS = MAX_THRESHOLDS;

/** `count` evenly spaced values from `from` to `to`, both included. */
export function linspace(from: number, to: number, count: number): number[] {
  if (count === 1) {
    return [from];
  }
  const step = (to - from) / (count - 1);
  return Array.from({ length: count }, (_, i) =>
    Number((from + i * step).toFixed(6)),
  );
}

/**
 * Turn a spec and the control state into layer options. `bins` is the number
 * of filled bands, so the threshold count is one fewer when the open lower
 * band is on; the gradient spans the same thresholds, so its domain is the
 * spec's. Pure: this is what the UI re-runs on every control change.
 */
export function contourOptions(
  spec: ContourSpec,
  style: ContourStyle,
): ContourRenderOptions {
  const { scheme, bins, fill, lines } = style;
  if (!Number.isInteger(bins) || bins < MIN_BINS || bins > MAX_BINS) {
    throw new RangeError(`bins must be an integer in ${MIN_BINS}–${MAX_BINS}`);
  }
  const includeLower = spec.includeLower ?? false;
  const thresholds = linspace(
    spec.domain[0],
    spec.domain[1],
    bins - (includeLower ? 1 : 0),
  );
  return {
    thresholds,
    fill,
    bands: { colors: SCHEMES[scheme], includeLower },
    lines: lines ? (spec.lines === false ? undefined : spec.lines) : false,
  };
}

export const DATASETS: Dataset[] = [
  {
    id: "swisstopo",
    label: "swisstopo PK1000 (EPSG:2056, RGB uint8)",
    url: "https://data.geo.admin.ch/ch.swisstopo.pixelkarte-farbe-pk1000.noscale/swiss-map-raster1000_1000/swiss-map-raster1000_1000_krel_50_2056.tif",
    center: [8.23, 46.82],
    zoom: 7,
    note: "LV95 / oblique Mercator — the warp is doing real work here.",
  },
  {
    id: "nlcd",
    label: "NLCD 2023 land cover (Albers, palette + nodata)",
    url: "https://ds-wheels.s3.us-east-1.amazonaws.com/Annual_NLCD_LndCov_2023_CU_C1V0.tif",
    center: [-98.5, 39.5],
    zoom: 4,
    note: "Palette photometric with a colormap texture; nodata 250 discarded.",
  },
  {
    id: "tn-ortho",
    label: "Tennessee orthophoto (EPSG:2274, grayscale uint8)",
    url: "https://data.source.coop/giswqs/tn-imagery/imagery/AndersonCo_OrthoPan_2ft_2000.tif",
    center: [-84.18, 36.05],
    zoom: 12,
    note: "State Plane in US survey feet; MinIsBlack grayscale, nodata 255.",
  },
  {
    id: "naip",
    label: "NAIP Colorado 2023 (EPSG:26913, RGB+NIR uint8)",
    url: "https://naipeuwest.blob.core.windows.net/naip/v002/co/2023/co_030cm_2023/40104/m_4010460_nw_13_030_20231020_20240104.tif",
    center: [-104.72, 40.19],
    zoom: 13,
    note: "Four bands with ExtraSamples = 0: band 4 is near-infrared, not alpha. Switch presets live.",
    imagery: {
      presets: [
        { label: "true colour (R, G, B)", bands: [0, 1, 2] },
        { label: "false colour infrared (NIR, R, G)", bands: [3, 0, 1] },
        { label: "near-infrared as grey", bands: [3] },
      ],
    },
  },
  {
    id: "maxar-wv3",
    label: "Maxar WorldView-3 multispectral (EPSG:32646, 8 × uint16)",
    url: "https://maxar-opendata.s3.amazonaws.com/events/BayofBengal-Cyclone-Mocha-May-23/ard/46/033111330333/2023-05-22/10300100E6747500-ms.tif",
    center: [92.85, 20.3],
    zoom: 13,
    note: "Eight 16-bit bands (coastal, blue, green, yellow, red, red edge, NIR1, NIR2) plus a mask; needs a stretch.",
    imagery: {
      presets: [
        { label: "true colour (red, green, blue)", bands: [4, 2, 1] },
        { label: "false colour infrared (NIR1, red, green)", bands: [6, 4, 2] },
        {
          label: "SWIR-less agriculture (NIR2, red edge, coastal)",
          bands: [7, 5, 0],
        },
        { label: "NIR1 as grey", bands: [6] },
      ],
      stretch: { max: 4000, initial: 1800 },
    },
  },
  {
    id: "swissalti3d",
    label: "swissALTI3D 1 km tile (EPSG:2056, float32) → shader contours",
    url: "https://data.geo.admin.ch/ch.swisstopo.swissalti3d/swissalti3d_2019_2573-1085/swissalti3d_2019_2573-1085_2_2056_5728.tif",
    center: [7.66, 46.4],
    zoom: 14,
    note: "2 m DEM in LV95; bands every 50 m and lines drawn in the fragment shader.",
    contour: {
      // 600–2600 m in 41 bands is a threshold every 50 m.
      domain: [600, 2600],
      bins: 41,
      scheme: "viridis",
      lines: {
        width: 1,
        color: "rgba(60, 40, 20, 0.8)",
        majorEvery: 5,
        majorWidth: 2,
      },
    },
  },
  {
    id: "usgs-3dep",
    label: "USGS 3DEP 1″ n47w122 (EPSG:4326, float32) → shader contours",
    url: "https://prd-tnm.s3.amazonaws.com/StagedProducts/Elevation/1/TIFF/current/n47w122/USGS_1_n47w122.tif",
    center: [-121.76, 46.85],
    zoom: 10,
    note: "30 m DEM in geographic coordinates (Mount Rainier); bands every 200 m.",
    contour: {
      // 22 thresholds every 200 m plus the open band below 200 m.
      domain: [200, 4400],
      bins: 23,
      includeLower: true,
      scheme: "turbo",
      lines: {
        width: 0.8,
        color: "rgba(60, 40, 20, 0.7)",
        majorEvery: 5,
        majorWidth: 1.6,
      },
    },
  },
  {
    id: "s2-b04",
    label: "Sentinel-2 B04 36QWD (EPSG:32636, uint16) → shader contours",
    url: "https://sentinel-cogs.s3.us-west-2.amazonaws.com/sentinel-s2-l2a-cogs/36/Q/WD/2020/7/S2A_36QWD_20200701_0_L2A/B04.tif",
    center: [33.5, 17.5],
    zoom: 9,
    note: "Red-band reflectance as isobands: exercises the uint16 (usampler2D) contour path.",
    contour: {
      domain: [1000, 4000],
      bins: 5,
      includeLower: true,
      scheme: "YlGnBu",
      lines: false,
    },
  },
];
