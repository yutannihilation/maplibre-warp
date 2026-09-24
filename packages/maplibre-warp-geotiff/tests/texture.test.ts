import { SampleFormat } from "@cogeotiff/core";
import { describe, expect, it } from "vitest";

import {
  createColormapTexture,
  createTexture2D,
  inferTextureFormat,
} from "../src/texture.js";

/**
 * A stand-in for `WebGL2RenderingContext` that returns each enum's *name*
 * instead of its numeric value, so the assertions below read as the GL
 * constants they are checking.
 */
const gl = new Proxy(
  {},
  { get: (_target, name) => name },
) as unknown as WebGL2RenderingContext;

const UINT = [SampleFormat.Uint];
const INT = [SampleFormat.Int];
const FLOAT = [SampleFormat.Float];

describe("inferTextureFormat", () => {
  it("maps 8-bit unsigned samples to normalised formats", () => {
    expect(inferTextureFormat(gl, 1, [8], UINT)).toMatchObject({
      internalFormat: "R8",
      format: "RED",
      type: "UNSIGNED_BYTE",
      sampler: "float",
      filterable: true,
      normalized: true,
      bytesPerPixel: 1,
    });
    expect(inferTextureFormat(gl, 2, [8, 8], UINT)).toMatchObject({
      internalFormat: "RG8",
      bytesPerPixel: 2,
    });
    expect(inferTextureFormat(gl, 4, [8, 8, 8, 8], UINT)).toMatchObject({
      internalFormat: "RGBA8",
      bytesPerPixel: 4,
    });
  });

  it("maps 16-bit unsigned samples to integer formats, not normalised ones", () => {
    // WebGL2 has no core normalised 16-bit format, so these must be sampled
    // with a usampler2D and scaled in the shader.
    const format = inferTextureFormat(gl, 1, [16], UINT);
    expect(format).toMatchObject({
      internalFormat: "R16UI",
      format: "RED_INTEGER",
      type: "UNSIGNED_SHORT",
      sampler: "uint",
      filterable: false,
      bytesPerPixel: 2,
    });
  });

  it("maps signed and floating-point samples", () => {
    expect(inferTextureFormat(gl, 1, [16], INT)).toMatchObject({
      internalFormat: "R16I",
      sampler: "int",
    });
    expect(inferTextureFormat(gl, 1, [32], FLOAT)).toMatchObject({
      internalFormat: "R32F",
      sampler: "float",
      // Linear filtering of float textures needs OES_texture_float_linear.
      filterable: false,
    });
  });

  it("rejects three-channel input, which must be padded to RGBA first", () => {
    expect(() => inferTextureFormat(gl, 3, [8, 8, 8], UINT)).toThrow(
      /Unsupported texture format/,
    );
  });

  it("rejects mixed bit widths and mixed sample formats", () => {
    expect(() => inferTextureFormat(gl, 2, [8, 16], UINT)).toThrow(
      /varying BitsPerSample/,
    );
    expect(() =>
      inferTextureFormat(gl, 2, [8, 8], [SampleFormat.Uint, SampleFormat.Int]),
    ).toThrow(/varying SampleFormat/);
  });

  it("rejects channel counts and bit widths outside the supported set", () => {
    expect(() => inferTextureFormat(gl, 5, [8], UINT)).toThrow(
      /Unsupported SamplesPerPixel/,
    );
    expect(() => inferTextureFormat(gl, 1, [64], UINT)).toThrow(
      /Unsupported BitsPerSample/,
    );
  });

  it("has no gaps in the 8-bit unsigned path the COG layer depends on", () => {
    for (const channels of [1, 2, 4] as const) {
      const bits = Array.from({ length: channels }, () => 8);
      const formats = Array.from({ length: channels }, () => SampleFormat.Uint);
      expect(() =>
        inferTextureFormat(gl, channels, bits, formats),
      ).not.toThrow();
    }
  });
});

/**
 * A stub context that records pixel-store writes. `getParameter` throws: the
 * upload functions run inside MapLibre's GL-state bracket and must never read
 * state back — a `getParameter` round trip stalls the pipeline, and MapLibre
 * re-sets whatever they change.
 */
function makeStubGl() {
  const state = new Map<string, unknown>([
    ["UNPACK_ALIGNMENT", 8],
    ["UNPACK_FLIP_Y_WEBGL", true],
    ["UNPACK_PREMULTIPLY_ALPHA_WEBGL", true],
  ]);
  const uploadState: Record<string, unknown> = {};

  const base: Record<string, unknown> = {
    createTexture: () => ({}),
    bindTexture: () => undefined,
    activeTexture: () => undefined,
    texParameteri: () => undefined,
    pixelStorei: (pname: string, value: unknown) => {
      state.set(pname, value);
    },
    getParameter: (pname: string) => {
      throw new Error(
        `getParameter(${pname}) must not be called: uploads run inside MapLibre's bracket and never read GL state back`,
      );
    },
    // Snapshot the pixel-store state at the moment of upload: that, not just
    // the end state, is what decides whether the bytes land correctly.
    texImage2D: () => {
      Object.assign(uploadState, readPixelStore());
    },
    texImage3D: () => {
      Object.assign(uploadState, readPixelStore());
    },
  };

  function readPixelStore() {
    return {
      alignment: state.get("UNPACK_ALIGNMENT"),
      flipY: state.get("UNPACK_FLIP_Y_WEBGL"),
      premultiply: state.get("UNPACK_PREMULTIPLY_ALPHA_WEBGL"),
    };
  }

  const stub = new Proxy(base, {
    get: (target, name: string) => (name in target ? target[name] : name),
  }) as unknown as WebGL2RenderingContext;

  return { gl: stub, uploadState };
}

describe("texture upload pixel-store handling", () => {
  const rgba8 = (gl: WebGL2RenderingContext) =>
    inferTextureFormat(gl, 4, [8, 8, 8, 8], UINT);

  it("uploads tightly packed, unflipped and un-premultiplied, whatever the state was", () => {
    const { gl, uploadState } = makeStubGl();
    createTexture2D(gl, {
      width: 2,
      height: 2,
      data: new Uint8Array(16),
      format: rgba8(gl),
      linear: true,
    });
    // Raster samples are data, not display-ready colour: any flip or
    // premultiply would corrupt them. The parameters are set outright rather
    // than read and restored (the stub's `getParameter` throws).
    expect(uploadState).toEqual({
      alignment: 1,
      flipY: false,
      premultiply: false,
    });
  });

  it("does the same for a colormap upload", () => {
    const { gl, uploadState } = makeStubGl();
    createColormapTexture(gl, {
      width: 256,
      height: 1,
      data: new Uint8ClampedArray(256 * 4),
      colorSpace: "srgb",
    } as ImageData);
    expect(uploadState).toEqual({
      alignment: 1,
      flipY: false,
      premultiply: false,
    });
  });
});
