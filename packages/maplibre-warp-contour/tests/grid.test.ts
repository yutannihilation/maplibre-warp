import { describe, expect, it } from "vitest";

import {
  gridSampleMercator,
  gridSize,
  projectGrid,
  toTileCoordinate,
} from "../src/grid.js";

describe("gridSize", () => {
  it("counts corner samples for tile cells plus the buffer on both sides", () => {
    expect(gridSize({ tileSize: 256, buffer: 1 })).toBe(259);
    expect(gridSize({ tileSize: 4, buffer: 0 })).toBe(5);
  });
});

describe("gridSampleMercator", () => {
  it("places sample (buffer, buffer) on the tile's top-left corner", () => {
    const spec = { z: 2, x: 1, y: 3, tileSize: 256, buffer: 2 };
    expect(gridSampleMercator(spec, 2, 2)).toEqual([1 / 4, 3 / 4]);
  });

  it("places sample (buffer + tileSize, buffer + tileSize) on the bottom-right corner", () => {
    const spec = { z: 2, x: 1, y: 3, tileSize: 256, buffer: 2 };
    expect(gridSampleMercator(spec, 258, 258)).toEqual([2 / 4, 4 / 4]);
  });

  it("steps one mercator pixel per sample", () => {
    const spec = { z: 0, x: 0, y: 0, tileSize: 256, buffer: 1 };
    const [x0] = gridSampleMercator(spec, 1, 1);
    const [x1] = gridSampleMercator(spec, 2, 1);
    expect(x1 - x0).toBeCloseTo(1 / 256, 12);
  });
});

describe("toTileCoordinate", () => {
  const opts = { tileSize: 256, buffer: 1, extent: 4096 };

  it("maps the tile corners to 0 and extent", () => {
    expect(toTileCoordinate(1, opts)).toBe(0);
    expect(toTileCoordinate(257, opts)).toBe(4096);
  });

  it("maps buffer samples outside [0, extent]", () => {
    expect(toTileCoordinate(0, opts)).toBe(-16);
    expect(toTileCoordinate(258, opts)).toBe(4112);
  });

  it("rounds fractional grid positions", () => {
    expect(toTileCoordinate(1.5, opts)).toBe(8);
    expect(toTileCoordinate(1.03, opts)).toBe(0);
    expect(toTileCoordinate(1.04, opts)).toBe(1);
  });
});

describe("projectGrid", () => {
  const spec = { z: 3, x: 5, y: 2, tileSize: 16, buffer: 0 };

  it("returns interleaved pixel coordinates for every sample", () => {
    const out = projectGrid(spec, (mx, my) => [mx, my], { latticeStep: 4 });
    const n = gridSize(spec);
    expect(out).toBeInstanceOf(Float64Array);
    expect(out.length).toBe(2 * n * n);
    // Sample (0, 0) is the tile's top-left corner in mercator.
    expect(out[0]).toBeCloseTo(5 / 8, 12);
    expect(out[1]).toBeCloseTo(2 / 8, 12);
    // Sample (n-1, n-1) is the bottom-right corner.
    expect(out[2 * (n * n - 1)]).toBeCloseTo(6 / 8, 12);
    expect(out[2 * (n * n - 1) + 1]).toBeCloseTo(3 / 8, 12);
  });

  it("only evaluates the projection on lattice nodes", () => {
    let calls = 0;
    projectGrid(
      spec,
      (mx, my) => {
        calls++;
        return [mx, my];
      },
      { latticeStep: 4 },
    );
    expect(calls).toBe(5 * 5);
  });

  it("reproduces an affine projection exactly between lattice nodes", () => {
    const affine = (mx: number, my: number): [number, number] => [
      1000 * mx - 3 * my + 7,
      -20 * mx + 4000 * my + 0.5,
    ];
    const interpolated = projectGrid(spec, affine, { latticeStep: 8 });
    const direct = projectGrid(spec, affine, { latticeStep: 1 });
    for (let i = 0; i < direct.length; i++) {
      expect(interpolated[i]).toBeCloseTo(direct[i]!, 9);
    }
  });

  it("marks every sample of a lattice cell NaN when a corner fails to project", () => {
    const n = gridSize(spec);
    const out = projectGrid(
      spec,
      (mx, my) => (mx > 0.7 ? [Number.NaN, Number.NaN] : [mx, my]),
      { latticeStep: 8 },
    );
    // Lattice nodes are at columns 0, 8, 16. mx > 0.7 corresponds to columns
    // beyond 0.7 * 128 - 80 = 9.6, so the node at column 16 fails and the
    // right-hand lattice cells (columns 8..16) are NaN.
    const sample = (i: number, j: number) => out[2 * (j * n + i)]!;
    expect(sample(4, 4)).not.toBeNaN();
    expect(sample(8, 4)).not.toBeNaN();
    expect(sample(9, 4)).toBeNaN();
    expect(sample(16, 4)).toBeNaN();
  });

  it("handles a lattice step that does not divide the cell count", () => {
    const affine = (mx: number, my: number): [number, number] => [
      1000 * mx - 3 * my + 7,
      -20 * mx + 4000 * my + 0.5,
    ];
    let calls = 0;
    const interpolated = projectGrid(
      spec,
      (mx, my) => {
        calls++;
        return affine(mx, my);
      },
      { latticeStep: 5 },
    );
    // Nodes at 0, 5, 10, 15 and the far edge 16.
    expect(calls).toBe(5 * 5);
    const direct = projectGrid(spec, affine, { latticeStep: 1 });
    for (let i = 0; i < direct.length; i++) {
      expect(interpolated[i]).toBeCloseTo(direct[i]!, 9);
    }
  });

  it("rejects non-positive or fractional lattice steps", () => {
    expect(() =>
      projectGrid(spec, (mx, my) => [mx, my], { latticeStep: 0 }),
    ).toThrow(RangeError);
    expect(() =>
      projectGrid(spec, (mx, my) => [mx, my], { latticeStep: 2.5 }),
    ).toThrow(RangeError);
  });
});
