import { COGLayer } from "@yutannihilation/maplibre-warp-geotiff";
import * as maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";

import type { ContourFill } from "@yutannihilation/maplibre-warp-geotiff";
import type { LayerSpecification, ProjectionSpecification } from "maplibre-gl";
// maplibre-gl v6 resolves its worker through a dynamic `new URL()`, which no
// bundler can statically analyse, so the worker chunk is never emitted and the
// production build 404s on it. Bundle it explicitly and hand over the URL, as
// MapLibre's own Vite guidance prescribes.
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import type { ContourStyle, Dataset, SchemeId } from "./datasets.js";
import {
  contourOptions,
  DATASETS,
  MAX_BINS,
  MIN_BINS,
  SCHEMES,
} from "./datasets.js";

maplibregl.setWorkerUrl(workerUrl);

const LAYER_ID = "cog";

const statusEl = document.getElementById("status") as HTMLDivElement;
const legendEl = document.getElementById("legend") as HTMLDivElement;
const selectEl = document.getElementById("dataset") as HTMLSelectElement;
const projectionEl = document.getElementById("projection") as HTMLSelectElement;
const contourControlsEl = document.getElementById(
  "contour-controls",
) as HTMLFieldSetElement;
const fillEl = document.getElementById("fill") as HTMLSelectElement;
const linesEl = document.getElementById("lines") as HTMLInputElement;
const schemeEl = document.getElementById("scheme") as HTMLSelectElement;
const binsEl = document.getElementById("bins") as HTMLInputElement;
const binsValueEl = document.getElementById("bins-value") as HTMLOutputElement;
const opacityEl = document.getElementById("opacity") as HTMLInputElement;
const opacityValueEl = document.getElementById(
  "opacity-value",
) as HTMLOutputElement;
opacityValueEl.value = opacityEl.value;

for (const dataset of DATASETS) {
  const option = document.createElement("option");
  option.value = dataset.id;
  option.textContent = dataset.label;
  selectEl.append(option);
}
for (const id of Object.keys(SCHEMES)) {
  const option = document.createElement("option");
  option.value = id;
  option.textContent = id;
  schemeEl.append(option);
}
binsEl.min = String(MIN_BINS);
binsEl.max = String(MAX_BINS);

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
let currentDataset: Dataset | undefined;
/** Once the user has picked a scheme it carries across datasets. */
let schemeChosen = false;

/**
 * Keep the controls describing a valid configuration: the layer rejects
 * "no fill and no lines", so while the fill is "none" the lines are forced
 * on and the checkbox is locked. Run whenever either control or the dataset
 * changes, before the options are built.
 */
function constrainContourControls(): void {
  const linesOnly = fillEl.value === "none";
  if (linesOnly) {
    linesEl.checked = true;
  }
  linesEl.disabled = linesOnly;
}

/** The contour controls' current state. */
function styleFromControls(): ContourStyle {
  constrainContourControls();
  return {
    scheme: schemeEl.value as SchemeId,
    bins: Number(binsEl.value),
    fill: fillEl.value as ContourFill,
    lines: linesEl.checked,
  };
}

/** The contour options the controls currently describe, for `dataset`. */
function contourFromControls(dataset: Dataset) {
  return dataset.contour
    ? contourOptions(dataset.contour, styleFromControls())
    : undefined;
}

function showDataset(dataset: Dataset): void {
  if (map.getLayer(LAYER_ID)) {
    map.removeLayer(LAYER_ID);
  }
  currentDataset = dataset;

  // A new dataset brings its own bin count and line default and, until the
  // user picks one, its own scheme; the fill mode is the user's and carries
  // across. Imagery datasets have nothing to control.
  contourControlsEl.hidden = !dataset.contour;
  if (dataset.contour) {
    binsEl.value = String(dataset.contour.bins);
    binsValueEl.value = binsEl.value;
    linesEl.checked = dataset.contour.lines !== false;
    if (!schemeChosen) {
      schemeEl.value = dataset.contour.scheme;
    }
  }

  statusEl.textContent = `${dataset.note}\nopening COG…`;

  const started = performance.now();
  current = new COGLayer({
    id: LAYER_ID,
    geotiff: dataset.url,
    opacity: Number(opacityEl.value),
    contour: contourFromControls(dataset),
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
  renderLegend(current);
}

/**
 * Apply the contour controls to the layer that is already on the map.
 * `setContour` re-styles the tiles on the GPU without reloading anything —
 * including switching between bands, gradient and lines-only, which
 * compiles a new module chain on demand — so this runs live while the
 * slider is dragged.
 */
function restyleContours(): void {
  binsValueEl.value = binsEl.value;
  if (!current || !currentDataset?.contour) {
    return;
  }
  current.setContour(contourFromControls(currentDataset)!);
  renderLegend(current);
}

/** Opacity is a per-frame uniform, so this too is live and reload-free. */
function applyOpacity(): void {
  opacityValueEl.value = opacityEl.value;
  current?.setOpacity(Number(opacityEl.value));
}

// Evenly split domains rarely land on round numbers; one decimal is plenty.
const legendNumber = new Intl.NumberFormat("en", { maximumFractionDigits: 1 });

/**
 * Legend from the layer's own model: a swatch and a range per band, or a
 * ramp with its end values for a gradient. Empty for lines only.
 */
function renderLegend(layer: COGLayer): void {
  const fmt = (v: number) => legendNumber.format(v);
  const gradient = layer.getGradient();
  if (gradient) {
    const ramp = document.createElement("div");
    ramp.className = "ramp";
    ramp.style.background = `linear-gradient(to right, ${gradient.stops.join(", ")})`;
    const labels = document.createElement("div");
    labels.className = "ramp-labels";
    for (const v of [gradient.min, gradient.max]) {
      const span = document.createElement("span");
      span.textContent = fmt(v);
      labels.append(span);
    }
    legendEl.replaceChildren(ramp, labels);
    return;
  }
  legendEl.replaceChildren(
    ...layer.getBands().flatMap((band) => {
      const swatch = document.createElement("i");
      swatch.style.background = band.color;
      const label = document.createElement("span");
      label.textContent =
        band.min === undefined
          ? `< ${fmt(band.max!)}`
          : band.max === undefined
            ? `≥ ${fmt(band.min)}`
            : `${fmt(band.min)} – ${fmt(band.max)}`;
      return [swatch, label];
    }),
  );
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
schemeEl.addEventListener("change", () => {
  schemeChosen = true;
  restyleContours();
});
binsEl.addEventListener("input", restyleContours);
fillEl.addEventListener("change", restyleContours);
linesEl.addEventListener("change", restyleContours);
opacityEl.addEventListener("input", applyOpacity);

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
