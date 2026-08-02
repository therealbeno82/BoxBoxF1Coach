// ─── LEADERBOARD VALIDATOR CALIBRATION ────────────────────────────────────────
// Measures how well a lap's own speed trace reconstructs its recorded lap time,
// which is what the online leaderboard's anti-tamper check leans on. Prints the
// distribution so the integralRatio* window in src/lib/leaderboard/limits.js can
// be set from data rather than guessed at.
//
// Run it whenever you want to re-check that window — especially against laps you
// actually drove, since the committed default was calibrated on the demo session,
// which is resampled replay data rather than raw recorder output.
//
//   node scripts/calibrate-leaderboard.mjs                      # the demo session
//   node scripts/calibrate-leaderboard.mjs "path/to/session.json"   # a "Save Session" export
//
// A session export comes out of the Live screen's "Save Session" button and keeps
// every lap's full stored shape, which is exactly what this needs.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..");

const { integrateLapTime } = await import(
  pathToFileURL(path.join(repo, "src/lib/leaderboard/validate.js")).href);
const { THRESHOLDS } = await import(
  pathToFileURL(path.join(repo, "src/lib/leaderboard/limits.js")).href);

const target = process.argv[2] || path.join(repo, "src-tauri/demo/session.json");
const raw = JSON.parse(fs.readFileSync(target, "utf8"));

// Two input shapes. The demo replay uses short keys and carries a session-level
// track length; a "Save Session" export keeps the recorder's own lap shape.
function normalise(file) {
  if (file.kind === "f1coach-session") {
    return {
      label: `${file.track} · ${file.sessionType} · ${file.laps.length} laps`,
      laps: file.laps.map((l) => ({
        lapNumber: l.lapNumber, lapTime: l.lapTime, invalid: l.invalid,
        // A lap only knows its own length if it was recorded after that field
        // existed; otherwise the tail correction has to be skipped.
        trackLengthM: l.meta?.trackLengthM ?? null,
        wet: (l.tyre?.visual === 7 || l.tyre?.visual === 8),
        samples: l.samples,
      })),
    };
  }
  // Demo replay format (scripts/make-demo-session.mjs).
  return {
    label: `${raw.track} · demo replay · ${file.laps.length} laps`,
    laps: file.laps.map((l) => ({
      lapNumber: l.lapNumber, lapTime: l.lapTime, invalid: l.invalid,
      trackLengthM: file.trackLength ?? null,
      wet: (l.tyre?.visual === 7 || l.tyre?.visual === 8),
      samples: l.samples.map((s) => ({ dist: s.d, speed: s.sp })),
    })),
  };
}

const { label, laps } = normalise(raw);
console.log(`\n${label}\n`);

const rows = [];
for (const lap of laps) {
  if (!(lap.lapTime > 0) || !Array.isArray(lap.samples) || lap.samples.length < 50) continue;
  const derived = integrateLapTime(lap.samples, lap.trackLengthM);
  if (derived == null) continue;
  const ratio = derived / lap.lapTime;
  // An out-lap starts well past the line and can't reconstruct; the real
  // validator rejects it on coverage long before it reaches this check, so it
  // would only skew the calibration.
  const partial = lap.samples[0].dist > THRESHOLDS.firstDistMaxM;
  rows.push({ ...lap, derived, ratio, partial });
}

for (const r of rows) {
  const tags = [r.partial && "partial", r.invalid && "invalid", r.wet && "wet"].filter(Boolean);
  console.log(
    `  lap ${String(r.lapNumber).padStart(2)}` +
    `  claimed ${r.lapTime.toFixed(3)}s  derived ${r.derived.toFixed(3)}s` +
    `  ratio ${r.ratio.toFixed(4)}` +
    (tags.length ? `   [${tags.join(", ")}]` : ""));
}

const usable = rows.filter((r) => !r.partial).map((r) => r.ratio).sort((a, b) => a - b);
if (!usable.length) {
  console.log("\nNo complete laps to calibrate from.\n");
  process.exit(0);
}
const at = (q) => usable[Math.min(usable.length - 1, Math.floor(q * usable.length))];
console.log(`\n  ${usable.length} complete laps`);
console.log(`  ratio  min ${usable[0].toFixed(4)}  p50 ${at(0.5).toFixed(4)}  p95 ${at(0.95).toFixed(4)}  max ${usable[usable.length - 1].toFixed(4)}`);
console.log(`  current pass window  ${THRESHOLDS.integralRatioPassMin} – ${THRESHOLDS.integralRatioPassMax}`);
console.log(`  current accept window ${THRESHOLDS.integralRatioMin} – ${THRESHOLDS.integralRatioMax}`);

const outside = usable.filter((r) => r < THRESHOLDS.integralRatioPassMin || r > THRESHOLDS.integralRatioPassMax).length;
const rejected = usable.filter((r) => r < THRESHOLDS.integralRatioMin || r > THRESHOLDS.integralRatioMax).length;
console.log(`\n  would flag ${outside}/${usable.length}, reject ${rejected}/${usable.length} of these genuine laps`);
if (rejected) console.log("  ⚠ the accept window is rejecting real laps — widen it.");

// How big an edit would this window actually catch?
const median = at(0.5);
const shave = (s) => {
  const worst = Math.max(...usable);
  return worst / (1 - s) > THRESHOLDS.integralRatioMax;
};
for (const pct of [0.02, 0.03, 0.05, 0.10]) {
  console.log(`  a ${(pct * 100).toFixed(0)}% shaved lap time would be ${shave(pct) ? "REJECTED" : "missed"}`);
}
console.log(`  (median genuine ratio ${median.toFixed(4)})\n`);
