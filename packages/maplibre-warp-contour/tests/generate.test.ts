import { VectorTile } from "@mapbox/vector-tile";
import { PbfReader } from "pbf";
import { describe, expect, it } from "vitest";
import type { ContourOptions, WarpSource } from "../src/generate.js";
import { generateContourTile } from "../src/generate.js";
import type { FetchedTile } from "../src/window.js";

/**
 * A synthetic source whose CRS is mercator scaled by WORLD, with one level of
 * one pixel per CRS unit in 64-pixel tiles covering the whole world. Pixel
 * values equal the pixel centre's x coordinate, so a contour at level `v`
 * sits at level pixel x = v, i.e. mercator x = v / WORLD.
 */
const WORLD = 4096;
const TILE = 64;

function makeSource(
  overrides: Partial<WarpSource> = {},
  record?: Array<[number, number]>,
): WarpSource {
  return {
    levels: [
      {
        metersPerPixel: 1,
        tileWidth: TILE,
        tileHeight: TILE,
        matrixWidth: WORLD / TILE,
        matrixHeight: WORLD / TILE,
        crsToPixel: (x, y) => [x, y],
      },
    ],
    mercatorToCrs: (mx, my) => [mx * WORLD, my * WORLD],
    fetchTiles: async (_level, xy) => {
      record?.push(...xy);
      return xy.map(([x, y]): FetchedTile => {
        const data = new Float32Array(TILE * TILE);
        for (let r = 0; r < TILE; r++) {
          for (let c = 0; c < TILE; c++) {
            data[r * TILE + c] = x * TILE + c + 0.5;
          }
        }
        return {
          x,
          y,
          width: TILE,
          height: TILE,
          data,
          stride: 1,
          offset: 0,
          nodata: null,
          mask: null,
        };
      });
    },
    ...overrides,
  };
}

const options: ContourOptions = {
  band: 0,
  thresholds: [900],
  mode: "both",
  tileSize: 256,
  buffer: 1,
  extent: 4096,
  includeLower: false,
  includeUpper: true,
  layerNames: { bands: "bands", lines: "lines" },
  maxSourceTiles: 64,
};

const request = { z: 4, x: 3, y: 5 };

describe("generateContourTile", () => {
  it("fetches exactly the source tiles under the buffered grid", async () => {
    const record: Array<[number, number]> = [];
    await generateContourTile(request, makeSource({}, record), options);
    // Grid mercator x ∈ [(768-1)/4096, (1024+1)/4096] → pixels 767..1025 →
    // cols 11..16; y ∈ 1279..1537 → rows 19..24.
    const cols = new Set(record.map(([x]) => x));
    const rows = new Set(record.map(([, y]) => y));
    expect([...cols].sort((a, b) => a - b)).toEqual([11, 12, 13, 14, 15, 16]);
    expect([...rows].sort((a, b) => a - b)).toEqual([19, 20, 21, 22, 23, 24]);
    expect(record.length).toBe(36);
  });

  it("places the contour where the warped value crosses the threshold", async () => {
    const bytes = await generateContourTile(request, makeSource(), options);
    expect(bytes).not.toBeNull();
    const tile = new VectorTile(new PbfReader(bytes!));

    const lines = tile.layers.lines!;
    expect(lines.length).toBe(1);
    const line = lines.feature(0);
    expect(line.properties).toEqual({ level: 900, index: 0 });
    // Sample i has value 767 + i; 900 → i = 133 → tile x = (133 − 1)·16.
    const geometry = line.loadGeometry();
    expect(geometry).toHaveLength(1);
    for (const point of geometry[0]!) {
      expect(point.x).toBe(2112);
    }
    const ys = geometry[0]!.map((p) => p.y);
    expect(Math.min(...ys)).toBe(-16);
    expect(Math.max(...ys)).toBe(4112);

    const bands = tile.layers.bands!;
    expect(bands.length).toBe(1);
    const band = bands.feature(0);
    expect(band.properties).toEqual({ band: 0, min: 900 });
    const ring = band.loadGeometry()[0]!;
    const xs = ring.map((p) => p.x);
    expect(Math.min(...xs)).toBe(2112);
    expect(Math.max(...xs)).toBe(4112);
  });

  it("emits only the requested layers", async () => {
    const bandsOnly = new VectorTile(
      new PbfReader(
        (await generateContourTile(request, makeSource(), {
          ...options,
          mode: "bands",
        }))!,
      ),
    );
    expect(Object.keys(bandsOnly.layers)).toEqual(["bands"]);
    const linesOnly = new VectorTile(
      new PbfReader(
        (await generateContourTile(request, makeSource(), {
          ...options,
          mode: "lines",
        }))!,
      ),
    );
    expect(Object.keys(linesOnly.layers)).toEqual(["lines"]);
  });

  it("returns null when no grid sample projects into the level", async () => {
    const source = makeSource({
      mercatorToCrs: () => [Number.NaN, Number.NaN],
    });
    await expect(
      generateContourTile(request, source, options),
    ).resolves.toBeNull();
  });

  it("returns null when the footprint lies outside the level's tile matrix", async () => {
    const source = makeSource({
      mercatorToCrs: (mx, my) => [mx * WORLD + 10 * WORLD, my * WORLD],
    });
    await expect(
      generateContourTile(request, source, options),
    ).resolves.toBeNull();
  });

  it("fails explicitly when the footprint needs more source tiles than allowed", async () => {
    await expect(
      generateContourTile(request, makeSource(), {
        ...options,
        maxSourceTiles: 4,
      }),
    ).rejects.toThrow(RangeError);
  });

  it("propagates abort", async () => {
    const controller = new AbortController();
    const source = makeSource({
      fetchTiles: (_level, _xy, signal) =>
        new Promise((_, reject) => {
          signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
    });
    const pending = generateContourTile(
      request,
      source,
      options,
      controller.signal,
    );
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });
});
