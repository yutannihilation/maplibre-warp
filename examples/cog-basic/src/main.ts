import { COGContourSource } from "@yutannihilation/maplibre-warp-contour";
import { COGLayer } from "@yutannihilation/maplibre-warp-geotiff";
import * as maplibregl from "maplibre-gl";
// The contour source's worker, bundled by Vite. The library's default
// `new URL("./worker.js", import.meta.url)` works against the built package;
// the example runs from sources, so hand it the bundled source module.
// biome-ignore lint/correctness/useImportExtensions: Vite `?worker` query import
import ContourWorker from "../../../packages/maplibre-warp-contour/src/worker.ts?worker";
import "maplibre-gl/dist/maplibre-gl.css";

import type {
  ExpressionSpecification,
  LayerSpecification,
  ProjectionSpecification,
} from "maplibre-gl";
// maplibre-gl v6 resolves its worker through a dynamic `new URL()`, which no
// bundler can statically analyse, so the worker chunk is never emitted and the
// production build 404s on it. Bundle it explicitly and hand over the URL, as
// MapLibre's own Vite guidance prescribes.
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";

import type { ContourConfig, Dataset } from "./datasets.js";
import { DATASETS } from "./datasets.js";

maplibregl.setWorkerUrl(workerUrl);

const LAYER_ID = "cog";
const CONTOUR_SOURCE_ID = "cog-contours";
const CONTOUR_FILL_ID = "cog-contour-bands";
const CONTOUR_LINE_ID = "cog-contour-lines";

const statusEl = document.getElementById("status") as HTMLDivElement;
const legendEl = document.getElementById("legend") as HTMLDivElement;
const selectEl = document.getElementById("dataset") as HTMLSelectElement;
const projectionEl = document.getElementById("projection") as HTMLSelectElement;

for (const dataset of DATASETS) {
  const option = document.createElement("option");
  option.value = dataset.id;
  option.textContent = dataset.label;
  selectEl.append(option);
}

const map = new maplibregl.Map({
  container: "map",
  style: "https://demotiles.maplibre.org/style.json",
  center: DATASETS[0]!.center,
  zoom: DATASETS[0]!.zoom,
  hash: true,
});
map.addControl(new maplibregl.NavigationControl(), "top-right");
map.addControl(new maplibregl.ScaleControl());

/**
 * Insert the COG under the basemap's first symbol layer, so MapLibre's labels
 * stay on top. Getting labels to keep drawing correctly after our layer is
 * also the regression check for GL-state leakage (MapLibre issue #8413).
 */
function firstSymbolLayerId(): string | undefined {
  return map
    .getStyle()
    .layers?.find((layer: LayerSpecification) => layer.type === "symbol")?.id;
}

let current: COGLayer | undefined;
let currentContours: COGContourSource | undefined;

function removeContours(): void {
  for (const id of [CONTOUR_LINE_ID, CONTOUR_FILL_ID]) {
    if (map.getLayer(id)) {
      map.removeLayer(id);
    }
  }
  if (map.getSource(CONTOUR_SOURCE_ID)) {
    map.removeSource(CONTOUR_SOURCE_ID);
  }
  currentContours?.destroy();
  currentContours = undefined;
  legendEl.replaceChildren();
}

/**
 * Add the contour vector source plus a fill layer coloured per band and a
 * line layer with thicker major lines, all through the MapLibre style spec.
 */
async function showContours(
  dataset: Dataset,
  config: ContourConfig,
  started: number,
): Promise<void> {
  const contours = new COGContourSource({
    id: `contours-${dataset.id}`,
    geotiff: dataset.url,
    thresholds: config.thresholds,
    includeLower: config.includeLower,
    includeUpper: config.includeUpper,
    createWorker: () => new ContourWorker(),
  });
  contours.register(maplibregl);
  currentContours = contours;

  const spec = await contours.getSourceSpecification();
  if (currentContours !== contours) {
    contours.destroy();
    return;
  }
  const bands = contours.getBands();
  if (bands.length !== config.colors.length) {
    throw new Error(
      `${bands.length} bands but ${config.colors.length} colours configured`,
    );
  }

  map.addSource(CONTOUR_SOURCE_ID, spec);
  const before = firstSymbolLayerId();
  // MapLibre's tuple typing for `match` cannot express a spread of pairs.
  const fillColor = [
    "match",
    ["get", "band"],
    ...bands.flatMap((band, k) => [band.band, config.colors[k]!]),
    "rgba(0, 0, 0, 0)",
  ] as unknown as ExpressionSpecification;
  map.addLayer(
    {
      id: CONTOUR_FILL_ID,
      type: "fill",
      source: CONTOUR_SOURCE_ID,
      "source-layer": "bands",
      paint: {
        "fill-color": fillColor,
        "fill-opacity": 0.75,
        "fill-antialias": false,
      },
    },
    before,
  );
  const major = config.majorEvery ?? 5;
  map.addLayer(
    {
      id: CONTOUR_LINE_ID,
      type: "line",
      source: CONTOUR_SOURCE_ID,
      "source-layer": "lines",
      paint: {
        "line-color": "rgba(60, 40, 20, 0.8)",
        "line-width": [
          "case",
          ["==", ["%", ["get", "index"], major], 0],
          1.4,
          0.5,
        ],
      },
    },
    before,
  );

  legendEl.replaceChildren(
    ...bands.flatMap((band, k) => {
      const swatch = document.createElement("i");
      swatch.style.background = config.colors[k]!;
      const label = document.createElement("span");
      label.textContent =
        band.min === undefined
          ? `< ${band.max}`
          : band.max === undefined
            ? `≥ ${band.min}`
            : `${band.min} – ${band.max}`;
      return [swatch, label];
    }),
  );

  const [west, south, east, north] = spec.bounds!;
  map.fitBounds(
    [
      [west, south],
      [east, north],
    ],
    { padding: 24, duration: 0 },
  );
  statusEl.textContent = [
    dataset.note,
    `contour source: z${spec.minzoom}–z${spec.maxzoom}, ${bands.length} bands`,
    `header read in ${Math.round(performance.now() - started)} ms`,
  ].join("\n");
}

function showDataset(dataset: Dataset): void {
  if (map.getLayer(LAYER_ID)) {
    map.removeLayer(LAYER_ID);
  }
  removeContours();

  statusEl.textContent = `${dataset.note}\nopening COG…`;

  const started = performance.now();
  if (dataset.contour) {
    showContours(dataset, dataset.contour, started).catch((error: unknown) => {
      console.error("[contours]", error);
      statusEl.textContent = `${dataset.note}\ncontour source failed: ${String(error)}`;
    });
  }
  if (dataset.render === false) {
    current = undefined;
    return;
  }
  current = new COGLayer({
    id: LAYER_ID,
    geotiff: dataset.url,
    onGeoTIFFLoad: (geotiff, { projection, geographicBounds }) => {
      const headerMs = Math.round(performance.now() - started);
      statusEl.textContent = [
        dataset.note,
        `CRS: ${projection.title || projection.projName || geotiff.crs}`,
        `size: ${geotiff.width} × ${geotiff.height}, ${geotiff.overviews.length} overviews`,
        `bands: ${geotiff.count}, nodata: ${geotiff.nodata ?? "none"}`,
        `header read in ${headerMs} ms`,
      ].join("\n");
      map.fitBounds(
        [
          [geographicBounds.west, geographicBounds.south],
          [geographicBounds.east, geographicBounds.north],
        ],
        { padding: 24, duration: 0 },
      );
    },
  });

  map.addLayer(current, firstSymbolLayerId());
}

let styleReady = false;

/**
 * Show whichever dataset the `<select>` currently names.
 *
 * The select is the single source of truth. Both the initial load and later
 * changes route through here, so a selection made before the style is ready is
 * applied when `load` fires rather than being lost: the previous version
 * re-showed `DATASETS[0]` on load unconditionally, which silently overrode any
 * change that landed first and left the dropdown disagreeing with the map.
 */
function showSelectedDataset(): void {
  if (!styleReady) {
    // `addLayer` throws before the style is ready. The `load` handler below
    // will apply whatever is selected by then.
    return;
  }
  const dataset = DATASETS.find((d) => d.id === selectEl.value);
  if (dataset) {
    showDataset(dataset);
  }
}

/**
 * Apply whichever projection the `<select>` currently names.
 *
 * The projection is a property of the map, not of the layer: the layer reads
 * MapLibre's current shader variant every frame and follows it. This control
 * only exists to exercise that.
 *
 * Guarded the same way as the dataset selector, because `setProjection` throws
 * before the style has loaded — a change made in that first moment would
 * otherwise be lost and leave the dropdown disagreeing with the map.
 */
function applySelectedProjection(): void {
  if (!styleReady) {
    return;
  }
  map.setProjection({
    type: projectionEl.value as ProjectionSpecification["type"],
  });
}

map.on("load", () => {
  styleReady = true;
  showSelectedDataset();
  applySelectedProjection();
});

selectEl.addEventListener("change", showSelectedDataset);
projectionEl.addEventListener("change", applySelectedProjection);

// Surface WebGL errors in the example rather than letting them scroll past.
map.on("error", (event: { error: unknown }) => {
  console.error("[maplibre]", event.error);
});

declare global {
  interface Window {
    /** Exposed for browser-driven verification. */
    __cog: {
      map: maplibregl.Map;
      layer: () => COGLayer | undefined;
      contours: () => COGContourSource | undefined;
    };
  }
}
window.__cog = { map, layer: () => current, contours: () => currentContours };
