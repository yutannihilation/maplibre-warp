/**
 * Small helpers and defaults shared by the tile scheduler, the layer's
 * source-open loop and the headless payload cache, so the retry and cache
 * policies are described in one place.
 */

/** Soft cap on retained tile payload bytes. */
export const DEFAULT_MAX_CACHE_BYTE_SIZE = 256 * 1024 * 1024;
/** Soft cap on retained tile payloads. */
export const DEFAULT_MAX_CACHE_SIZE = 512;
/** Delay before the first retry of a failed load, in milliseconds. */
export const DEFAULT_RETRY_BASE_DELAY = 1000;
/** Failed attempts allowed before a load gives up. */
export const DEFAULT_MAX_RETRIES = 3;

/** The rejection an aborted operation carries. */
export function abortError(): DOMException {
  return new DOMException("The operation was aborted.", "AbortError");
}

/**
 * Wait `ms`, or resolve early if `signal` aborts.
 *
 * Resolving rather than rejecting on abort keeps retry loops' control flow in
 * one place: the caller re-checks `signal.aborted` and returns.
 */
export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
