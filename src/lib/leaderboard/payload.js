// ─── LEADERBOARD PAYLOAD ──────────────────────────────────────────────────────
// Turning a stored lap into something publishable, and turning a published trace
// back into a reference the app can use.
//
// The published shape is the SAME { meta, tyre, samples } object lib/lapExport.js
// writes to a file. That's deliberate: a downloaded reference flows through the
// exact code path a file-loaded one does, so there's no second import path to
// keep working, and a user can still save one to disk afterwards.
//
// Three differences from the file export, each with a reason:
//
//   • setup is OMITTED ENTIRELY — not null, absent. The file export asks "hide
//     your setup?" because a file is something you hand to one person you chose.
//     A board row is public and permanent, so there is no version of that
//     question worth asking; the answer is always no.
//   • meta gains the circuit identity and true lap length the validator needs.
//   • fuel is dropped (it says nothing about a push lap) and miniSectors kept
//     (the Live screen's per-slice comparison can use them).

import { sanitizeTraceSamples } from "../traceSamples.js";
import { boardIdForLap } from "./boardKey.js";

const APP_VERSION = typeof __APP_VERSION__ !== "undefined" ? __APP_VERSION__ : "0.0.0";

export const PAYLOAD_SCHEMA = 1;

// A lap → the object that gets gzipped and uploaded.
// Returns null when the lap has no board (the caller should have checked
// eligibility first; this is the backstop).
export function buildSubmission(lap) {
  if (!lap || !Array.isArray(lap.samples)) return null;
  const board = boardIdForLap(lap);
  if (!board.boardId) return null;

  // Round world positions to 10cm. They're only used to draw a racing line, the
  // recorder's own precision is nowhere near a millimetre, and at ~500 samples
  // the trimmed digits are several KB of every upload. `y` gets the same
  // treatment: it's published so a downloaded reference can drape elevation onto
  // the T-cam's road, and it would otherwise ride along at full float width —
  // sanitizeTraceSamples and this builder both SPREAD rather than whitelist, so a
  // new channel ships by default whether or not anyone meant it to.
  const samples = sanitizeTraceSamples(lap.samples).map((s) => {
    const out = { ...s };
    if (typeof out.x === "number") out.x = Math.round(out.x * 10) / 10;
    if (typeof out.y === "number") out.y = Math.round(out.y * 10) / 10;
    if (typeof out.z === "number") out.z = Math.round(out.z * 10) / 10;
    return out;
  });

  return {
    meta: {
      driver: lap.meta?.driver || "You",
      track: lap.meta?.track || null,
      sessionType: lap.meta?.sessionType || null,
      trackId: lap.meta?.trackId ?? null,
      trackSlug: board.slug,
      trackLengthM: lapLengthOf(lap),
      lapTime: lap.lapTime,
      sectorTimes: lap.sectorTimes || null,
      sampleCount: samples.length,
      // Conditions the lap ran in. Useful context on a board row and free to carry.
      ...(typeof lap.meta?.weather === "number" ? { weather: lap.meta.weather } : {}),
      ...(typeof lap.meta?.trackTemp === "number" ? { trackTemp: lap.meta.trackTemp } : {}),
      ...(typeof lap.meta?.airTemp === "number" ? { airTemp: lap.meta.airTemp } : {}),
      // Sector boundary distances, so a downloaded reference draws its sector
      // lines on the trace stack exactly as a local lap does.
      ...(lap.meta?.sectors ? { sectors: lap.meta.sectors } : {}),
      appVersion: APP_VERSION,
      schema: PAYLOAD_SCHEMA,
    },
    // Top level, NOT inside meta. lib/coach/refMatch.js reads lap.tyre first and
    // only falls back to meta.tyres text — put the compound in the wrong place
    // and the coach silently mutes itself against every downloaded reference.
    tyre: lap.tyre || null,
    miniSectors: lap.miniSectors || null,
    samples,
  };
}

// The circuit's true length for this lap. Laps recorded before that field existed
// fall back to the last sample rounded up to the next bin, which is up to 10m
// short — the validator's tolerance is set wide enough to absorb that.
export function lapLengthOf(lap) {
  if (lap?.meta?.trackLengthM > 0) return lap.meta.trackLengthM;
  const samples = lap?.samples;
  const last = Array.isArray(samples) && samples.length ? samples[samples.length - 1].dist : 0;
  return last > 0 ? Math.ceil(last / 10) * 10 : 0;
}

// ─── Compression ──────────────────────────────────────────────────────────────
// CompressionStream is native in WebView2 (Chromium) and in Deno, so the same
// API compresses here and decompresses in the Edge Function with no dependency.
// A ~500-sample lap goes from ~82KB of compact JSON to ~11KB.
//
// Note the JSON is stringified COMPACT here, unlike lib/lapExport.js which
// pretty-prints for a human to read. That alone is 72% of the bytes.

export async function gzipJson(obj) {
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  if (typeof CompressionStream === "undefined") return bytes; // uncompressed fallback
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function gunzipJson(bytes) {
  try {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
    return JSON.parse(await new Response(stream).text());
  } catch {
    return null;
  }
}

// ─── Download ─────────────────────────────────────────────────────────────────
// A published trace → the reference object the app's existing pipeline consumes.
// Sanitising is not optional: this is third-party data on its way to the coaching
// engine and the zone derivation that drives the voice calls.
export function traceToReference(json, { entry, boardId } = {}) {
  if (!json?.meta || !Array.isArray(json.samples)) return null;
  return {
    ...json,
    samples: sanitizeTraceSamples(json.samples),
    // Tagged so lapSourceLabel renders it as somebody else's published lap
    // rather than a trace loaded from disk.
    source: "leaderboard",
    ...(entry ? { entryId: entry.entryId, boardId } : {}),
  };
}
