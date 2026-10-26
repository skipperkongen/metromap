import { describe, expect, it } from "vitest";
import {
  copenhagenMetro,
  evaluate,
  prepareNetwork,
  project,
  riversideCity,
  type Network,
  type Point,
} from "../src/index.js";
import { relaxRefineStages } from "../src/algorithms/relax-refine.js";
import { shapeAwareGrid } from "../src/algorithms/shape-aware.js";
import { octant, signedTurn } from "../src/aesthetics.js";

/** A network with one line through the given grid points, named S0, S1, … */
function line(points: Point[], loop = false) {
  const names = points.map((_, i) => `S${i}`);
  const network: Network = {
    stations: names.map((name) => ({ name })),
    lines: [{ name: "L", route: loop ? [...names, names[0]!] : names }],
  };
  return { prepared: prepareNetwork(network), grid: points };
}

describe("turns", () => {
  it("measures directions and signed turns in 45° steps", () => {
    expect(octant({ x: 1, y: 0 })).toBe(0);
    expect(octant({ x: 1, y: 1 })).toBe(1);
    expect(octant({ x: 0, y: -1 })).toBe(6);
    expect(signedTurn(0, 1)).toBe(1);
    expect(signedTurn(0, 7)).toBe(-1);
    expect(signedTurn(0, 4)).toBe(4);
  });
});

describe("evaluate", () => {
  it("counts a zig-zag: two consecutive turns in opposite directions", () => {
    // east, south-east, east: a 45° jog one way, then back
    const { prepared, grid } = line([
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 2, y: 1 },
      { x: 3, y: 1 },
    ]);
    const score = evaluate(prepared, grid);
    expect(score.count.turn).toBe(2);
    expect(score.count.zigzag).toBe(1);
  });

  it("does not count turns in the same direction as a zig-zag", () => {
    // east, south-east, south: a smooth 90° curve
    const { prepared, grid } = line([
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 2, y: 1 },
      { x: 2, y: 2 },
    ]);
    expect(evaluate(prepared, grid).count.zigzag).toBe(0);
  });

  it("finds no dents or sharp turns in an octagonal ring", () => {
    const octagon = [
      { x: 1, y: 0 },
      { x: 2, y: 0 },
      { x: 3, y: 1 },
      { x: 3, y: 2 },
      { x: 2, y: 3 },
      { x: 1, y: 3 },
      { x: 0, y: 2 },
      { x: 0, y: 1 },
    ];
    const { prepared, grid } = line(octagon, true);
    const score = evaluate(prepared, grid);
    expect(score.count.turn).toBe(8);
    expect(score.count.loopConcave).toBe(0);
    expect(score.count.loopSharp).toBe(0);
    expect(score.count.zigzag).toBe(0);
  });

  it("counts a dent in a ring and its sharp corners", () => {
    // A square with its right side pushed in.
    const dented = [
      { x: 0, y: 0 },
      { x: 2, y: 0 },
      { x: 1, y: 1 },
      { x: 2, y: 2 },
      { x: 0, y: 2 },
    ];
    const { prepared, grid } = line(dented, true);
    const score = evaluate(prepared, grid);
    expect(score.count.loopConcave).toBe(1);
    expect(score.count.loopSharp).toBeGreaterThan(0);
  });

  it("counts a station lying on another edge", () => {
    const network: Network = {
      stations: [{ name: "A" }, { name: "B" }, { name: "C" }, { name: "D" }],
      lines: [
        { name: "L1", route: ["A", "B"] },
        { name: "L2", route: ["C", "D"] },
      ],
    };
    const prepared = prepareNetwork(network);
    const grid = [
      { x: 0, y: 0 },
      { x: 2, y: 0 },
      { x: 1, y: 0 }, // C sits on A–B
      { x: 1, y: 1 },
    ];
    expect(evaluate(prepared, grid).count.stationOnEdge).toBe(1);
  });

  it("asks for label room on short horizontal edges between long names", () => {
    const network: Network = {
      stations: [{ name: "A very long station name" }, { name: "Another long station name" }],
      lines: [{ name: "L", route: ["A very long station name", "Another long station name"] }],
    };
    const prepared = prepareNetwork(network);
    const tight = evaluate(prepared, [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
    ]);
    const roomy = evaluate(prepared, [
      { x: 0, y: 0 },
      { x: 3, y: 0 },
    ]);
    expect(tight.count.labelRoom).toBe(1);
    expect(roomy.count.labelRoom).toBe(0);
  });
});

describe.each([
  ["Copenhagen", copenhagenMetro()],
  ["Riverside", riversideCity()],
])("shape-aware on %s", (_name, network) => {
  const prepared = prepareNetwork(network);
  const geo = project(prepared.stations);
  const grid = shapeAwareGrid(prepared);

  it("scores better than relax & refine on its own objective", () => {
    const before = evaluate(prepared, relaxRefineStages(prepared, 3).grid, { geo }).total;
    expect(evaluate(prepared, grid, { geo }).total).toBeLessThan(before);
  });

  it("is deterministic for a given seed", () => {
    expect(shapeAwareGrid(prepared, { seed: 1 })).toEqual(grid);
  });
});

describe("shape-aware on the Copenhagen ring", () => {
  it("makes the ring convex, with no zig-zags", () => {
    const prepared = prepareNetwork(copenhagenMetro());
    const score = evaluate(prepared, shapeAwareGrid(prepared), { geo: project(prepared.stations) });
    expect(score.count.loopConcave).toBe(0);
    expect(score.count.zigzag).toBe(0);
  });
});
