import { afterEach, describe, expect, it } from "vitest";

import {
  COG_DEM_PROTOCOL,
  COGDemSource,
  cogDemProtocol,
  demMaxZoom,
  demMaxZoomForBounds,
  parseCogDemUrl,
} from "../src/cog-dem-source.js";

const geotiff = "https://example.com/dem.tif";
const live: COGDemSource[] = [];
const make = (props: ConstructorParameters<typeof COGDemSource>[0]) => {
  const source = new COGDemSource(props);
  live.push(source);
  return source;
};

afterEach(() => {
  for (const source of live.splice(0)) {
    source.destroy();
  }
});

describe("COGDemSource construction", () => {
  it("applies defaults and validates its options", () => {
    const source = make({ id: "a", geotiff });
    expect(source.tileSize).toBe(512);
    expect(source.encoding).toBe("terrarium");
    expect(source.fillValue).toBe(0);
    expect(source.band).toBe(0);
    expect(source.tileUrlTemplate).toBe("cog-dem://a/{z}/{x}/{y}");
    expect(source.specification).toBeUndefined();

    expect(() => make({ id: "", geotiff })).toThrow(RangeError);
    expect(() => make({ id: "x/y", geotiff })).toThrow(RangeError);
    expect(() => make({ id: "b", geotiff, tileSize: 300 as 256 })).toThrow(
      RangeError,
    );
    expect(() => make({ id: "c", geotiff, fillValue: NaN })).toThrow(
      RangeError,
    );
    expect(() => make({ id: "d", geotiff, band: -1 })).toThrow(RangeError);
    expect(() =>
      make({ id: "e", geotiff, encoding: "png" as "mapbox" }),
    ).toThrow(RangeError);
  });

  it("refuses a duplicate id until the first source is destroyed", () => {
    const first = make({ id: "dup", geotiff });
    expect(() => make({ id: "dup", geotiff })).toThrow(/already exists/);
    first.destroy();
    expect(() => make({ id: "dup", geotiff })).not.toThrow();
  });

  it("encodes the id in the URL template", () => {
    expect(make({ id: "my dem", geotiff }).tileUrlTemplate).toBe(
      "cog-dem://my%20dem/{z}/{x}/{y}",
    );
  });
});

describe("parseCogDemUrl", () => {
  it("parses id and XYZ and rejects anything else", () => {
    expect(parseCogDemUrl("cog-dem://my%20dem/14/8600/5800")).toEqual({
      id: "my dem",
      index: { z: 14, x: 8600, y: 5800 },
    });
    for (const bad of [
      "cog-dem://a/1/2",
      "cog-dem://a/b/1/2/3",
      "https://a/1/2/3",
      "cog-dem:///1/2/3",
      // A stray percent escape is malformed too, not a bare URIError.
      "cog-dem://dem%E0/1/2/3",
    ]) {
      expect(() => parseCogDemUrl(bad)).toThrow(/malformed/);
    }
    expect(COG_DEM_PROTOCOL).toBe("cog-dem");
  });
});

describe("demMaxZoom", () => {
  it("picks the zoom where an output pixel reaches the source pixel", () => {
    // 2 m at 46.4°: 27.6 Mm / (2 m · 512) ≈ 2^14.7 → 15.
    expect(demMaxZoom(2, 46.4, 512)).toBe(15);
    // A 256-pixel tile needs one more zoom for the same density.
    expect(demMaxZoom(2, 46.4, 256)).toBe(16);
    // 30 m at 47°: → 11.
    expect(demMaxZoom(30, 47, 512)).toBe(11);
    expect(demMaxZoom(30, 47, 512, 1)).toBe(10);
    expect(demMaxZoom(0.001, 0, 512)).toBe(22);
    expect(demMaxZoom(1e9, 0, 512)).toBe(0);
  });

  it("judges a dataset at its latitude nearest the equator", () => {
    // 30 m across 20°–80° N: at 80° an output pixel covers few metres and
    // 30 m is reached by z9; at 20° it takes z12. The centre (50°) would
    // say 11 and leave the southern part coarser than its data.
    expect(demMaxZoomForBounds(30, [-10, 20, 10, 80], 512)).toBe(
      demMaxZoom(30, 20, 512),
    );
    expect(demMaxZoomForBounds(30, [-10, 20, 10, 80], 512)).toBeGreaterThan(
      demMaxZoom(30, 50, 512),
    );
    // Southern hemisphere: the magnitude counts.
    expect(demMaxZoomForBounds(30, [-10, -80, 10, -20], 512)).toBe(
      demMaxZoom(30, 20, 512),
    );
    // Straddling the equator: the equator itself.
    expect(demMaxZoomForBounds(30, [-10, -5, 10, 40], 512)).toBe(
      demMaxZoom(30, 0, 512),
    );
  });
});

describe("COGDemSource.open", () => {
  it("forgets a failed open so the next call retries from scratch", async () => {
    // jsdom has no OffscreenCanvas; a stub that yields no WebGL2 context
    // makes every open fail at the same, first step, and counts attempts.
    let constructed = 0;
    class FakeOffscreenCanvas {
      constructor() {
        constructed++;
      }
      getContext(): null {
        return null;
      }
    }
    Object.assign(globalThis, { OffscreenCanvas: FakeOffscreenCanvas });
    try {
      const source = make({ id: "retry", geotiff });
      await expect(source.open()).rejects.toThrow(/WebGL2/);
      await expect(source.open()).rejects.toThrow(/WebGL2/);
      expect(constructed).toBe(2);
    } finally {
      Object.assign(globalThis, { OffscreenCanvas: undefined });
    }
  });
});

describe("cogDemProtocol", () => {
  it("rejects unknown ids and malformed URLs", async () => {
    await expect(
      cogDemProtocol({ url: "cog-dem://nobody/0/0/0" }, new AbortController()),
    ).rejects.toThrow(/no COGDemSource/);
    await expect(
      cogDemProtocol({ url: "cog-dem://nobody" }, new AbortController()),
    ).rejects.toThrow(/malformed/);
  });

  it("refuses to render before the source is open", async () => {
    make({ id: "closed", geotiff });
    await expect(
      cogDemProtocol({ url: "cog-dem://closed/0/0/0" }, new AbortController()),
    ).rejects.toThrow(/before open\(\)/);
  });

  it("rejects open() on a destroyed source", async () => {
    const source = make({ id: "gone", geotiff });
    source.destroy();
    await expect(source.open()).rejects.toThrow(/destroyed/);
  });
});
