// ─── SHARED f1-circuits SOURCE ACCESS ──────────────────────────────────────────
// The upstream centerline dataset and the two operations both track scripts do to
// it: fetch the GeoJSON and project a circuit's lat/long into a local metric frame.
//
// Two scripts read this source and MUST agree about it:
//   • fetch-tracks.mjs — resamples the projection along a spline into the committed
//     public/tracks/<slug>.json geometry.
//   • fit-corners.mjs  — resamples the SAME projection LINEARLY (the chord) and runs
//     the corner detector on it, because the detector needs straights to read flat
//     (see that script's header). It writes its apexes back into the spline file.
// Keeping the id→slug map and the projection here is what stops the two from
// disagreeing about which circuit is which, or where its origin sits.
//
// github.com/bacinger/f1-circuits, MIT © Tomislav Bacinger.

export const SRC = "https://raw.githubusercontent.com/bacinger/f1-circuits/master";
export const ATTRIBUTION =
  "Track geometry: f1-circuits (github.com/bacinger/f1-circuits), MIT © Tomislav Bacinger.";

// f1-circuits feature id → app track slug (src/lib/trackData.js).
export const TRACKS = {
  "au-1953": "australia",   "bh-2002": "bahrain",     "cn-2004": "china",
  "es-1991": "spain",       "mc-1929": "monaco",      "ca-1978": "canada",
  "at-1969": "austria",     "gb-1948": "silverstone", "hu-1986": "hungary",
  "be-1925": "belgium",     "it-1922": "italy",       "sg-2008": "singapore",
  "jp-1962": "japan",       "us-2012": "usa",         "mx-1962": "mexico",
  "br-1940": "brazil",      "ae-2009": "abudhabi",    "it-1953": "imola",
  "nl-1948": "netherlands", "sa-2021": "saudiarabia", "us-2022": "miami",
  "qa-2004": "qatar",       "es-2026": "madring",     "az-2016": "azerbaijan",
  "us-2023": "lasvegas",
};

const R_EARTH = 6371000;

export async function fetchText(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} — ${url}`);
  return res.text();
}

// The whole feature collection, indexed by feature id.
export async function fetchCircuits() {
  const geo = JSON.parse(await fetchText(`${SRC}/f1-circuits.geojson`));
  return new Map(geo.features.map((f) => [f.properties.id, f]));
}

// Equirectangular projection about the circuit's own centroid: distortion over a few km
// is far below the 12 m fit tolerance, and trackGeometry only ever aligns rigidly.
export function toMetres(coords) {
  const lat0 = coords.reduce((a, c) => a + c[1], 0) / coords.length;
  const lon0 = coords.reduce((a, c) => a + c[0], 0) / coords.length;
  const kx = (Math.PI / 180) * R_EARTH * Math.cos((lat0 * Math.PI) / 180);
  const ky = (Math.PI / 180) * R_EARTH;
  return coords.map(([lon, lat]) => [(lon - lon0) * kx, (lat - lat0) * ky]);
}
