export { splitFloat64, splitFloat64Array } from "./fp64.js";
export type { SpherePoint } from "./globe.js";
export { GLOBE_RADIUS, horizonPlane, sphereFromMercator } from "./globe.js";
export {
  COMMON_SPACE_SIZE,
  commonSpaceFromLngLat,
  EARTH_CIRCUMFERENCE,
  EPSG_3857_CIRCUMFERENCE,
  epsg3857FromMercator,
  lngLatFromCommonSpace,
  MAX_WEB_MERCATOR_LAT,
  mercatorFromEPSG3857,
  mercatorFromLngLat,
  rescaleCommonSpaceToEPSG3857,
  rescaleEPSG3857ToCommonSpace,
  WGS84_ELLIPSOID_A,
} from "./mercator.js";
export type { TileMeshData } from "./mesh.js";
export { buildTileMesh, DEFAULT_MAX_ERROR, GpuMesh } from "./mesh.js";
export type { ViewportProjection } from "./projection.js";
export { projectionFromVariant } from "./projection.js";
export type {
  RasterCustomLayerProps,
  RasterSource,
  RasterTilePayload,
} from "./raster-custom-layer.js";
export {
  globeFrameUniforms,
  mercatorFrameUniforms,
  RasterCustomLayer,
  translateMatrix,
} from "./raster-custom-layer.js";
export type {
  ModuleBindings,
  RasterModuleInstance,
  RasterShaderModule,
  RenderPipeline,
  TextureBinding,
  UniformValue,
} from "./shader/module.js";
export { collectBindings, pipelineKey } from "./shader/module.js";
export { ProgramCache, RasterProgram } from "./shader/program.js";
export {
  ATTRIB_POS_HIGH,
  ATTRIB_POS_LOW,
  ATTRIB_UV,
  buildFragmentSource,
  buildVertexSource,
} from "./shader/sources.js";
export type {
  DrawableTile,
  SchedulerTile,
  TileSchedulerOptions,
  TileSchedulerUpdateOptions,
  TileState,
} from "./tile-scheduler.js";
export { TileScheduler, tileKey } from "./tile-scheduler.js";
export type { AffineTilesetOptions } from "./tileset/affine-tileset.js";
export { AffineTileset } from "./tileset/affine-tileset.js";
export type { AffineTilesetLevelOptions } from "./tileset/affine-tileset-level.js";
export { AffineTilesetLevel } from "./tileset/affine-tileset-level.js";
export { BoundingVolumeCache } from "./tileset/bounding-volume-cache.js";
export type {
  RasterTilesetDescriptor,
  RasterTilesetLevel,
} from "./tileset/tileset-interface.js";
export { createRootTiles, getTileIndices } from "./tileset/traversal.js";
export type {
  Bounds,
  Corners,
  Point,
  ProjectionFunction,
  TileIndex,
  ZRange,
} from "./tileset/types.js";
export type {
  GlobeRasterViewport,
  MercatorRasterViewport,
  RasterViewport,
} from "./tileset/viewport.js";
export type { CornerLatitudes } from "./tileset/web-mercator-clamp.js";
export { createInitialWebMercatorTriangulation } from "./tileset/web-mercator-clamp.js";
export {
  createRasterViewport,
  drawingBufferRatio,
  extractFrustumPlanes,
  unitsPerMeterAtLatitude,
} from "./viewport-shim.js";
