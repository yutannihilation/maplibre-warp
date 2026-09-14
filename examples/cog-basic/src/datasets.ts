export interface Dataset {
  id: string;
  label: string;
  url: string;
  /** Where to fly when this dataset is selected. */
  center: [lng: number, lat: number];
  zoom: number;
  /** What this dataset is meant to exercise. */
  note: string;
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
];
