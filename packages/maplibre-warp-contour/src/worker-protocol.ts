/** Messages between {@link WorkerBackend} and the worker entry. */

import type { BackendInit, ContourMeta } from "./backend.js";

export type WorkerRequest =
  | { type: "open"; id: number; init: BackendInit }
  | { type: "tile"; id: number; z: number; x: number; y: number }
  | { type: "abort"; id: number };

export type WorkerResponse =
  | { id: number; ok: true; meta: ContourMeta }
  | { id: number; ok: true; tile: ArrayBuffer | null }
  | { id: number; ok: false; error: { name: string; message: string } };
