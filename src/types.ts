// ---------- Input ----------

export interface Station {
  /** Unique station name. Lines refer to stations by this name. */
  name: string;
  lat?: number;
  lon?: number;
}

export interface Line {
  name: string;
  /** CSS color. A palette color is assigned when omitted. */
  color?: string;
  /**
   * Names of the stations the line calls at, in travel order. Each consecutive
   * pair is one segment. Repeat the first station at the end to make a loop.
   */
  route: string[];
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
}

export interface MetroMap {
  width: number;
  height: number;
  stations: MapStation[];
  lines: MapLine[];
}
