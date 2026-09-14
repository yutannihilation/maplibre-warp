import { defineConfig } from "vite";

export default defineConfig({
  server: { port: 5173 },
  // `@maplibre-cog-warp/*` are workspace sources; let Vite pre-bundle their
  // dependencies but always read the packages themselves fresh.
  optimizeDeps: {
    exclude: [
      "@maplibre-cog-warp/raster",
      "@maplibre-cog-warp/geotiff",
      // Pre-bundling maplibre-gl v6 drops its ESM worker chunk
      // (`maplibre-gl-worker.mjs` 404s), which stalls every source load.
      "maplibre-gl",
    ],
  },
});
