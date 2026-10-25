// ---------- Input ----------

export interface Station {
  /** Unique station name. Lines refer to stations by this name. */
  name: string;
  lat?: number;
  lon?: number;
}

/** A station on a line's route. A plain string is shorthand for `{ station, stop: true }`. */
export type RouteEntry = string | { station: string; stop?: boolean };

export interface Line {
  name: string;
  /** CSS color. A palette color is assigned when omitted. */
  color?: string;
  /**
   * Stations in travel order. Each consecutive pair is one segment.
   * Repeat the first station at the end to make a loop.
   * Use `{ station, stop: false }` for stations the line passes without stopping.
   */
  route: RouteEntry[];
}

export interface Network {
  stations: Station[];
  lines: Line[];
}

// ---------- Output ----------

export interface Point {
  x: number;
  y: number;
}

export interface MapStation {
  name: string;
  /** Station center in canvas coordinates. */
  x: number;
  y: number;
}

/** Where a line crosses a station, offset to the line's own lane. */
export interface MapLineStation {
  station: string;
  x: number;
  y: number;
  stop: boolean;
}

/** The drawn path between two consecutive stations, in travel direction. */
export interface MapSegment {
  from: string;
  to: string;
  points: Point[];
}

export interface MapLine {
  name: string;
  color: string;
  segments: MapSegment[];
  /** Every station on the route, in travel order (a loop's start is listed once). */
  stations: MapLineStation[];
}

export interface MetroMap {
  width: number;
  height: number;
  stations: MapStation[];
  lines: MapLine[];
}
