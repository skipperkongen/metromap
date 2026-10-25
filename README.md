# metromap
Algorithm to layout and draw a network in the style typical of urban transit metro maps.

Give it stations (optionally with lat/lon) and lines (ordered routes); get back an
octilinear metro map in canvas coordinates, ready to draw.

## Install

```shell
npm install metromap
```

## Example

```ts
import { layout, renderSvg } from "metromap";

const map = layout({
  stations: [
    { name: "Northgate", lat: 0.04, lon: -0.03 },
    { name: "Elm Park", lat: 0.03, lon: -0.022 },
    { name: "Central", lat: 0.0, lon: 0.0 },
    { name: "Market" }, // no coordinates: placed between its neighbours
    { name: "Harbour", lat: -0.034, lon: 0.03 },
    { name: "Airport", lat: -0.016, lon: 0.046 },
  ],
  lines: [
    { name: "Red", color: "#e5332a", route: ["Northgate", "Elm Park", "Central", "Market", "Harbour"] },
    { name: "Green", route: ["Elm Park", "Central", "Market", "Airport"] },
  ],
});

const svg = renderSvg(map); // standalone SVG string
```

## Data model

**Input** (`Network`)

- `stations`: `{ name, lat?, lon? }`. Names are unique; lines refer to stations by name.
- `lines`: `{ name, color?, route }`. `route` lists the names of the stations the line calls at,
  in travel order; each consecutive pair is one segment. A line always calls at every station on
  its route. Repeat the first station at the end for a loop.

**Output** (`MetroMap`)

- `stations`: `{ name, x, y }` in canvas coordinates.
- `lines`: `{ name, color, segments }`
  - `segments`: `{ from, to, points }`, one per route pair, in travel direction. Points are final:
    lines sharing track are already offset side by side.
- `width`, `height`: canvas size.

## How the layout works

![Geography → relaxed → grid → metro map](docs/images/pipeline.svg)

1. Fill in missing coordinates by interpolating along lines, then project lat/lon.
2. Relax the network: every edge is pulled towards the nearest horizontal, vertical or 45° direction
   with a whole-number length, while stations repel each other and a fading pull keeps geography.
3. Snap stations to a grid, then improve locally (fewer bends, crossings and stations on edges).
4. Route each edge (straight, or with one 45° bend) and offset parallel lines into lanes.

The full, illustrated explanation is in [docs/algorithm.md](docs/algorithm.md).

## Demo

A browser-only demo: pick a sample network or draw your own, press **Create metro map**, recolor lines.

```shell
npm run demo         # dev server
npm run demo:build   # single self-contained file: dist-demo/index.html
```

## Real-life metro maps

For inspiration, some official and well-known maps of real metro systems:

- [New York City Subway](https://www.mta.info/map/5256)
- [London Underground](https://metroeasy.com/wp-content/uploads/2025/06/London-Underground-2025-scaled.jpg)
- [Copenhagen Metro](https://metroeasy.com/wp-content/uploads/2025/09/Copenhagen-Metro-Map.jpg)
- [Vienna U-Bahn](https://metroeasy.com/wp-content/uploads/2025/09/Vienna-U-Bahn-Map.jpg)
- [Beijing Subway](https://www.metroman.cn/en/maps/beijing)
- [Tokyo Metro](https://www.tokyometro.jp/en/subwaymap/index.html)
- [Ho Chi Minh City Metro](https://hochiminhcitymetro.com/maps/)
- [Mexico City Metro](https://mexicocity.cdmx.gob.mx/e/getting-around/the-metro-system-map/?lang=en)

Overview: as of 16 May 2026, 214 cities in 63 countries operate 965 metro lines
(see Wikipedia's [List of metro systems](https://en.wikipedia.org/wiki/List_of_metro_systems)).

## Development

```shell
npm install
npm run lint
npm run typecheck
npm test
npm run build
```

## Publish new version

> For developers

You can publish the package to npm in two ways:

1. Create a release on GitHub, which automatically triggers publication to npm via GitHub Actions.
2. Publish locally.

### Method 1: Via GitHub Actions

- On GitHub, set `secrets.NPM_TOKEN`
- Update the version number (`npm version patch|minor|major`)
- Merge to main (via PR, direct push to main or other way)
- Create new release on GitHub

### Method 2: Direct to npm

```shell
npm publish
```

`prepublishOnly` cleans and rebuilds `dist/` before publishing.
