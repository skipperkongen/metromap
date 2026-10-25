import type { Network } from "../types.js";

/**
 * A made-up city with a local line, an express line that skips stations on
 * the same track, and a crosstown line. Two stations have no coordinates and
 * are placed between their neighbours.
 */
export function riversideCity(): Network {
  return {
    stations: [
      { name: "Northgate", lat: 0.04, lon: -0.03 },
      { name: "Elm Park", lat: 0.03, lon: -0.022 },
      { name: "Hill Road", lat: 0.022, lon: -0.015 },
      { name: "University", lat: 0.012, lon: -0.008 },
      { name: "Central", lat: 0.0, lon: 0.0 },
      { name: "Market", lat: -0.006, lon: 0.01 },
      { name: "Riverside", lat: -0.014, lon: 0.017 },
      { name: "Docks" },
      { name: "Harbour", lat: -0.034, lon: 0.03 },
      { name: "West End", lat: 0.002, lon: -0.04 },
      { name: "Museum", lat: 0.003, lon: -0.02 },
      { name: "Old Town", lat: 0.006, lon: 0.012 },
      { name: "Stadium" },
      { name: "Eastfield", lat: 0.012, lon: 0.042 },
    ],
    lines: [
      {
        name: "Red Local",
        color: "#e5332a",
        route: ["Northgate", "Elm Park", "Hill Road", "University", "Central", "Market", "Riverside", "Docks", "Harbour"],
      },
      {
        name: "Red Express",
        color: "#8e44ad",
        route: [
          "Northgate",
          { station: "Elm Park", stop: false },
          { station: "Hill Road", stop: false },
          "University",
          "Central",
          { station: "Market", stop: false },
          "Riverside",
          { station: "Docks", stop: false },
          "Harbour",
        ],
      },
      {
        name: "Crosstown",
        color: "#0072bc",
        route: ["West End", "Museum", "Central", "Old Town", "Stadium", "Eastfield"],
      },
    ],
  };
}
