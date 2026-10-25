// Generates the illustrations in docs/images/ by running the real layout code.
// Run with `npm run docs:figures` (builds the library first).

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { computeStages, octilinearTarget } from "../dist/algorithms/relax-refine.js";
import { layout } from "../dist/layout.js";
import { offsetPolyline, routeEdge, snapToFreeCells } from "../dist/pipeline.js";
import { fillMissingCoordinates } from "../dist/network.js";
import { renderSvg } from "../dist/render.js";
import { copenhagenMetro } from "../dist/samples/copenhagen.js";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "docs", "images");
mkdirSync(OUT, { recursive: true });

// ---------- Style ----------

const C = {
  bg: "#ffffff",
  ink: "#1d1d1f",
  muted: "#8a8a8f",
  faint: "#c9c9cc",
  grid: "#e8e8e5",
  accent: "#e5332a",
  blue: "#0072bc",
  green: "#00a651",
  amber: "#f7a600",
  purple: "#8e44ad",
};
const FONT = "-apple-system, 'Segoe UI', Helvetica, Arial, sans-serif";

function svg(w, h, body) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" font-family="${FONT}" font-size="13">
<defs>
  <marker id="arrow" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="context-stroke"/></marker>
</defs>
<rect width="${w}" height="${h}" rx="12" fill="${C.bg}"/>
${body}
</svg>
`;
}

const f = (n) => String(Math.round(n * 10) / 10);
const text = (x, y, s, o = {}) =>
  `<text x="${f(x)}" y="${f(y)}" fill="${o.fill ?? C.ink}" font-size="${o.size ?? 13}" text-anchor="${o.anchor ?? "start"}"${o.weight ? ` font-weight="${o.weight}"` : ""}${o.italic ? ` font-style="italic"` : ""}>${s}</text>`;
const line = (a, b, o = {}) =>
  `<line x1="${f(a.x)}" y1="${f(a.y)}" x2="${f(b.x)}" y2="${f(b.y)}" stroke="${o.stroke ?? C.ink}" stroke-width="${o.width ?? 2}" stroke-linecap="round"${o.dash ? ` stroke-dasharray="${o.dash}"` : ""}${o.arrow ? ` marker-end="url(#arrow)"` : ""}${o.opacity ? ` opacity="${o.opacity}"` : ""}/>`;
const dot = (p, o = {}) =>
  `<circle cx="${f(p.x)}" cy="${f(p.y)}" r="${o.r ?? 4.5}" fill="${o.fill ?? "#fff"}" stroke="${o.stroke ?? C.ink}" stroke-width="${o.width ?? 1.8}"${o.dash ? ` stroke-dasharray="${o.dash}"` : ""}/>`;
const poly = (pts, o = {}) =>
  `<polyline points="${pts.map((p) => `${f(p.x)},${f(p.y)}`).join(" ")}" fill="none" stroke="${o.stroke ?? C.ink}" stroke-width="${o.width ?? 2}" stroke-linecap="round" stroke-linejoin="${o.join ?? "round"}"${o.dash ? ` stroke-dasharray="${o.dash}"` : ""}${o.opacity ? ` opacity="${o.opacity}"` : ""}/>`;

/** Map world points into a box, keeping aspect ratio. */
function fitter(points, box, pad = 16) {
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const spanX = Math.max(...xs) - minX || 1;
  const spanY = Math.max(...ys) - minY || 1;
  const k = Math.min((box.w - 2 * pad) / spanX, (box.h - 2 * pad) / spanY);
  const ox = box.x + (box.w - spanX * k) / 2;
  const oy = box.y + (box.h - spanY * k) / 2;
  const fn = (p) => ({ x: ox + (p.x - minX) * k, y: oy + (p.y - minY) * k });
  fn.k = k;
  fn.min = { x: minX, y: minY };
  fn.max = { x: minX + spanX, y: minY + spanY };
  return fn;
}

/** Draw a network at given positions: each edge in the color of the first line using it. */
function drawNetwork(stages, positions, box, o = {}) {
  const map = fitter(positions, box, o.pad ?? 18);
  const out = [];
  if (o.grid) {
    for (let gx = Math.ceil(map.min.x); gx <= map.max.x; gx++) {
      for (let gy = Math.ceil(map.min.y); gy <= map.max.y; gy++) out.push(dot(map({ x: gx, y: gy }), { r: 1.2, fill: C.faint, stroke: "none" }));
    }
  }
  for (const e of stages.prepared.edges) {
    const color = stages.prepared.lines[e.lines[0]].color;
    const pts = o.paths ? o.paths[stages.prepared.edges.indexOf(e)].map(map) : [map(positions[e.a]), map(positions[e.b])];
    out.push(poly(pts, { stroke: color, width: o.lineWidth ?? 3 }));
  }
  positions.forEach((p, i) => {
    const highlight = o.highlight?.has(i);
    out.push(dot(map(p), { r: highlight ? 4 : 2.6, width: highlight ? 2 : 1.2, stroke: highlight ? C.accent : C.ink }));
  });
  return out.join("\n");
}

function panelTitle(box, title, subtitle) {
  return text(box.x + 4, box.y + 16, title, { weight: 600 }) + (subtitle ? text(box.x + 4, box.y + 33, subtitle, { fill: C.muted, size: 12 }) : "");
}

function write(name, content) {
  writeFileSync(join(OUT, name), content);
  console.log("wrote", join("docs/images", name));
}

const cph = copenhagenMetro();
const keep = new Set([0, 15, 60, 600]);
const snapshots = new Map();
const stages = computeStages(cph, 3, (it, pos) => {
  if (keep.has(it)) snapshots.set(it, pos);
});

/** Mean angle (degrees) between each edge and its nearest 0°/45°/90° direction. */
function meanAngleError(edges, pos) {
  let total = 0;
  for (const e of edges) {
    const deg = (Math.atan2(pos[e.b].y - pos[e.a].y, pos[e.b].x - pos[e.a].x) * 180) / Math.PI;
    const off = ((deg % 45) + 45) % 45;
    total += Math.min(off, 45 - off);
  }
  return total / edges.length;
}
// The layout is deterministic, so a second run can measure convergence now that the edges are known.
const angleError = [];
computeStages(cph, 3, (_it, pos) => angleError.push(meanAngleError(stages.prepared.edges, pos)));
const snappedError = meanAngleError(stages.prepared.edges, stages.snapped);
const geoPositions = stages.geo.map((p) => p ?? { x: 0, y: 0 });

// ---------- 1. Pipeline overview ----------
{
  const W = 1000;
  const H = 330;
  const boxes = [0, 1, 2, 3].map((i) => ({ x: 16 + i * 246, y: 14, w: 230, h: 300 }));
  const titles = [
    ["1. Geography", "projected lat/lon"],
    ["2. Relaxed", "pulled toward 0°/45°/90°"],
    ["3. On the grid", "snapped + local search"],
    ["4. Metro map", "routed, lanes, labels"],
  ];
  const body = [];
  const inner = (b) => ({ x: b.x, y: b.y + 40, w: b.w, h: b.h - 40 });
  body.push(drawNetwork(stages, geoPositions, inner(boxes[0])));
  body.push(drawNetwork(stages, stages.relaxed, inner(boxes[1])));
  body.push(drawNetwork(stages, stages.grid, inner(boxes[2]), { grid: true, paths: stages.paths }));
  const map = layout(cph);
  const finalSvg = renderSvg(map, { legend: false }).replace(/<svg [^>]*>/, "").replace("</svg>", "");
  const ib = inner(boxes[3]);
  const k = Math.min(ib.w / map.width, ib.h / map.height);
  body.push(
    `<g transform="translate(${f(ib.x + (ib.w - map.width * k) / 2)} ${f(ib.y + (ib.h - map.height * k) / 2)}) scale(${k.toFixed(4)})">${finalSvg}</g>`,
  );
  boxes.forEach((b, i) => {
    body.push(panelTitle(b, ...titles[i]));
    if (i < 3) body.push(line({ x: b.x + b.w + 2, y: 190 }, { x: b.x + b.w + 14, y: 190 }, { stroke: C.muted, width: 1.5, arrow: true }));
  });
  write("pipeline.svg", svg(W, H, body.join("\n")));
}

// ---------- 2. Missing coordinates ----------
{
  const net = {
    stations: [
      { name: "A", lat: 0, lon: 0 },
      { name: "B" },
      { name: "C" },
      { name: "D", lat: 1, lon: 3 },
      { name: "E" },
    ],
    lines: [{ name: "L", route: ["A", "B", "C", "D", "E"] }],
  };
  const filled = fillMissingCoordinates(net);
  const pts = filled.map((s) => ({ x: s.lon, y: -s.lat }));
  const map = fitter(pts, { x: 30, y: 30, w: 640, h: 170 }, 30);
  const P = pts.map(map);
  const body = [poly(P.slice(0, 4), { stroke: C.blue, width: 3 }), poly(P.slice(3), { stroke: C.blue, width: 3, dash: "6 6" })];
  filled.forEach((s, i) => {
    const known = net.stations[i].lat !== undefined;
    body.push(dot(P[i], { r: 7, fill: known ? C.ink : "#fff", stroke: known ? C.ink : C.accent, dash: known ? undefined : "3 2" }));
    body.push(text(P[i].x, P[i].y - 16, s.name, { anchor: "middle", weight: 600 }));
  });
  body.push(text(P[1].x, P[1].y + 26, "t = 1/3", { anchor: "middle", fill: C.accent, size: 12 }));
  body.push(text(P[2].x, P[2].y + 26, "t = 2/3", { anchor: "middle", fill: C.accent, size: 12 }));
  body.push(text(P[4].x, P[4].y + 26, "extended by the line's", { anchor: "middle", fill: C.accent, size: 12 }));
  body.push(text(P[4].x, P[4].y + 41, "average spacing", { anchor: "middle", fill: C.accent, size: 12 }));
  body.push(dot({ x: 40, y: 232 }, { r: 6, fill: C.ink }), text(54, 237, "has lat/lon", { fill: C.muted, size: 12 }));
  body.push(dot({ x: 150, y: 232 }, { r: 6, stroke: C.accent, dash: "3 2" }), text(164, 237, "estimated", { fill: C.muted, size: 12 }));
  write("missing-coordinates.svg", svg(700, 252, body.join("\n")));
}

// ---------- 3. Octilinear target ----------
{
  const panel = (ox, d, title) => {
    const S = 56; // pixels per grid step
    const o = { x: ox + 50, y: 220 };
    const at = (p) => ({ x: o.x + p.x * S, y: o.y + p.y * S });
    const out = [];
    for (let gx = 0; gx <= 3; gx++) for (let gy = -3; gy <= 0; gy++) out.push(dot(at({ x: gx, y: gy }), { r: 1.6, fill: C.faint, stroke: "none" }));
    // The 8 directions and the sector boundaries at ±22.5°.
    for (let k = 0; k < 8; k++) {
      const a = (k * Math.PI) / 4;
      out.push(line(o, { x: o.x + Math.cos(a) * 40, y: o.y + Math.sin(a) * 40 }, { stroke: C.faint, width: 1.5 }));
      const b = a + Math.PI / 8;
      out.push(line(o, { x: o.x + Math.cos(b) * 190, y: o.y + Math.sin(b) * 190 }, { stroke: C.grid, width: 1, dash: "3 4" }));
    }
    const t = octilinearTarget(d, 3);
    out.push(line(at(t), at(d), { stroke: C.muted, width: 1.5, dash: "4 3" }));
    out.push(line(o, at(d), { stroke: C.ink, width: 2.5, arrow: true }));
    out.push(line(o, at(t), { stroke: C.accent, width: 3, arrow: true }));
    out.push(dot(o, { r: 5, fill: C.ink }));
    out.push(text(at(d).x + 8, at(d).y - 6, `d = (${d.x}, ${-d.y})`, { size: 12 }));
    out.push(text(at(t).x + 8, at(t).y + 18, `target = (${t.x}, ${-t.y})`, { fill: C.accent, size: 12, weight: 600 }));
    out.push(text(ox + 20, 30, title, { weight: 600 }));
    return out.join("\n");
  };
  const body = [
    panel(0, { x: 2.3, y: -0.8 }, "Nearly horizontal → horizontal, 2 steps"),
    panel(340, { x: 1.4, y: -2.1 }, "Nearly diagonal → diagonal, 2 steps"),
    text(20, 290, "dashed rays: sector boundaries at ±22.5°  ·  grey dashes: the error the relaxation removes", { fill: C.muted, size: 12 }),
  ];
  write("octilinear-target.svg", svg(680, 305, body.join("\n")));
}

// ---------- 4. Forces ----------
{
  const body = [];
  const W = 220;
  const titles = ["Edge pull", "Station repulsion", "Edge clearance", "Geographic anchor"];
  const subs = ["toward the octilinear target", "if closer than 1 step", "if closer than ½ step", "weight 0.3, fading to 0"];
  titles.forEach((t, i) => {
    body.push(text(20 + i * W, 28, t, { weight: 600 }), text(20 + i * W, 45, subs[i], { fill: C.muted, size: 12 }));
  });
  // Edge pull: u→v off-angle; target shown as ghost; both ends move half the error.
  {
    const u = { x: 50, y: 150 };
    const v = { x: 175, y: 110 };
    // Both ends move half the error, so they meet the target halfway.
    body.push(line({ x: 50, y: 130 }, { x: 175, y: 130 }, { stroke: C.accent, width: 2, dash: "5 4" }));
    body.push(line(u, v, { stroke: C.blue, width: 3 }));
    body.push(line(u, { x: 50, y: 130 }, { stroke: C.ink, width: 2, arrow: true }));
    body.push(line(v, { x: 175, y: 130 }, { stroke: C.ink, width: 2, arrow: true }));
    body.push(dot(u), dot(v));
    body.push(text(u.x - 10, u.y + 24, "u", { weight: 600 }), text(v.x + 8, v.y - 6, "v", { weight: 600 }));
    body.push(text(60, 190, "each end moves half the error", { fill: C.muted, size: 12 }));
  }
  // Repulsion.
  {
    const a = { x: W + 85, y: 130 };
    const b = { x: W + 120, y: 130 };
    body.push(`<circle cx="${a.x}" cy="${a.y}" r="60" fill="none" stroke="${C.faint}" stroke-dasharray="4 4"/>`);
    body.push(line(a, { x: a.x - 35, y: a.y }, { arrow: true }), line(b, { x: b.x + 35, y: b.y }, { arrow: true }));
    body.push(dot(a), dot(b));
    body.push(text(a.x, a.y + 85, "radius = 1 step", { fill: C.muted, size: 12, anchor: "middle" }));
  }
  // Edge clearance.
  {
    const a = { x: 2 * W + 25, y: 150 };
    const b = { x: 2 * W + 195, y: 150 };
    const s = { x: 2 * W + 110, y: 138 };
    body.push(line(a, b, { stroke: C.green, width: 3 }));
    body.push(line(s, { x: s.x, y: s.y - 32 }, { arrow: true }));
    body.push(line(a, { x: a.x, y: a.y + 18 }, { arrow: true }), line(b, { x: b.x, y: b.y + 18 }, { arrow: true }));
    body.push(dot(a), dot(b), dot(s, { stroke: C.accent }));
    body.push(text(s.x + 10, s.y - 14, "s", { weight: 600 }));
    body.push(text(2 * W + 20, 200, "s moves off; the edge moves back", { fill: C.muted, size: 12 }));
  }
  // Anchor.
  {
    const g = { x: 3 * W + 60, y: 160 };
    const p = { x: 3 * W + 150, y: 105 };
    body.push(dot(g, { r: 6, stroke: C.muted, dash: "3 2" }));
    body.push(line(p, { x: p.x - 40, y: p.y + 24 }, { arrow: true }));
    body.push(dot(p));
    body.push(text(g.x - 6, g.y + 26, "real position", { fill: C.muted, size: 12 }));
    body.push(text(p.x + 10, p.y - 8, "current", { size: 12 }));
  }
  write("forces.svg", svg(4 * W + 10, 220, body.join("\n")));
}

// ---------- 5. Relaxation progress + convergence ----------
{
  const W = 1000;
  const H = 400;
  const body = [];
  [0, 15, 60, 600].forEach((it, i) => {
    const b = { x: 16 + i * 246, y: 14, w: 230, h: 240 };
    body.push(panelTitle(b, `Iteration ${it}`, it === 0 ? "start: geography" : it === 600 ? "end" : ""));
    body.push(drawNetwork(stages, snapshots.get(it), { x: b.x, y: b.y + 36, w: b.w, h: b.h - 36 }));
  });
  // Chart: mean angle error per iteration (22.5° is the worst possible).
  const cx = 70;
  const cy = 290;
  const cw = 880;
  const ch = 80;
  const maxDeg = 22.5;
  body.push(text(16, 278, "Mean angle between an edge and its nearest 0°/45°/90° direction", { weight: 600, size: 12 }));
  body.push(line({ x: cx, y: cy + ch }, { x: cx + cw, y: cy + ch }, { stroke: C.faint, width: 1 }));
  body.push(line({ x: cx, y: cy }, { x: cx + cw, y: cy }, { stroke: C.grid, width: 1 }));
  body.push(text(cx - 8, cy + 4, "22.5°", { anchor: "end", fill: C.muted, size: 11 }));
  body.push(text(cx - 8, cy + ch + 4, "0°", { anchor: "end", fill: C.muted, size: 11 }));
  const n = angleError.length - 1;
  const pts = angleError.map((v, i) => ({ x: cx + (i / n) * cw, y: cy + ch - (v / maxDeg) * ch }));
  body.push(poly(pts, { stroke: C.blue, width: 2 }));
  const last = pts[pts.length - 1];
  body.push(text(pts[0].x + 6, pts[0].y - 4, `${angleError[0].toFixed(1)}°`, { fill: C.blue, size: 11 }));
  body.push(text(last.x - 4, last.y - 6, `${angleError[n].toFixed(1)}° after relaxing → ${snappedError.toFixed(1)}° after grid snapping`, { fill: C.blue, size: 11, anchor: "end" }));
  for (const it of [0, 150, 300, 450, 600]) body.push(text(cx + (it / n) * cw, cy + ch + 16, String(it), { anchor: "middle", fill: C.muted, size: 11 }));
  body.push(text(cx + cw, cy + ch + 30, "iteration", { anchor: "end", fill: C.muted, size: 11 }));
  write("relaxation.svg", svg(W, H + 22, body.join("\n")));
}

// ---------- 6. Grid snapping ----------
{
  // Three relaxed positions; two round to the same cell.
  const relaxed = [
    { x: 1.2, y: 1.15 }, // 3 connections
    { x: 0.8, y: 0.85 }, // 1 connection
    { x: 2.7, y: 1.35 }, // 2 connections
  ];
  const adjacency = [[0, 1, 2], [0], [1, 2]];
  const snapped = snapToFreeCells(relaxed, adjacency);
  const S = 90;
  const at = (p) => ({ x: 60 + p.x * S, y: 20 + p.y * S });
  const body = [];
  for (let gx = 0; gx <= 3; gx++) for (let gy = 0; gy <= 2; gy++) body.push(dot(at({ x: gx, y: gy }), { r: 2, fill: C.faint, stroke: "none" }));
  const labels = ["3 connections", "1 connection", "2 connections"];
  relaxed.forEach((p, i) => {
    body.push(line(at(p), at(snapped[i]), { stroke: C.accent, width: 1.8, arrow: true }));
    body.push(dot(at(p), { r: 5, stroke: C.muted, dash: "3 2" }));
    body.push(dot(at(snapped[i]), { r: 6, fill: C.ink }));
    const lp = at(p);
    body.push(text(lp.x + (i === 1 ? -12 : 12), lp.y + (i === 1 ? -10 : 22), labels[i], { size: 12, anchor: i === 1 ? "end" : "start" }));
  });
  body.push(dot({ x: 440, y: 64 }, { r: 5, stroke: C.muted, dash: "3 2" }), text(454, 68, "relaxed position", { fill: C.muted, size: 12 }));
  body.push(dot({ x: 440, y: 90 }, { r: 6, fill: C.ink }), text(454, 94, "grid cell", { fill: C.muted, size: 12 }));
  body.push(text(440, 130, "Two stations round to the same cell.", { size: 12 }));
  body.push(text(440, 148, "The busier one keeps it; the other", { size: 12 }));
  body.push(text(440, 166, "takes the nearest free cell.", { size: 12 }));
  write("grid-snapping.svg", svg(720, 230, body.join("\n")));
}

// ---------- 7. Local search ----------
{
  // Station S sits between A and B; try S's 8 neighbours and score each with the refine() rules.
  const A = { x: 0, y: 2 };
  const B = { x: 5, y: 0 };
  const S = { x: 2, y: 2 };
  const nonOct = (p, q) => {
    const dx = Math.abs(q.x - p.x);
    const dy = Math.abs(q.y - p.y);
    return !(dx === 0 || dy === 0 || dx === dy);
  };
  const turn = (p, c, q) => {
    const u = { x: c.x - p.x, y: c.y - p.y };
    const v = { x: q.x - c.x, y: q.y - c.y };
    const cos = (u.x * v.x + u.y * v.y) / (Math.hypot(u.x, u.y) * Math.hypot(v.x, v.y) || 1);
    return cos < -0.5 ? 12 : cos < 0.3 ? 3 : cos < 0.99 ? 1 : 0;
  };
  const cost = (c) => (nonOct(A, c) ? 6 : 0) + (nonOct(c, B) ? 6 : 0) + turn(A, c, B);
  const candidates = [S, ...[-1, 0, 1].flatMap((dx) => [-1, 0, 1].map((dy) => ({ x: S.x + dx, y: S.y + dy })))].filter(
    (c, i, all) => all.findIndex((d) => d.x === c.x && d.y === c.y) === i && !(c.x === A.x && c.y === A.y),
  );
  const best = candidates.reduce((m, c) => (cost(c) < cost(m) ? c : m), S);
  const P = 64;
  const at = (p) => ({ x: 50 + p.x * P, y: 50 + p.y * P });
  const body = [];
  for (let gx = 0; gx <= 5; gx++) for (let gy = 0; gy <= 3; gy++) body.push(dot(at({ x: gx, y: gy }), { r: 1.8, fill: C.faint, stroke: "none" }));
  // Before: A–S–B with S–B needing a bend; after: through the best cell.
  body.push(poly([at(A), ...routeEdge(S, B, [A, S, B]).map(at)], { stroke: C.faint, width: 4 }));
  body.push(poly([at(A), at(best), ...routeEdge(best, B, [A, best, B]).slice(1).map(at)], { stroke: C.blue, width: 4 }));
  for (const c of candidates) {
    if (c === S) continue;
    const p = at(c);
    const isBest = c.x === best.x && c.y === best.y;
    body.push(`<rect x="${f(p.x - 13)}" y="${f(p.y - 10)}" width="26" height="20" rx="5" fill="${isBest ? C.accent : "#fff"}" stroke="${isBest ? C.accent : C.faint}"/>`);
    body.push(text(p.x, p.y + 4.5, String(cost(c)), { anchor: "middle", size: 12, fill: isBest ? "#fff" : C.ink, weight: isBest ? 700 : undefined }));
  }
  body.push(dot(at(S), { r: 7, stroke: C.muted, dash: "3 2" }), text(at(S).x - 10, at(S).y + 24, `now: ${cost(S)}`, { size: 12, fill: C.muted }));
  body.push(dot(at(A), { r: 7, fill: C.ink }), text(at(A).x - 4, at(A).y + 26, "A", { weight: 600 }));
  body.push(dot(at(B), { r: 7, fill: C.ink }), text(at(B).x + 12, at(B).y + 5, "B", { weight: 600 }));
  body.push(text(440, 60, "Moving S to a neighbouring cell", { weight: 600 }));
  body.push(text(440, 80, "Numbers: cost if S moved there", { size: 12, fill: C.muted }));
  body.push(text(440, 104, "+6 per edge that needs a bend", { size: 12 }));
  body.push(text(440, 122, "+1 / +3 / +12 for a 45° / 90° / U-turn", { size: 12 }));
  body.push(text(440, 152, "grey: before (S–B needs a bend)", { size: 12, fill: C.muted }));
  body.push(text(440, 170, "blue: after moving to the cheapest cell", { size: 12, fill: C.blue }));
  write("local-search.svg", svg(720, 290, body.join("\n")));
}

// ---------- 8. Edge routing ----------
{
  const a = { x: 0, y: 2 };
  const b = { x: 3, y: 0 };
  const obstacle = { x: 2, y: 0 };
  const chosen = routeEdge(a, b, [a, b, obstacle]);
  const diagFirst = [a, { x: 2, y: 0 }, b];
  const straightFirst = [a, { x: 1, y: 2 }, b];
  const P = 80;
  const at = (p) => ({ x: 60 + p.x * P, y: 40 + p.y * P });
  const body = [];
  for (let gx = 0; gx <= 3; gx++) for (let gy = 0; gy <= 2; gy++) body.push(dot(at({ x: gx, y: gy }), { r: 1.8, fill: C.faint, stroke: "none" }));
  body.push(poly(diagFirst.map(at), { stroke: C.faint, width: 3, dash: "6 5" }));
  body.push(poly(straightFirst.map(at), { stroke: C.faint, width: 3, dash: "6 5" }));
  body.push(poly(chosen.map(at), { stroke: C.green, width: 4 }));
  body.push(dot(at(a), { r: 6, fill: C.ink }), dot(at(b), { r: 6, fill: C.ink }), dot(at(obstacle), { r: 6, stroke: C.accent }));
  body.push(text(at(a).x - 12, at(a).y + 24, "a", { weight: 600 }), text(at(b).x + 12, at(b).y + 5, "b", { weight: 600 }));
  body.push(text(at(obstacle).x, at(obstacle).y - 14, "another station", { anchor: "middle", size: 12, fill: C.accent }));
  body.push(text(330, 60, "a → b is 3 across, 2 up: not octilinear.", { size: 12 }));
  body.push(text(330, 80, "Two one-bend paths exist (dashed):", { size: 12 }));
  body.push(text(330, 98, "diagonal first, or straight first.", { size: 12 }));
  body.push(text(330, 124, "The bend farther from other", { size: 12, fill: C.green }));
  body.push(text(330, 142, "stations wins (solid).", { size: 12, fill: C.green }));
  write("edge-routing.svg", svg(600, 230, body.join("\n")));
}

// ---------- 9. Lanes ----------
{
  const body = [];
  // Panel 1: three lines through a bend, mitered.
  const path = [
    { x: 40, y: 170 },
    { x: 200, y: 170 },
    { x: 300, y: 70 },
  ];
  const lanes = [
    { color: C.green, offset: -9 },
    { color: C.amber, offset: 0 },
    { color: C.accent, offset: 9 },
  ];
  body.push(text(20, 28, "Shared edge: one lane per line", { weight: 600 }));
  body.push(text(20, 45, "offsets (i − (n−1)/2) × laneWidth, mitered at bends", { fill: C.muted, size: 12 }));
  for (const lane of lanes) body.push(poly(offsetPolyline(path, lane.offset), { stroke: lane.color, width: 7, join: "miter" }));
  body.push(poly(path, { stroke: C.ink, width: 1, dash: "3 3" }));
  body.push(line({ x: 60, y: 205 }, { x: 140, y: 205 }, { stroke: C.muted, width: 1.5, arrow: true }));
  body.push(text(150, 209, "reference direction (first line's travel)", { fill: C.muted, size: 12 }));

  // Panel 2: lines split at a station; the lane changes and the dot sits between both ends.
  const ox = 400;
  const st = { x: ox + 150, y: 140 };
  const w = 9;
  // The line that turns off takes the lane on the side it turns to, so the lines don't cross.
  const inA = offsetPolyline([{ x: ox + 20, y: 140 }, st], w / 2);
  const inB = offsetPolyline([{ x: ox + 20, y: 140 }, st], -w / 2);
  const outA = offsetPolyline([st, { x: ox + 270, y: 140 }], 0);
  const outB = offsetPolyline([st, { x: ox + 250, y: 240 }], 0);
  body.push(text(ox + 10, 28, "Lines split at a station", { weight: 600 }));
  body.push(text(ox + 10, 45, "one station dot, sized to cover every lane", { fill: C.muted, size: 12 }));
  body.push(poly([...inA, ...outA], { stroke: C.blue, width: 7 }));
  body.push(poly([...inB, ...outB], { stroke: C.amber, width: 7 }));
  // Same sizing rule as renderSvg: lane spread + half a line width + 1.
  const spread = Math.max(...[inA[1], inB[1], outA[0], outB[0]].map((p) => Math.hypot(p.x - st.x, p.y - st.y)));
  body.push(dot(st, { r: Math.max(3.2 * 1.6, spread + 7 / 2 + 1), width: 2 }));
  write("lanes.svg", svg(720, 260, body.join("\n")));
}

// ---------- 10. Station dots (rendered by renderSvg) ----------
{
  const net = {
    stations: [
      { name: "Terminus", lat: 0.01, lon: 0 },
      { name: "Single line", lat: 0.01, lon: 0.01 },
      { name: "Shared track", lat: 0.01, lon: 0.02 },
      { name: "Lines cross", lat: 0.01, lon: 0.03 },
      { name: "End", lat: 0.01, lon: 0.04 },
      { name: "North", lat: 0.02, lon: 0.03 },
      { name: "South", lat: 0, lon: 0.03 },
      { name: "Branch", lat: 0, lon: 0.02 },
    ],
    lines: [
      { name: "Red", color: C.accent, route: ["Terminus", "Single line", "Shared track", "Lines cross", "End"] },
      { name: "Purple", color: C.purple, route: ["Branch", "Shared track", "Lines cross", "End"] },
      { name: "Blue", color: C.blue, route: ["North", "Lines cross", "South"] },
    ],
  };
  write("stations.svg", renderSvg(layout(net, { spacing: 100, padding: 70 }), { fontSize: 13 }));
}

// ---------- 11. Label candidates ----------
{
  const st = { x: 300, y: 140 };
  const spots = [
    [1, 0, 0],
    [-1, 0, 0.5],
    [0, -1, 1.5],
    [0, 1, 1.5],
    [0.75, -0.75, 1],
    [0.75, 0.75, 1],
    [-0.75, -0.75, 1.5],
    [-0.75, 0.75, 1.5],
  ];
  // Spacing exaggerated (renderSvg uses a gap of ~8px) so the boxes don't overlap.
  const w = 84;
  const h = 20;
  const gap = 34;
  const body = [line({ x: 40, y: 140 }, { x: 560, y: 140 }, { stroke: C.blue, width: 6 })];
  // Same geometry as renderSvg; a box crossing the line costs 8, like one line hit there.
  const boxes = spots.map(([dx, dy, pref]) => {
    const ax = st.x + dx * gap;
    const ay = st.y + dy * gap;
    const x = dx > 0 ? ax : dx < 0 ? ax - w : ax - w / 2;
    const y = dy > 0 ? ay : dy < 0 ? ay - h : ay - h / 2;
    const hitsLine = y < 140 + 4 && y + h > 140 - 4;
    return { x, y, pref, hitsLine, score: pref + (hitsLine ? 8 : 0) };
  });
  const bestIndex = boxes.reduce((m, b, i) => (b.score < boxes[m].score ? i : m), 0);
  boxes.forEach(({ x, y, pref, hitsLine }, i) => {
    const chosen = i === bestIndex;
    body.push(`<rect x="${f(x)}" y="${f(y)}" width="${w}" height="${h}" rx="3" fill="${chosen ? "#fdecea" : "none"}" stroke="${chosen ? C.accent : hitsLine ? C.faint : C.muted}" stroke-dasharray="${chosen ? "" : "3 3"}"/>`);
    body.push(text(x + w / 2, y + 13, `${pref}${hitsLine ? " + line" : ""}`, { anchor: "middle", size: 11, fill: chosen ? C.accent : C.muted }));
  });
  body.push(dot(st, { r: 4 }));
  body.push(text(20, 28, "Eight candidate spots, each with a base preference", { weight: 600 }));
  body.push(text(20, 45, "lowest total penalty wins (here: upper right) · spacing exaggerated", { fill: C.muted, size: 12 }));
  write("labels.svg", svg(600, 250, body.join("\n")));
}

// ---------- 12. Full maps ----------
write("copenhagen.svg", renderSvg(layout(copenhagenMetro())));
