// ─── TRACK LABELS ─────────────────────────────────────────────────────────────
// One place that turns a raw track distance into the human label the driver
// actually thinks in: the corner/zone name when the point sits inside a named
// strategy zone (e.g. "T6 Hairpin"), otherwise the sector it falls in
// ("Sector 2") for broader advice. Every AI-facing finding (lap evidence,
// cross-lap trends, live position) runs through this so the coach speaks in
// corners and sectors, never metres.
//
// Returns a bound labeler: makeTrackLabeler({ zones, sectors, corners })(dist, lapLen).
//  • corners — optional [{ n, name, f }] real-world corner DB for the active track
//              (see cornerData.js). When supplied it takes priority, so the coach
//              speaks in real corner names ("T1 – Abbey") rather than generic zones.
//  • zones   — [{ name, start, end }] with start/end as lap fraction (0..1),
//              the same shape the rest of the app derives from the trace.
//  • sectors — optional [distance, …] sector-boundary distances from the trace
//              (meta.sectors); when absent we fall back to even thirds.
import { cornerLabel, nearestCorner } from "./cornerData.js";

export function makeTrackLabeler({ zones, sectors, corners } = {}) {
  const zs = Array.isArray(zones) ? zones : [];
  const cs = Array.isArray(corners) ? corners : [];
  const bounds = (Array.isArray(sectors) ? sectors : [])
    .filter((d) => typeof d === "number" && d > 0)
    .sort((a, b) => a - b);

  return function labelAt(dist, lapLen) {
    if (typeof dist !== "number" || !isFinite(dist)) return null;

    if (lapLen > 0) {
      const pct = dist / lapLen;
      // Real corner name from the curated DB wins ("T1 – Abbey").
      if (cs.length) {
        const c = nearestCorner(cs, pct);
        if (c) return cornerLabel(c);
      }
      // Otherwise the trace-derived strategy zone name.
      const z = zs.find((zn) => pct >= zn.start && pct <= zn.end);
      if (z?.name) return z.name;
    }

    // Otherwise name the sector — real boundaries when the trace carries them,
    // even thirds when it doesn't.
    if (bounds.length) {
      let n = 1;
      for (const b of bounds) if (dist > b) n++;
      return `Sector ${Math.min(n, bounds.length + 1)}`;
    }
    if (lapLen > 0) {
      return `Sector ${Math.min(3, Math.floor((dist / lapLen) * 3) + 1)}`;
    }
    return null;
  };
}
