import type { MetroMap, Point } from "./types.js";

export interface RenderOptions {
  /** Stroke width of a line. Default 6. */
  lineWidth?: number;
  /** Radius of a station dot on a single line; interchange dots are larger. Default 3.2. */
  stationRadius?: number;
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
  const stationRadius = options.stationRadius ?? 3.2;
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

  // Stations: one dot each. Where several lines call, the dot grows to cover all their lanes.
  const lanePoints = new Map<string, Point[]>();
  const linesAt = new Map<string, Set<string>>();
  for (const line of map.lines) {
    for (const seg of line.segments) {
      const ends: [string, Point][] = [
        [seg.from, seg.points[0]!],
        [seg.to, seg.points[seg.points.length - 1]!],
      ];
      for (const [name, p] of ends) {
        lanePoints.set(name, [...(lanePoints.get(name) ?? []), p]);
        linesAt.set(name, (linesAt.get(name) ?? new Set()).add(line.name));
      }
    }
  }
  const dots = new Map<string, number>(); // station name → dot radius
  for (const station of map.stations) {
    const lines = linesAt.get(station.name)?.size ?? 0;
    const spread = Math.max(0, ...(lanePoints.get(station.name) ?? []).map((p) => Math.hypot(p.x - station.x, p.y - station.y)));
    const r = lines > 1 ? Math.max(stationRadius * 1.6, spread + lineWidth / 2 + 1) : stationRadius;
    dots.set(station.name, r);
    out.push(
      `<circle cx="${fmt(station.x)}" cy="${fmt(station.y)}" r="${fmt(r)}" fill="#fff" stroke="${ink}" stroke-width="${lines > 1 ? 2 : 1.6}"/>`,
    );
  }

  // Labels, placed greedily where they collide least with lines and other labels.
  const placed: Box[] = [];
  const dotBoxes: Box[] = map.stations.map((st) => {
    const r = dots.get(st.name)!;
    return { x: st.x - r, y: st.y - r, w: 2 * r, h: 2 * r };
  });
  const order = [...map.stations].sort((a, b) => (linesAt.get(b.name)?.size ?? 0) - (linesAt.get(a.name)?.size ?? 0));
  const labels: string[] = [];
  for (const station of order) {
    const gap = dots.get(station.name)! + 5;
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
    labels.push(
      `<text x="${fmt(chosen.tx)}" y="${fmt(chosen.ty)}" text-anchor="${chosen.anchor}">${esc(station.name)}</text>`,
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
