import { describe, expect, it } from "vitest";

import { traceIsolines } from "../src/isolines.js";
import { makeGrid } from "./helpers.js";

const N = 5;

describe("traceIsolines", () => {
  it("traces a straight line through a linear ramp and joins it into one polyline", () => {
    const grid = makeGrid(N, (i) => i);
    const [iso] = traceIsolines(grid, N, [1.5]);
    expect(iso!.level).toBe(1.5);
    expect(iso!.lines).toHaveLength(1);
    const line = iso!.lines[0]!;
    // One segment per cell row, joined: 5 points from y = 0 to y = 4.
    expect(line.length).toBe(2 * N);
    for (let k = 0; k < line.length; k += 2) {
      expect(line[k]).toBeCloseTo(1.5, 12);
    }
    const ys = [line[1], line[line.length - 1]].sort((a, b) => a! - b!);
    expect(ys).toEqual([0, 4]);
  });

  it("interpolates along cell edges", () => {
    const grid = makeGrid(N, (i, j) => i + j);
    const [iso] = traceIsolines(grid, N, [2.5]);
    expect(iso!.lines).toHaveLength(1);
    const line = iso!.lines[0]!;
    for (let k = 0; k < line.length; k += 2) {
      expect(line[k]! + line[k + 1]!).toBeCloseTo(2.5, 12);
    }
  });

  it("closes a ring around a peak", () => {
    const grid = makeGrid(N, (i, j) => 10 - Math.hypot(i - 2, j - 2));
    const [iso] = traceIsolines(grid, N, [8.5]);
    expect(iso!.lines).toHaveLength(1);
    const line = iso!.lines[0]!;
    expect(line[0]).toBe(line[line.length - 2]);
    expect(line[1]).toBe(line[line.length - 1]);
    expect(line.length).toBeGreaterThan(2 * 4);
  });

  it("keeps every point on a grid edge between samples that straddle the level", () => {
    const grid = makeGrid(N, (i, j) => Math.sin(i * 1.3) + Math.cos(j * 0.7));
    for (const iso of traceIsolines(grid, N, [-0.5, 0, 0.5])) {
      for (const line of iso.lines) {
        for (let k = 0; k < line.length; k += 2) {
          const x = line[k]!;
          const y = line[k + 1]!;
          const onVertical = Number.isInteger(x);
          const onHorizontal = Number.isInteger(y);
          expect(onVertical || onHorizontal).toBe(true);
          const a = onVertical
            ? grid[Math.floor(y) * N + x]!
            : grid[y * N + Math.floor(x)]!;
          const b = onVertical
            ? grid[Math.ceil(y) * N + x]!
            : grid[y * N + Math.ceil(x)]!;
          const lo = Math.min(a, b);
          const hi = Math.max(a, b);
          expect(lo).toBeLessThanOrEqual(iso.level);
          expect(hi).toBeGreaterThanOrEqual(iso.level);
        }
      }
    }
  });

  it("emits two segments for a saddle cell", () => {
    const grid = new Float32Array([1, 0, 0, 1]);
    const [iso] = traceIsolines(grid, 2, [0.5]);
    expect(iso!.lines).toHaveLength(2);
    for (const line of iso!.lines) {
      expect(line.length).toBe(4);
    }
  });

  it("emits nothing from cells touching a NaN sample", () => {
    const grid = makeGrid(N, (i) => i);
    grid[2 * N + 2] = Number.NaN;
    const [iso] = traceIsolines(grid, N, [1.5]);
    const ys = new Set<number>();
    for (const line of iso!.lines) {
      for (let k = 1; k < line.length; k += 2) {
        ys.add(line[k]!);
      }
    }
    // Rows 1..3 (cells touching sample (2,2)) are gone.
    expect(ys.has(1.5)).toBe(false);
    expect(ys.has(2.5)).toBe(false);
    expect(ys.has(0)).toBe(true);
    expect(ys.has(4)).toBe(true);
  });

  it("returns one entry per threshold, even when empty", () => {
    const grid = makeGrid(N, (i) => i);
    const result = traceIsolines(grid, N, [-1, 1.5, 100]);
    expect(result.map((r) => r.level)).toEqual([-1, 1.5, 100]);
    expect(result[0]!.lines).toHaveLength(0);
    expect(result[2]!.lines).toHaveLength(0);
  });

  it("rejects malformed input", () => {
    expect(() => traceIsolines(new Float32Array(3), 2, [0])).toThrow(
      RangeError,
    );
    expect(() => traceIsolines(new Float32Array(4), 2, [1, 1])).toThrow(
      RangeError,
    );
    expect(() => traceIsolines(new Float32Array(4), 2, [2, 1])).toThrow(
      RangeError,
    );
  });
});
