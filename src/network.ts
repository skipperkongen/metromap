import type { Line, Network, Station } from "./types.js";

export const PALETTE = [
  "#e5332a", // red
  "#0072bc", // blue
  "#00a651", // green
  "#f7a600", // amber
  "#8e44ad", // purple
  "#00a5c8", // cyan
  "#e2007a", // magenta
  "#8b5a2b", // brown
  "#7f8c8d", // grey
  "#2c3e50", // navy
];

export interface NormalizedLine {
  name: string;
  color: string;
  /** Route as written, including the repeated first station of a loop. */
  route: string[];
}

/** Resolve defaults and check that the network is consistent. Throws on invalid input. */
export function normalizeLines(network: Network): NormalizedLine[] {
  const names = new Set<string>();
  for (const s of network.stations) {
    if (names.has(s.name)) throw new Error(`Duplicate station name "${s.name}"`);
    names.add(s.name);
  }
  return network.lines.map((line: Line, i) => {
    const route = [...line.route];
    for (const station of route) {
      if (!names.has(station)) {
        throw new Error(`Line "${line.name}" refers to unknown station "${station}"`);
      }
    }
    for (let k = 1; k < route.length; k++) {
      if (route[k] === route[k - 1]) {
        throw new Error(`Line "${line.name}" visits "${route[k]}" twice in a row`);
      }
    }
    return { name: line.name, color: line.color ?? PALETTE[i % PALETTE.length]!, route };
  });
}

export function hasCoordinates(s: Station): s is Station & { lat: number; lon: number } {
  return typeof s.lat === "number" && typeof s.lon === "number";
}

/**
 * Returns a copy of the stations where every station has lat/lon.
 * Missing coordinates are interpolated along the lines between the nearest
 * stations that have them. Stations no line can place keep no coordinates.
 */
export function fillMissingCoordinates(network: Network): Station[] {
  const known = new Map<string, { lat: number; lon: number }>();
  for (const s of network.stations) if (hasCoordinates(s)) known.set(s.name, { lat: s.lat, lon: s.lon });

  const estimates = new Map<string, { lat: number; lon: number; n: number }>();
  const addEstimate = (name: string, lat: number, lon: number) => {
    const e = estimates.get(name) ?? { lat: 0, lon: 0, n: 0 };
    e.lat += lat;
    e.lon += lon;
    e.n += 1;
    estimates.set(name, e);
  };

  for (const line of network.lines) {
    const route = line.route;
    const anchors = route.flatMap((name, i) => (known.has(name) ? [i] : []));
    if (anchors.length === 0) continue;
    // A typical spacing, used to extend past the last known station.
    const step = averageStep(route, known);

    for (let i = 0; i < route.length; i++) {
      const name = route[i]!;
      if (known.has(name)) continue;
      const before = anchors.filter((a) => a < i).pop();
      const after = anchors.find((a) => a > i);
      if (before !== undefined && after !== undefined) {
        const a = known.get(route[before]!)!;
        const b = known.get(route[after]!)!;
        const t = (i - before) / (after - before);
        addEstimate(name, a.lat + (b.lat - a.lat) * t, a.lon + (b.lon - a.lon) * t);
      } else {
        // Extend straight out from the end of the known part of the route.
        const end = before ?? after!;
        const towards = anchors.length > 1 ? (before !== undefined ? anchors[anchors.length - 2]! : anchors[1]!) : end;
        const a = known.get(route[end]!)!;
        const b = known.get(route[towards]!)!;
        const len = Math.hypot(a.lat - b.lat, a.lon - b.lon);
        const dir = len > 0 ? { lat: (a.lat - b.lat) / len, lon: (a.lon - b.lon) / len } : { lat: 0, lon: 1 };
        const k = Math.abs(i - end);
        addEstimate(name, a.lat + dir.lat * step * k, a.lon + dir.lon * step * k);
      }
    }
  }

  return network.stations.map((s) => {
    if (hasCoordinates(s)) return { ...s };
    const e = estimates.get(s.name);
    return e ? { ...s, lat: e.lat / e.n, lon: e.lon / e.n } : { ...s };
  });
}

/** Average distance per route step between known stations, also across unknown ones in between. */
function averageStep(route: string[], known: Map<string, { lat: number; lon: number }>): number {
  let total = 0;
  let steps = 0;
  let prev = -1;
  for (let i = 0; i < route.length; i++) {
    const b = known.get(route[i]!);
    if (!b) continue;
    if (prev >= 0) {
      const a = known.get(route[prev]!)!;
      total += Math.hypot(a.lat - b.lat, a.lon - b.lon);
      steps += i - prev;
    }
    prev = i;
  }
  return steps > 0 ? total / steps : 0.01;
}
