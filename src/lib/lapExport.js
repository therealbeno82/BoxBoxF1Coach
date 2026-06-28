// ─── LAP EXPORT ───────────────────────────────────────────────────────────────
// Recorded laps live in memory only for the duration of a session. This helper
// lets the user explicitly save ONE chosen lap to a .json file they can keep or
// share. The file uses the same { meta, samples } shape the Trace Calibrator
// exports, so an exported lap re-imports through Setup → "Load trace JSON" and
// shows up as a comparison source — no special import path needed.

import { tyreCondition } from "./tyres.js";

// Lap time as a filename-safe, human-readable string, e.g. "1m27.345s". Windows
// forbids ':' in filenames so we can't reuse the on-screen "1:27.345" form.
function lapTimeLabel(sec) {
  if (!sec || sec <= 0) return "no-time";
  const m = Math.floor(sec / 60);
  const s = (sec % 60).toFixed(3).padStart(6, "0");
  return `${m}m${s}s`;
}

// Strip the characters Windows/macOS forbid in filenames and collapse whitespace,
// but keep spaces so each field of the name stays readable. Falls back when the
// field is empty so a position in the "A - B - C" name is never blank.
function fileSafe(s, fallback) {
  const out = String(s ?? "")
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return out || fallback;
}

export function exportLapToFile(lap) {
  if (!lap || !Array.isArray(lap.samples) || lap.samples.length === 0) return;

  const payload = {
    meta: {
      driver: lap.meta?.driver || "You",
      track:  lap.meta?.track  || "Live",
      sessionType: lap.meta?.sessionType || null, // coarse mode: Time Trial / Qualifying / …
      exportedAt: new Date().toISOString(),
      sampleCount: lap.samples.length,
      lapNumber: lap.lapNumber,
      lapTime: lap.lapTime,
      sectorTimes: lap.sectorTimes || null,
      source: lap.source || "live",
    },
    setup: lap.setup || null, // garage setup driven on this lap (null for older laps)
    tyre: lap.tyre || null,   // compound worn → preserves the dry/wet split on reload
    samples: lap.samples,
  };

  // Human-readable filename: Driver - Track - Session - Tyre - Lap Time.
  // tyreCondition buckets the compound to "wet"/"dry" (or null when untagged).
  const cond = tyreCondition(lap.tyre);
  const tyre = cond ? cond[0].toUpperCase() + cond.slice(1) : "Unknown";
  const name = [
    fileSafe(payload.meta.driver, "You"),
    fileSafe(payload.meta.track, "Track"),
    fileSafe(payload.meta.sessionType, "Session"),
    tyre,
    lapTimeLabel(payload.meta.lapTime),
  ].join(" - ") + ".json";

  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url  = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
