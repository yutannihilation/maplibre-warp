/**
 * Module-worker entry: a {@link LocalBackend} driven by messages.
 *
 * Instantiate with `new Worker(new URL("./worker.js", import.meta.url),
 * { type: "module" })`, or point a bundler at the package's `./worker` export.
 */

import { LocalBackend } from "./local-backend.js";
import type { WorkerRequest, WorkerResponse } from "./worker-protocol.js";
import { installDOMParserShim } from "./xml-shim.js";

// `@developmentseed/geotiff` parses the GDAL_METADATA tag with `DOMParser`
// when a file is opened; workers have none, so provide the subset it uses.
installDOMParserShim(self as unknown as Record<string, unknown>);

let backend: LocalBackend | undefined;
const controllers = new Map<number, AbortController>();

const post = (response: WorkerResponse, transfer: Transferable[] = []): void =>
  (self as unknown as Worker).postMessage(response, transfer);

const fail = (id: number, error: unknown): void =>
  post({
    id,
    ok: false,
    error:
      error instanceof Error
        ? { name: error.name, message: error.message }
        : { name: "Error", message: String(error) },
  });

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;
  switch (request.type) {
    case "open": {
      backend?.destroy();
      backend = new LocalBackend(request.init);
      try {
        post({ id: request.id, ok: true, meta: await backend.open() });
      } catch (error) {
        fail(request.id, error);
      }
      return;
    }
    case "tile": {
      if (!backend) {
        fail(request.id, new Error("worker backend is not open"));
        return;
      }
      const controller = new AbortController();
      controllers.set(request.id, controller);
      try {
        const tile = await backend.tile(
          request.z,
          request.x,
          request.y,
          controller.signal,
        );
        if (tile === null) {
          post({ id: request.id, ok: true, tile: null });
        } else {
          const buffer = tile.buffer.slice(
            tile.byteOffset,
            tile.byteOffset + tile.byteLength,
          ) as ArrayBuffer;
          post({ id: request.id, ok: true, tile: buffer }, [buffer]);
        }
      } catch (error) {
        fail(request.id, error);
      } finally {
        controllers.delete(request.id);
      }
      return;
    }
    case "abort":
      controllers.get(request.id)?.abort();
      return;
  }
};
