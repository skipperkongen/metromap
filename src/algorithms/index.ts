import type { LayoutAlgorithm } from "../algorithm.js";
import { gridSnap } from "./grid-snap.js";
import { relaxRefine } from "./relax-refine.js";
import { shapeAware } from "./shape-aware.js";

export { gridSnap, type GridSnapOptions } from "./grid-snap.js";
export { relaxRefine, type RelaxRefineOptions } from "./relax-refine.js";
export { shapeAware, type ShapeAwareOptions } from "./shape-aware.js";

/** Every built-in algorithm. The first is the default. Add new algorithms here. */
export const ALGORITHMS: LayoutAlgorithm[] = [relaxRefine, shapeAware, gridSnap];
