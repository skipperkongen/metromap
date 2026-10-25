import { describe, expect, it } from "vitest";
import { fillMissingCoordinates } from "../src/index.js";
import { normalizeLines } from "../src/network.js";

describe("normalizeLines", () => {
  const stations = [{ name: "A" }, { name: "B" }];

  it("assigns palette colors when none are given", () => {
    const [line] = normalizeLines({ stations, lines: [{ name: "L", route: ["A", "B"] }] });
    expect(line!.color).toMatch(/^#/);
  });

  it("rejects unknown stations, duplicates and immediate repeats", () => {
    expect(() => normalizeLines({ stations, lines: [{ name: "L", route: ["A", "C"] }] })).toThrow(/unknown station "C"/);
    expect(() => normalizeLines({ stations: [{ name: "A" }, { name: "A" }], lines: [] })).toThrow(/Duplicate/);
    expect(() => normalizeLines({ stations, lines: [{ name: "L", route: ["A", "A"] }] })).toThrow(/twice in a row/);
  });
});

describe("fillMissingCoordinates", () => {
  it("interpolates between known neighbours along a line", () => {
    const filled = fillMissingCoordinates({
      stations: [{ name: "A", lat: 0, lon: 0 }, { name: "B" }, { name: "C" }, { name: "D", lat: 3, lon: 6 }],
      lines: [{ name: "L", route: ["A", "B", "C", "D"] }],
    });
    expect(filled[1]).toMatchObject({ lat: 1, lon: 2 });
    expect(filled[2]).toMatchObject({ lat: 2, lon: 4 });
  });

  it("extends past the last known station", () => {
    const filled = fillMissingCoordinates({
      stations: [{ name: "A", lat: 0, lon: 0 }, { name: "B", lat: 0, lon: 1 }, { name: "C" }],
      lines: [{ name: "L", route: ["A", "B", "C"] }],
    });
    expect(filled[2]!.lat).toBeCloseTo(0);
    expect(filled[2]!.lon).toBeCloseTo(2);
  });

  it("extends using the spacing between known stations that are not adjacent", () => {
    const filled = fillMissingCoordinates({
      stations: [{ name: "A", lat: 0, lon: 0 }, { name: "B" }, { name: "C", lat: 0, lon: 2 }, { name: "D" }],
      lines: [{ name: "L", route: ["A", "B", "C", "D"] }],
    });
    expect(filled[3]!.lat).toBeCloseTo(0);
    expect(filled[3]!.lon).toBeCloseTo(3);
  });

  it("leaves stations no line can place without coordinates", () => {
    const filled = fillMissingCoordinates({ stations: [{ name: "A" }], lines: [] });
    expect(filled[0]!.lat).toBeUndefined();
  });
});
