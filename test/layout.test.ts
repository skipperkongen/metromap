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
      const names = line.route;
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

describe("shared track", () => {
  const map = layout(riversideCity());

  it("puts lines that share an edge in separate lanes", () => {
    const seg = (name: string) => map.lines.find((l) => l.name === name)!.segments.find((s) => s.from === "University")!;
    const red = seg("Red").points[0]!;
    const green = seg("Green").points[0]!;
    expect(Math.hypot(red.x - green.x, red.y - green.y)).toBeGreaterThan(4);
  });
});

describe("station dots", () => {
  const map = layout(riversideCity());
  const svg = renderSvg(map, { legend: false });
  const circles = [...svg.matchAll(/<circle cx="([\d.]+)" cy="([\d.]+)" r="([\d.]+)"/g)].map((m) => ({
    x: Number(m[1]),
    y: Number(m[2]),
    r: Number(m[3]),
  }));
  const at = (name: string) => {
    const s = map.stations.find((st) => st.name === name)!;
    return circles.filter((c) => Math.abs(c.x - s.x) < 0.1 && Math.abs(c.y - s.y) < 0.1);
  };

  it("draws exactly one dot per station", () => {
    expect(circles).toHaveLength(map.stations.length);
    for (const s of map.stations) expect(at(s.name), s.name).toHaveLength(1);
  });

  it("makes interchange dots larger than single-line dots", () => {
    expect(at("Central")[0]!.r).toBeGreaterThan(at("Elm Park")[0]!.r);
  });
});

describe("loops", () => {
  it("draws every segment of a loop, back to the start", () => {
    const map = layout(copenhagenMetro());
    const ring = map.lines.find((l) => l.name === "M3 Cityringen")!;
    expect(ring.segments).toHaveLength(17);
    expect(ring.segments[0]!.from).toBe("København H");
    expect(ring.segments[16]!.to).toBe("København H");
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
