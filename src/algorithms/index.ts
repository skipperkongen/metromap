import type { LayoutAlgorithm } from "../algorithm.js";
import { gridSnap } from "./grid-snap.js";
import { relaxRefine } from "./relax-refine.js";

export { gridSnap, type GridSnapOptions } from "./grid-snap.js";
export { relaxRefine, type RelaxRefineOptions } from "./relax-refine.js";

/** Every built-in algorithm. The first is the default. Add new algorithms here. */
export const ALGORITHMS: LayoutAlgorithm[] = [relaxRefine, gridSnap];
