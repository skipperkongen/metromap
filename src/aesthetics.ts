import { segmentsCross } from "./geometry.js";
import { routeEdge, type PreparedNetwork } from "./pipeline.js";
import type { Point } from "./types.js";

// A formal, weighted definition of what makes a metro map look good.
// Every goal is measured on the grid layout (before lane offsets), so any
// grid-based algorithm can be scored and compared. See docs/aesthetics.md.

export type Goal =
  | "stationOnEdge"
  | "crossing"
  | "overlap"
  | "edgeBend"
  | "tooLong"
  | "length"
  | "turn"
  | "zigzag"
  | "loopConcave"
  | "loopSharp"
  | "backtrack"
  | "rhythm"
  | "geo"
  | "labelRoom";

export const GOALS: Goal[] = [
  "stationOnEdge",
  "crossing",
  "overlap",
  "edgeBend",
  "tooLong",
  "length",
  "turn",
  "zigzag",
  "loopConcave",
  "loopSharp",
  "backtrack",
  "rhythm",
  "geo",
  "labelRoom",
];

export interface AestheticWeights {
  /** An edge's path runs through a station it doesn't connect. */
  stationOnEdge: number;
  /** Two edges without a common station cross. */
  crossing: number;
  /** Two edges leave the same station in the same direction, so they overlap. */
  overlap: number;
  /** An edge is not octilinear and needs a bend between its stations. */
  edgeBend: number;
  /** Per grid step an edge is longer than `maxEdgeLength`. */
  tooLong: number;
  /** Per grid step an edge is longer than 1 (compactness). */
  length: number;
  /** A line turns by 45°, 90°, 135° or 180°. */
  turn: [number, number, number, number];
  /** Two consecutive turns of a line go opposite ways. Halved when the straight run between them is long. */
  zigzag: number;
  /** A ring line turns against its own direction, making a dent. */
  loopConcave: number;
  /** A ring line turns more than 45° at once, per extra 45°. */
  loopSharp: number;
  /** A leg of an open line points away from the line's overall direction (more than 90°). */
  backtrack: number;
  /** Per grid step of difference between consecutive edge lengths along a line. */
  rhythm: number;
  /** Per 45° an edge deviates from its geographic direction, beyond the first 45°. */
  geo: number;
  /** Per grid step a horizontal edge is too short for the two station names above or below it. */
  labelRoom: number;
}

export const DEFAULT_WEIGHTS: AestheticWeights = {
  stationOnEdge: 40,
  crossing: 15,
  overlap: 25,
  edgeBend: 2,
  tooLong: 3,
  length: 0.3,
  turn: [1, 3, 8, 20],
  zigzag: 5,
  loopConcave: 6,
  loopSharp: 2,
  backtrack: 3,
  rhythm: 0.5,
  geo: 2,
  labelRoom: 3,
};

export interface AestheticScore {
  /** Weighted sum of all goals. Lower is better. */
  total: number;
  /** Cost contributed by each goal. */
  cost: Record<Goal, number>;
  /** How often each issue occurs, e.g. the number of zig-zags. */
  count: Record<Goal, number>;
}

export interface EvaluateOptions {
  /** Projected geographic positions (from `project`), for the `geo` goal. */
  geo?: (Point | null)[];
  maxEdgeLength?: number;
  weights?: Partial<AestheticWeights>;
  /** Grid path of each edge; routed with `routeEdge` when omitted. */
  paths?: Point[][];
  /**
   * Label width per character, in grid steps, for the `labelRoom` goal.
   * Default 0.105: a 12px font (about 6.7px per character) on a 64px grid.
   */
  labelStepsPerChar?: number;
}

interface Leg {
  dir: number; // octant 0..7, clockwise on screen (y points down)
  steps: number;
  from: Point;
  to: Point;
}

/**
 * Score a grid layout against every goal. `grid` has one point per station, in
 * `prepared.stations` order, with whole-number coordinates.
 */
export function evaluate(prepared: PreparedNetwork, grid: Point[], options: EvaluateOptions = {}): AestheticScore {
  const w = { ...DEFAULT_WEIGHTS, ...options.weights };
  const maxLen = options.maxEdgeLength ?? 3;
  const { edges, lines, index, stations } = prepared;
  const paths = options.paths ?? edges.map((e) => routeEdge(grid[e.a]!, grid[e.b]!, grid));

  const cost = Object.fromEntries(GOALS.map((g) => [g, 0])) as Record<Goal, number>;
  const count = Object.fromEntries(GOALS.map((g) => [g, 0])) as Record<Goal, number>;
  const add = (goal: Goal, c: number, n = 1) => {
    cost[goal] += c;
    count[goal] += n;
  };

  // ---------- Edges ----------
  const cells = new Map(grid.map((p, i) => [`${p.x},${p.y}`, i]));
  const outgoing: number[][] = stations.map(() => []); // first-leg direction of each edge, per station
  edges.forEach((e, ei) => {
    const path = paths[ei]!;
    const len = pathSteps(path);
    if (path.length > 2) add("edgeBend", w.edgeBend);
    if (len > maxLen) add("tooLong", w.tooLong * (len - maxLen), len - maxLen);
    if (len > 1) cost.length += w.length * (len - 1);
    count.length += len;

    // Stations the path runs through: on a whole-number grid, walk its grid points.
    for (let k = 1; k < path.length; k++) {
      const p = path[k - 1]!;
      const q = path[k]!;
      const steps = Math.max(Math.abs(q.x - p.x), Math.abs(q.y - p.y));
      const sx = Math.sign(q.x - p.x);
      const sy = Math.sign(q.y - p.y);
      for (let t = k === 1 ? 1 : 0; t < steps; t++) {
        const s = cells.get(`${p.x + sx * t},${p.y + sy * t}`);
        if (s !== undefined && s !== e.a && s !== e.b) add("stationOnEdge", w.stationOnEdge);
      }
    }

    // Labels go above or below a horizontal edge, so its length must fit both names side by side.
    if (path.length === 2 && path[0]!.y === path[1]!.y) {
      const perChar = options.labelStepsPerChar ?? 0.105;
      const need = ((stations[e.a]!.name.length + stations[e.b]!.name.length) / 2) * perChar + 0.3;
      if (len < need) add("labelRoom", w.labelRoom * (need - len));
    }

    outgoing[e.a]!.push(octant(sub(path[1]!, path[0]!)));
    outgoing[e.b]!.push(octant(sub(path[path.length - 2]!, path[path.length - 1]!)));

    const geo = options.geo;
    const ga = geo?.[e.a];
    const gb = geo?.[e.b];
    if (ga && gb) {
      const angle = angleBetween(sub(grid[e.b]!, grid[e.a]!), sub(gb, ga));
      if (angle > 45) cost.geo += (w.geo * (angle - 45)) / 45;
      if (angle > 90) count.geo++;
    }
  });

  for (let i = 0; i < edges.length; i++) {
    for (let j = i + 1; j < edges.length; j++) {
      const e = edges[i]!;
      const f = edges[j]!;
      if (e.a === f.a || e.a === f.b || e.b === f.a || e.b === f.b) continue;
      if (pathsCross(paths[i]!, paths[j]!)) add("crossing", w.crossing);
    }
  }

  for (const dirs of outgoing) {
    const seen = new Set<number>();
    for (const d of dirs) {
      if (seen.has(d)) add("overlap", w.overlap);
      seen.add(d);
    }
  }

  // ---------- Lines ----------
  const edgeIndex = new Map(edges.map((e, i) => [`${e.a}|${e.b}`, i]));
  for (const line of lines) {
    const route = line.route.map((name) => index.get(name)!);
    const loop = route.length > 3 && route[0] === route[route.length - 1];

    // The line as drawn: grid paths in travel order, joined.
    const points: Point[] = [];
    const edgeLengths: number[] = [];
    for (let k = 1; k < route.length; k++) {
      const u = route[k - 1]!;
      const v = route[k]!;
      const ei = edgeIndex.get(u < v ? `${u}|${v}` : `${v}|${u}`)!;
      let path = paths[ei]!;
      if (edges[ei]!.a !== u) path = [...path].reverse();
      edgeLengths.push(pathSteps(path));
      for (const p of path) {
        const last = points[points.length - 1];
        if (!last || last.x !== p.x || last.y !== p.y) points.push(p);
      }
    }

    const legs = toLegs(points, loop);
    const turns: { t: number; run: number }[] = [];
    const turnCount = loop ? legs.length : legs.length - 1;
    for (let i = 0; i < turnCount; i++) {
      const a = legs[i]!;
      const b = legs[(i + 1) % legs.length]!;
      // `run` is the straight leg that follows this turn, up to the next turn.
      turns.push({ t: signedTurn(a.dir, b.dir), run: b.steps });
    }

    for (const { t } of turns) if (t !== 0) add("turn", w.turn[Math.abs(t) - 1]!);

    // Zig-zags: consecutive turns in opposite directions.
    const pairCount = loop ? turns.length : turns.length - 1;
    for (let i = 0; i < pairCount; i++) {
      const a = turns[i]!;
      const b = turns[(i + 1) % turns.length]!;
      if (a.t !== 0 && b.t !== 0 && Math.sign(a.t) !== Math.sign(b.t) && Math.abs(a.t) < 4 && Math.abs(b.t) < 4) {
        add("zigzag", a.run <= 2 ? w.zigzag : w.zigzag / 2);
      }
    }

    if (loop) {
      // A simple closed line turns ±8 × 45° in total; its sign is the ring's direction.
      const orientation = Math.sign(turns.reduce((s, { t }) => s + t, 0));
      if (orientation !== 0) {
        for (const { t } of turns) {
          if (Math.sign(t) === -orientation) add("loopConcave", w.loopConcave);
          else if (Math.abs(t) > 1) add("loopSharp", w.loopSharp * (Math.abs(t) - 1), Math.abs(t) - 1);
        }
      }
    } else if (points.length > 1) {
      const overall = sub(points[points.length - 1]!, points[0]!);
      if (Math.max(Math.abs(overall.x), Math.abs(overall.y)) >= 2) {
        for (const leg of legs) {
          const v = sub(leg.to, leg.from);
          if (v.x * overall.x + v.y * overall.y < 0) add("backtrack", w.backtrack);
        }
      }
    }

    for (let k = 1; k < edgeLengths.length; k++) {
      const d = Math.abs(edgeLengths[k]! - edgeLengths[k - 1]!);
      if (d > 0) add("rhythm", w.rhythm * d, d);
    }
  }

  const total = GOALS.reduce((s, g) => s + cost[g], 0);
  return { total, cost, count };
}

/** Split a polyline into maximal straight legs. For a loop, legs that meet at the start are merged too. */
function toLegs(points: Point[], loop: boolean): Leg[] {
  const legs: Leg[] = [];
  for (let i = 1; i < points.length; i++) {
    const v = sub(points[i]!, points[i - 1]!);
    const steps = Math.max(Math.abs(v.x), Math.abs(v.y));
    if (steps === 0) continue;
    const dir = octant(v);
    const last = legs[legs.length - 1];
    if (last && last.dir === dir) {
      last.steps += steps;
      last.to = points[i]!;
    } else {
      legs.push({ dir, steps, from: points[i - 1]!, to: points[i]! });
    }
  }
  if (loop && legs.length > 1 && legs[0]!.dir === legs[legs.length - 1]!.dir) {
    const last = legs.pop()!;
    legs[0] = { dir: last.dir, steps: last.steps + legs[0]!.steps, from: last.from, to: legs[0]!.to };
  }
  return legs;
}

/** Octilinear direction index 0..7 (0 = east, 2 = south on screen). */
export function octant(v: Point): number {
  return ((Math.round(Math.atan2(v.y, v.x) / (Math.PI / 4)) % 8) + 8) % 8;
}

/** Turn from direction a to b in 45° units: −3..−1 one way, 1..3 the other, 4 for a U-turn. */
export function signedTurn(a: number, b: number): number {
  const d = (((b - a) % 8) + 8) % 8;
  return d > 4 ? d - 8 : d;
}

/** Path length in grid steps (diagonal steps count as 1). */
export function pathSteps(path: Point[]): number {
  let n = 0;
  for (let i = 1; i < path.length; i++) n += Math.max(Math.abs(path[i]!.x - path[i - 1]!.x), Math.abs(path[i]!.y - path[i - 1]!.y));
  return n;
}

function pathsCross(p: Point[], q: Point[]): boolean {
  for (let i = 1; i < p.length; i++) {
    for (let j = 1; j < q.length; j++) if (segmentsCross(p[i - 1]!, p[i]!, q[j - 1]!, q[j]!)) return true;
  }
  return false;
}

function sub(a: Point, b: Point): Point {
  return { x: a.x - b.x, y: a.y - b.y };
}

function angleBetween(u: Point, v: Point): number {
  const lu = Math.hypot(u.x, u.y);
  const lv = Math.hypot(v.x, v.y);
  if (lu === 0 || lv === 0) return 0;
  const cos = Math.max(-1, Math.min(1, (u.x * v.x + u.y * v.y) / (lu * lv)));
  return (Math.acos(cos) * 180) / Math.PI;
}
