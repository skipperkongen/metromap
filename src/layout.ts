import { fillMissingCoordinates, hasCoordinates, normalizeLines, type NormalizedLine } from "./network.js";
import type { MapLine, MapSegment, MapStation, MetroMap, Network, Point, Station } from "./types.js";

export interface LayoutOptions {
  /** Canvas distance between neighbouring grid points. Default 64. */
  spacing?: number;
  /** Canvas distance between parallel lines sharing a track. Default 8. */
  laneWidth?: number;
  /** Empty margin around the map. Default 80. */
  padding?: number;
  /** Longest an edge may be, in grid steps. Default 3. */
  maxEdgeLength?: number;
}

export interface Edge {
  a: number;
  b: number;
  /** Indices of lines using this edge, in drawing order. */
  lines: number[];
  /** Line traversal that defines which side is "left" for lane offsets. */
  reversed: boolean;
}

const DIRS: Point[] = [
  { x: 1, y: 0 },
  { x: 1, y: 1 },
  { x: 0, y: 1 },
  { x: -1, y: 1 },
  { x: -1, y: 0 },
  { x: -1, y: -1 },
  { x: 0, y: -1 },
  { x: 1, y: -1 },
];

/** Turn a network of stations and lines into an octilinear metro map in canvas coordinates. */
export function layout(network: Network, options: LayoutOptions = {}): MetroMap {
  const spacing = options.spacing ?? 64;
  const laneWidth = options.laneWidth ?? 8;
  const padding = options.padding ?? 80;
  const maxLen = options.maxEdgeLength ?? 3;

  const { lines, stations, index, edges, grid, paths } = computeStages(network, maxLen);
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

export interface Stages {
  lines: NormalizedLine[];
  stations: Station[];
  index: Map<string, number>;
  edges: Edge[];
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

/**
 * Runs the layout pipeline up to the grid paths and returns every intermediate
 * result. `layout()` builds its output from this; the docs figures draw it.
 */
export function computeStages(
  network: Network,
  maxLen = 3,
  onRelaxStep?: (iteration: number, pos: Point[]) => void,
): Stages {
  const lines = normalizeLines(network);
  const stations = fillMissingCoordinates(network);
  const index = new Map(stations.map((s, i) => [s.name, i]));
  const edges = buildEdges(lines, index);
  const adjacency: number[][] = stations.map(() => []);
  edges.forEach((e, i) => {
    adjacency[e.a]!.push(i);
    adjacency[e.b]!.push(i);
  });

  const geo = project(stations);
  const relaxed = stations.length > 0 ? relax(geo, edges, maxLen, onRelaxStep) : [];
  const snapped = snapToFreeCells(relaxed, adjacency);
  const grid = snapped.map((p) => ({ ...p }));
  refine(grid, edges, adjacency, lines, index, maxLen);
  const paths = edges.map((e) => routeEdge(grid[e.a]!, grid[e.b]!, grid));
  return { lines, stations, index, edges, geo, relaxed, snapped, grid, paths };
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
function project(stations: Station[]): (Point | null)[] {
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

function dist(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function average(points: Point[]): Point {
  const s = points.reduce((acc, p) => ({ x: acc.x + p.x, y: acc.y + p.y }), { x: 0, y: 0 });
  return { x: s.x / points.length, y: s.y / points.length };
}

function closestOnSegment(p: Point, a: Point, b: Point): { point: Point; t: number } {
  const d = { x: b.x - a.x, y: b.y - a.y };
  const len2 = d.x * d.x + d.y * d.y;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * d.x + (p.y - a.y) * d.y) / len2)) : 0;
  return { point: { x: a.x + d.x * t, y: a.y + d.y * t }, t };
}

function segmentsCross(p1: Point, p2: Point, p3: Point, p4: Point): boolean {
  const o = (a: Point, b: Point, c: Point) => Math.sign((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x));
  return o(p1, p2, p3) * o(p1, p2, p4) < 0 && o(p3, p4, p1) * o(p3, p4, p2) < 0;
}
