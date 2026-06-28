// ─── DRIVER STATS ─────────────────────────────────────────────────────────────
// Aggregates one driver's persisted laps (lapStore shape) into the numbers the
// Dashboard home page shows: personal-best lap overall and per session type
// (Time Trial / Qualifying / …), totals, per-track bests with theoretical-optimal
// sectors, and a recent-laps list. Pure + side-effect-free so it can run inside a
// useMemo; the UI does all formatting (via formatLapTime).
//
// Laps carry meta { driver, track, sessionType (coarse label), sessionId } and the
// usual { lapTime, sectorTimes:[s1,s2,s3]|null, recordedAt }.

import { tyreCondition } from "./tyres.js";

const hasTime = (l) => typeof l?.lapTime === "number" && l.lapTime > 0;

// Bucket a lap by the rubber it was set on. Laps recorded before tyre data was
// collected (or with no compound) have an unknown condition — fold them into the
// dry bucket so existing personal bests stay visible; dry is the default racing
// condition and almost all legacy laps are dry.
const conditionOf = (l) => tyreCondition(l?.tyre) ?? "dry";

// Session types we always want to surface as their own slot, in this order, even
// when other types also have laps. Matches sessionTypeName's coarse buckets.
export const FEATURED_SESSION_TYPES = ["Time Trial", "Qualifying"];

export function computeDriverStats(laps = [], opts = {}) {
  const recentCount = opts.recent || 10;
  const valid = laps.filter(hasTime);
  const byTimeAsc = [...valid].sort((a, b) => a.lapTime - b.lapTime);

  const fastestOverall = byTimeAsc[0] || null;

  // Fastest lap per coarse session type — first hit wins since the list is sorted
  // ascending by lap time.
  const typeMap = new Map();
  for (const l of byTimeAsc) {
    const t = l.meta?.sessionType;
    if (t && !typeMap.has(t)) typeMap.set(t, l);
  }
  // Featured types first (in declared order), then any remaining types fastest-first.
  const fastestBySessionType = [];
  for (const t of FEATURED_SESSION_TYPES) {
    if (typeMap.has(t)) { fastestBySessionType.push({ type: t, lap: typeMap.get(t) }); typeMap.delete(t); }
  }
  for (const [type, lap] of [...typeMap.entries()].sort((a, b) => a[1].lapTime - b[1].lapTime)) {
    fastestBySessionType.push({ type, lap });
  }

  // Per-track personal best + theoretical-optimal sectors (min of each sector
  // across that track's laps — the "perfect lap" the driver chases).
  const trackMap = new Map();
  for (const l of valid) {
    const track = l.meta?.track || "Unknown";
    let e = trackMap.get(track);
    if (!e) { e = { track, best: l, bestDry: null, bestWet: null, optimal: [null, null, null] }; trackMap.set(track, e); }
    if (l.lapTime < e.best.lapTime) e.best = l;
    // Separate dry vs wet personal bests so a lap set on Inters/Wets is ranked
    // against other wet laps, never against a dry PB it could never beat.
    const cond = conditionOf(l); // "dry" | "wet"
    if (!e[cond === "wet" ? "bestWet" : "bestDry"] || l.lapTime < e[cond === "wet" ? "bestWet" : "bestDry"].lapTime) {
      e[cond === "wet" ? "bestWet" : "bestDry"] = l;
    }
    if (Array.isArray(l.sectorTimes)) {
      for (let i = 0; i < 3; i++) {
        const s = l.sectorTimes[i];
        if (typeof s === "number" && s > 0 && (e.optimal[i] == null || s < e.optimal[i])) e.optimal[i] = s;
      }
    }
  }
  const perTrackBest = [...trackMap.values()].sort((a, b) => a.best.lapTime - b.best.lapTime);

  // Per-track personal best within each featured session type, for the
  // dashboard's category PB tables (Time Trial / Qualifying). One best lap per
  // track per category, fastest-first; the lap itself is carried so the row can
  // show its sectors, tyre and date.
  const catMaps = new Map(FEATURED_SESSION_TYPES.map((t) => [t, new Map()]));
  for (const l of valid) {
    const m = catMaps.get(l.meta?.sessionType);
    if (!m) continue;
    const track = l.meta?.track || "Unknown";
    const e = m.get(track);
    if (!e || l.lapTime < e.lapTime) m.set(track, l);
  }
  const perCategoryBest = FEATURED_SESSION_TYPES.map((type) => ({
    type,
    tracks: [...catMaps.get(type).values()].sort((a, b) => a.lapTime - b.lapTime),
  }));

  // Totals — distinct sessionId = number of drive sessions (laps without one are
  // still counted toward total laps, just not toward sessions).
  const sessions = new Set();
  for (const l of laps) { const s = l.meta?.sessionId; if (s) sessions.add(s); }
  const totals = { laps: laps.length, sessions: sessions.size };

  // Recent laps, newest first, each tagged with its gap to the same-track best so
  // the list reads like a timing screen.
  const recent = [...laps]
    .sort((a, b) => (b.recordedAt || 0) - (a.recordedAt || 0))
    .slice(0, recentCount)
    .map((l) => {
      const track = l.meta?.track || "Unknown";
      const best = trackMap.get(track)?.best;
      const gap = hasTime(l) && best ? l.lapTime - best.lapTime : null;
      return { lap: l, gap };
    });

  // Theoretical-best sectors for the overall-fastest lap's track.
  const fastTrack = fastestOverall ? trackMap.get(fastestOverall.meta?.track || "Unknown") : null;

  return {
    fastestOverall,
    fastestBySessionType,
    perTrackBest,
    perCategoryBest,
    totals,
    recent,
    bestSectors: fastTrack ? fastTrack.optimal : [null, null, null],
    bestSectorsTrack: fastTrack?.track || null,
    hasLaps: valid.length > 0,
  };
}
