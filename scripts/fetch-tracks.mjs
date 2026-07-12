// ─── FETCH + CONVERT REAL CIRCUIT GEOMETRY ─────────────────────────────────────
// One-time dev script (NOT wired into predev/prebuild — the output is committed).
// Downloads centerline + track-width CSVs from the open TUMFTM racetrack-database
// (github.com/TUMFTM/racetrack-database, LGPL-3.0) for every F1 circuit the game
// visits that the dataset covers, resamples each to a uniform ~2.5 m arc-length
// spacing, and writes compact JSON into public/tracks/ so the packaged app can
// fetch them same-origin (the CSP blocks external CDNs — same reason /ort/ exists).
//
//   node scripts/fetch-tracks.mjs
//
// Output per circuit:  public/tracks/<slug>.json
//   { slug, source, spacing, closed, attribution, points: [[x, y, wRight, wLeft], …] }
//   x/y are centerline meters in the dataset's local frame; wRight/wLeft are track
//   widths (m) to each side of the centerline relative to the direction of travel.
//   Runtime alignment into the game's world frame happens in src/lib/trackGeometry.js.
// Plus:  public/tracks/index.json  (coverage map + attribution)
//        public/tracks/LICENSE.txt (upstream license, shipped with the data)

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = resolve(root, "public/tracks");

const RAW = "https://raw.githubusercontent.com/TUMFTM/racetrack-database/master";
const ATTRIBUTION =
  "Track geometry: TUMFTM racetrack-database (github.com/TUMFTM/racetrack-database), LGPL-3.0.";

// App track slug (src/lib/trackData.js) → dataset CSV basename. Circuits the game
// visits but the dataset lacks (monaco, singapore, azerbaijan, imola, saudiarabia,
// miami, lasvegas, qatar) fall back to a heuristic road at runtime.
const TRACKS = {
  australia:   "Melbourne",
  china:       "Shanghai",
  bahrain:     "Sakhir",
  spain:       "Catalunya",
  canada:      "Montreal",
  silverstone: "Silverstone",
  hungary:     "Budapest",
  belgium:     "Spa",
  italy:       "Monza",
  japan:       "Suzuka",
  abudhabi:    "YasMarina",
  usa:         "Austin",
  brazil:      "SaoPaulo",
  austria:     "Spielberg",
  mexico:      "MexicoCity",
  netherlands: "Zandvoort",
};

const SPACING = 2.5; // meters between resampled centerline points

async function fetchText(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res.text();
}

// Parse "x_m,y_m,w_tr_right_m,w_tr_left_m" CSV (comment/header lines start with #).
function parseCsv(text) {
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith("#")) continue;
    const cols = s.split(",").map(Number);
    if (cols.length < 4 || cols.some((v) => !isFinite(v))) continue;
    rows.push(cols.slice(0, 4)); // [x, y, wRight, wLeft]
  }
  return rows;
}

// Resample a closed-loop polyline (with per-point widths) to uniform arc spacing.
function resample(rows, spacing) {
  // Drop an explicit duplicate closing point; we close the loop ourselves.
  const first = rows[0], last = rows[rows.length - 1];
  if (Math.hypot(first[0] - last[0], first[1] - last[1]) < 0.5) rows = rows.slice(0, -1);

  const n = rows.length;
  const cum = [0]; // cumulative arc length, including the closing segment
  for (let i = 1; i <= n; i++) {
    const a = rows[i - 1], b = rows[i % n];
    cum[i] = cum[i - 1] + Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  const total = cum[n];
  const count = Math.max(8, Math.round(total / spacing));
  const out = [];
  let seg = 1;
  for (let k = 0; k < count; k++) {
    const s = (k / count) * total;
    while (seg <= n && cum[seg] < s) seg++;
    const i = Math.min(seg, n);
    const a = rows[i - 1], b = rows[i % n];
    const span = cum[i] - cum[i - 1];
    const t = span > 0 ? (s - cum[i - 1]) / span : 0;
    out.push([
      +(a[0] + (b[0] - a[0]) * t).toFixed(2),
      +(a[1] + (b[1] - a[1]) * t).toFixed(2),
      +(a[2] + (b[2] - a[2]) * t).toFixed(2),
      +(a[3] + (b[3] - a[3]) * t).toFixed(2),
    ]);
  }
  return { points: out, total };
}

mkdirSync(outDir, { recursive: true });

const license = await fetchText(`${RAW}/LICENSE`).catch(() => null);
if (license) writeFileSync(resolve(outDir, "LICENSE.txt"), license);
else console.warn("[fetch-tracks] could not fetch upstream LICENSE — add it manually");

const index = { _attribution: ATTRIBUTION, tracks: {} };
for (const [slug, file] of Object.entries(TRACKS)) {
  const csv = await fetchText(`${RAW}/tracks/${file}.csv`);
  const rows = parseCsv(csv);
  if (rows.length < 100) throw new Error(`${file}.csv parsed to only ${rows.length} rows`);
  const { points, total } = resample(rows, SPACING);
  const json = {
    slug, source: `${file}.csv`, spacing: SPACING, closed: true,
    attribution: ATTRIBUTION, points,
  };
  writeFileSync(resolve(outDir, `${slug}.json`), JSON.stringify(json));
  index.tracks[slug] = { file: `${slug}.json`, lengthM: Math.round(total), points: points.length };
  console.log(`[fetch-tracks] ${slug.padEnd(12)} ← ${file}.csv  ${Math.round(total)} m, ${points.length} pts`);
}
writeFileSync(resolve(outDir, "index.json"), JSON.stringify(index, null, 2));
console.log(`[fetch-tracks] wrote ${Object.keys(index.tracks).length} circuits + index.json`);
