import { defineGridAlgorithm } from "../algorithm.js";
import { evaluate, pathSteps, type AestheticWeights } from "../aesthetics.js";
import { DIRS } from "../geometry.js";
import type { CanvasOptions, PreparedNetwork } from "../pipeline.js";
import type { Point } from "../types.js";
import { relaxRefineStages } from "./relax-refine.js";

export interface ShapeAwareOptions extends CanvasOptions {
  /** Longest an edge may be, in grid steps. Default 3. */
  maxEdgeLength?: number;
  /** Override any of the aesthetic weights (see `DEFAULT_WEIGHTS`). */
  weights?: Partial<AestheticWeights>;
  /** Most rounds of (cheap passes, then compound moves) to run. Default 6. */
  maxRounds?: number;
  /** Random restarts of the iterated local search. 0 turns them off. Default 4. */
  restarts?: number;
  /** Seed for the restarts' random perturbations. The same seed gives the same map. Default 1. */
  seed?: number;
}

/**
 * Starts from relax & refine and optimises the full aesthetic objective
 * (`evaluate`): no zig-zags, convex rings with 45° turns, even rhythm, clean
 * junctions. Besides single stations it moves whole chains and refits rings.
 * See docs/aesthetics.md.
 */
export const shapeAware = defineGridAlgorithm<ShapeAwareOptions>({
  id: "shape-aware",
  name: "Shape-aware",
  description: "Relax & refine, then reshapes whole lines: no zig-zags, convex 45° rings, even spacing, clean junctions.",
  place: (prepared, options) => shapeAwareGrid(prepared, options),
});

/** A run of stations joined by edges, whose inner stations have exactly two edges. */
interface Chain {
  stations: number[];
  /** A cycle with no junction on it. */
  closed: boolean;
}

/** Grid positions from the shape-aware optimisation (one per station). */
export function shapeAwareGrid(prepared: PreparedNetwork, options: ShapeAwareOptions = {}): Point[] {
  const maxLen = options.maxEdgeLength ?? 3;
  const maxRounds = options.maxRounds ?? 6;
  const start = relaxRefineStages(prepared, maxLen);
  let grid = start.grid.map((p) => ({ ...p }));
  const score = (g: Point[]) => evaluate(prepared, g, { geo: start.geo, maxEdgeLength: maxLen, weights: options.weights }).total;
  let current = score(grid);

  const n = grid.length;
  const chains = findChains(prepared);
  const rings = prepared.lines
    .map((l) => l.route.map((name) => prepared.index.get(name)!))
    .filter((r) => r.length > 3 && r[0] === r[r.length - 1])
    .map((r) => r.slice(0, -1))
    .filter((r) => new Set(r).size === r.length);

  const valid = (g: Point[]) => new Set(g.map((p) => `${p.x},${p.y}`)).size === n;
  const apply = (g: Point[], moves: Map<number, Point>) => g.map((p, i) => moves.get(i) ?? p);

  /** Of the candidate moves, take the one that lowers the cost most (if any). */
  const best = (base: Point[], baseScore: number, candidates: Map<number, Point>[]) => {
    let grid = base;
    let score_ = baseScore;
    for (const moves of candidates) {
      const next = apply(base, moves);
      if (!valid(next)) continue;
      const s = score(next);
      if (s < score_ - 1e-6) {
        score_ = s;
        grid = next;
      }
    }
    return { grid, score: score_ };
  };

  /** Greedily re-lay the given chains on top of a candidate layout. */
  const repair = (g: Point[], chainIds: number[]) => {
    let result = { grid: g, score: score(g) };
    for (const ci of chainIds) result = best(result.grid, result.score, chainMoves(chains[ci]!, result.grid, prepared));
    return result;
  };

  /** Cheap moves: single stations, chains, ring refits on their own. Repeat until nothing improves. */
  const cheapPasses = () => {
    for (let pass = 0; pass < 20; pass++) {
      const before = current;
      const step = (candidates: Map<number, Point>[]) => {
        ({ grid, score: current } = best(grid, current, candidates));
      };
      for (const ring of rings) step(ringFits(ring, grid));
      for (const chain of chains) step(chainMoves(chain, grid, prepared));
      for (let s = 0; s < n; s++) {
        if (prepared.adjacency[s]!.length > 0) step(DIRS.map((d) => new Map([[s, { x: grid[s]!.x + d.x, y: grid[s]!.y + d.y }]])));
      }
      if (current >= before - 1e-6) break;
    }
  };

  /**
   * Compound moves: change something big (refit a ring, move a junction), then
   * repair the chains attached to it, and judge the result as a whole. Escapes
   * the local minima single moves get stuck in.
   */
  const compoundPass = (): boolean => {
    let improved = false;
    const consider = (moves: Map<number, Point>, touched: Set<number>) => {
      const next = apply(grid, moves);
      if (!valid(next)) return;
      const chainIds = chains.flatMap((c, i) =>
        c.stations.some((st) => touched.has(st)) && !c.stations.every((st) => moves.has(st)) ? [i] : [],
      );
      const result = repair(next, chainIds);
      if (result.score < current - 1e-6) {
        grid = result.grid;
        current = result.score;
        improved = true;
      }
    };
    for (const ring of rings) for (const moves of ringFits(ring, grid)) consider(moves, new Set(ring));
    for (let j = 0; j < n; j++) {
      if (prepared.adjacency[j]!.length < 3) continue;
      for (const d of DIRS) consider(new Map([[j, { x: grid[j]!.x + d.x, y: grid[j]!.y + d.y }]]), new Set([j]));
    }
    return improved;
  };

  /** Greedy descent to a local minimum: cheap passes, then compound moves, until neither helps. */
  const descend = () => {
    for (let round = 0; round < maxRounds; round++) {
      cheapPasses();
      if (!compoundPass()) break;
    }
  };

  /**
   * One random compound perturbation, accepted even if it makes things worse:
   * refit a ring, move a junction and repair its chains, or re-lay a chain on a
   * random arc.
   */
  const perturb = (rand: () => number) => {
    const pick = <T>(items: T[]): T | undefined => items[Math.floor(rand() * items.length)];
    const junctions = grid.flatMap((_, i) => (prepared.adjacency[i]!.length >= 3 ? [i] : []));
    for (let attempt = 0; attempt < 20; attempt++) {
      const r = rand();
      let moves: Map<number, Point> | undefined;
      let touched = new Set<number>();
      if (r < 0.3 && rings.length > 0) {
        const ring = pick(rings)!;
        moves = pick(ringFits(ring, grid));
        touched = new Set(ring);
      } else if (r < 0.65 && junctions.length > 0) {
        const j = pick(junctions)!;
        const d = pick(DIRS)!;
        moves = new Map([[j, { x: grid[j]!.x + d.x, y: grid[j]!.y + d.y }]]);
        touched = new Set([j]);
      } else if (chains.length > 0) {
        moves = pick(chainMoves(pick(chains)!, grid, prepared, Infinity));
      }
      if (!moves) continue;
      const next = apply(grid, moves);
      if (!valid(next)) continue;
      const chainIds = chains.flatMap((c, i) => (c.stations.some((st) => touched.has(st)) && !c.stations.every((st) => moves.has(st)) ? [i] : []));
      ({ grid, score: current } = repair(next, chainIds));
      return;
    }
  };

  descend();
  // Iterated local search: perturb the best layout, descend again, keep improvements.
  const rand = mulberry32(options.seed ?? 1);
  let bestGrid = grid;
  let bestScore = current;
  for (let r = 0; r < (options.restarts ?? 4); r++) {
    grid = bestGrid;
    current = bestScore;
    perturb(rand);
    descend();
    if (current < bestScore - 1e-6) {
      bestGrid = grid;
      bestScore = current;
    }
  }
  grid = bestGrid;
  return grid;
}

/** Split the edge graph into chains between junctions (stations without exactly two edges). */
function findChains(prepared: PreparedNetwork): Chain[] {
  const { edges, adjacency } = prepared;
  const used = new Set<number>();
  const chains: Chain[] = [];
  const other = (ei: number, s: number) => (edges[ei]!.a === s ? edges[ei]!.b : edges[ei]!.a);
  const walk = (startStation: number, startEdge: number): number[] => {
    const stations = [startStation];
    let s = startStation;
    let ei = startEdge;
    for (;;) {
      used.add(ei);
      s = other(ei, s);
      stations.push(s);
      if (adjacency[s]!.length !== 2 || s === startStation) break;
      const next = adjacency[s]!.find((e) => e !== ei)!;
      if (used.has(next)) break;
      ei = next;
    }
    return stations;
  };
  adjacency.forEach((list, s) => {
    if (list.length === 2) return;
    for (const ei of list) if (!used.has(ei)) chains.push({ stations: walk(s, ei), closed: false });
  });
  // Whatever is left are cycles made only of two-edge stations.
  adjacency.forEach((list, s) => {
    for (const ei of list) if (!used.has(ei)) chains.push({ stations: walk(s, ei), closed: true });
  });
  return chains;
}

/** Candidate moves for one chain: shift it, re-lay it evenly on a one-bend path, or straighten a branch end. */
function chainMoves(chain: Chain, grid: Point[], prepared: PreparedNetwork, arcLimit = ARC_CANDIDATES): Map<number, Point>[] {
  const st = chain.stations;
  const inner = st.slice(1, -1);
  const candidates: Map<number, Point>[] = [];
  if (inner.length > 0) {
    for (const d of DIRS) candidates.push(new Map(inner.map((s) => [s, { x: grid[s]!.x + d.x, y: grid[s]!.y + d.y }])));
  }
  if (chain.closed) return candidates;

  const isEnd = (s: number) => prepared.adjacency[s]!.length === 1;
  const first = st[0]!;
  const last = st[st.length - 1]!;
  if (isEnd(last) !== isEnd(first)) {
    // A branch ending in a terminus: lay it out straight from its junction.
    const ordered = isEnd(last) ? st : [...st].reverse();
    const anchor = grid[ordered[0]!]!;
    const moving = ordered.slice(1);
    const step = Math.max(1, Math.round(pathSteps(ordered.map((s) => grid[s]!)) / moving.length));
    for (const d of DIRS) {
      for (const k of new Set([1, step])) {
        candidates.push(new Map(moving.map((s, i) => [s, { x: anchor.x + d.x * k * (i + 1), y: anchor.y + d.y * k * (i + 1) }])));
      }
    }
  } else if (inner.length > 0) {
    // Both ends fixed: spread the inner stations evenly along a convex arc between them.
    // There are many arcs; keep the few that move the stations least.
    const placements: { moves: Map<number, Point>; shift: number }[] = [];
    for (const path of arcPaths(grid[first]!, grid[last]!)) {
      const len = pathSteps(path);
      if (len < inner.length + 1) continue;
      const placed = inner.map((_, i) => pointAlong(path, Math.round(((i + 1) * len) / (inner.length + 1))));
      const shift = placed.reduce((sum, p, i) => sum + (p.x - grid[inner[i]!]!.x) ** 2 + (p.y - grid[inner[i]!]!.y) ** 2, 0);
      placements.push({ moves: new Map(inner.map((s, i) => [s, placed[i]!])), shift });
    }
    placements.sort((a, b) => a.shift - b.shift);
    for (const p of placements.slice(0, arcLimit)) candidates.push(p.moves);
  }
  return candidates;
}

/**
 * Candidate moves for a ring line: put its stations, in route order and evenly
 * spaced, on convex octilinear octagons that fit around its current position.
 */
function ringFits(ring: number[], grid: Point[]): Map<number, Point>[] {
  const pts = ring.map((s) => grid[s]!);
  const orientation = Math.sign(signedArea(pts));
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const candidates: Map<number, Point>[] = [];
  for (const grow of [0, 1, 2, 3]) {
    const x0 = Math.min(...xs) - grow;
    const x1 = Math.max(...xs) + grow;
    const y0 = Math.min(...ys) - grow;
    const y1 = Math.max(...ys) + grow;
    const maxCut = Math.floor(Math.min(x1 - x0, y1 - y0) / 2);
    for (let c = 0; c <= maxCut; c++) {
      let corners = dedupe([
        { x: x0 + c, y: y0 },
        { x: x1 - c, y: y0 },
        { x: x1, y: y0 + c },
        { x: x1, y: y1 - c },
        { x: x1 - c, y: y1 },
        { x: x0 + c, y: y1 },
        { x: x0, y: y1 - c },
        { x: x0, y: y0 + c },
      ]);
      if (corners.length < 3) continue;
      if (Math.sign(signedArea(corners)) !== orientation) corners = corners.reverse();
      const outline = [...corners, corners[0]!];
      const perimeter = pathSteps(outline);
      if (perimeter < ring.length) continue;
      // Rotate the stations around the outline to stay as close as possible to where they are.
      let best: Point[] = [];
      let bestCost = Infinity;
      for (let offset = 0; offset < perimeter; offset++) {
        const placed = ring.map((_, i) => pointAlong(outline, (offset + Math.round((i * perimeter) / ring.length)) % perimeter));
        const cost = placed.reduce((sum, p, i) => sum + (p.x - pts[i]!.x) ** 2 + (p.y - pts[i]!.y) ** 2, 0);
        if (cost < bestCost) {
          bestCost = cost;
          best = placed;
        }
      }
      candidates.push(new Map(ring.map((s, i) => [s, best[i]!])));
    }
  }
  return candidates;
}

/** How many of the closest arcs per chain are fully scored. */
const ARC_CANDIDATES = 8;

/**
 * Convex octilinear arcs from a to b: up to five legs in consecutive directions
 * d, d±1, …, d±4, so every turn is 45° and goes the same way (at most 180° in
 * total). This covers straight lines, one-bend paths, L-shapes, quarter and
 * half octagons.
 *
 * With the directions fixed, the leg lengths must satisfy Σ lengthᵢ·uᵢ = b − a:
 * two equations. Legs 1 and 3 are 90° apart (legs 1 and 2 for two-leg arcs),
 * so they are solved for exactly; the other legs are enumerated.
 */
export function arcPaths(a: Point, b: Point): Point[][] {
  const key = `${a.x},${a.y},${b.x},${b.y}`;
  let paths = arcCache.get(key);
  if (!paths) {
    paths = computeArcPaths(a, b);
    if (arcCache.size > 5000) arcCache.clear();
    arcCache.set(key, paths);
  }
  return paths;
}

const arcCache = new Map<string, Point[][]>();

function computeArcPaths(a: Point, b: Point): Point[][] {
  const delta = { x: b.x - a.x, y: b.y - a.y };
  const range = Math.min(8, Math.max(Math.abs(delta.x), Math.abs(delta.y)) + 2);
  const paths = new Map<string, Point[]>();

  const emit = (dirs: Point[], lengths: number[]) => {
    const path = [a];
    dirs.forEach((u, i) => {
      if (lengths[i] === 0) return;
      const p = path[path.length - 1]!;
      path.push({ x: p.x + u.x * lengths[i]!, y: p.y + u.y * lengths[i]! });
    });
    if (path.length > 1) paths.set(path.map((p) => `${p.x},${p.y}`).join(" "), path);
  };

  for (let d = 0; d < 8; d++) {
    for (const turn of [1, -1]) {
      for (let legs = 1; legs <= 5; legs++) {
        const dirs = Array.from({ length: legs }, (_, i) => DIRS[(((d + i * turn) % 8) + 8) % 8]!);
        if (legs === 1) {
          const u = dirs[0]!;
          const k = Math.max(Math.abs(delta.x), Math.abs(delta.y));
          if (u.x * k === delta.x && u.y * k === delta.y) emit(dirs, [k]);
          continue;
        }
        // Solve for legs i and j, enumerate the rest.
        const [i, j] = legs === 2 ? [0, 1] : [0, 2];
        const free = dirs.map((_, k) => k).filter((k) => k !== i && k !== j);
        const ui = dirs[i]!;
        const uj = dirs[j]!;
        const det = ui.x * uj.y - ui.y * uj.x;
        const lengths = new Array<number>(legs).fill(0);
        const recurse = (f: number, rx: number, ry: number) => {
          if (f === free.length) {
            const li = (rx * uj.y - ry * uj.x) / det;
            const lj = (ui.x * ry - ui.y * rx) / det;
            if (!Number.isInteger(li) || !Number.isInteger(lj) || li < 0 || lj < 0) return;
            lengths[i] = li;
            lengths[j] = lj;
            emit(dirs, lengths);
            return;
          }
          const k = free[f]!;
          for (let len = 1; len <= range; len++) {
            lengths[k] = len;
            recurse(f + 1, rx - dirs[k]!.x * len, ry - dirs[k]!.y * len);
          }
        };
        recurse(0, delta.x, delta.y);
      }
    }
  }
  return [...paths.values()];
}

/** The grid point `steps` grid steps along an octilinear path. */
function pointAlong(path: Point[], steps: number): Point {
  let left = steps;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1]!;
    const b = path[i]!;
    const len = Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y));
    if (left <= len) return { x: a.x + Math.sign(b.x - a.x) * left, y: a.y + Math.sign(b.y - a.y) * left };
    left -= len;
  }
  return { ...path[path.length - 1]! };
}

function signedArea(pts: Point[]): number {
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]!;
    const q = pts[(i + 1) % pts.length]!;
    s += p.x * q.y - q.x * p.y;
  }
  return s / 2;
}

function dedupe(pts: Point[]): Point[] {
  return pts.filter((p, i) => {
    const q = pts[(i + 1) % pts.length]!;
    return p.x !== q.x || p.y !== q.y;
  });
}

/** Small, fast, seeded random number generator (returns 0 ≤ x < 1). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
