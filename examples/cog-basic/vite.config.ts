import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const src = (path: string) =>
  fileURLToPath(new URL(`../../packages/${path}`, import.meta.url));

export default defineConfig({
  server: { port: 5173 },
  resolve: {
    // Resolve the workspace packages to their TypeScript sources rather than
    // their published `dist/` entry points. Without this the example cannot be
    // run from a fresh clone until `pnpm build` has produced a `dist/`, and
    // edits to package sources need a rebuild before they show up here.
    // Longest specifier first — Vite matches these in order.
    alias: [
      {
        find: "@maplibre-cog-warp/raster/gpu-modules",
        replacement: src("maplibre-raster/src/gpu-modules/index.ts"),
      },
      {
        find: "@maplibre-cog-warp/raster",
        replacement: src("maplibre-raster/src/index.ts"),
      },
      {
        find: "@maplibre-cog-warp/geotiff",
        replacement: src("maplibre-geotiff/src/index.ts"),
      },
    ],
  },
  optimizeDeps: {
    // Pre-bundling maplibre-gl v6 drops its ESM worker chunk
    // (`maplibre-gl-worker.mjs` 404s), which stalls every source load.
    exclude: ["maplibre-gl"],
  },
});
