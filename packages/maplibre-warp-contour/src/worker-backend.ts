/**
 * Backend that forwards to a module worker running {@link LocalBackend}.
 */

import type { BackendInit, ContourBackend, ContourMeta } from "./backend.js";
import type { WorkerRequest, WorkerResponse } from "./worker-protocol.js";

interface Pending {
  resolve: (response: WorkerResponse) => void;
  reject: (error: Error) => void;
}

export function defaultCreateWorker(): Worker {
  return new Worker(new URL("./worker.js", import.meta.url), {
    type: "module",
  });
}

export class WorkerBackend implements ContourBackend {
  private readonly worker: Worker;
  private readonly init: BackendInit;
  private readonly pending = new Map<number, Pending>();
  private nextId = 0;

  constructor(init: BackendInit, createWorker: () => Worker) {
    this.init = init;
    this.worker = createWorker();
    this.worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const response = event.data;
      const entry = this.pending.get(response.id);
      if (!entry) {
        return;
      }
      this.pending.delete(response.id);
      if (response.ok) {
        entry.resolve(response);
      } else {
        const error = new Error(response.error.message);
        error.name = response.error.name;
        entry.reject(error);
      }
    };
    this.worker.onerror = (event) => {
      const error = new Error(event.message || "contour worker failed");
      for (const entry of this.pending.values()) {
        entry.reject(error);
      }
      this.pending.clear();
    };
  }

  private send(
    request: WorkerRequest,
    signal?: AbortSignal,
  ): Promise<WorkerResponse> {
    return new Promise((resolve, reject) => {
      const onAbort = (): void => {
        this.pending.delete(request.id);
        this.worker.postMessage({ type: "abort", id: request.id });
        reject(new DOMException("Contour tile aborted", "AbortError"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.pending.set(request.id, {
        resolve: (response) => {
          signal?.removeEventListener("abort", onAbort);
          resolve(response);
        },
        reject: (error) => {
          signal?.removeEventListener("abort", onAbort);
          reject(error);
        },
      });
      this.worker.postMessage(request);
    });
  }

  async open(signal?: AbortSignal): Promise<ContourMeta> {
    const response = await this.send(
      { type: "open", id: ++this.nextId, init: this.init },
      signal,
    );
    if (!("meta" in response)) {
      throw new Error("unexpected worker response to open");
    }
    return response.meta;
  }

  async tile(
    z: number,
    x: number,
    y: number,
    signal: AbortSignal,
  ): Promise<Uint8Array | null> {
    const response = await this.send(
      { type: "tile", id: ++this.nextId, z, x, y },
      signal,
    );
    if (!("tile" in response)) {
      throw new Error("unexpected worker response to tile");
    }
    return response.tile === null ? null : new Uint8Array(response.tile);
  }

  destroy(): void {
    this.worker.terminate();
    const error = new DOMException("Contour backend destroyed", "AbortError");
    for (const entry of this.pending.values()) {
      entry.reject(error);
    }
    this.pending.clear();
  }
}
