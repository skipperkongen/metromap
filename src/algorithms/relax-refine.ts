import { defineGridAlgorithm } from "../algorithm.js";
import { DIRS, average, closestOnSegment, dist, segmentsCross } from "../geometry.js";
import type { NormalizedLine } from "../network.js";
import {
  prepareNetwork,
  project,
  routeEdge,
  snapToFreeCells,
  type CanvasOptions,
  type Edge,
  type PreparedNetwork,
} from "../pipeline.js";
import type { Network, Point } from "../types.js";

export interface RelaxRefineOptions extends CanvasOptions {
  /** Longest an edge may be, in grid steps. Default 3. */
  maxEdgeLength?: number;
}

/**
 * The default algorithm: a force-directed relaxation pulls edges toward
 * 0°/45°/90°, then stations are snapped to a grid and improved by local search.
 * See docs/algorithm.md.
 */
export const relaxRefine = defineGridAlgorithm<RelaxRefineOptions>({
  id: "relax-refine",
  name: "Relax & refine",
  description: "Force-directed relaxation toward octilinear edges, then grid snapping and local search.",
  place: (prepared, options) => relaxRefineStages(prepared, options.maxEdgeLength ?? 3).grid,
});

export interface Stages {
  prepared: PreparedNetwork;
  /** Projected positions, in units of a typical station gap (null when unknown). */
  geo: (Point | null)[];
  /** After the continuous relaxation. */
  relaxed: Point[];
  /** After rounding to free grid cells. */
  snapped: Point[];
  /** After the local search: final grid positions. */
  grid: Point[];
  /** Grid path of each edge, before lane offsets. */
  paths: Point[][];
}

/** Runs the algorithm and returns every intermediate result. The docs figures draw these. */
export function computeStages(
  network: Network,
  maxLen = 3,
  onRelaxStep?: (iteration: number, pos: Point[]) => void,
): Stages {
  return relaxRefineStages(prepareNetwork(network), maxLen, onRelaxStep);
}

/** Relax & refine's placement, with every intermediate result. Other algorithms can start from its grid. */
export function relaxRefineStages(
  prepared: PreparedNetwork,
  maxLen: number,
  onRelaxStep?: (iteration: number, pos: Point[]) => void,
): Stages {
  const { lines, stations, index, edges, adjacency } = prepared;
  const geo = project(stations);
  const relaxed = stations.length > 0 ? relax(geo, edges, maxLen, onRelaxStep) : [];
  const snapped = snapToFreeCells(relaxed, adjacency);
  const grid = snapped.map((p) => ({ ...p }));
  refine(grid, edges, adjacency, lines, index, maxLen);
  const paths = edges.map((e) => routeEdge(grid[e.a]!, grid[e.b]!, grid));
  return { prepared, geo, relaxed, snapped, grid, paths };
}

/**
 * Continuous relaxation: pull every edge towards the nearest octilinear direction
 * with a whole-number length, keep stations apart, and drift away from geography
 * only as much as needed.
 */
function relax(
  geo: (Point | null)[],
  edges: Edge[],
  maxLen: number,
  onStep?: (iteration: number, pos: Point[]) => void,
): Point[] {
  const n = geo.length;
  const known = geo.filter((p): p is Point => p !== null);
  const center = known.length > 0 ? average(known) : { x: 0, y: 0 };
  const pos: Point[] = geo.map((p, i) =>
    p ? { ...p } : { x: center.x + 3 * Math.cos((2 * Math.PI * i) / n), y: center.y + 3 * Math.sin((2 * Math.PI * i) / n) },
  );

  const iterations = 600;
  onStep?.(0, pos.map((p) => ({ ...p })));
  for (let it = 0; it < iterations; it++) {
    const progress = it / iterations;
    const sum = pos.map(() => ({ x: 0, y: 0 }));
    const weight = pos.map(() => 0);
    const push = (i: number, dx: number, dy: number, w: number) => {
      sum[i]!.x += dx * w;
      sum[i]!.y += dy * w;
      weight[i]! += w;
    };

    for (const e of edges) {
      const pa = pos[e.a]!;
      const pb = pos[e.b]!;
      const d = { x: pb.x - pa.x, y: pb.y - pa.y };
      const target = octilinearTarget(d, maxLen);
      const err = { x: d.x - target.x, y: d.y - target.y };
      push(e.a, err.x / 2, err.y / 2, 1);
      push(e.b, -err.x / 2, -err.y / 2, 1);
    }

    // Keep stations from crowding each other.
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const d = dist(pos[i]!, pos[j]!);
        const min = 1;
        if (d < min) {
          const ux = d > 1e-9 ? (pos[i]!.x - pos[j]!.x) / d : Math.cos(i + j);
          const uy = d > 1e-9 ? (pos[i]!.y - pos[j]!.y) / d : Math.sin(i + j);
          const m = (min - d) / 2;
          push(i, ux * m, uy * m, 1);
          push(j, -ux * m, -uy * m, 1);
        }
      }
    }

    // Keep stations off edges they do not belong to.
    for (let s = 0; s < n; s++) {
      for (const e of edges) {
        if (e.a === s || e.b === s) continue;
        const { point, t } = closestOnSegment(pos[s]!, pos[e.a]!, pos[e.b]!);
        const d = dist(pos[s]!, point);
        const min = 0.5;
        if (d < min && t > 0 && t < 1) {
          const ux = d > 1e-9 ? (pos[s]!.x - point.x) / d : 1;
          const uy = d > 1e-9 ? (pos[s]!.y - point.y) / d : 0;
          const m = (min - d) / 2;
          push(s, ux * m, uy * m, 1);
          push(e.a, -ux * m * (1 - t), -uy * m * (1 - t), 1);
          push(e.b, -ux * m * t, -uy * m * t, 1);
        }
      }
    }

    // Weak pull back to geography, fading out so the schematic shape can settle.
    const anchor = 0.3 * (1 - progress);
    geo.forEach((g, i) => {
      if (g) push(i, g.x - pos[i]!.x, g.y - pos[i]!.y, anchor);
    });

    for (let i = 0; i < n; i++) {
      if (weight[i]! > 0) {
        pos[i]!.x += (sum[i]!.x / weight[i]!) * 0.5;
        pos[i]!.y += (sum[i]!.y / weight[i]!) * 0.5;
      }
    }
    onStep?.(it + 1, pos.map((p) => ({ ...p })));
  }
  return pos;
}

/** The octilinear vector closest to `d`, with a whole-number length between 1 and maxLen grid steps. */
export function octilinearTarget(d: Point, maxLen: number): Point {
  const sector = ((Math.round(Math.atan2(d.y, d.x) / (Math.PI / 4)) % 8) + 8) % 8;
  const dir = DIRS[sector]!;
  // Project onto the direction, measured in grid steps along it.
  const along = (d.x * dir.x + d.y * dir.y) / (dir.x * dir.x + dir.y * dir.y);
  const steps = Math.min(maxLen, Math.max(1, Math.round(along)));
  return { x: dir.x * steps, y: dir.y * steps };
}

/**
 * Local search on the grid: move single stations to a neighbouring cell when that
 * makes their edges octilinear, straightens lines, or removes crossings.
 */
function refine(
  grid: Point[],
  edges: Edge[],
  adjacency: number[][],
  lines: NormalizedLine[],
  index: Map<string, number>,
  maxLen: number,
): void {
  // For every station, the pairs of edges a line runs through consecutively.
  const turns: [number, number, number][][] = grid.map(() => []); // [station before, station, station after]
  for (const line of lines) {
    const r = line.route.map((name) => index.get(name)!);
    const loop = r.length > 2 && r[0] === r[r.length - 1];
    const visits = loop ? r.slice(0, -1) : r;
    for (let k = 0; k < visits.length; k++) {
      const prev = k > 0 ? visits[k - 1] : loop ? visits[visits.length - 1] : undefined;
      const next = k < visits.length - 1 ? visits[k + 1] : loop ? visits[0] : undefined;
      if (prev !== undefined && next !== undefined) turns[visits[k]!]!.push([prev, visits[k]!, next]);
    }
  }

  const occupied = new Map<string, number>();
  grid.forEach((p, i) => occupied.set(`${p.x},${p.y}`, i));

  const edgeCost = (ei: number): number => {
    const e = edges[ei]!;
    const a = grid[e.a]!;
    const b = grid[e.b]!;
    const dx = Math.abs(b.x - a.x);
    const dy = Math.abs(b.y - a.y);
    let cost = 0;
    if (!(dx === 0 || dy === 0 || dx === dy)) cost += 6; // needs a bend
    const len = Math.max(dx, dy);
    if (len > maxLen) cost += 3 * (len - maxLen);
    // Judge the path as it will be drawn, bend included.
    const path = routeEdge(a, b, grid);
    for (let k = 1; k < path.length; k++) {
      const p = path[k - 1]!;
      const q = path[k]!;
      // Stations the path runs through.
      for (let s = 0; s < grid.length; s++) {
        if (s === e.a || s === e.b) continue;
        if (dist(closestOnSegment(grid[s]!, p, q).point, grid[s]!) < 0.3) cost += 40;
      }
      // Crossings with edges that do not share a station.
      for (let fi = 0; fi < edges.length; fi++) {
        if (fi === ei) continue;
        const f = edges[fi]!;
        if (f.a === e.a || f.a === e.b || f.b === e.a || f.b === e.b) continue;
        if (segmentsCross(p, q, grid[f.a]!, grid[f.b]!)) cost += 15;
      }
    }
    return cost;
  };

  const turnCost = (s: number): number => {
    let cost = 0;
    for (const [p, c, q] of turns[s]!) {
      const u = { x: grid[c]!.x - grid[p]!.x, y: grid[c]!.y - grid[p]!.y };
      const v = { x: grid[q]!.x - grid[c]!.x, y: grid[q]!.y - grid[c]!.y };
      const cos = (u.x * v.x + u.y * v.y) / (Math.hypot(u.x, u.y) * Math.hypot(v.x, v.y) || 1);
      if (cos < -0.5) cost += 12; // sharp U-turn
      else if (cos < 0.3) cost += 3; // right angle
      else if (cos < 0.99) cost += 1; // 45° bend
    }
    return cost;
  };

  const localCost = (s: number): number => {
    let cost = 0;
    for (const ei of adjacency[s]!) cost += edgeCost(ei);
    const touched = new Set<number>([s]);
    for (const ei of adjacency[s]!) {
      touched.add(edges[ei]!.a);
      touched.add(edges[ei]!.b);
    }
    for (const t of touched) cost += turnCost(t);
    return cost;
  };

  for (let pass = 0; pass < 8; pass++) {
    let improved = false;
    for (let s = 0; s < grid.length; s++) {
      if (adjacency[s]!.length === 0) continue;
      const original = grid[s]!;
      let bestCost = localCost(s);
      let best = original;
      for (const d of DIRS) {
        const c = { x: original.x + d.x, y: original.y + d.y };
        if (occupied.has(`${c.x},${c.y}`)) continue;
        grid[s] = c;
        const cost = localCost(s);
        if (cost < bestCost - 1e-9) {
          bestCost = cost;
          best = c;
        }
      }
      grid[s] = best;
      if (best !== original) {
        occupied.delete(`${original.x},${original.y}`);
        occupied.set(`${best.x},${best.y}`, s);
        improved = true;
      }
    }
    if (!improved) break;
  }
}
