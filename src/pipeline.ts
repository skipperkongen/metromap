import { dist } from "./geometry.js";
import { fillMissingCoordinates, hasCoordinates, normalizeLines, type NormalizedLine } from "./network.js";
import type { MapLine, MapSegment, MapStation, MetroMap, Network, Point, Station } from "./types.js";

// The parts of a layout every grid-based algorithm shares: preparing the input,
// projecting, snapping to the grid, routing edges and offsetting lines into lanes.

/** Options for turning grid positions into canvas coordinates. */
export interface CanvasOptions {
  /** Canvas distance between neighbouring grid points. Default 64. */
  spacing?: number;
  /** Canvas distance between parallel lines sharing a track. Default 8. */
  laneWidth?: number;
  /** Empty margin around the map. Default 80. */
  padding?: number;
}

export interface Edge {
  a: number;
  b: number;
  /** Indices of lines using this edge, in drawing order. */
  lines: number[];
  /** Line traversal that defines which side is "left" for lane offsets. */
  reversed: boolean;
}

/** A validated network with station indices and edges, ready for an algorithm to place. */
export interface PreparedNetwork {
  lines: NormalizedLine[];
  /** Stations with missing coordinates estimated where possible. */
  stations: Station[];
  index: Map<string, number>;
  /** One edge per pair of stations that are adjacent on some line. */
  edges: Edge[];
  /** Edge indices touching each station. */
  adjacency: number[][];
}

/** Validate the network, estimate missing coordinates and build the edge list. Throws on invalid input. */
export function prepareNetwork(network: Network): PreparedNetwork {
  const lines = normalizeLines(network);
  const stations = fillMissingCoordinates(network);
  const index = new Map(stations.map((s, i) => [s.name, i]));
  const edges = buildEdges(lines, index);
  const adjacency: number[][] = stations.map(() => []);
  edges.forEach((e, i) => {
    adjacency[e.a]!.push(i);
    adjacency[e.b]!.push(i);
  });
  return { lines, stations, index, edges, adjacency };
}

/**
 * Turn grid positions (one per station, in `prepared.stations` order) into a
 * metro map: route every edge, offset shared track into lanes, and scale to
 * canvas coordinates. Edges are routed with `routeEdge` unless `paths` gives
 * a grid path per edge (in `prepared.edges` order, from `a` to `b`).
 */
export function buildMetroMap(
  prepared: PreparedNetwork,
  grid: Point[],
  options: CanvasOptions = {},
  paths: Point[][] = prepared.edges.map((e) => routeEdge(grid[e.a]!, grid[e.b]!, grid)),
): MetroMap {
  const spacing = options.spacing ?? 64;
  const laneWidth = options.laneWidth ?? 8;
  const padding = options.padding ?? 80;
  const { lines, stations, index, edges } = prepared;
  if (stations.length === 0) return { width: 2 * padding, height: 2 * padding, stations: [], lines: [] };

  // Canvas transform.
  const xs = grid.map((p) => p.x);
  const ys = grid.map((p) => p.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const toCanvas = (p: Point): Point => ({
    x: (p.x - minX) * spacing + padding,
    y: (p.y - minY) * spacing + padding,
  });

  const mapStations: MapStation[] = stations.map((s, i) => ({ name: s.name, ...toCanvas(grid[i]!) }));

  // Offset each line into its lane on every edge.
  const edgeKey = (a: number, b: number) => (a < b ? `${a}|${b}` : `${b}|${a}`);
  const edgeByKey = new Map(edges.map((e, i) => [edgeKey(e.a, e.b), i]));

  const mapLines: MapLine[] = lines.map((line, li) => {
    const route = line.route.map((name) => ({ name, i: index.get(name)! }));
    const segments: MapSegment[] = [];
    for (let k = 1; k < route.length; k++) {
      const from = route[k - 1]!;
      const to = route[k]!;
      const ei = edgeByKey.get(edgeKey(from.i, to.i))!;
      const e = edges[ei]!;
      const lane = e.lines.indexOf(li);
      const offset = (lane - (e.lines.length - 1) / 2) * laneWidth;
      // Path is stored a→b; lanes are measured left of the reference direction.
      let pts = paths[ei]!.map(toCanvas);
      const refForward = !e.reversed;
      if (!refForward) pts = pts.reverse();
      pts = offsetPolyline(pts, offset);
      if (!refForward) pts = pts.reverse();
      if (from.i !== e.a) pts = pts.reverse();
      segments.push({ from: from.name, to: to.name, points: pts });
    }

    return { name: line.name, color: line.color, segments };
  });

  const maxX = Math.max(...xs);
  const maxY = Math.max(...ys);
  return {
    width: (maxX - minX) * spacing + 2 * padding,
    height: (maxY - minY) * spacing + 2 * padding,
    stations: mapStations,
    lines: mapLines,
  };
}

function buildEdges(lines: NormalizedLine[], index: Map<string, number>): Edge[] {
  const edges = new Map<string, Edge>();
  lines.forEach((line, li) => {
    for (let k = 1; k < line.route.length; k++) {
      const u = index.get(line.route[k - 1]!)!;
      const v = index.get(line.route[k]!)!;
      const a = Math.min(u, v);
      const b = Math.max(u, v);
      const key = `${a}|${b}`;
      let e = edges.get(key);
      if (!e) {
        // The first line to use an edge fixes its reference direction.
        e = { a, b, lines: [], reversed: u !== a };
        edges.set(key, e);
      }
      if (!e.lines.includes(li)) e.lines.push(li);
    }
  });
  return [...edges.values()];
}

/** Equirectangular projection, scaled so the median edge length is about 1. Missing coordinates get null. */
export function project(stations: Station[]): (Point | null)[] {
  const placed = stations.filter(hasCoordinates);
  if (placed.length === 0) return stations.map(() => null);
  const lat0 = placed.reduce((s, p) => s + p.lat, 0) / placed.length;
  const k = Math.cos((lat0 * Math.PI) / 180);
  const raw = stations.map((s) => (hasCoordinates(s) ? { x: s.lon * k, y: -s.lat } : null));

  // Scale by nearest-neighbour distance, which is a good proxy for station spacing.
  const pts = raw.filter((p): p is Point => p !== null);
  const nearest = pts
    .map((p) => Math.min(...pts.filter((q) => q !== p).map((q) => dist(p, q))))
    .filter((d) => d > 0 && Number.isFinite(d))
    .sort((a, b) => a - b);
  const unit = nearest.length > 0 ? nearest[Math.floor(nearest.length / 2)]! : 1;
  return raw.map((p) => (p ? { x: p.x / unit, y: p.y / unit } : null));
}

/** Round to integer grid cells; when two stations want the same cell, the busier one wins. */
export function snapToFreeCells(pos: Point[], adjacency: number[][]): Point[] {
  const order = pos.map((_, i) => i).sort((a, b) => adjacency[b]!.length - adjacency[a]!.length);
  const taken = new Set<string>();
  const result: Point[] = new Array(pos.length);
  for (const i of order) {
    const p = pos[i]!;
    let best: Point | null = null;
    for (let r = 0; best === null; r++) {
      let bestD = Infinity;
      for (let dx = -r; dx <= r; dx++) {
        for (let dy = -r; dy <= r; dy++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const c = { x: Math.round(p.x) + dx, y: Math.round(p.y) + dy };
          if (taken.has(`${c.x},${c.y}`)) continue;
          const d = dist(c, p);
          if (d < bestD) {
            bestD = d;
            best = c;
          }
        }
      }
    }
    taken.add(`${best.x},${best.y}`);
    result[i] = best;
  }
  return result;
}

/** Grid path between two stations: straight when octilinear, otherwise one 45° bend. */
export function routeEdge(a: Point, b: Point, grid: Point[]): Point[] {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const adx = Math.abs(dx);
  const ady = Math.abs(dy);
  if (adx === 0 || ady === 0 || adx === ady) return [a, b];
  const diag = Math.min(adx, ady);
  const sx = Math.sign(dx);
  const sy = Math.sign(dy);
  // Diagonal first, or straight first: pick the bend that stays clear of other stations.
  const bendDiagFirst = { x: a.x + sx * diag, y: a.y + sy * diag };
  const bendStraightFirst = { x: b.x - sx * diag, y: b.y - sy * diag };
  const clearance = (bend: Point) => Math.min(...grid.filter((p) => p !== a && p !== b).map((p) => dist(p, bend)), 9);
  const bend = clearance(bendDiagFirst) >= clearance(bendStraightFirst) ? bendDiagFirst : bendStraightFirst;
  return [a, bend, b];
}

/** Shift a polyline sideways by `offset`, positive to the left of travel direction (in screen space). */
export function offsetPolyline(points: Point[], offset: number): Point[] {
  if (offset === 0 || points.length < 2) return points.map((p) => ({ ...p }));
  const normals: Point[] = [];
  for (let i = 1; i < points.length; i++) {
    const d = { x: points[i]!.x - points[i - 1]!.x, y: points[i]!.y - points[i - 1]!.y };
    const len = Math.hypot(d.x, d.y) || 1;
    normals.push({ x: d.y / len, y: -d.x / len });
  }
  return points.map((p, i) => {
    if (i === 0) return { x: p.x + normals[0]!.x * offset, y: p.y + normals[0]!.y * offset };
    if (i === points.length - 1) {
      const nl = normals[normals.length - 1]!;
      return { x: p.x + nl.x * offset, y: p.y + nl.y * offset };
    }
    // Miter join keeps parallel lanes at a constant distance through the bend.
    const n1 = normals[i - 1]!;
    const n2 = normals[i]!;
    const k = offset / (1 + n1.x * n2.x + n1.y * n2.y);
    return { x: p.x + (n1.x + n2.x) * k, y: p.y + (n1.y + n2.y) * k };
  });
}
