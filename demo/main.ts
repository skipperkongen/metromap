import {
  copenhagenMetro,
  fillMissingCoordinates,
  layout,
  normalizeEntry,
  PALETTE,
  renderSvg,
  riversideCity,
  type MetroMap,
  type Network,
  type Station,
} from "../src/index.js";

// ---------- State ----------

interface Entry {
  station: string;
  stop: boolean;
}

interface EditLine {
  name: string;
  color: string;
  route: Entry[];
}

type Mode = "stations" | "lines";

/** Geographic view of the input pane: the lat/lon at the pane center and pixels per degree of latitude. */
interface View {
  lat: number;
  lon: number;
  scale: number;
}

const state = {
  stations: [] as Station[],
  lines: [] as EditLine[],
  mode: "stations" as Mode,
  selected: null as string | null,
  drawing: null as number | null,
  map: null as MetroMap | null,
  stale: false,
  view: { lat: 0, lon: 0, scale: 20000 } as View,
};

const SAMPLES: Record<string, () => Network> = {
  copenhagen: copenhagenMetro,
  riverside: riversideCity,
  empty: () => ({ stations: [], lines: [] }),
};

// ---------- Elements ----------

const $ = <T extends Element>(sel: string) => document.querySelector(sel) as T;
const inputSvg = $<SVGSVGElement>("#input");
const mapEl = $<HTMLDivElement>("#map");
const linesEl = $<HTMLDivElement>("#lines");
const sampleSelect = $<HTMLSelectElement>("#sample");
const hintEl = $<HTMLParagraphElement>("#hint");
const drawingBar = $<HTMLDivElement>("#drawing-bar");
const drawingLabel = $<HTMLSpanElement>("#drawing-label");
const stationPanel = $<HTMLElement>("#station-panel");
const stationName = $<HTMLInputElement>("#station-name");
const stationInfo = $<HTMLParagraphElement>("#station-info");
const staleEl = $<HTMLDivElement>("#stale");
const mapStatus = $<HTMLSpanElement>("#map-status");
const downloadBtn = $<HTMLButtonElement>("#download");
const jsonEl = $<HTMLTextAreaElement>("#json");
const jsonError = $<HTMLSpanElement>("#json-error");

// ---------- Network helpers ----------

function loadNetwork(net: Network) {
  state.stations = net.stations.map((s) => ({ ...s }));
  state.lines = net.lines.map((l, i) => ({
    name: l.name,
    color: l.color ?? PALETTE[i % PALETTE.length]!,
    route: l.route.map(normalizeEntry),
  }));
  state.selected = null;
  state.drawing = null;
  state.map = null;
  state.stale = false;
  fitView();
}

function currentNetwork(): Network {
  return {
    stations: state.stations,
    lines: state.lines.map((l) => ({
      name: l.name,
      color: l.color,
      route: l.route.map((e) => (e.stop ? e.station : { station: e.station, stop: false })),
    })),
  };
}

/** The network that goes into the layout: only finished lines and the stations they use. */
function layoutInput(): Network {
  const lines = currentNetwork().lines.filter((l) => l.route.length >= 2);
  const used = new Set(lines.flatMap((l) => l.route.map((e) => normalizeEntry(e).station)));
  return { stations: state.stations.filter((s) => used.has(s.name)), lines };
}

function uniqueName(base: string, taken: Iterable<string>): string {
  const set = new Set(taken);
  for (let i = 1; ; i++) {
    const name = `${base} ${i}`;
    if (!set.has(name)) return name;
  }
}

function changed() {
  if (state.map) state.stale = true;
  render();
}

// ---------- Geographic projection for the input pane ----------

function paneSize() {
  const r = inputSvg.getBoundingClientRect();
  return { w: r.width || 600, h: r.height || 400 };
}

function cosLat() {
  return Math.cos((state.view.lat * Math.PI) / 180);
}

function toScreen(lat: number, lon: number) {
  const { w, h } = paneSize();
  const v = state.view;
  return { x: w / 2 + (lon - v.lon) * cosLat() * v.scale, y: h / 2 - (lat - v.lat) * v.scale };
}

function toGeo(x: number, y: number) {
  const { w, h } = paneSize();
  const v = state.view;
  return { lat: v.lat - (y - h / 2) / v.scale, lon: v.lon + (x - w / 2) / (cosLat() * v.scale) };
}

function fitView() {
  const placed = fillMissingCoordinates(currentNetwork()).filter(
    (s): s is Station & { lat: number; lon: number } => s.lat !== undefined && s.lon !== undefined,
  );
  if (placed.length === 0) {
    state.view = { lat: 0, lon: 0, scale: 20000 };
    return;
  }
  const lats = placed.map((s) => s.lat);
  const lons = placed.map((s) => s.lon);
  const lat = (Math.min(...lats) + Math.max(...lats)) / 2;
  const lon = (Math.min(...lons) + Math.max(...lons)) / 2;
  const k = Math.cos((lat * Math.PI) / 180);
  const { w, h } = paneSize();
  const spanLat = Math.max(...lats) - Math.min(...lats) || 0.01;
  const spanLon = (Math.max(...lons) - Math.min(...lons)) * k || 0.01;
  state.view = { lat, lon, scale: 0.8 * Math.min((w - 40) / spanLon, (h - 40) / spanLat) };
}

function eventPoint(ev: PointerEvent | WheelEvent) {
  const r = inputSvg.getBoundingClientRect();
  return { x: ev.clientX - r.left, y: ev.clientY - r.top };
}

// ---------- Rendering: input pane ----------

function renderInput() {
  inputSvg.setAttribute("class", `canvas mode-${state.mode}`);
  const { w, h } = paneSize();
  inputSvg.setAttribute("viewBox", `0 0 ${w} ${h}`);

  const filled = fillMissingCoordinates(currentNetwork());
  const pos = new Map<string, { x: number; y: number; estimated: boolean }>();
  filled.forEach((s, i) => {
    if (s.lat === undefined || s.lon === undefined) return;
    const original = state.stations[i]!;
    pos.set(s.name, { ...toScreen(s.lat, s.lon), estimated: original.lat === undefined || original.lon === undefined });
  });

  // Lines: one short stroke per consecutive pair, offset so shared track shows every line.
  const pairLines = new Map<string, number[]>();
  const pairKey = (a: string, b: string) => (a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`);
  state.lines.forEach((line, li) => {
    for (let k = 1; k < line.route.length; k++) {
      const key = pairKey(line.route[k - 1]!.station, line.route[k]!.station);
      const list = pairLines.get(key) ?? [];
      if (!list.includes(li)) list.push(li);
      pairLines.set(key, list);
    }
  });

  const parts: string[] = [];
  state.lines.forEach((line, li) => {
    const width = state.drawing === li ? 4.5 : 3;
    for (let k = 1; k < line.route.length; k++) {
      const a = line.route[k - 1]!.station;
      const b = line.route[k]!.station;
      const pa = pos.get(a);
      const pb = pos.get(b);
      if (!pa || !pb) continue;
      const [first, second] = a < b ? [pa, pb] : [pb, pa];
      const len = Math.hypot(second.x - first.x, second.y - first.y) || 1;
      const nx = (second.y - first.y) / len;
      const ny = -(second.x - first.x) / len;
      const group = pairLines.get(pairKey(a, b))!;
      const off = (group.indexOf(li) - (group.length - 1) / 2) * 4;
      parts.push(
        `<line x1="${pa.x + nx * off}" y1="${pa.y + ny * off}" x2="${pb.x + nx * off}" y2="${pb.y + ny * off}" stroke="${line.color}" stroke-width="${width}" stroke-linecap="round"/>`,
      );
    }
  });

  for (const s of state.stations) {
    const p = pos.get(s.name);
    if (!p) continue;
    const selected = state.selected === s.name;
    const onLine = state.lines.some((l) => l.route.some((e) => e.station === s.name));
    const r = selected ? 7 : 5;
    const stroke = selected ? "var(--accent)" : "var(--ink)";
    const dash = p.estimated ? ` stroke-dasharray="2 2"` : "";
    const fill = onLine ? "var(--panel)" : "var(--grid)";
    parts.push(
      `<g class="station" data-station="${escAttr(s.name)}">` +
        `<circle cx="${p.x}" cy="${p.y}" r="12" fill="transparent"/>` +
        `<circle cx="${p.x}" cy="${p.y}" r="${r}" fill="${fill}" stroke="${stroke}" stroke-width="${selected ? 2.5 : 1.5}"${dash}/>` +
        `<text x="${p.x + 9}" y="${p.y - 7}" font-size="11" fill="var(--muted)"${p.estimated ? ` font-style="italic"` : ""}>${escText(s.name)}${p.estimated ? " (estimated)" : ""}</text>` +
        `</g>`,
    );
  }

  if (state.stations.length === 0) {
    parts.push(
      `<text x="${w / 2}" y="${h / 2}" text-anchor="middle" fill="var(--muted)" font-size="14">Click anywhere to add a station</text>`,
    );
  }

  inputSvg.innerHTML = parts.join("");
}

// ---------- Rendering: sidebar ----------

function renderSidebar() {
  document.querySelectorAll<HTMLButtonElement>(".segmented button").forEach((b) => {
    b.setAttribute("aria-checked", String(b.dataset.mode === state.mode));
  });

  hintEl.innerHTML =
    state.mode === "stations"
      ? "Click empty space to <b>add a station</b>. Drag a station to move it, click it to rename or delete."
      : "Click stations in order to <b>draw a line</b>; clicking empty space adds a new station. <b>Shift-click</b> adds a station the line passes without stopping. Click the first station to close a loop.";

  const drawingLine = state.drawing !== null ? state.lines[state.drawing] : undefined;
  drawingBar.hidden = !drawingLine;
  if (drawingLine) drawingLabel.textContent = `Drawing ${drawingLine.name} (${drawingLine.route.length} stations)`;

  const selected = state.stations.find((s) => s.name === state.selected);
  stationPanel.hidden = !selected;
  if (selected) {
    if (document.activeElement !== stationName) stationName.value = selected.name;
    const served = state.lines.filter((l) => l.route.some((e) => e.station === selected.name));
    stationInfo.textContent =
      served.length === 0
        ? "Not on any line yet."
        : served
            .map((l) => {
              const stops = l.route.some((e) => e.station === selected.name && e.stop);
              return `${l.name}: ${stops ? "stops" : "passes through"}`;
            })
            .join(" · ");
  }

  linesEl.innerHTML = "";
  if (state.lines.length === 0) {
    linesEl.innerHTML = `<p class="hint">No lines yet. Switch to the Lines tool and click stations.</p>`;
  }
  state.lines.forEach((line, li) => {
    const card = document.createElement("div");
    card.className = `line-card${state.drawing === li ? " drawing" : ""}`;

    const header = document.createElement("div");
    header.className = "row";
    const color = document.createElement("input");
    color.type = "color";
    color.value = toHex(line.color);
    color.title = "Line color";
    color.addEventListener("input", () => {
      line.color = color.value;
      recolorMap();
      renderInput();
      syncJson();
    });
    const name = document.createElement("input");
    name.type = "text";
    name.value = line.name;
    name.setAttribute("aria-label", "Line name");
    name.addEventListener("change", () => {
      const value = name.value.trim();
      if (value && !state.lines.some((l, i) => i !== li && l.name === value)) {
        line.name = value;
        changed();
      } else {
        name.value = line.name;
      }
    });
    const remove = document.createElement("button");
    remove.className = "icon-button";
    remove.textContent = "×";
    remove.title = "Delete line";
    remove.addEventListener("click", () => {
      state.lines.splice(li, 1);
      if (state.drawing === li) state.drawing = null;
      else if (state.drawing !== null && state.drawing > li) state.drawing--;
      changed();
    });
    header.append(color, name, remove);

    const route = document.createElement("div");
    route.className = "route";
    if (line.route.length === 0) {
      route.innerHTML = `<span class="route-empty">Click stations on the map to build the route.</span>`;
    }
    line.route.forEach((entry, k) => {
      const isLoopEnd = k === line.route.length - 1 && k > 1 && entry.station === line.route[0]!.station;
      const chip = document.createElement("button");
      chip.className = `chip${entry.stop ? "" : " pass"}`;
      chip.title = entry.stop ? "Stops here. Click to pass through instead." : "Passes through. Click to stop here.";
      chip.innerHTML = `<span class="dot" style="color:${line.color}">${entry.stop ? "●" : "○"}</span>${escText(entry.station)}${isLoopEnd ? " ↺" : ""}`;
      chip.addEventListener("click", () => {
        entry.stop = !entry.stop;
        // The two ends of a loop are the same visit.
        if (isLoopEnd) line.route[0]!.stop = entry.stop;
        else if (k === 0 && line.route.length > 2 && line.route[line.route.length - 1]!.station === entry.station) {
          line.route[line.route.length - 1]!.stop = entry.stop;
        }
        changed();
      });
      route.append(chip);
    });

    const actions = document.createElement("div");
    actions.className = "row";
    if (state.drawing !== li) {
      const extend = document.createElement("button");
      extend.className = "small";
      extend.textContent = "Extend";
      extend.title = "Add more stations to the end of this line";
      extend.addEventListener("click", () => {
        state.mode = "lines";
        state.drawing = li;
        render();
      });
      actions.append(extend);
    }
    if (line.route.length > 0) {
      const undo = document.createElement("button");
      undo.className = "small";
      undo.textContent = "Remove last stop";
      undo.addEventListener("click", () => {
        line.route.pop();
        changed();
      });
      actions.append(undo);
    }

    card.append(header, route, actions);
    linesEl.append(card);
  });

  syncJson();
}

function syncJson() {
  if (document.activeElement !== jsonEl) jsonEl.value = JSON.stringify(currentNetwork(), null, 2);
}

// ---------- Rendering: metro map ----------

function renderMap() {
  staleEl.hidden = !(state.map && state.stale);
  downloadBtn.disabled = !state.map;
  if (!state.map) {
    if (!mapEl.querySelector(".error")) {
      mapEl.innerHTML = `<p class="placeholder">Pick a network or draw one, then press <b>Create metro map</b>.</p>`;
    }
    return;
  }
  mapEl.innerHTML = renderSvg(state.map);
  // Fit large maps to the pane, but don't blow small ones up beyond 1.4×.
  const svg = mapEl.querySelector("svg")!;
  svg.style.maxWidth = `${Number(svg.getAttribute("width")) * 1.4}px`;
  svg.style.maxHeight = `${Number(svg.getAttribute("height")) * 1.4}px`;
  applyMapZoom();
}

// ---------- Zoom and pan on the metro map ----------

let mapZoom = { k: 1, x: 0, y: 0 };
let mapDrag: { x: number; y: number; zoom: typeof mapZoom } | null = null;

function applyMapZoom() {
  const svg = mapEl.querySelector("svg");
  if (svg) svg.style.transform = `translate(${mapZoom.x}px, ${mapZoom.y}px) scale(${mapZoom.k})`;
}

/** Pointer position relative to the untransformed map SVG. */
function mapPoint(ev: MouseEvent) {
  // The transformed box starts at (untransformed origin + translation).
  const r = mapEl.querySelector("svg")!.getBoundingClientRect();
  return { x: ev.clientX - (r.left - mapZoom.x), y: ev.clientY - (r.top - mapZoom.y) };
}

mapEl.addEventListener(
  "wheel",
  (ev) => {
    if (!state.map) return;
    ev.preventDefault();
    const p = mapPoint(ev);
    const k = Math.min(12, Math.max(0.5, mapZoom.k * Math.exp(-ev.deltaY * 0.0015)));
    const f = k / mapZoom.k;
    // Keep the point under the cursor fixed.
    mapZoom = { k, x: p.x - (p.x - mapZoom.x) * f, y: p.y - (p.y - mapZoom.y) * f };
    applyMapZoom();
  },
  { passive: false },
);

mapEl.addEventListener("pointerdown", (ev) => {
  if (!state.map || ev.button !== 0) return;
  mapEl.setPointerCapture(ev.pointerId);
  mapDrag = { x: ev.clientX, y: ev.clientY, zoom: { ...mapZoom } };
  mapEl.classList.add("panning");
});

mapEl.addEventListener("pointermove", (ev) => {
  if (!mapDrag) return;
  mapZoom = { ...mapDrag.zoom, x: mapDrag.zoom.x + ev.clientX - mapDrag.x, y: mapDrag.zoom.y + ev.clientY - mapDrag.y };
  applyMapZoom();
});

const endMapDrag = () => {
  mapDrag = null;
  mapEl.classList.remove("panning");
};
mapEl.addEventListener("pointerup", endMapDrag);
mapEl.addEventListener("pointercancel", endMapDrag);

mapEl.addEventListener("dblclick", () => {
  mapZoom = { k: 1, x: 0, y: 0 };
  applyMapZoom();
});

function recolorMap() {
  if (!state.map) return;
  for (const mapLine of state.map.lines) {
    const line = state.lines.find((l) => l.name === mapLine.name);
    if (line) mapLine.color = line.color;
  }
  renderMap();
}

function createMap() {
  finishDrawing();
  const input = layoutInput();
  if (input.lines.length === 0) {
    state.map = null;
    mapStatus.textContent = "";
    mapEl.innerHTML = `<p class="placeholder error">Add at least one line with two or more stations first.</p>`;
    render();
    return;
  }
  try {
    const t0 = performance.now();
    state.map = layout(input);
    const ms = Math.round(performance.now() - t0);
    state.stale = false;
    mapStatus.textContent = `${input.stations.length} stations · ${input.lines.length} lines · ${ms} ms · scroll to zoom`;
    mapZoom = { k: 1, x: 0, y: 0 };
  } catch (err) {
    state.map = null;
    mapStatus.textContent = "";
    mapEl.innerHTML = `<p class="placeholder error">${escText(String((err as Error).message ?? err))}</p>`;
  }
  render();
}

function render() {
  renderInput();
  renderSidebar();
  renderMap();
}

// ---------- Editing ----------

function addStation(x: number, y: number): string {
  const name = uniqueName("Station", state.stations.map((s) => s.name));
  state.stations.push({ name, ...roundGeo(toGeo(x, y)) });
  return name;
}

function startLine(): number {
  const name = uniqueName("Line", state.lines.map((l) => l.name));
  const used = new Set(state.lines.map((l) => l.color.toLowerCase()));
  const color = PALETTE.find((c) => !used.has(c.toLowerCase())) ?? PALETTE[state.lines.length % PALETTE.length]!;
  state.lines.push({ name, color, route: [] });
  return state.lines.length - 1;
}

function addToLine(station: string, stop: boolean) {
  if (state.drawing === null) state.drawing = startLine();
  const line = state.lines[state.drawing]!;
  const last = line.route[line.route.length - 1];
  if (last?.station === station) {
    // Clicking the last station again ends the line.
    finishDrawing();
    return;
  }
  const closesLoop = line.route.length >= 3 && line.route[0]!.station === station;
  line.route.push({ station, stop: closesLoop ? line.route[0]!.stop : stop });
  if (closesLoop) finishDrawing();
}

function finishDrawing() {
  if (state.drawing === null) return;
  const line = state.lines[state.drawing];
  // A line needs at least two stations to be drawn.
  if (line && line.route.length < 2) state.lines.splice(state.drawing, 1);
  state.drawing = null;
}

function renameStation(oldName: string, newName: string): boolean {
  if (!newName || state.stations.some((s) => s.name === newName)) return false;
  const station = state.stations.find((s) => s.name === oldName);
  if (!station) return false;
  station.name = newName;
  for (const line of state.lines) for (const e of line.route) if (e.station === oldName) e.station = newName;
  if (state.selected === oldName) state.selected = newName;
  return true;
}

function deleteStation(name: string) {
  state.stations = state.stations.filter((s) => s.name !== name);
  for (const line of state.lines) {
    line.route = line.route.filter((e) => e.station !== name);
    // Removing a station can leave the same station twice in a row.
    line.route = line.route.filter((e, k) => k === 0 || e.station !== line.route[k - 1]!.station);
  }
  state.lines = state.lines.filter((l, i) => l.route.length >= 2 || i === state.drawing);
  if (state.selected === name) state.selected = null;
}

// ---------- Pointer interaction on the input pane ----------

let gesture:
  | { kind: "station"; name: string; start: { x: number; y: number }; moved: boolean; shift: boolean }
  | { kind: "background"; start: { x: number; y: number }; view: View; moved: boolean; shift: boolean }
  | null = null;

inputSvg.addEventListener("pointerdown", (ev) => {
  if (ev.button !== 0) return;
  const p = eventPoint(ev);
  const target = (ev.target as Element).closest("[data-station]");
  inputSvg.setPointerCapture(ev.pointerId);
  gesture = target
    ? { kind: "station", name: target.getAttribute("data-station")!, start: p, moved: false, shift: ev.shiftKey }
    : { kind: "background", start: p, view: { ...state.view }, moved: false, shift: ev.shiftKey };
});

inputSvg.addEventListener("pointermove", (ev) => {
  if (!gesture) return;
  const p = eventPoint(ev);
  const dx = p.x - gesture.start.x;
  const dy = p.y - gesture.start.y;
  if (!gesture.moved && Math.hypot(dx, dy) < 4) return;
  gesture.moved = true;
  if (gesture.kind === "background") {
    inputSvg.classList.add("panning");
    const v = gesture.view;
    state.view = { ...v, lat: v.lat + dy / v.scale, lon: v.lon - dx / (Math.cos((v.lat * Math.PI) / 180) * v.scale) };
    renderInput();
    inputSvg.classList.add("panning");
  } else if (state.mode === "stations") {
    const name = gesture.name;
    const station = state.stations.find((s) => s.name === name);
    if (station) {
      Object.assign(station, roundGeo(toGeo(p.x, p.y)));
      if (state.map) state.stale = true;
      renderInput();
    }
  }
});

inputSvg.addEventListener("pointerup", (ev) => {
  const g = gesture;
  gesture = null;
  inputSvg.classList.remove("panning");
  if (!g) return;
  if (g.moved) {
    if (g.kind === "station") render();
    return;
  }
  const p = eventPoint(ev);
  if (state.mode === "stations") {
    if (g.kind === "station") {
      state.selected = g.name;
      render();
    } else {
      addStation(p.x, p.y);
      state.selected = null;
      changed();
    }
  } else {
    const name = g.kind === "station" ? g.name : addStation(p.x, p.y);
    addToLine(name, !g.shift);
    changed();
  }
});

inputSvg.addEventListener(
  "wheel",
  (ev) => {
    ev.preventDefault();
    const p = eventPoint(ev);
    const before = toGeo(p.x, p.y);
    state.view.scale *= Math.exp(-ev.deltaY * 0.0015);
    const after = toGeo(p.x, p.y);
    state.view.lat += before.lat - after.lat;
    state.view.lon += before.lon - after.lon;
    renderInput();
  },
  { passive: false },
);

// ---------- Controls ----------

document.querySelectorAll<HTMLButtonElement>(".segmented button").forEach((b) => {
  b.addEventListener("click", () => {
    finishDrawing();
    state.mode = b.dataset.mode as Mode;
    state.selected = null;
    render();
  });
});

sampleSelect.addEventListener("change", () => {
  loadNetwork(SAMPLES[sampleSelect.value]!());
  state.mode = sampleSelect.value === "empty" ? "stations" : state.mode;
  mapStatus.textContent = "";
  render();
});

$("#create").addEventListener("click", createMap);
$("#recreate").addEventListener("click", createMap);
$("#finish-line").addEventListener("click", () => {
  finishDrawing();
  render();
});
$("#new-line").addEventListener("click", () => {
  finishDrawing();
  state.mode = "lines";
  state.drawing = startLine();
  render();
});

stationName.addEventListener("change", () => {
  if (!state.selected) return;
  if (renameStation(state.selected, stationName.value.trim())) changed();
  else stationName.value = state.selected;
});

$("#delete-station").addEventListener("click", () => {
  if (state.selected) {
    deleteStation(state.selected);
    changed();
  }
});

downloadBtn.addEventListener("click", () => {
  if (!state.map) return;
  const blob = new Blob([renderSvg(state.map)], { type: "image/svg+xml" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "metro-map.svg";
  a.click();
  URL.revokeObjectURL(a.href);
});

$("#json-apply").addEventListener("click", () => {
  try {
    const net = JSON.parse(jsonEl.value) as Network;
    if (!Array.isArray(net.stations) || !Array.isArray(net.lines)) throw new Error("Expected { stations: [...], lines: [...] }");
    loadNetwork(net);
    jsonError.textContent = "";
    render();
  } catch (err) {
    jsonError.textContent = (err as Error).message;
  }
});

document.addEventListener("keydown", (ev) => {
  const typing = ev.target instanceof HTMLInputElement || ev.target instanceof HTMLTextAreaElement;
  if (typing) return;
  if (ev.key === "Escape" || ev.key === "Enter") {
    finishDrawing();
    state.selected = null;
    render();
  } else if ((ev.key === "Delete" || ev.key === "Backspace") && state.selected) {
    deleteStation(state.selected);
    changed();
  }
});

new ResizeObserver(() => renderInput()).observe(inputSvg);

// ---------- Utilities ----------

function roundGeo(g: { lat: number; lon: number }) {
  return { lat: Math.round(g.lat * 1e6) / 1e6, lon: Math.round(g.lon * 1e6) / 1e6 };
}

/** `<input type="color">` only accepts #rrggbb. */
function toHex(color: string): string {
  if (/^#[0-9a-f]{6}$/i.test(color)) return color;
  if (/^#[0-9a-f]{3}$/i.test(color)) return `#${[...color.slice(1)].map((c) => c + c).join("")}`;
  const ctx = document.createElement("canvas").getContext("2d");
  if (!ctx) return "#000000";
  ctx.fillStyle = color;
  return ctx.fillStyle.startsWith("#") ? ctx.fillStyle : "#000000";
}

function escText(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escAttr(s: string) {
  return escText(s).replace(/"/g, "&quot;");
}

// ---------- Start ----------

loadNetwork(SAMPLES[sampleSelect.value]!());
render();
