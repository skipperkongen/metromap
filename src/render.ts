import type { MetroMap, Point } from "./types.js";

export interface RenderOptions {
  /** Stroke width of a line. Default 6. */
  lineWidth?: number;
  /** Radius of a stop dot. Default 3.2. */
  stopRadius?: number;
  /** Corner radius where a line bends. Default 14. */
  cornerRadius?: number;
  fontSize?: number;
  fontFamily?: string;
  background?: string;
  /** Color for station outlines and labels. */
  ink?: string;
  /** Draw a legend of line names below the map. Default true. */
  legend?: boolean;
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Render a metro map as a standalone SVG string. */
export function renderSvg(map: MetroMap, options: RenderOptions = {}): string {
  const lineWidth = options.lineWidth ?? 6;
  const stopRadius = options.stopRadius ?? 3.2;
  const cornerRadius = options.cornerRadius ?? 14;
  const fontSize = options.fontSize ?? 12;
  const fontFamily = options.fontFamily ?? "'Helvetica Neue', Helvetica, Arial, sans-serif";
  const background = options.background ?? "#ffffff";
  const ink = options.ink ?? "#1d1d1f";
  const showLegend = options.legend ?? true;

  const out: string[] = [];

  // Lines, drawn as one continuous rounded path per line.
  const lineSegments: [Point, Point][] = [];
  for (const line of map.lines) {
    const pts: Point[] = [];
    for (const seg of line.segments) {
      for (const p of seg.points) {
        const last = pts[pts.length - 1];
        if (!last || Math.hypot(last.x - p.x, last.y - p.y) > 0.01) pts.push(p);
      }
    }
    for (let i = 1; i < pts.length; i++) lineSegments.push([pts[i - 1]!, pts[i]!]);
    if (pts.length < 2) continue;
    out.push(
      `<path d="${roundedPath(pts, cornerRadius)}" fill="none" stroke="${esc(line.color)}" stroke-width="${lineWidth}" stroke-linecap="round" stroke-linejoin="round"/>`,
    );
  }

  // Stops: a dot on every line that stops; a connector when several lines stop.
  const stopsByStation = new Map<string, Point[]>();
  for (const line of map.lines) {
    for (const s of line.stations) {
      if (!s.stop) continue;
      const list = stopsByStation.get(s.station) ?? [];
      if (!list.some((p) => Math.hypot(p.x - s.x, p.y - s.y) < 0.5)) list.push({ x: s.x, y: s.y });
      stopsByStation.set(s.station, list);
    }
  }
  for (const [, dots] of stopsByStation) {
    if (dots.length > 1) {
      const chain = orderAlongAxis(dots);
      const d = chain.map((p, i) => `${i === 0 ? "M" : "L"}${fmt(p.x)} ${fmt(p.y)}`).join(" ");
      out.push(`<path d="${d}" fill="none" stroke="${ink}" stroke-width="${2 * stopRadius + 5}" stroke-linecap="round" stroke-linejoin="round"/>`);
      out.push(`<path d="${d}" fill="none" stroke="#fff" stroke-width="${2 * stopRadius + 2}" stroke-linecap="round" stroke-linejoin="round"/>`);
    }
    for (const p of dots) {
      out.push(`<circle cx="${fmt(p.x)}" cy="${fmt(p.y)}" r="${stopRadius}" fill="#fff" stroke="${ink}" stroke-width="1.6"/>`);
    }
  }

  // Stations every line passes without stopping: a small gap in the line, so the station is still visible.
  for (const station of map.stations) {
    if (stopsByStation.has(station.name)) continue;
    for (const line of map.lines) {
      for (const s of line.stations) {
        if (s.station !== station.name) continue;
        out.push(`<circle cx="${fmt(s.x)}" cy="${fmt(s.y)}" r="${fmt(lineWidth * 0.3)}" fill="${background}"/>`);
      }
    }
  }

  // Labels, placed greedily where they collide least with lines and other labels.
  const placed: Box[] = [];
  // Every place a line meets a station, stopping or not.
  const dotBoxes: Box[] = map.lines.flatMap((l) =>
    l.stations.map((p) => ({ x: p.x - stopRadius, y: p.y - stopRadius, w: 2 * stopRadius, h: 2 * stopRadius })),
  );
  const linesAt = (name: string) => map.lines.filter((l) => l.stations.some((s) => s.station === name)).length;
  const order = [...map.stations].sort((a, b) => linesAt(b.name) - linesAt(a.name));
  const labels: string[] = [];
  for (const station of order) {
    const dots = stopsByStation.get(station.name) ?? [];
    const lanePts = map.lines.flatMap((l) => l.stations.filter((s) => s.station === station.name));
    const spread = Math.max(0, ...lanePts.map((p) => Math.hypot(p.x - station.x, p.y - station.y)));
    const gap = spread + stopRadius + 5;
    const w = textWidth(station.name, fontSize);
    const h = fontSize * 1.2;

    let best: { box: Box; anchor: string; tx: number; ty: number } | null = null;
    let bestScore = Infinity;
    LABEL_SPOTS.forEach(([dx, dy, preference]) => {
      const ax = station.x + dx * gap;
      const ay = station.y + dy * gap;
      const x = dx > 0 ? ax : dx < 0 ? ax - w : ax - w / 2;
      const y = dy > 0 ? ay : dy < 0 ? ay - h : ay - h / 2;
      const box = { x, y, w, h };
      let score = preference;
      for (const [p, q] of lineSegments) if (segmentHitsBox(p, q, inflate(box, 2))) score += 8;
      for (const other of placed) score += overlapArea(box, other) * 0.5 + (overlapArea(box, other) > 0 ? 30 : 0);
      for (const dot of dotBoxes) if (overlapArea(box, dot) > 0) score += 20;
      // A label should sit closer to its own station than to any other.
      const own = distanceToBox(station, box);
      for (const other of map.stations) {
        if (other !== station && distanceToBox(other, box) < own + 2) score += 40;
      }
      if (box.x < 0 || box.y < 0 || box.x + box.w > map.width || box.y + box.h > map.height) score += 10;
      if (score < bestScore) {
        bestScore = score;
        const anchor = dx > 0 ? "start" : dx < 0 ? "end" : "middle";
        best = { box, anchor, tx: dx > 0 ? x : dx < 0 ? x + w : x + w / 2, ty: y + h * 0.78 };
      }
    });
    const chosen = best as { box: Box; anchor: string; tx: number; ty: number } | null;
    if (!chosen) continue;
    placed.push(chosen.box);
    const muted = dots.length === 0 ? ` fill-opacity="0.55" font-style="italic"` : "";
    labels.push(
      `<text x="${fmt(chosen.tx)}" y="${fmt(chosen.ty)}" text-anchor="${chosen.anchor}"${muted}>${esc(station.name)}</text>`,
    );
  }
  out.push(
    `<g font-family="${esc(fontFamily)}" font-size="${fontSize}" fill="${ink}" paint-order="stroke" stroke="${background}" stroke-width="3" stroke-linejoin="round">${labels.join("")}</g>`,
  );

  // Legend.
  let height = map.height;
  if (showLegend && map.lines.length > 0) {
    const rowH = 22;
    let x = 24;
    let y = map.height + 4;
    const items: string[] = [];
    for (const line of map.lines) {
      const w = 34 + textWidth(line.name, fontSize) + 24;
      if (x + w > map.width - 16 && x > 24) {
        x = 24;
        y += rowH;
      }
      items.push(
        `<line x1="${x}" y1="${y}" x2="${x + 26}" y2="${y}" stroke="${esc(line.color)}" stroke-width="${lineWidth}" stroke-linecap="round"/>`,
        `<text x="${x + 34}" y="${y + fontSize * 0.35}" font-family="${esc(fontFamily)}" font-size="${fontSize}" fill="${ink}">${esc(line.name)}</text>`,
      );
      x += w;
    }
    out.push(`<g>${items.join("")}</g>`);
    height = y + rowH;
  }

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${fmt(map.width)} ${fmt(height)}" width="${fmt(map.width)}" height="${fmt(height)}">`,
    `<rect width="100%" height="100%" fill="${background}"/>`,
    ...out,
    `</svg>`,
  ].join("\n");
}

// [dx, dy, preference]: right and left read best, diagonals last.
const LABEL_SPOTS: [number, number, number][] = [
  [1, 0, 0],
  [-1, 0, 0.5],
  [0, -1, 1.5],
  [0, 1, 1.5],
  [0.75, -0.75, 1],
  [0.75, 0.75, 1],
  [-0.75, -0.75, 1.5],
  [-0.75, 0.75, 1.5],
];

/** SVG path through the points with each corner rounded off. */
function roundedPath(pts: Point[], radius: number): string {
  let d = `M${fmt(pts[0]!.x)} ${fmt(pts[0]!.y)}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const prev = pts[i - 1]!;
    const cur = pts[i]!;
    const next = pts[i + 1]!;
    const l1 = Math.hypot(cur.x - prev.x, cur.y - prev.y);
    const l2 = Math.hypot(next.x - cur.x, next.y - cur.y);
    const r = Math.min(radius, l1 / 2, l2 / 2);
    if (r < 0.5) {
      d += ` L${fmt(cur.x)} ${fmt(cur.y)}`;
      continue;
    }
    const a = { x: cur.x - ((cur.x - prev.x) / l1) * r, y: cur.y - ((cur.y - prev.y) / l1) * r };
    const b = { x: cur.x + ((next.x - cur.x) / l2) * r, y: cur.y + ((next.y - cur.y) / l2) * r };
    d += ` L${fmt(a.x)} ${fmt(a.y)} Q${fmt(cur.x)} ${fmt(cur.y)} ${fmt(b.x)} ${fmt(b.y)}`;
  }
  const last = pts[pts.length - 1]!;
  return `${d} L${fmt(last.x)} ${fmt(last.y)}`;
}

/** Order points along their main axis so a connector runs through them without zig-zagging. */
function orderAlongAxis(points: Point[]): Point[] {
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const spanX = Math.max(...xs) - Math.min(...xs);
  const spanY = Math.max(...ys) - Math.min(...ys);
  return [...points].sort((a, b) => (spanX >= spanY ? a.x - b.x || a.y - b.y : a.y - b.y || a.x - b.x));
}

function textWidth(text: string, fontSize: number): number {
  return text.length * fontSize * 0.56;
}

function distanceToBox(p: Point, b: Box): number {
  const dx = Math.max(b.x - p.x, 0, p.x - (b.x + b.w));
  const dy = Math.max(b.y - p.y, 0, p.y - (b.y + b.h));
  return Math.hypot(dx, dy);
}

function inflate(b: Box, m: number): Box {
  return { x: b.x - m, y: b.y - m, w: b.w + 2 * m, h: b.h + 2 * m };
}

function overlapArea(a: Box, b: Box): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

/** Liang–Barsky clip test: does segment pq pass through the box? */
function segmentHitsBox(p: Point, q: Point, b: Box): boolean {
  let t0 = 0;
  let t1 = 1;
  const dx = q.x - p.x;
  const dy = q.y - p.y;
  const checks: [number, number][] = [
    [-dx, p.x - b.x],
    [dx, b.x + b.w - p.x],
    [-dy, p.y - b.y],
    [dy, b.y + b.h - p.y],
  ];
  for (const [pk, qk] of checks) {
    if (pk === 0) {
      if (qk < 0) return false;
    } else {
      const t = qk / pk;
      if (pk < 0) t0 = Math.max(t0, t);
      else t1 = Math.min(t1, t);
      if (t0 > t1) return false;
    }
  }
  return true;
}

function fmt(n: number): string {
  return String(Math.round(n * 10) / 10);
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
