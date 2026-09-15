import { describe, expect, it } from "vitest";
import type { NeighbourOffset } from "../src/halo.js";
import {
  HALO,
  NEIGHBOUR_OFFSETS,
  neighbourCoordinates,
  neighbourIndex,
  stitchHalo,
} from "../src/halo.js";

/** A `w × h` single-band tile filled with `fill(col, row)`. */
function tile(
  w: number,
  h: number,
  fill: (col: number, row: number) => number,
  count = 1,
  mask: Uint8Array | null = null,
) {
  const data = new Float32Array(w * h * count);
  for (let row = 0; row < h; row++) {
    for (let col = 0; col < w; col++) {
      for (let b = 0; b < count; b++) {
        data[(row * w + col) * count + b] = fill(col, row) + b * 1000;
      }
    }
  }
  return { width: w, height: h, count, data, mask };
}

/** Neighbours as a {@link neighbourIndex}-addressed grid. */
function grid<T>(entries: Array<[NeighbourOffset, T]>): Array<T | undefined> {
  const out: Array<T | undefined> = [];
  for (const [offset, value] of entries) {
    out[neighbourIndex(offset)] = value;
  }
  return out;
}

/** Read texel `(col, row)` of a padded `pw`-wide single-band array. */
const texel = (out: ArrayLike<number>, pw: number, col: number, row: number) =>
  out[row * pw + col];

describe("neighbourIndex", () => {
  it("lays the eight offsets out row-major around the centre slot 4", () => {
    expect(NEIGHBOUR_OFFSETS.map(neighbourIndex)).toEqual([
      0, 1, 2, 3, 5, 6, 7, 8,
    ]);
  });
});

describe("neighbourCoordinates", () => {
  const offsets = (list: ReturnType<typeof neighbourCoordinates>) =>
    list.map((n) => n.offset);

  it("lists all eight neighbours for an interior tile, in offset order", () => {
    const n = neighbourCoordinates(3, 4, 10, 10);
    expect(n).toHaveLength(8);
    expect(offsets(n)).toEqual(NEIGHBOUR_OFFSETS);
    expect(n[0]).toEqual({ offset: [-1, -1], x: 2, y: 3 });
    expect(n[7]).toEqual({ offset: [1, 1], x: 4, y: 5 });
  });

  it("drops neighbours outside the grid", () => {
    expect(offsets(neighbourCoordinates(0, 0, 4, 4))).toEqual([
      [1, 0],
      [0, 1],
      [1, 1],
    ]);
    expect(offsets(neighbourCoordinates(3, 3, 4, 4))).toEqual([
      [-1, -1],
      [0, -1],
      [-1, 0],
    ]);
    expect(neighbourCoordinates(0, 0, 1, 1)).toHaveLength(0);
  });
});

describe("stitchHalo", () => {
  it("is one texel wide", () => {
    expect(HALO).toBe(1);
  });

  it("copies the interior and takes every edge from the matching neighbour", () => {
    // Centre texels are 100 + col + 10·row; neighbour (dx, dy) texels are
    // encoded as 1000·(dx+2) + 100·(dy+2) + col + 10·row so each padded texel
    // can be traced back to its source.
    const w = 3;
    const h = 2;
    const centre = tile(w, h, (c, r) => 100 + c + 10 * r);
    const neighbours = grid(
      NEIGHBOUR_OFFSETS.map(
        (offset): [NeighbourOffset, ReturnType<typeof tile>] => {
          const [dx, dy] = offset;
          return [
            offset,
            tile(w, h, (c, r) => 1000 * (dx + 2) + 100 * (dy + 2) + c + 10 * r),
          ];
        },
      ),
    );
    const out = stitchHalo(centre, neighbours);
    const pw = w + 2;
    expect(out).toBeInstanceOf(Float32Array);
    expect(out.length).toBe(pw * (h + 2));

    // Interior, shifted by one.
    expect(texel(out, pw, 1, 1)).toBe(100);
    expect(texel(out, pw, 3, 2)).toBe(112);

    // Left column ← left neighbour's last column (col 2), same row.
    expect(texel(out, pw, 0, 1)).toBe(1000 * 1 + 100 * 2 + 2 + 0);
    expect(texel(out, pw, 0, 2)).toBe(1000 * 1 + 100 * 2 + 2 + 10);
    // Right column ← right neighbour's first column.
    expect(texel(out, pw, 4, 1)).toBe(1000 * 3 + 100 * 2 + 0 + 0);
    // Top row ← top neighbour's last row (row 1), same column.
    expect(texel(out, pw, 2, 0)).toBe(1000 * 2 + 100 * 1 + 1 + 10);
    // Bottom row ← bottom neighbour's first row.
    expect(texel(out, pw, 3, 3)).toBe(1000 * 2 + 100 * 3 + 2 + 0);
    // Corners ← diagonal neighbours' opposite corners.
    expect(texel(out, pw, 0, 0)).toBe(1000 * 1 + 100 * 1 + 2 + 10);
    expect(texel(out, pw, 4, 0)).toBe(1000 * 3 + 100 * 1 + 0 + 10);
    expect(texel(out, pw, 0, 3)).toBe(1000 * 1 + 100 * 3 + 2 + 0);
    expect(texel(out, pw, 4, 3)).toBe(1000 * 3 + 100 * 3 + 0 + 0);
  });

  it("clamps to the centre's own edge where no neighbour exists", () => {
    const centre = tile(2, 2, (c, r) => 1 + c + 2 * r); // [[1,2],[3,4]]
    const out = stitchHalo(centre, []);
    expect(Array.from(out)).toEqual([
      1, 1, 2, 2, 1, 1, 2, 2, 3, 3, 4, 4, 3, 3, 4, 4,
    ]);
  });

  it("fills a corner without a diagonal neighbour from the edge neighbour", () => {
    // Top row of the image: only left, right and bottom neighbours exist.
    const centre = tile(2, 1, () => 0);
    const neighbours = grid([
      [[-1, 0], tile(2, 1, (c) => 10 + c)], // last col = 11
      [[1, 0], tile(2, 1, (c) => 20 + c)], // first col = 20
      [[0, 1], tile(2, 1, (c) => 30 + c)],
      [[-1, 1], tile(2, 1, () => 41)],
      [[1, 1], tile(2, 1, () => 51)],
    ]);
    const out = stitchHalo(centre, neighbours);
    expect(Array.from(out)).toEqual([
      11,
      0,
      0,
      20, // top row clamps in y: takes the side neighbours' values
      11,
      0,
      0,
      20,
      41,
      30,
      31,
      51,
    ]);
  });

  it("handles clipped edge tiles of differing size", () => {
    // Centre is a clipped right-edge tile (width 2); its top neighbour is
    // clipped the same way, its left neighbour is full width.
    const centre = tile(2, 3, () => 1);
    const neighbours = grid([
      [[-1, 0], tile(4, 3, (c) => (c === 3 ? 7 : 0))],
      [[0, -1], tile(2, 3, (_c, r) => (r === 2 ? 9 : 0))],
    ]);
    const out = stitchHalo(centre, neighbours);
    const pw = 4;
    expect(texel(out, pw, 0, 2)).toBe(7);
    expect(texel(out, pw, 1, 0)).toBe(9);
    expect(texel(out, pw, 2, 0)).toBe(9);
  });

  it("keeps every band of a multi-band tile", () => {
    const centre = tile(1, 1, () => 5, 3);
    const neighbours = grid([[[1, 0], tile(1, 1, () => 6, 3)]]);
    const out = stitchHalo(centre, neighbours);
    // Row 1: [left clamp | centre | right neighbour], 3 samples each.
    expect(Array.from(out.subarray(3 * 3, 3 * 6))).toEqual([
      5, 1005, 2005, 5, 1005, 2005, 6, 1006, 2006,
    ]);
  });

  it("clamps instead of copying a neighbour texel its mask marks missing", () => {
    // Right neighbour: first column is [valid 20, masked 99]; the masked
    // texel must not reach the halo, the centre's own edge (2) stands in.
    const centre = tile(2, 2, (c, r) => 1 + c + 2 * r); // [[1,2],[3,4]]
    const right = tile(
      2,
      2,
      (c, r) => (r === 0 ? 20 : 99) + c,
      1,
      new Uint8Array([255, 255, 0, 255]),
    );
    // Diagonal neighbour whose corner texel is masked: the corner falls back
    // to the padded texel in the same row, i.e. the clamped 4. The top-right
    // corner has no diagonal at all and clamps in y to the right neighbour.
    const diag = tile(2, 2, () => 77, 1, new Uint8Array([0, 255, 255, 255]));
    const out = stitchHalo(
      centre,
      grid([
        [[1, 0], right],
        [[1, 1], diag],
      ]),
    );
    expect(Array.from(out)).toEqual([
      1, 1, 2, 20, 1, 1, 2, 20, 3, 3, 4, 4, 3, 3, 4, 4,
    ]);
  });

  it("rejects a neighbour whose data length does not match its size", () => {
    const centre = tile(2, 2, () => 0);
    const short = { ...tile(2, 2, () => 0), data: new Float32Array(3) };
    expect(() => stitchHalo(centre, grid([[[1, 0], short]]))).toThrow(
      /samples/,
    );
  });

  it("rejects neighbours that do not share the seam length", () => {
    const centre = tile(2, 2, () => 0);
    expect(() =>
      stitchHalo(centre, grid([[[-1, 0], tile(2, 3, () => 0)]])),
    ).toThrow(/tall/);
    expect(() =>
      stitchHalo(centre, grid([[[0, 1], tile(3, 2, () => 0)]])),
    ).toThrow(/wide/);
    expect(() =>
      stitchHalo(centre, grid([[[1, 1], tile(2, 2, () => 0, 2)]])),
    ).toThrow(/bands/);
  });
});
