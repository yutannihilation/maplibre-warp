/**
 * Which MapLibre projection a frame is rendered with.
 *
 * This lives on its own, rather than in `viewport-shim.ts`, because both the
 * camera shim and the shader-source builder dispatch on it and neither should
 * have to import the other.
 */

/**
 * The space a frame's frustum planes and tile bounding volumes are in.
 *
 * - `"mercator"`: common space `[0, 512]²`, Y north-up.
 * - `"globe"`: MapLibre's unit sphere (see `globe.ts`).
 */
export type ViewportProjection = "mercator" | "globe";

/** MapLibre's shader variant name for plain mercator. */
const MERCATOR_VARIANT = "mercator";

/**
 * MapLibre's shader variant name for globe rendering, including the animated
 * globe↔mercator transition (`projectionTransition` in `(0, 1)`).
 */
const GLOBE_VARIANT = "globe";

/**
 * Which projection a MapLibre shader variant name denotes, or `undefined` for
 * one this package does not know how to render.
 *
 * The variant name is MapLibre's own cache key for "which projection shader
 * code applies", so it is the right thing to dispatch on. Note that the style
 * projection `"globe"` reports the `"mercator"` variant once zoomed past its
 * transition to flat rendering.
 */
export function projectionFromVariant(
  variantName: string,
): ViewportProjection | undefined {
  switch (variantName) {
    case MERCATOR_VARIANT:
      return "mercator";
    case GLOBE_VARIANT:
      return "globe";
    default:
      return undefined;
  }
}
