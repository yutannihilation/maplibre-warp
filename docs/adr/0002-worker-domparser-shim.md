# ADR 0002: A minimal DOMParser shim inside the contour worker

Status: Proposed

## Context

`@developmentseed/geotiff` 0.8.0-beta.2 (latest) parses the `GDAL_METADATA`
TIFF tag with `DOMParser` eagerly when a file is opened. Workers have no
`DOMParser`, so any COG carrying that tag (most DEMs) fails to open in the
contour worker with `ReferenceError: DOMParser is not defined`.

## Decision

`packages/maplibre-warp-contour/src/xml-shim.ts` defines `DOMParser` on the
worker global **only when it is missing**, implementing exactly the subset the
library uses: `documentElement.tagName`, `querySelectorAll("Item")`,
`getAttribute`, `textContent`, plus entity decoding. Any other selector or
content type throws rather than answering wrongly. Unit-tested against real
`GDALMetadata` XML.

## Alternatives rejected

- Main-thread only: gives up the worker, which is the point of the design.
- `pnpm patch` of the dependency: fixes this repository but not consumers of
  the published package.

## Consequences

- The shim is tied to the library's current parser; an upstream change to use
  other DOM APIs would surface as an explicit error in the worker.
- Follow-up: propose a DOM-free `GDAL_METADATA` parser upstream in
  `developmentseed/deck.gl-raster`, after which the shim can be removed.
