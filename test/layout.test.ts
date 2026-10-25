import { describe, expect, it } from "vitest";
import { copenhagenMetro, layout, renderSvg, riversideCity, type MetroMap, type Network } from "../src/index.js";

const SPACING = 50;

function allLegs(map: MetroMap) {
  return map.lines.flatMap((l) =>
    l.segments.flatMap((s) => s.points.slice(1).map((q, i) => [s.points[i]!, q] as const)),
  );
}

describe.each([
  ["Copenhagen", copenhagenMetro()],
  ["Riverside", riversideCity()],
])("layout of %s", (_name, network: Network) => {
  const map = layout(network, { spacing: SPACING });

  it("keeps every station with its name", () => {
    expect(map.stations.map((s) => s.name).sort()).toEqual(network.stations.map((s) => s.name).sort());
  });

  it("gives every station its own position", () => {
    const keys = new Set(map.stations.map((s) => `${Math.round(s.x)},${Math.round(s.y)}`));
    expect(keys.size).toBe(map.stations.length);
  });

  it("only draws horizontal, vertical and 45° legs", () => {
    for (const [p, q] of allLegs(map)) {
      const dx = Math.abs(q.x - p.x);
      const dy = Math.abs(q.y - p.y);
      const octilinear = dx < 0.01 || dy < 0.01 || Math.abs(dx - dy) < 0.01;
      expect(octilinear, `leg (${p.x},${p.y}) → (${q.x},${q.y})`).toBe(true);
    }
  });

  it("produces one segment per consecutive route pair, in travel direction", () => {
    network.lines.forEach((line, i) => {
      const names = line.route.map((e) => (typeof e === "string" ? e : e.station));
      const segments = map.lines[i]!.segments;
      expect(segments.map((s) => [s.from, s.to])).toEqual(names.slice(1).map((to, k) => [names[k], to]));
    });
  });

  it("keeps the canvas inside its reported size", () => {
    for (const s of map.stations) {
      expect(s.x).toBeGreaterThan(0);
      expect(s.y).toBeGreaterThan(0);
      expect(s.x).toBeLessThan(map.width);
      expect(s.y).toBeLessThan(map.height);
    }
  });

  it("renders to SVG", () => {
    const svg = renderSvg(map);
    expect(svg.startsWith("<svg")).toBe(true);
    for (const line of map.lines) expect(svg).toContain(line.color);
  });
});

describe("stops and pass-throughs", () => {
  const map = layout(riversideCity());
  const express = map.lines.find((l) => l.name === "Red Express")!;

  it("marks stations the express skips", () => {
    const stops = Object.fromEntries(express.stations.map((s) => [s.station, s.stop]));
    expect(stops).toMatchObject({ Northgate: true, "Elm Park": false, Central: true, Market: false, Harbour: true });
  });

  it("puts the express in its own lane next to the local line", () => {
    const local = map.lines.find((l) => l.name === "Red Local")!;
    const e = express.stations.find((s) => s.station === "Elm Park")!;
    const l = local.stations.find((s) => s.station === "Elm Park")!;
    expect(Math.hypot(e.x - l.x, e.y - l.y)).toBeGreaterThan(4);
  });
});

describe("loops", () => {
  it("lists a loop's first station once", () => {
    const map = layout(copenhagenMetro());
    const ring = map.lines.find((l) => l.name === "M3 Cityringen")!;
    expect(ring.stations.filter((s) => s.station === "København H")).toHaveLength(1);
    expect(ring.segments).toHaveLength(17);
  });
});

describe("networks without coordinates", () => {
  it("still lays out every station", () => {
    const map = layout({
      stations: ["A", "B", "C", "D"].map((name) => ({ name })),
      lines: [{ name: "L", route: ["A", "B", "C", "D"] }],
    });
    expect(map.stations).toHaveLength(4);
    expect(new Set(map.stations.map((s) => `${s.x},${s.y}`)).size).toBe(4);
  });

  it("handles an empty network", () => {
    expect(layout({ stations: [], lines: [] }).stations).toEqual([]);
  });
});
