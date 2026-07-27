// ─── DEMO SESSION BUILDER ─────────────────────────────────────────────────────
// Converts a session export from the app's own lap log (Performance Center →
// Export session) into the compact replay file the Rust core plays back in Demo
// Mode, so "no game running" shows a REAL race instead of a synthetic sine wave.
//
//   node scripts/make-demo-session.mjs "<session-export.json>" [outFile]
//     outFile  default src-tauri/demo/session.json — committed data, compiled
//              into the exe by include_str!, so re-run the Rust build after
//              regenerating it.
//
// Why a build step rather than reading the export directly: the export is
// DISTANCE-binned (one sample per 10 m) and carries no time axis, no curvature
// and no forces — all things a replay needs to drive the UI *and* the FFB engine
// at 60 Hz. Deriving them here keeps the core's per-tick work to a lerp between
// two neighbouring samples.
//
// What is derived, and how honest it is:
//   • t        — real. Integrated as Σ dd/v from the recorded speed trace, then
//                scaled so the last sample lands exactly on the recorded lapTime.
//   • lg (lateral g) — real. Menger curvature of the recorded world path × v²,
//                signed to agree with the recorded steering.
//   • ag (long. g)   — real. dv/dt along that time axis.
//   • weather/temps  — INFERRED. The export never carried them, so conditions
//                come from the compound on the car (a stint on Intermediates was
//                a wet stint). Cosmetic only: the coach's dry/wet matching reads
//                the compound itself (lib/coach/refMatch.js).
// Everything else (inputs, speed, gear, ERS, tyre temps, world position, sector
// and lap times, setup, compound, age) is passed through untouched.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { TRACKS, getTrackByName } from "../src/lib/trackData.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const inFile = process.argv[2];
if (!inFile) {
  console.error('usage: node scripts/make-demo-session.mjs "<session-export.json>" [outFile]');
  process.exit(1);
}
const outFile = resolve(root, process.argv[3] || "src-tauri/demo/session.json");

const src = JSON.parse(readFileSync(resolve(inFile), "utf8"));
if (!Array.isArray(src.laps) || !src.laps.length) {
  console.error(`${inFile}: no laps in this file`);
  process.exit(1);
}

// The numeric m_sessionType the core forwards, from the export's label. Values
// are the buckets sessionTypeName() (src/lib/format.js) decodes back.
const SESSION_TYPE = {
  "practice": 2, "qualifying": 9, "sprint shootout": 12, "race": 15, "time trial": 18,
};
// Visual compound codes that mean wet rubber → the weather that put them on the
// car. See src/lib/tyres.js for the code table.
const WET_TYRE_WEATHER = { 7: 3, 8: 4, 10: 4, 15: 4 }; // Inter → Light Rain, Wet → Heavy Rain
const DRY = { weather: 0, trackTemp: 30, airTemp: 28 };
const WET = { trackTemp: 26, airTemp: 25 };

// The circuit as the game would report it: TRACKS is keyed by m_trackId, which is
// what the UI needs to load the right track map.
const track = getTrackByName(src.track);
const trackId = track ? Number(Object.entries(TRACKS).find(([, t]) => t === track)[0]) : -1;
if (!track) console.warn(`! unknown circuit "${src.track}" — trackId left at -1 (demo gets no track map)`);

const r = (v, n) => +(+v).toFixed(n);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// ─── Per-lap conversion ───────────────────────────────────────────────────────
// Returns null for a lap that can't be replayed (no time, too few samples).
function convertLap(lap) {
  const s = (lap.samples || []).filter((p) => Number.isFinite(p.dist) && Number.isFinite(p.speed));
  if (!(lap.lapTime > 0) || s.length < 10) return null;
  const n = s.length;

  // ── Time axis: dt = dd / v between neighbouring bins, scaled to the real lap
  // time. The 10 m trapezoid over-reads by ~2% through the braking zones, and
  // the first/last bins don't sit exactly on the line, so the scale absorbs both
  // and every replayed lap comes out at the time it was actually set.
  const t = new Float64Array(n);
  for (let i = 1; i < n; i++) {
    const dd = Math.max(0, s[i].dist - s[i - 1].dist);
    const v = Math.max(5, (s[i].speed + s[i - 1].speed) / 2) / 3.6; // m/s, floored so a stop can't stall
    t[i] = t[i - 1] + dd / v;
  }
  const raw = t[n - 1];
  const scale = raw > 0 ? lap.lapTime / raw : 1;
  for (let i = 0; i < n; i++) t[i] *= scale;

  // ── Lateral g from the recorded world path: Menger curvature over a ±20 m
  // window (2 bins either side — 10 m is inside the coordinate noise), × v².
  const W = 2;
  const kap = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = s[Math.max(0, i - W)], b = s[i], c = s[Math.min(n - 1, i + W)];
    if (![a.x, a.z, b.x, b.z, c.x, c.z].every(Number.isFinite)) continue;
    const abx = b.x - a.x, abz = b.z - a.z;
    const bcx = c.x - b.x, bcz = c.z - b.z;
    const acx = c.x - a.x, acz = c.z - a.z;
    const l = Math.hypot(abx, abz) * Math.hypot(bcx, bcz) * Math.hypot(acx, acz);
    kap[i] = l > 1e-6 ? (2 * (abx * bcz - abz * bcx)) / l : 0;
  }

  // ── Longitudinal g: central difference of speed along the time axis.
  const ag = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const p = Math.max(0, i - 1), q = Math.min(n - 1, i + 1);
    const dt = t[q] - t[p];
    ag[i] = dt > 1e-3 ? ((s[q].speed - s[p].speed) / 3.6) / dt / 9.81 : 0;
  }

  // ── Sector boundaries as distances, read off the time axis at the real sector
  // times. The export's meta.sectors are the game's own split *distances* only
  // when telemetry supplied them; deriving them here works for every session.
  const st = Array.isArray(lap.sectorTimes) ? lap.sectorTimes : [];
  const distAt = (time) => {
    if (!(time > 0)) return 0;
    let i = 0;
    while (i < n - 1 && t[i + 1] < time) i++;
    const span = t[i + 1] - t[i];
    const u = span > 1e-6 ? clamp((time - t[i]) / span, 0, 1) : 0;
    return s[i].dist + (s[Math.min(n - 1, i + 1)].dist - s[i].dist) * u;
  };

  const wetWeather = WET_TYRE_WEATHER[lap.tyre?.visual];
  return {
    lapNumber: lap.lapNumber ?? 0,
    lapTime: r(lap.lapTime, 3),
    invalid: !!lap.invalid,
    sectorTimes: st.map((x) => r(x, 3)),
    sector2Start: r(distAt(st[0]), 1),
    sector3Start: r(distAt((st[0] || 0) + (st[1] || 0)), 1),
    weather: wetWeather ?? DRY.weather,
    trackTemp: wetWeather ? WET.trackTemp : DRY.trackTemp,
    airTemp: wetWeather ? WET.airTemp : DRY.airTemp,
    tyre: { visual: lap.tyre?.visual ?? -1, actual: lap.tyre?.actual ?? -1, age: lap.tyre?.age ?? 0 },
    setup: lap.setup ?? null,
    // Short keys: 12k samples ship inside the exe, and the Rust side names them
    // (src-tauri/src/telemetry/demo.rs).
    samples: s.map((p, i) => ({
      t: r(t[i], 3), d: r(p.dist, 1),
      th: p.throttle ?? 0, br: p.brake ?? 0, st: p.steer ?? 0, sp: r(p.speed, 1),
      g: p.gear ?? 0, em: p.ersMode ?? 0, ek: r(p.ersSpent ?? 0, 0),
      bo: p.boost ? 1 : 0, ae: p.aeroMode ?? 0,
      ts: p.tyreSurf ?? 0, tc: p.tyreCarc ?? 0,
      x: Number.isFinite(p.x) ? r(p.x, 1) : 0,
      y: Number.isFinite(p.y) ? r(p.y, 1) : 0,
      z: Number.isFinite(p.z) ? r(p.z, 1) : 0,
      // v²κ in g, capped — the sign is calibrated against steering below.
      lg: r(clamp(kap[i] * (p.speed / 3.6) ** 2 / 9.81, -6, 6), 2),
      ag: r(clamp(ag[i], -6, 6), 2),
    })),
  };
}

const laps = src.laps.map(convertLap).filter(Boolean);
if (!laps.length) {
  console.error("no replayable laps (each needs a lapTime and ≥10 samples)");
  process.exit(1);
}
const dropped = src.laps.length - laps.length;

// ─── Curvature sign calibration ───────────────────────────────────────────────
// The (x, z) cross product is consistent lap to lap but its sign relative to the
// game's steering convention is not knowable up front, so measure it: if turning
// right (positive steer) came out negative, flip the whole session.
let agree = 0;
for (const lap of laps) for (const p of lap.samples) if (Math.abs(p.st) > 10) agree += Math.sign(p.lg) * p.st;
if (agree < 0) for (const lap of laps) for (const p of lap.samples) p.lg = p.lg === 0 ? 0 : -p.lg;

// Track length: the S/F line sits just past the last bin of a lap.
const maxDist = Math.max(...laps.flatMap((l) => l.samples.map((p) => p.d)));
const trackLength = Math.round(maxDist) + 1;

const out = {
  kind: "f1coach-demo-session",
  version: 1,
  // Provenance — this is a real session, recorded by the app's own lap log.
  source: basename(inFile),
  recordedAt: src.exportedAt ?? null,
  driver: src.driver ?? "Demo Driver",
  track: src.track ?? null,
  trackId,
  trackLength,
  sessionType: SESSION_TYPE[String(src.sessionType ?? "").toLowerCase()] ?? 15,
  laps,
};

mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, JSON.stringify(out));

const total = laps.reduce((a, l) => a + l.lapTime, 0);
const peakG = Math.max(...laps.flatMap((l) => l.samples.map((p) => Math.abs(p.lg))));
console.log(`${basename(outFile)}: ${laps.length} laps${dropped ? ` (${dropped} unreplayable, skipped)` : ""}`);
console.log(`  ${out.driver} · ${out.track} (id ${out.trackId}, ${trackLength} m) · session type ${out.sessionType}`);
console.log(`  ${laps.reduce((a, l) => a + l.samples.length, 0)} samples · ${(total / 60).toFixed(1)} min of replay · peak ${peakG.toFixed(1)} g`);
console.log(`  ${(JSON.stringify(out).length / 1e6).toFixed(2)} MB → ${outFile}`);
