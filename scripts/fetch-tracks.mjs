// ─── FETCH + CONVERT REAL CIRCUIT GEOMETRY ─────────────────────────────────────
// One-time dev script (NOT wired into predev/prebuild — the output is committed).
// Downloads the f1-circuits GeoJSON (github.com/bacinger/f1-circuits, MIT), projects
// each circuit's lat/long centerline into a local metric frame, resamples it along a
// spline to a uniform ~2.5 m arc-length spacing (see resample() — the spline is not a
// cosmetic choice), and writes compact JSON into public/tracks/ so the packaged app
// can fetch them same-origin (the CSP blocks external hosts — same reason /ort/
// exists).
//
//   node scripts/fetch-tracks.mjs
//
// Output per circuit:  public/tracks/<slug>.json
//   { slug, source, spacing, closed, attribution, points: [[x, y, wRight, wLeft], …] }
//   x/y are centerline meters in a local frame centred on the circuit; wRight/wLeft are
//   track half-widths (m) either side of the centerline relative to the direction of
//   travel. Runtime alignment into the game's world frame happens in
//   src/lib/trackGeometry.js, which rejects fits worse than 12 m RMSE.
// Plus:  public/tracks/index.json  (coverage map + attribution)
//        public/tracks/LICENSE.txt (upstream license, shipped with the data)
//
// WHY THIS SOURCE: it was previously the TUMFTM racetrack-database, but that dataset
// predates several redesigns (it ships the pre-2021 21-corner Yas Marina, the pre-2023
// Barcelona, …) and covers only 16 of the 25 circuits the game visits. Measured against
// the TUMFTM centerlines this data agrees to ~2.5-5 m RMSE while also covering Monaco,
// Singapore, Baku, Jeddah, Miami, Las Vegas, Losail, Imola and Madring, all on their
// current layouts.
//
// WIDTHS: the GeoJSON has centerlines only. Circuits previously covered by TUMFTM reuse
// that dataset's median measured half-widths (baked into WIDTHS below); the rest fall
// back to NOMINAL_WIDTH. Widths only affect how wide the drawn road looks — the fit and
// the corner markers use the centerline.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { catmullRom } from "../src/lib/racingLine.js";
// The source dataset, the id→slug map and the projection are shared with
// fit-corners.mjs — see scripts/lib/f1circuits.mjs for why they must agree.
import { SRC, ATTRIBUTION, TRACKS, fetchText, toMetres } from "./lib/f1circuits.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = resolve(root, "public/tracks");

// Median measured half-widths (m) from the TUMFTM racetrack-database, kept because the
// GeoJSON carries centerlines only. Circuits absent here use NOMINAL_WIDTH.
const WIDTHS = {
  australia: [6.14, 6.10], austria: [5.45, 5.45], bahrain: [6.53, 6.44],
  belgium: [4.62, 4.68],   brazil: [5.93, 5.86],  canada: [4.50, 4.58],
  china: [6.43, 6.42],     hungary: [4.97, 4.95], italy: [4.51, 4.61],
  japan: [4.60, 4.57],     mexico: [5.85, 5.87],  netherlands: [4.81, 4.77],
  silverstone: [6.88, 6.87], spain: [5.39, 5.60], usa: [6.34, 6.67],
};
const NOMINAL_WIDTH = [6.0, 6.0];

const SPACING = 2.5;   // meters between resampled centerline points

// ─── Resampling ────────────────────────────────────────────────────────────────
// THE SOURCE IS COARSER THAN THE OUTPUT, and that is the whole reason this is a
// spline and not a lerp. The GeoJSON ways carry a vertex every 5-10 m through a
// corner; resampling them linearly puts the extra points ON THE CHORDS, so the
// output looks dense while its shape stays a polygon — measured on the first
// version of this file, 600+ points per lap turned by under 0.05° while individual
// ones turned as much as 56° in a single 2.5 m step. Invisible in the plan view,
// but the T-cam draws a corner from the seat and it arrived as flat panels.
//
// So interpolate BETWEEN the source vertices along a centripetal Catmull-Rom, the
// same curve src/lib/racingLine.js runs the drawn lines through — imported rather
// than re-typed, so the geometry and the app can't disagree about what a curve is.
// It passes through every surveyed vertex; only the invented points in between move.
const SUB = 16;   // spline samples per source segment — at 5-10 m spacing that's a
                  // sub-metre polyline, whose own chord error is a few mm

// The curve through a closed ring of [x, y] vertices, as a dense polyline.
export function spline(pts) {
  // A GeoJSON ring usually repeats its first vertex last. Left in, that's a
  // zero-length span, which collapses a centripetal knot and drops the join back
  // to a chord — the one corner in the lap that stays faceted.
  const ring = pts.length > 1 && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1]
    ? pts.slice(0, -1) : pts;
  const m = ring.length;
  const at = (i) => { const p = ring[((i % m) + m) % m]; return { x: p[0], z: p[1] }; };
  const out = [];
  for (let i = 0; i < m; i++) {
    for (let s = 0; s < SUB; s++) {
      const q = catmullRom(at(i - 1), at(i), at(i + 1), at(i + 2), s / SUB);
      out.push([q.x, q.z]);
    }
  }
  return out;
}

// Uniform arc-length resample around the closed loop. Walks the DENSE polyline, so
// the output keeps its exact uniform spacing (a spline is not unit-speed in its own
// parameter, and plenty of the app assumes these points are evenly spaced) while
// sitting on the curve rather than on the chords.
function resample(pts, spacing) {
  const curve = spline(pts);
  const loop = [...curve, curve[0]];
  const cum = [0];
  for (let i = 1; i < loop.length; i++) {
    const dx = loop[i][0] - loop[i - 1][0], dy = loop[i][1] - loop[i - 1][1];
    cum.push(cum[i - 1] + Math.hypot(dx, dy));
  }
  const total = cum[cum.length - 1];
  const out = [];
  let j = 1;
  for (let d = 0; d < total; d += spacing) {
    while (j < cum.length - 1 && cum[j] < d) j++;
    const t = (d - cum[j - 1]) / (cum[j] - cum[j - 1] || 1);
    out.push([
      loop[j - 1][0] + (loop[j][0] - loop[j - 1][0]) * t,
      loop[j - 1][1] + (loop[j][1] - loop[j - 1][1]) * t,
    ]);
  }
  return { points: out, total };
}

mkdirSync(outDir, { recursive: true });

const geo = JSON.parse(await fetchText(`${SRC}/f1-circuits.geojson`));
const byId = new Map(geo.features.map((f) => [f.properties.id, f]));

const license = await fetchText(`${SRC}/LICENSE.md`).catch(() => null);
if (license) writeFileSync(resolve(outDir, "LICENSE.txt"), license);
else console.warn("[fetch-tracks] could not fetch upstream LICENSE — add it manually");

const index = { _attribution: ATTRIBUTION, tracks: {} };

for (const [id, slug] of Object.entries(TRACKS)) {
  const feat = byId.get(id);
  if (!feat) { console.warn(`[fetch-tracks] ${slug}: ${id} not in dataset — skipped`); continue; }

  const metres = toMetres(feat.geometry.coordinates);
  const { points, total } = resample(metres, SPACING);
  const [wr, wl] = WIDTHS[slug] ?? NOMINAL_WIDTH;
  const nominal = !WIDTHS[slug];

  const rows = points.map(([x, y]) => [+x.toFixed(2), +y.toFixed(2), wr, wl]);
  const json = {
    slug,
    source: `f1-circuits ${id}`,
    spacing: SPACING,
    closed: true,
    attribution: ATTRIBUTION + (nominal ? " Track widths are nominal (not measured)." : ""),
    points: rows,
  };
  writeFileSync(resolve(outDir, `${slug}.json`), JSON.stringify(json));
  index.tracks[slug] = {
    file: `${slug}.json`,
    lengthM: Math.round(total),
    declaredM: feat.properties.length ?? null,
    points: rows.length,
    widths: nominal ? "nominal" : "measured",
  };
  console.log(
    `[fetch-tracks] ${slug.padEnd(12)} ${String(rows.length).padStart(4)} pts  ` +
    `${total.toFixed(0).padStart(5)} m (declared ${feat.properties.length ?? "?"})` +
    (nominal ? "  [nominal widths]" : "")
  );
}

writeFileSync(resolve(outDir, "index.json"), JSON.stringify(index, null, 2) + "\n");
console.log(`[fetch-tracks] wrote ${Object.keys(index.tracks).length} circuits to public/tracks/`);
