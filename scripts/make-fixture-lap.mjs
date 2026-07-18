// ─── SYNTHETIC FIXTURE LAP (dev verification for the Driving Lines tab) ────────
// Builds an importable trace JSON from a bundled real circuit so the track-fitting
// pipeline can be exercised without driving: it synthesizes a plausible racing line
// from the circuit's centerline + widths, then maps it through a KNOWN rotation /
// translation / mirror to simulate the game's world frame. If trackGeometry's
// alignment is correct, the fitted road will land exactly under this line (console
// logs the RMSE) with the line kissing the inside curbs at apexes.
//
//   node scripts/make-fixture-lap.mjs [slug] [outFile] [trackLabel]
//     slug       default "silverstone" (must exist in public/tracks/)
//     outFile    default "public/dev-fixture-lap.json"  (dev-only — do not commit)
//     trackLabel default capitalized slug; use e.g. "Monaco" to test the
//                heuristic-fallback path with real-looking data.
//
// Load it via Performance Center → reference selector → "Load trace JSON".

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const slug = process.argv[2] || "silverstone";
const outFile = resolve(root, process.argv[3] || "public/dev-fixture-lap.json");
const trackLabel = process.argv[4] || slug[0].toUpperCase() + slug.slice(1);

// The known "game world" transform the fitter must recover.
const THETA = (37 * Math.PI) / 180;
const TX = 840, TZ = -1200;
const MIRROR = true;

const { points, spacing } = JSON.parse(
  readFileSync(resolve(root, `public/tracks/${slug}.json`), "utf8"));
const n = points.length;

// Smoothed signed curvature of the centerline (same convention as trackGeometry:
// (x, z) plane cross product, neighbours ±6 m).
const step = Math.max(2, Math.round(6 / spacing));
const kap = new Array(n);
for (let i = 0; i < n; i++) {
  const a = points[(i - step + n) % n], b = points[i], c = points[(i + step) % n];
  const abx = b[0] - a[0], abz = b[1] - a[1];
  const bcx = c[0] - b[0], bcz = c[1] - b[1];
  const acx = c[0] - a[0], acz = c[1] - a[1];
  const l = Math.hypot(abx, abz) * Math.hypot(bcx, bcz) * Math.hypot(acx, acz);
  kap[i] = l > 1e-6 ? (2 * (abx * bcz - abz * bcx)) / l : 0;
}
const blur = (v, hw, passes) => {
  let out = v.slice();
  for (let p = 0; p < passes; p++) {
    const nx = new Array(n);
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let d = -hw; d <= hw; d++) s += out[(i + d + n) % n];
      nx[i] = s / (2 * hw + 1);
    }
    out = nx;
  }
  return out;
};
const kSm = blur(kap, Math.round(12 / spacing) * 2, 2);

// Racing line: offset from the centerline toward the corner INSIDE by saturated
// curvature (inside is the −n side when k > 0, matching trackGeometry's convention),
// leaving ~1.5 m to the edge. Straights stay near the middle.
const KSAT = 1 / 55;
const line = [];
for (let i = 0; i < n; i++) {
  const a = points[(i - 1 + n) % n], c = points[(i + 1) % n];
  let tx = c[0] - a[0], tz = c[1] - a[1];
  const tl = Math.hypot(tx, tz) || 1;
  tx /= tl; tz /= tl;
  const nx = tz, nz = -tx; // left of travel
  const sat = Math.max(-1, Math.min(1, kSm[i] / KSAT));
  const wIns = sat > 0 ? points[i][2] : points[i][3]; // k>0 → inside on the right (wr)
  const off = -sat * Math.max(0, wIns - 1.5);
  line.push({ x: points[i][0] + nx * off, z: points[i][1] + nz * off, sat: Math.abs(sat) });
}

// Map into the fake game frame: mirror → rotate → translate; add gentle elevation.
const cosT = Math.cos(THETA), sinT = Math.sin(THETA);
let dist = 0, time = 0;
const samples = [];
const OUT_EVERY = Math.max(1, Math.round(10 / spacing)); // ~10 m bins like real capture
let prev = null;
let prevSpeed = 0; // km/h at the previous sample — integrates segment time below
for (let i = 0; i < n; i++) {
  const p = line[i];
  const mz = MIRROR ? -p.z : p.z;
  const wx = cosT * p.x - sinT * mz + TX;
  const wz = sinT * p.x + cosT * mz + TZ;
  if (prev) {
    const d = Math.hypot(wx - prev.x, wz - prev.z);
    dist += d;
    time += d / Math.max(1, prevSpeed / 3.6);
  }
  const speed = Math.max(62, 318 * (1 - 0.74 * p.sat)); // km/h, slow in corners
  prevSpeed = speed;
  if (i % OUT_EVERY === 0) {
    const frac = dist;
    samples.push({
      dist: Math.round(dist * 10) / 10,
      x: Math.round(wx * 100) / 100,
      z: Math.round(wz * 100) / 100,
      y: Math.round((6 * Math.sin((frac / 900)) + 3 * Math.sin(frac / 260 + 1)) * 100) / 100,
      speed: Math.round(speed),
      throttle: p.sat > 0.25 ? Math.round(30 + 50 * (1 - p.sat)) : 100,
      brake: p.sat > 0.55 ? Math.round(60 * p.sat) : 0,
      gear: Math.max(2, Math.min(8, Math.round(8 - 5 * p.sat))),
      steer: Math.round(60 * (kSm[i] / KSAT > 1 ? 1 : kSm[i] / KSAT * -1) * -1),
    });
  }
  prev = { x: wx, z: wz };
}

const lapTime = Math.round(time * 1000) / 1000;
const fixture = {
  meta: { driver: "Fixture", track: trackLabel, date: new Date().toISOString().slice(0, 10) },
  lapTime,
  sectorTimes: [lapTime * 0.34, lapTime * 0.33, lapTime * 0.33].map((s) => Math.round(s * 1000) / 1000),
  samples,
};
writeFileSync(outFile, JSON.stringify(fixture));
console.log(`[fixture] ${trackLabel} (${slug}): ${samples.length} samples, ${Math.round(dist)} m, ` +
  `${lapTime.toFixed(1)} s → ${outFile}`);
console.log(`[fixture] injected transform: theta=37°, t=(${TX}, ${TZ}), mirror=${MIRROR}`);
