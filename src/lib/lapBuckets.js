// ─── LAP BUCKETS ──────────────────────────────────────────────────────────────
// Splits a track's saved laps into comparable groups before any coaching maths
// touches them. A qualifying lap on new softs and a race lap on old hards are not
// the same experiment: fuel load, ERS strategy and rubber all differ by seconds,
// so pooling them made every cross-lap average, trend and "you're X off your
// best" line swing wildly and produced advice that read as noise. Coaching now
// only ever compares like with like.
//
// The split:
//   • Race    → one bucket PER COMPOUND (Soft / Medium / Hard / Inter / Wet), the
//               axis that dominates race lap time.
//   • Qualifying (incl. Sprint Shootout), Time Trial, Practice → one bucket each,
//               further split dry vs wet only — quali runs are already low-fuel
//               push laps, so compound matters far less than the wet/dry divide.
//   • Untagged laps (no session type, or recorded before tyre data existed) fall
//     into an "Unclassified" bucket rather than contaminating a real one.
//
// Everything here is pure so callers can run it inside a useMemo.

import { formatLapTime } from "./format.js";
import { tyreLabel, tyreCondition, tyreColor } from "./tyres.js";
import { isRankable } from "./driverStats.js";

// Coarse session groups (meta.sessionType comes from format.js's sessionTypeName).
// Sprint Shootout is a qualifying session by every measure that matters here.
const SESSION_GROUP = {
  "Race": "Race",
  "Qualifying": "Qualifying",
  "Sprint Shootout": "Qualifying",
  "Time Trial": "Time Trial",
  "Practice": "Practice",
};

// Display order — quali first (the pace yardstick), then race stints hardest-last.
const GROUP_ORDER = ["Qualifying", "Time Trial", "Practice", "Race", "Unclassified"];
const COMPOUND_ORDER = ["Soft", "Medium", "Hard", "Super Hard", "Inter", "Wet"];

const hasTime = (l) => typeof l?.lapTime === "number" && l.lapTime > 0;

// The bucket a single lap belongs to: { key, group, compound, label, color }.
// `key` is the identity used to gather laps; `label` is what the UI/prompt prints.
export function lapBucket(lap) {
  const group = SESSION_GROUP[lap?.meta?.sessionType] || "Unclassified";
  if (group === "Race") {
    const compound = tyreLabel(lap?.tyre) || "Unknown";
    return {
      key: `Race::${compound}`,
      group, compound,
      label: `Race · ${compound}`,
      color: tyreColor(lap?.tyre) || null,
    };
  }
  // Non-race: dry vs wet only. Untagged laps fold into dry (the default racing
  // condition, and what nearly all legacy laps were) — same rule as driverStats.
  const cond = tyreCondition(lap?.tyre) ?? "dry";
  return {
    key: `${group}::${cond}`,
    group, compound: null,
    label: cond === "wet" ? `${group} · Wet` : group,
    color: null,
  };
}

// Group laps by bucket key → { ...bucket, laps } , laps in the order given
// (callers pass oldest → newest). Only laps that can be coached on are kept:
// game-valid (isRankable) with a real lap time.
export function bucketLaps(laps = []) {
  const out = new Map();
  for (const l of laps) {
    if (!isRankable(l) || !hasTime(l)) continue;
    const b = lapBucket(l);
    let e = out.get(b.key);
    if (!e) { e = { ...b, laps: [] }; out.set(b.key, e); }
    e.laps.push(l);
  }
  return out;
}

// ── Pace gate ────────────────────────────────────────────────────────────────
// Sharing a bucket is necessary but not sufficient. An out-lap, an in-lap, a lap
// spent behind traffic, a fuel-save lap or a half-spin the game didn't delete all
// look like ordinary laps to `isRankable` (which only drops track-limits
// deletions) — and any one of them, pooled into a cross-lap average, invents
// "recurring" deficits of tens of km/h that the driver never actually had.
//
// The gate is deliberately permissive: it removes laps that aren't the same
// exercise, not laps that are merely slower. Two cutoffs, and the MORE generous
// one wins, so neither can over-trim on its own:
//   • 103% of the bucket's best — the classic pace filter; on a 90s lap that's
//     +2.7s, which catches out-laps and traffic without touching real driving.
//   • median + 1.5×IQR — robust outlier rejection, so a race stint whose whole
//     spread is legitimately wide (degradation) doesn't get chopped at the tail.
// Under 4 laps there is no distribution worth trusting, so only the 103% rule
// applies.
const PACE_GATE_FACTOR = 1.03;

const quantile = (sortedAsc, q) => {
  if (!sortedAsc.length) return null;
  const pos = (sortedAsc.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return lo === hi ? sortedAsc[lo] : sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (pos - lo);
};

// The lap-time ceiling for a set of laps: { best, median, cutoff } or null.
export function paceGate(laps = []) {
  const times = laps.map((l) => l.lapTime).filter((t) => typeof t === "number" && t > 0).sort((a, b) => a - b);
  if (!times.length) return null;
  const best = times[0];
  const med = quantile(times, 0.5);
  const byBest = best * PACE_GATE_FACTOR;
  let cutoff = byBest;
  if (times.length >= 4) {
    const iqr = quantile(times, 0.75) - quantile(times, 0.25);
    cutoff = Math.max(byBest, med + 1.5 * iqr);
  }
  return { best, median: med, cutoff };
}

// The laps the coach may reason about right now, WITH the audit trail of what was
// left out and why. THE definition of the coaching window — every cross-lap input
// (evidence, trends, corner profiles) draws from it, so they can't drift apart or
// silently re-mix conditions.
//
//   { laps, dropped: [{ lap, reason }], gate, key }
//
// The lap under analysis is always kept even when it fails the gate: it's the lap
// being coached, so dropping it would silently analyse a different lap than the
// one asked for. It's tagged `outlier` instead, and the screen says so.
//
// The window ENDS at `lap`. Normally that's the newest lap and the cutoff does
// nothing, but the Coach Log can be pinned to an earlier one — and a review of
// lap 4 that quietly drew its "recurring" patterns from laps 5-20 would be
// describing laps the driver hadn't driven yet at the point they're looking at.
export function buildCoachingSet(laps = [], lap = null, max = 20) {
  const empty = { laps: [], dropped: [], gate: null, key: null, outlierSubject: false };
  if (!lap) return empty;
  const key = lapBucket(lap).key;
  const all = (laps || []).filter((l) => isRankable(l) && hasTime(l) && lapBucket(l).key === key);
  const at = all.findIndex((l) => l === lap || (l.id != null && l.id === lap.id));
  const inBucket = (at >= 0 ? all.slice(0, at + 1) : all).slice(-max);
  if (!inBucket.length) return empty;

  const gate = paceGate(inBucket);
  const isLatest = (l) => l === lap || (l.id != null && l.id === lap.id);
  const kept = [], dropped = [];
  for (const l of inBucket) {
    if (!gate || l.lapTime <= gate.cutoff || isLatest(l)) kept.push(l);
    else dropped.push({ lap: l, reason: `${(l.lapTime - gate.best).toFixed(2)}s off the best lap here` });
  }
  const outlierSubject = !!gate && lap.lapTime > gate.cutoff;
  return { laps: kept, dropped, gate, key, outlierSubject };
}

// Backwards-compatible view of the above: just the laps.
export function coachingWindow(laps = [], lap = null, max = 20) {
  return buildCoachingSet(laps, lap, max).laps;
}

// ── Pace summary ─────────────────────────────────────────────────────────────

const median = (nums) => {
  const s = [...nums].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// Least-squares slope of lap time against lap order, in seconds per lap — the
// stint's drop-off. Computed only within ONE session (lap order across sessions
// is meaningless) and only with enough laps to mean anything; null otherwise.
function stintSlope(laps) {
  const bySession = new Map();
  for (const l of laps) {
    const k = l.meta?.sessionId || "";
    if (!k) continue;
    if (!bySession.has(k)) bySession.set(k, []);
    bySession.get(k).push(l);
  }
  // The newest session with a usable run — that's the stint worth commenting on.
  let run = null;
  for (const rows of bySession.values()) {
    if (rows.length < 4) continue;
    if (!run || (rows[rows.length - 1].recordedAt || 0) > (run[run.length - 1].recordedAt || 0)) run = rows;
  }
  if (!run) return null;
  const n = run.length;
  const meanX = (n - 1) / 2;
  const meanY = run.reduce((a, l) => a + l.lapTime, 0) / n;
  let num = 0, den = 0;
  run.forEach((l, i) => { num += (i - meanX) * (l.lapTime - meanY); den += (i - meanX) ** 2; });
  return den > 0 ? num / den : null;
}

// One deterministic coaching line per bucket, from that bucket's own numbers.
// Ordered by what actually costs the most: drop-off, then repeatability, then a
// confirmation that the pace is there.
function bucketAdvice(row) {
  if (row.laps < 2) return "Only one lap in this bucket — drive a few more before reading anything into the pace.";
  if (row.deg != null && row.deg > 0.06) {
    return `Losing ~${row.deg.toFixed(2)}s a lap through the stint — ease the entry aggression and manage tyre temperature to hold the pace.`;
  }
  if (row.spread > 1.0) {
    return `Your typical lap is ${row.spread.toFixed(2)}s off your best here — repeatability, not outright speed, is the gain.`;
  }
  if (row.deg != null && row.deg < -0.06) {
    return `Pace improving ~${Math.abs(row.deg).toFixed(2)}s a lap as the stint runs — you're building into it, so push earlier next time.`;
  }
  return `Consistent: typical lap within ${row.spread.toFixed(2)}s of your best on this rubber.`;
}

// Per-bucket pace rows + cross-bucket notes, for the Coach Log panel and the
// debrief prompt. `activeKey` (the current lap's bucket) is flagged so the UI can
// highlight the bucket the coaching actually came from. Returns null when no lap
// is coachable.
export function buildPaceBuckets(laps = [], opts = {}) {
  const buckets = bucketLaps(laps);
  if (!buckets.size) return null;

  const rows = [...buckets.values()].map((b) => {
    const times = b.laps.map((l) => l.lapTime);
    const best = Math.min(...times);
    const typical = median(times);
    const sessions = new Set(b.laps.map((l) => l.meta?.sessionId).filter(Boolean)).size;
    const row = {
      key: b.key, group: b.group, compound: b.compound, label: b.label, color: b.color,
      laps: b.laps.length, sessions,
      best, bestText: formatLapTime(best),
      typical, typicalText: formatLapTime(typical),
      spread: typical - best,
      deg: b.laps.length >= 4 ? stintSlope(b.laps) : null,
      active: b.key === opts.activeKey,
    };
    row.advice = bucketAdvice(row);
    return row;
  });

  rows.sort((a, b) => {
    const g = GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group);
    if (g !== 0) return g;
    if (a.compound && b.compound) {
      const c = COMPOUND_ORDER.indexOf(a.compound) - COMPOUND_ORDER.indexOf(b.compound);
      if (c !== 0) return c;
    }
    return a.best - b.best;
  });

  // Cross-bucket reads — only comparisons that are actually meaningful.
  const notes = [];
  const qual = rows.find((r) => r.group === "Qualifying" && r.laps >= 2);
  const raceRows = rows.filter((r) => r.group === "Race" && r.laps >= 2);
  if (qual && raceRows.length) {
    const fastestRace = raceRows.reduce((a, r) => (r.typical < a.typical ? r : a));
    const gap = fastestRace.typical - qual.best;
    if (gap > 0) {
      notes.push(`Race pace on ${fastestRace.compound} runs ${gap.toFixed(2)}s off your qualifying best — fuel and tyre management explain some of that; anything beyond ~2s is pace you can still take back.`);
    }
  }
  if (raceRows.length >= 2) {
    const sorted = [...raceRows].sort((a, b) => a.typical - b.typical);
    const quick = sorted[0], slow = sorted[sorted.length - 1];
    notes.push(`${quick.compound} is ${(slow.typical - quick.typical).toFixed(2)}s a lap quicker than ${slow.compound} over your laps here — worth weighing against how long each stint holds up.`);
  }

  return { rows, notes, activeKey: opts.activeKey || null };
}

// The same pace picture as a compact prompt block, so the between-lap LLM
// debrief can reason about qualifying vs race stints instead of a single lap.
// Every figure it may cite is present here, which is what keeps the grounding
// guardrail from stripping the numbers back out. Returns null when there's
// nothing worth stating.
export function buildPaceBlock(pace) {
  if (!pace?.rows?.length) return null;
  const lines = pace.rows.map((r) => {
    const deg = r.deg != null ? ` · stint trend ${r.deg >= 0 ? "+" : "−"}${Math.abs(r.deg).toFixed(2)}s/lap` : "";
    const tag = r.active ? " ← the lap just completed belongs here" : "";
    return `${r.label}: ${r.laps} lap${r.laps === 1 ? "" : "s"} · best ${r.bestText} · typical ${r.typicalText} (+${r.spread.toFixed(2)}s off best)${deg}${tag}`;
  });
  return (
    "PACE BY SESSION TYPE AND COMPOUND — laps on this track, grouped so qualifying, " +
    "and each race compound, are only ever compared against their own kind. Never " +
    "compare a figure from one group against another as if it were the same lap:" +
    "\n- " + lines.join("\n- ") +
    (pace.notes.length ? "\n" + pace.notes.map((n) => `- ${n}`).join("\n") : "")
  );
}
