import type { RasterArrayPixelInterleaved } from "@developmentseed/geotiff";
import { describe, expect, it } from "vitest";

import { addAlphaChannel } from "../src/geotiff-utils.js";

function rgb(
  data: RasterArrayPixelInterleaved["data"],
): RasterArrayPixelInterleaved {
  return {
    layout: "pixel-interleaved",
    count: 3,
    width: 2,
    height: 1,
    data,
    mask: null,
    transform: [1, 0, 0, 0, -1, 0],
    crs: 4326,
    nodata: null,
  };
}

describe("addAlphaChannel", () => {
  it("pads 8-bit RGB to RGBA with opaque alpha", () => {
    const out = addAlphaChannel(rgb(new Uint8Array([1, 2, 3, 4, 5, 6])));
    expect(out.count).toBe(4);
    expect(Array.from(out.data)).toEqual([1, 2, 3, 255, 4, 5, 6, 255]);
    expect(out.data.BYTES_PER_ELEMENT).toBe(1);
  });

  it("keeps the input's typed array for 16-bit and float data", () => {
    const u16 = addAlphaChannel(rgb(new Uint16Array([1, 2, 3, 4, 5, 6])));
    expect(u16.data).toBeInstanceOf(Uint16Array);
    expect(Array.from(u16.data)).toEqual([1, 2, 3, 65535, 4, 5, 6, 65535]);

    const i16 = addAlphaChannel(rgb(new Int16Array([-1, 2, 3, 4, 5, 6])));
    expect(i16.data).toBeInstanceOf(Int16Array);
    expect(Array.from(i16.data)).toEqual([-1, 2, 3, 32767, 4, 5, 6, 32767]);

    const f32 = addAlphaChannel(
      rgb(new Float32Array([0.5, -9999, 3, 4, 5, 6])),
    );
    expect(f32.data).toBeInstanceOf(Float32Array);
    expect(Array.from(f32.data)).toEqual([0.5, -9999, 3, 1, 4, 5, 6, 1]);
  });

  it("returns four-channel input unchanged", () => {
    const input = { ...rgb(new Uint8Array(8)), count: 4 };
    expect(addAlphaChannel(input)).toBe(input);
  });

  it("rejects channel counts other than three or four", () => {
    expect(() => addAlphaChannel(rgb(new Uint8Array(4)))).toThrow();
  });
});
