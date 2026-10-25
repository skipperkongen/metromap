import { relaxRefine, type RelaxRefineOptions } from "./algorithms/relax-refine.js";
import type { MetroMap, Network } from "./types.js";

export type LayoutOptions = RelaxRefineOptions;

/** Lay out a network with the default algorithm (relax & refine). */
export function layout(network: Network, options: LayoutOptions = {}): MetroMap {
  return relaxRefine.layout(network, options);
}
