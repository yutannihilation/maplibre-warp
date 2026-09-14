export interface ContourConfig {
  /** Strictly increasing levels, in the raster's units. */
  thresholds: number[];
  /** One colour per emitted band (see `hypsometric`). */
  colors: string[];
  includeLower?: boolean;
  includeUpper?: boolean;
  /** Draw every k-th line thicker. */
  majorEvery?: number;
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
  /**
   * Draw the raster itself with `COGLayer`. Off for DEMs, whose 32-bit float
   * samples the render layer does not accept yet.
   */
  render?: boolean;
  /** Generate contour vector tiles from the raster. */
  contour?: ContourConfig;
}

/** `from`, `from + step`, … up to and including `to`. */
export function range(from: number, to: number, step: number): number[] {
  const out: number[] = [];
  for (let v = from; v <= to + 1e-9; v += step) {
    out.push(Number(v.toFixed(6)));
  }
  return out;
}

/** A simple hypsometric ramp: green lowlands through brown to white peaks. */
export function hypsometric(count: number): string[] {
  const stops: Array<[number, number, number]> = [
    [86, 139, 84],
    [178, 190, 106],
    [232, 214, 158],
    [186, 130, 84],
    [130, 92, 74],
    [240, 240, 240],
  ];
  return Array.from({ length: count }, (_, k) => {
    const t = count === 1 ? 0 : (k / (count - 1)) * (stops.length - 1);
    const i = Math.min(Math.floor(t), stops.length - 2);
    const f = t - i;
    const a = stops[i]!;
    const b = stops[i + 1]!;
    const c = a.map((v, ch) => Math.round(v + (b[ch]! - v) * f));
    return `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
  });
}

const swissThresholds = range(600, 2600, 50);
const usgsThresholds = range(200, 4400, 200);

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
    id: "swissalti3d",
    label: "swissALTI3D 1 km tile (EPSG:2056, float32) → contours",
    url: "https://data.geo.admin.ch/ch.swisstopo.swissalti3d/swissalti3d_2019_2573-1085/swissalti3d_2019_2573-1085_2_2056_5728.tif",
    center: [7.66, 46.4],
    zoom: 14,
    note: "2 m DEM in LV95; contours every 50 m as MapLibre fill + line layers.",
    render: false,
    contour: {
      thresholds: swissThresholds,
      colors: hypsometric(swissThresholds.length),
      majorEvery: 5,
    },
  },
  {
    id: "usgs-3dep",
    label: "USGS 3DEP 1″ n47w122 (EPSG:4326, float32) → contours",
    url: "https://prd-tnm.s3.amazonaws.com/StagedProducts/Elevation/1/TIFF/current/n47w122/USGS_1_n47w122.tif",
    center: [-121.76, 46.85],
    zoom: 10,
    note: "30 m DEM in geographic coordinates (Mount Rainier); contours every 200 m.",
    render: false,
    contour: {
      thresholds: usgsThresholds,
      colors: hypsometric(usgsThresholds.length),
      majorEvery: 5,
    },
  },
];
