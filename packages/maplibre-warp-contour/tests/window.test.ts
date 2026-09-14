import { describe, expect, it } from "vitest";
import type { FetchedTile } from "../src/window.js";
import { assembleWindow } from "../src/window.js";

function tile(
  x: number,
  y: number,
  size: number,
  value: (col: number, row: number) => number,
  overrides: Partial<FetchedTile> = {},
): FetchedTile {
  const data = new Float32Array(size * size);
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      data[r * size + c] = value(x * size + c, y * size + r);
    }
  }
  return {
    x,
    y,
    width: size,
    height: size,
    data,
    stride: 1,
    offset: 0,
    nodata: null,
    mask: null,
    ...overrides,
  };
}

describe("assembleWindow", () => {
  const level = { tileWidth: 4, tileHeight: 4 };

  it("places tiles at their level pixel positions", () => {
    const tiles = [
      tile(2, 3, 4, (c, r) => c * 100 + r),
      tile(3, 3, 4, (c, r) => c * 100 + r),
    ];
    const window = assembleWindow(tiles, level, {
      minCol: 2,
      maxCol: 3,
      minRow: 3,
      maxRow: 3,
    });
    expect(window.x0).toBe(8);
    expect(window.y0).toBe(12);
    expect(window.width).toBe(8);
    expect(window.height).toBe(4);
    expect(window.stride).toBe(1);
    // Level pixel (13, 14) → window (5, 2).
    expect(window.data[2 * 8 + 5]).toBe(13 * 100 + 14);
  });

  it("masks pixels not covered by any returned tile, including clipped edges", () => {
    // Only one of two tiles in the range, and that tile is clipped to 3×2.
    const clipped = tile(1, 0, 4, (c, r) => c + r);
    clipped.width = 3;
    clipped.height = 2;
    clipped.data = new Float32Array([4, 5, 6, 5, 6, 7]);
    const window = assembleWindow([clipped], level, {
      minCol: 0,
      maxCol: 1,
      minRow: 0,
      maxRow: 0,
    });
    expect(window.mask).not.toBeNull();
    const mask = window.mask!;
    // Column 0..3 (tile 0, missing) masked.
    expect(mask[0]).toBe(0);
    expect(mask[3]).toBe(0);
    // Tile 1 covers window columns 4..6 rows 0..1 only.
    expect(mask[4]).toBe(1);
    expect(mask[6]).toBe(1);
    expect(mask[7]).toBe(0);
    expect(mask[3 * 8 + 4]).toBe(0);
    expect(window.data[1 * 8 + 6]).toBe(7);
  });

  it("combines tile masks and carries the nodata value and band layout", () => {
    const t = tile(0, 0, 4, () => 1, {
      mask: Uint8Array.from({ length: 16 }, (_, k) => (k === 5 ? 0 : 1)),
      nodata: -1,
      stride: 3,
      offset: 2,
    });
    // Data for stride 3: 48 samples.
    t.data = new Float32Array(48).fill(9);
    const window = assembleWindow([t], level, {
      minCol: 0,
      maxCol: 0,
      minRow: 0,
      maxRow: 0,
    });
    expect(window.mask![5]).toBe(0);
    expect(window.mask![4]).toBe(1);
    expect(window.nodata).toBe(-1);
    expect(window.stride).toBe(3);
    expect(window.offset).toBe(2);
    expect(window.data.length).toBe(48);
  });

  it("rejects tiles with differing sample layouts", () => {
    const a = tile(0, 0, 4, () => 1);
    const b = tile(1, 0, 4, () => 1, { stride: 2 });
    expect(() =>
      assembleWindow([a, b], level, {
        minCol: 0,
        maxCol: 1,
        minRow: 0,
        maxRow: 0,
      }),
    ).toThrow(RangeError);
  });
});
