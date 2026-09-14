import { COGLayer } from "@yutannihilation/maplibre-warp-geotiff";
import * as maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";

import type { LayerSpecification } from "maplibre-gl";

import type { Dataset } from "./datasets.js";
import { DATASETS } from "./datasets.js";

const LAYER_ID = "cog";

const statusEl = document.getElementById("status") as HTMLDivElement;
const selectEl = document.getElementById("dataset") as HTMLSelectElement;

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

function showDataset(dataset: Dataset): void {
  if (map.getLayer(LAYER_ID)) {
    map.removeLayer(LAYER_ID);
  }

  statusEl.textContent = `${dataset.note}\nopening COG…`;

  const started = performance.now();
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

map.on("load", () => {
  styleReady = true;
  showSelectedDataset();
});

selectEl.addEventListener("change", showSelectedDataset);

// Surface WebGL errors in the example rather than letting them scroll past.
map.on("error", (event: { error: unknown }) => {
  console.error("[maplibre]", event.error);
});

declare global {
  interface Window {
    /** Exposed for browser-driven verification. */
    __cog: { map: maplibregl.Map; layer: () => COGLayer | undefined };
  }
}
window.__cog = { map, layer: () => current };
