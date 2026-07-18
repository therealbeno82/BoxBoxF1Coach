// ─── FORMAT HELPERS ───────────────────────────────────────────────────────────
// Clamp a number to [lo, hi]. Shared so every screen doesn't mint its own copy.
export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// Number of live mini-sectors the lap is split into for the Live screen's S1/S2/S3
// cards — MINI_PER_SECTOR equal lap-fraction slices per main sector. Shared so the
// recorder (which stamps boundary times) and the UI (which lays out the pips) agree.
export const MINI_PER_SECTOR = 6;
export const MINI_SECTORS = MINI_PER_SECTOR * 3; // 18 slices across the whole lap

// Shared lap-time formatting, the single source of truth for the "m:ss.x" radio
// readout used across the prompts, the session lap log, and the Compare view.
// `decimals` controls the seconds precision — 1 for compact logs/prompts, 3 for
// the MoTeC-style Compare/sector view. Returns "—" for null/NaN so callers can
// render it unconditionally.
export function formatLapTime(seconds, decimals = 1) {
  if (seconds == null || Number.isNaN(seconds)) return "—";
  const m = Math.floor(seconds / 60);
  const sec = (seconds % 60).toFixed(decimals).padStart(decimals + 3, "0"); // 2 int digits + "." + decimals
  return `${m}:${sec}`;
}

// Convert a km/h speed to the active unit and round to an integer. The telemetry core
// always reports km/h (m_speed); the UI can show km/h or mph (a user pref).
// Returns the numeric value — callers append the unit label themselves.
export function toSpeed(kmh, units = "km/h") {
  if (typeof kmh !== "number" || Number.isNaN(kmh)) return 0;
  return Math.round(units === "mph" ? kmh * 0.621371 : kmh);
}

// The unit label for the active speed unit.
export function speedUnitLabel(units = "km/h") {
  return units === "mph" ? "mph" : "km/h";
}

// Convert a Celsius tyre temp to the active unit and round to an integer. The
// telemetry core always reports °C; the UI can show °C or °F (a user pref).
export function toTemp(celsius, tempUnits = "°C") {
  if (typeof celsius !== "number" || Number.isNaN(celsius)) return NaN;
  return Math.round(tempUnits === "°F" ? celsius * 9 / 5 + 32 : celsius);
}

// The unit symbol for the active temperature unit.
export function tempUnitLabel(tempUnits = "°C") {
  return tempUnits === "°F" ? "°F" : "°C";
}

// ─── SPEAKABLE TEXT ───────────────────────────────────────────────────────────
// Expand unit abbreviations and symbols into full words right before text is
// handed to a TTS engine (Kokoro or the browser's Web Speech). Engines spell out
// symbol clusters like "km/h" letter-by-letter ("kay em aitch"); rewriting them
// here is the reliable fix — the synthesiser never sees the abbreviation. This is
// the single chokepoint, so it covers real-time corner calls (which never touch
// the LLM) as well as LLM replies. Order matters: do the longer/slash forms first.
// Note: acronyms we WANT spelled out (DRS, ERS, RPM) are deliberately left alone.
export function speakable(text) {
  if (!text) return text;
  // Units are often glued to a digit ("280km/h"), where \b fails (no letter↔
  // non-letter transition between "0" and "k"). Lookarounds for "not a letter"
  // match both the spaced and glued forms.
  return text
    .replace(/(?<![a-z])km\/h(?![a-z])/gi, " kilometres per hour")
    .replace(/(?<![a-z])kph(?![a-z])/gi,   " kilometres per hour")
    .replace(/(?<![a-z])mph(?![a-z])/gi,   " miles per hour")
    .replace(/(?<![a-z])m\/s(?![a-z])/gi,  " metres per second")
    .replace(/(\d)\s*°\s*C\b/g, "$1 degrees")     // "90°C" / "90 °C" → "90 degrees"
    .replace(/(\d)\s*°/g,    "$1 degrees")          // bare degrees (track/air temp)
    .replace(/(\d)\s*%/g,    "$1 percent")
    .replace(/\bsec(s)?\b/gi, "seconds")
    .replace(/\bmins\b/gi,   "minutes")
    .replace(/\bavg\b/gi,    "average")
    .replace(/\bvs\.?\b/gi,  "versus")
    .replace(/(\d)\s*kg\b/gi, "$1 kilograms")
    .replace(/(\d)\s*m\b/g,  "$1 metres")           // "150m braking" → "150 metres" (digit-anchored)
    .replace(/ {2,}/g, " ");                         // collapse the spaces the glued-unit fixes introduce
}

// Coarse session-type label for the numeric m_sessionType the telemetry core forwards
// (F1 25/26 Format 2025 numbering). Granular Q1/Q2/Q3 and Sprint Shootout
// variants collapse into one bucket so the dashboard groups laps as the driver
// thinks of them — "Qualifying", "Time Trial", "Practice", "Race". Returns null
// for unset/unknown so callers can omit the split.
export function sessionTypeName(n) {
  if (typeof n !== "number" || n <= 0) return null;
  if (n <= 4) return "Practice";
  if (n <= 9) return "Qualifying";
  if (n <= 14) return "Sprint Shootout";
  if (n <= 17) return "Race";
  if (n === 18) return "Time Trial";
  return null;
}

// ─── 2026 BOOST / ACTIVE AERO LABELS ─────────────────────────────────────────
// One state→label mapping shared by the Live screen's status ribbon and the
// coach prompts (lib/coach/prompts.js), so the voice coach never describes a
// boost/aero state that contradicts what the driver sees on screen.
export function boostStateName(tel = {}) {
  return tel.overtakeActive ? "DEPLOYING" : tel.overtakeAvailable ? "READY" : "—";
}
// "Straight" = low-drag wing mode, "Corner" = high-downforce; "—" until the
// game reports active aero as available.
export function aeroModeName(tel = {}) {
  if (!tel.activeAeroAvailable) return "—";
  return tel.activeAeroMode ? "Straight" : "Corner";
}
