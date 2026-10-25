import { buildMetroMap, prepareNetwork, type CanvasOptions, type PreparedNetwork } from "./pipeline.js";
import type { MetroMap, Network, Point } from "./types.js";

/** A layout algorithm: turns a network into a metro map. */
export interface LayoutAlgorithm<O extends CanvasOptions = CanvasOptions> {
  /** Stable identifier, e.g. for a picker or a URL. */
  id: string;
  name: string;
  /** One sentence on how it works and what it is good for. */
  description: string;
  layout(network: Network, options?: O): MetroMap;
}

export interface GridAlgorithmSpec<O extends CanvasOptions> {
  id: string;
  name: string;
  description: string;
  /**
   * Place every station on the grid: return one point per station, in
   * `prepared.stations` order. Use whole numbers so edges can be routed
   * octilinearly, and give each station its own cell.
   */
  place(prepared: PreparedNetwork, options: O): Point[];
}

/**
 * Define an algorithm by its placement step only. Validation, edge routing,
 * lanes and canvas scaling are shared (see `prepareNetwork` and `buildMetroMap`).
 */
export function defineGridAlgorithm<O extends CanvasOptions = CanvasOptions>(spec: GridAlgorithmSpec<O>): LayoutAlgorithm<O> {
  return {
    id: spec.id,
    name: spec.name,
    description: spec.description,
    layout(network, options = {} as O) {
      const prepared = prepareNetwork(network);
      const grid = prepared.stations.length > 0 ? spec.place(prepared, options) : [];
      return buildMetroMap(prepared, grid, options);
    },
  };
}
