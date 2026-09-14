import { describe, expect, it } from "vitest";

import { buildIsobands } from "../src/isobands.js";
import { makeGrid, pointInPolygon, signedArea } from "./helpers.js";

const N = 5;

function polygonArea(polygon: Float64Array[]): number {
  return polygon.reduce((sum, ring) => sum + signedArea(ring), 0);
}

function bandArea(polygons: Float64Array[][]): number {
  return polygons.reduce((sum, polygon) => sum + polygonArea(polygon), 0);
}

describe("buildIsobands", () => {
  const ramp = makeGrid(N, (i) => i);

  it("produces one band per threshold with the upper band open by default", () => {
    const bands = buildIsobands(ramp, N, [1.5, 3], {});
    expect(
      bands.map((b) => ({ band: b.band, min: b.min, max: b.max })),
    ).toEqual([
      { band: 0, min: 1.5, max: 3 },
      { band: 1, min: 3, max: undefined },
    ]);
    expect(bandArea(bands[0]!.polygons)).toBeCloseTo(1.5 * 4, 9);
    expect(bandArea(bands[1]!.polygons)).toBeCloseTo(1 * 4, 9);
  });

  it("adds the region below the first threshold when includeLower is set", () => {
    const bands = buildIsobands(ramp, N, [1.5, 3], { includeLower: true });
    expect(bands[0]).toMatchObject({ band: 0, max: 1.5 });
    expect(bands[0]!.min).toBeUndefined();
    expect(bandArea(bands[0]!.polygons)).toBeCloseTo(1.5 * 4, 9);
    expect(bands[1]).toMatchObject({ band: 1, min: 1.5, max: 3 });
  });

  it("drops the open upper band when includeUpper is false", () => {
    const bands = buildIsobands(ramp, N, [1.5, 3], { includeUpper: false });
    expect(bands).toHaveLength(1);
    expect(bands[0]).toMatchObject({ band: 0, min: 1.5, max: 3 });
  });

  it("nests the next threshold's region as a hole", () => {
    const peak = makeGrid(N, (i, j) => 10 - Math.hypot(i - 2, j - 2));
    const bands = buildIsobands(peak, N, [8.2, 9.2], {});
    // [8.2, 9.2) is an annulus: one polygon, one outer ring and one hole.
    expect(bands[0]!.polygons).toHaveLength(1);
    const [annulus] = bands[0]!.polygons;
    expect(annulus).toHaveLength(2);
    expect(signedArea(annulus![0]!)).toBeGreaterThan(0);
    expect(signedArea(annulus![1]!)).toBeLessThan(0);
    // [9.2, ∞) is the disc inside the hole.
    expect(bands[1]!.polygons).toHaveLength(1);
    expect(bands[1]!.polygons[0]).toHaveLength(1);
    expect(signedArea(bands[1]!.polygons[0]![0]!)).toBeCloseTo(
      -signedArea(annulus![1]!),
      9,
    );
  });

  it("re-nests a lower region inside a hole of the upper region", () => {
    // A ring-shaped ridge: high on a circle of radius 2, low at the centre and
    // outside. Band [5, ∞) is an annulus; band [2, 5) then has an outer ring
    // outside the ridge *and* a separate island in the ridge's hole.
    const M = 9;
    const ridge = makeGrid(
      M,
      (i, j) => 10 - 4 * Math.abs(Math.hypot(i - 4, j - 4) - 2.2),
    );
    const bands = buildIsobands(ridge, M, [2, 5], {});
    expect(bands[1]!.polygons).toHaveLength(1);
    expect(bands[1]!.polygons[0]).toHaveLength(2);
    // The centre point (4, 4) has value 10 - 4·2.2 = 1.2 < 2, so it is in no
    // band; a point at radius 1 has value 10 - 4·1.2 = 5.2 ≥ 5.
    expect(
      bands.some((b) => b.polygons.some((p) => pointInPolygon(p, 4, 4))),
    ).toBe(false);
    const nearCentre = bands[0]!.polygons.filter((p) =>
      pointInPolygon(p, 4, 4.45),
    );
    // value at (4, 4.45): 10 - 4·|0.45 - 2.2| = 3 → band 0, as an island.
    expect(nearCentre).toHaveLength(1);
    for (const polygon of bands[0]!.polygons) {
      expect(signedArea(polygon[0]!)).toBeGreaterThan(0);
      for (const hole of polygon.slice(1)) {
        expect(signedArea(hole)).toBeLessThan(0);
      }
    }
  });

  it("partitions the finite region: every unambiguous cell centre is in exactly one band", () => {
    const M = 12;
    const grid = makeGrid(
      M,
      (i, j) => 3 * Math.sin(i * 0.9) * Math.cos(j * 0.6) + 0.3 * i,
    );
    const thresholds = [-2, -0.5, 1, 2.5];
    const bands = buildIsobands(grid, M, thresholds, {
      includeLower: true,
      includeUpper: true,
    });
    let checked = 0;
    for (let j = 0; j < M - 1; j++) {
      for (let i = 0; i < M - 1; i++) {
        const corners = [
          grid[j * M + i]!,
          grid[j * M + i + 1]!,
          grid[(j + 1) * M + i]!,
          grid[(j + 1) * M + i + 1]!,
        ];
        // Only use cells whose four corners fall in the same band.
        const classify = (v: number) => thresholds.filter((t) => v >= t).length;
        const c = classify(corners[0]!);
        if (!corners.every((v) => classify(v) === c)) {
          continue;
        }
        checked++;
        const hits = bands.filter((b) =>
          b.polygons.some((p) => pointInPolygon(p, i + 0.5, j + 0.5)),
        );
        expect(hits.map((b) => b.band)).toEqual([c]);
      }
    }
    expect(checked).toBeGreaterThan(10);
  });

  it("treats NaN samples as outside every band", () => {
    const grid = makeGrid(N, () => 5);
    grid[2 * N + 2] = Number.NaN;
    const bands = buildIsobands(grid, N, [1], {});
    expect(bands).toHaveLength(1);
    expect(bandArea(bands[0]!.polygons)).toBeLessThan(16);
    expect(bands[0]!.polygons.some((p) => pointInPolygon(p, 2, 2))).toBe(false);
  });

  it("rejects malformed input", () => {
    expect(() => buildIsobands(new Float32Array(3), 2, [0], {})).toThrow(
      RangeError,
    );
    expect(() => buildIsobands(new Float32Array(4), 2, [2, 1], {})).toThrow(
      RangeError,
    );
    expect(() => buildIsobands(new Float32Array(4), 2, [], {})).toThrow(
      RangeError,
    );
  });
});
