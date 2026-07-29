// ─── LAP EXPORT ───────────────────────────────────────────────────────────────
// Recorded laps live in memory only for the duration of a session. This helper
// lets the user explicitly save ONE chosen lap to a .json file they can keep or
// share. The file uses the same { meta, samples } shape the Trace Calibrator
// exports, so an exported lap re-imports through Setup → "Load trace JSON" and
// shows up as a comparison source — no special import path needed.
//
// exportSessionToFile / parseSessionFile handle the OTHER grain: a whole session
// of laps (e.g. a full race) saved to one file and reloaded into the Live screen's
// Session Laps panel to review later. Those keep every lap's full stored shape
// (samples, sectors, mini-sectors, setup, tyre) so the reloaded session drives the
// same sector colours, Compare traces and coaching as it did live.

import { tyreCondition } from "./tyres.js";
import { inTauri } from "./env.js";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";

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
export function fileSafe(s, fallback) {
  const out = String(s ?? "")
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return out || fallback;
}

// `hideSetup` lets the user share telemetry without disclosing their garage
// loadout — the exported file then carries no setup block at all.
// Async: opens a native Save dialog (see saveJson). Resolves true if the file
// was written, false if there was nothing to save or the user cancelled.
export async function exportLapToFile(lap, { hideSetup = false } = {}) {
  if (!lap || !Array.isArray(lap.samples) || lap.samples.length === 0) return false;

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
    setup: hideSetup ? null : (lap.setup || null), // garage setup driven on this lap (null for older laps or when hidden)
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

  return saveJson(payload, name);
}

// Save `payload` as pretty-printed JSON. Inside the Tauri app this opens a native
// "Save As" dialog (default filename `name`) so the driver picks the folder, then
// writes there via the write_text_file command. In a plain browser (`npm run dev`,
// no IPC) it falls back to the old anchor-download into the Downloads folder.
// Resolves true if a file was written, false if the user cancelled the dialog.
export async function saveJson(payload, name) {
  const text = JSON.stringify(payload, null, 2);
  if (inTauri) {
    try {
      const path = await save({
        defaultPath: name,
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (!path) return false; // dialog cancelled
      await invoke("write_text_file", { path, contents: text });
      return true;
    } catch (e) {
      console.error("Save failed:", e);
      return false;
    }
  }
  downloadJson(text, name);
  return true;
}

// Trigger a browser anchor-download of `text` as a file named `name`. The web-only
// fallback for saveJson; the packaged app uses the native Save dialog instead.
function downloadJson(text, name) {
  const blob = new Blob([text], { type: "application/json" });
  const url  = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// ─── SESSION EXPORT / IMPORT ──────────────────────────────────────────────────
// A whole session of laps in one file. Unlike exportLapToFile (one lap, shared as a
// reference trace), this keeps every lap's full stored shape so the session can be
// reloaded into the Live screen and reviewed exactly as it was driven.

const SESSION_KIND = "f1coach-session";
const SESSION_VERSION = 1;

// Save every lap in `laps` to a single .json file via the native Save dialog.
// Async. Resolves false when there's nothing to save OR the user cancelled the
// dialog, true once written. Filename: Driver - Track - Session - N laps - date.
export async function exportSessionToFile(laps, { driver, track, sessionType } = {}) {
  if (!Array.isArray(laps) || laps.length === 0) return false;

  const payload = {
    kind: SESSION_KIND,
    version: SESSION_VERSION,
    exportedAt: new Date().toISOString(),
    driver: driver || laps[0]?.meta?.driver || "You",
    track: track || laps[0]?.meta?.track || "Live",
    sessionType: sessionType || laps[0]?.meta?.sessionType || null,
    lapCount: laps.length,
    // Laps keep their exact stored shape (id, lapNumber, lapTime, sectorTimes,
    // miniSectors, invalid, source, meta, setup, tyre, samples). Ids are re-minted
    // on load, so a duplicate here never clobbers an existing lap.
    laps,
  };

  const dateTag = new Date().toLocaleDateString("en-CA"); // YYYY-MM-DD, filename-safe
  const name = [
    fileSafe(payload.driver, "You"),
    fileSafe(payload.track, "Track"),
    fileSafe(payload.sessionType, "Session"),
    `${payload.lapCount} laps`,
    dateTag,
  ].join(" - ") + ".json";

  return saveJson(payload, name);
}

// Parse a session .json file's text into its laps array. Throws with a readable
// message on anything that isn't a valid session export, so the caller can surface
// it. Accepts only files written by exportSessionToFile (kind + laps[] required).
export function parseSessionLaps(text) {
  let json;
  try { json = JSON.parse(text); }
  catch { throw new Error("Could not parse the file — it isn't valid JSON."); }

  if (!json || json.kind !== SESSION_KIND || !Array.isArray(json.laps)) {
    throw new Error("Not an F1 Coach session file — use “Save Session” to create one.");
  }
  const laps = json.laps.filter(
    (l) => l && typeof l.lapTime === "number" && Array.isArray(l.samples));
  if (!laps.length) throw new Error("This session file has no usable laps.");
  return laps;
}
