/**
 * In-thread backend: opens the COG and generates tiles where it is called.
 */

import { defaultDecoderPool } from "@developmentseed/geotiff";
import { openCOG } from "@yutannihilation/maplibre-warp-geotiff";

import type { BackendInit, ContourBackend, ContourMeta } from "./backend.js";
import { warpSourceFromCOG } from "./cog-warp-source.js";
import type { WarpSource } from "./generate.js";
import { generateContourTile } from "./generate.js";

export class LocalBackend implements ContourBackend {
  private readonly init: BackendInit;
  private opening?: Promise<{ source: WarpSource; meta: ContourMeta }>;
  private readonly controller = new AbortController();

  constructor(init: BackendInit) {
    this.init = init;
  }

  private ensureOpen(): Promise<{ source: WarpSource; meta: ContourMeta }> {
    this.opening ??= (async () => {
      const opened = await openCOG(this.init.geotiff, {
        signal: this.controller.signal,
      });
      if (!opened) {
        throw new DOMException("Contour backend destroyed", "AbortError");
      }
      return warpSourceFromCOG(opened, {
        band: this.init.options.band,
        pool: defaultDecoderPool(),
      });
    })();
    return this.opening;
  }

  async open(): Promise<ContourMeta> {
    return (await this.ensureOpen()).meta;
  }

  async tile(
    z: number,
    x: number,
    y: number,
    signal: AbortSignal,
  ): Promise<Uint8Array | null> {
    const { source } = await this.ensureOpen();
    return generateContourTile({ z, x, y }, source, this.init.options, signal);
  }

  destroy(): void {
    this.controller.abort();
  }
}
