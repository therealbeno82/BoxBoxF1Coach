// ─── LAP → TRACE META ─────────────────────────────────────────────────────────
// The `meta` block of the { meta, tyre, samples } trace shape, built from a
// stored lap. Two writers produce that shape — the file export (lapExport.js)
// and the leaderboard upload (leaderboard/payload.js) — and they had drifted:
// the file export left out the circuit identity, the true lap length, the
// sector boundary distances, the conditions and the game's invalid flag, so a
// lap saved to disk and loaded back as a reference lost its sector lines on the
// trace stack and its labels in the debrief, and an invalidated lap came back
// looking clean. One builder means a field added for one path reaches both.
//
// Optional fields are OMITTED rather than written as null when the lap doesn't
// carry them, so an older lap exports exactly what it knows and nothing more.

export function lapTraceMeta(lap) {
  const m = lap?.meta || {};
  return {
    driver: m.driver || "You",
    track: m.track || null,
    sessionType: m.sessionType || null,
    ...(m.trackId != null ? { trackId: m.trackId } : {}),
    ...(m.trackSlug ? { trackSlug: m.trackSlug } : {}),
    ...(m.trackLengthM > 0 ? { trackLengthM: m.trackLengthM } : {}),
    lapTime: lap?.lapTime,
    sectorTimes: lap?.sectorTimes || null,
    ...(lap?.invalid ? { invalid: true } : {}),
    // Conditions the lap ran in.
    ...(typeof m.weather === "number" ? { weather: m.weather } : {}),
    ...(typeof m.trackTemp === "number" ? { trackTemp: m.trackTemp } : {}),
    ...(typeof m.airTemp === "number" ? { airTemp: m.airTemp } : {}),
    // Sector boundary distances, so a reloaded or downloaded reference draws its
    // sector lines on the trace stack exactly as a local lap does.
    ...(m.sectors ? { sectors: m.sectors } : {}),
  };
}
