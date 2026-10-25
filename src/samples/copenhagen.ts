import type { Network } from "../types.js";

/** The Copenhagen Metro (M1–M4). Coordinates are approximate. */
export function copenhagenMetro(): Network {
  const s = (name: string, lat: number, lon: number) => ({ name, lat, lon });
  return {
    stations: [
      s("Vanløse", 55.6871, 12.4917),
      s("Flintholm", 55.6857, 12.4991),
      s("Lindevang", 55.6837, 12.5131),
      s("Fasanvej", 55.6815, 12.5232),
      s("Frederiksberg", 55.6812, 12.5318),
      s("Forum", 55.6818, 12.5524),
      s("Nørreport", 55.6833, 12.5714),
      s("Kongens Nytorv", 55.6795, 12.5853),
      s("Christianshavn", 55.6722, 12.5913),
      s("Islands Brygge", 55.6633, 12.5852),
      s("DR Byen", 55.6556, 12.589),
      s("Sundby", 55.6452, 12.586),
      s("Bella Center", 55.638, 12.5829),
      s("Ørestad", 55.629, 12.5794),
      s("Vestamager", 55.6197, 12.5757),
      s("Amagerbro", 55.6636, 12.6029),
      s("Lergravsparken", 55.662, 12.6166),
      s("Øresund", 55.6612, 12.629),
      s("Amager Strand", 55.656, 12.632),
      s("Femøren", 55.645, 12.638),
      s("Kastrup", 55.6357, 12.6475),
      s("Lufthavnen", 55.6303, 12.6497),
      s("København H", 55.6727, 12.565),
      s("Rådhuspladsen", 55.676, 12.569),
      s("Gammel Strand", 55.678, 12.5795),
      s("Marmorkirken", 55.6853, 12.5893),
      s("Østerport", 55.6929, 12.5873),
      s("Trianglen", 55.699, 12.5765),
      s("Poul Henningsens Plads", 55.709, 12.575),
      s("Vibenshus Runddel", 55.7062, 12.564),
      s("Skjolds Plads", 55.703, 12.552),
      s("Nørrebro", 55.7006, 12.5373),
      s("Nørrebros Runddel", 55.694, 12.539),
      s("Nuuks Plads", 55.689, 12.543),
      s("Aksel Møllers Have", 55.686, 12.533),
      s("Frederiksberg Allé", 55.674, 12.54),
      s("Enghave Plads", 55.668, 12.547),
      s("Orientkaj", 55.711, 12.597),
      s("Nordhavn", 55.7055, 12.591),
      s("Havneholmen", 55.666, 12.559),
      s("Enghave Brygge", 55.66, 12.56),
      s("Sluseholmen", 55.646, 12.545),
      s("Mozarts Plads", 55.648, 12.532),
      s("Ny Ellebjerg", 55.653, 12.516),
    ],
    lines: [
      {
        name: "M1",
        color: "#00814e",
        route: [
          "Vanløse", "Flintholm", "Lindevang", "Fasanvej", "Frederiksberg", "Forum", "Nørreport",
          "Kongens Nytorv", "Christianshavn", "Islands Brygge", "DR Byen", "Sundby", "Bella Center",
          "Ørestad", "Vestamager",
        ],
      },
      {
        name: "M2",
        color: "#f5b31a",
        route: [
          "Vanløse", "Flintholm", "Lindevang", "Fasanvej", "Frederiksberg", "Forum", "Nørreport",
          "Kongens Nytorv", "Christianshavn", "Amagerbro", "Lergravsparken", "Øresund", "Amager Strand",
          "Femøren", "Kastrup", "Lufthavnen",
        ],
      },
      {
        name: "M3 Cityringen",
        color: "#e3242b",
        route: [
          "København H", "Rådhuspladsen", "Gammel Strand", "Kongens Nytorv", "Marmorkirken", "Østerport",
          "Trianglen", "Poul Henningsens Plads", "Vibenshus Runddel", "Skjolds Plads", "Nørrebro",
          "Nørrebros Runddel", "Nuuks Plads", "Aksel Møllers Have", "Frederiksberg", "Frederiksberg Allé",
          "Enghave Plads", "København H",
        ],
      },
      {
        name: "M4",
        color: "#0093d0",
        route: [
          "Orientkaj", "Nordhavn", "Østerport", "Marmorkirken", "Kongens Nytorv", "Gammel Strand",
          "Rådhuspladsen", "København H", "Havneholmen", "Enghave Brygge", "Sluseholmen", "Mozarts Plads",
          "Ny Ellebjerg",
        ],
      },
    ],
  };
}
