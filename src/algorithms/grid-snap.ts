import { defineGridAlgorithm } from "../algorithm.js";
import { project, snapToFreeCells, type CanvasOptions } from "../pipeline.js";

export interface GridSnapOptions extends CanvasOptions {
  /** Grid cells per typical station gap. Higher keeps more geography, lower is more compact. Default 1.5. */
  resolution?: number;
}

/**
 * A baseline: project the geography and round every station to the nearest
 * free grid cell, with no relaxation or local search. Edges that are not
 * octilinear get one 45° bend. Useful for comparing what the other algorithms add.
 */
export const gridSnap = defineGridAlgorithm<GridSnapOptions>({
  id: "grid-snap",
  name: "Grid snap (baseline)",
  description: "Rounds the geography to the nearest grid cells, with no further optimisation.",
  place(prepared, options) {
    const resolution = options.resolution ?? 1.5;
    const geo = project(prepared.stations);
    // Stations no line could give coordinates to are lined up below the map.
    const known = geo.filter((p) => p !== null);
    const bottom = known.length > 0 ? Math.max(...known.map((p) => p.y)) : 0;
    let spare = 0;
    const pos = geo.map((p) => (p ? { x: p.x * resolution, y: p.y * resolution } : { x: spare++, y: (bottom + 2) * resolution }));
    return snapToFreeCells(pos, prepared.adjacency);
  },
});
