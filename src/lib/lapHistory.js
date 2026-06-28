// ─── LAP HISTORY ──────────────────────────────────────────────────────────────
// Two history-wide views of the driver's completed laps for the coaching LLM —
// the driver's ENTIRE saved lap history (all sessions, from lapStore), not just
// the current drive — so it can reason beyond the single most-recent lap that
// buildLapEvidence sees:
//
//   buildLapLog — a compact per-lap table (time, sector splits, gap to the
//     personal best) so the driver can ask about a specific earlier lap
//     ("what was my lap 3?", "which lap was quickest?").
//   buildTrends — cross-lap pattern detection: issues that recur across MOST of
//     the laps rather than appearing once, which is what makes "you KEEP doing
//     X in turn 3" coaching honest. Detects consistently-slow corners, a wrong
//     gear held lap after lap, persistent over-rotation, and inconsistency.
//
// Laps share the reference-trace sample shape
// ({ dist, throttle, brake, speed, steer, gear, ersMode, ersSpent }).

import { formatLapTime } from "./format.js";
import { tyreLabel, tyreCondition } from "./tyres.js";
import { cornerLabel } from "./cornerData.js";

// Nearest sample by track distance (samples are sorted by dist). Local copy so
// this module stays independent of lapEvidence.js (which keeps its own).
function sampleAt(samples, d) {
  let best = samples[0], bd = Math.abs(samples[0].dist - d);
  for (let i = 1; i < samples.length; i++) {
    const x = Math.abs(samples[i].dist - d);
    if (x < bd) { bd = x; best = samples[i]; }
  }
  return best;
}

// Most frequent value in a list (ignoring null/undefined) — used to find the
// gear the driver habitually takes a corner in, across laps.
function modal(values) {
  const counts = new Map();
  let best = null, bestCount = 0;
  for (const v of values) {
    if (v == null) continue;
    const c = (counts.get(v) || 0) + 1;
    counts.set(v, c);
    if (c > bestCount) { bestCount = c; best = v; }
  }
  return { value: best, count: bestCount };
}

const fmtSec = (s) => (typeof s === "number" && s > 0 ? s.toFixed(1) : "—");

// Lap-wide top speed (km/h) from the lap's binned samples, rounded — or null when a
// lap carries no samples (e.g. an imported time-only lap).
function topSpeedOf(lap) {
  if (!Array.isArray(lap?.samples) || !lap.samples.length) return null;
  let mx = 0;
  for (const s of lap.samples) if (typeof s.speed === "number" && s.speed > mx) mx = s.speed;
  return mx > 0 ? Math.round(mx) : null;
}

// ── Per-lap log ───────────────────────────────────────────────────────────────
export function buildLapLog(laps, opts = {}) {
  const rows = (laps || []).filter((l) => typeof l.lapTime === "number" && l.lapTime > 0);
  if (!rows.length) return null;

  // Personal best per condition so a wet/inter lap is judged against other wet
  // laps, not the (unbeatable-in-the-wet) dry best. Untagged laps fold into dry.
  const bestFor = (cond) => {
    const t = rows.filter((l) => (tyreCondition(l.tyre) ?? "dry") === cond);
    return t.length ? Math.min(...t.map((l) => l.lapTime)) : null;
  };
  const bestDry = bestFor("dry");
  const bestWet = bestFor("wet");
  const recent = rows.slice(-(opts.max || 15)); // cap tokens on a long history
  const lines = recent.map((l) => {
    const s = Array.isArray(l.sectorTimes)
      ? ` (S1 ${fmtSec(l.sectorTimes[0])} / S2 ${fmtSec(l.sectorTimes[1])} / S3 ${fmtSec(l.sectorTimes[2])})`
      : "";
    const cond = tyreCondition(l.tyre) ?? "dry";
    const condBest = cond === "wet" ? bestWet : bestDry;
    const gap = condBest != null && l.lapTime <= condBest + 1e-6 ? `best (${cond})` : `+${(l.lapTime - condBest).toFixed(1)} vs ${cond} best`;
    const tyre = tyreLabel(l.tyre);
    const tyreTag = tyre ? ` [${tyre}]` : "";
    const top = topSpeedOf(l);
    const topTag = top != null ? ` · top ${top} km/h` : "";
    return `Lap ${l.lapNumber ?? "?"}: ${formatLapTime(l.lapTime)}${s}${tyreTag} ${gap}${topTag}`;
  });

  const bestSummary = [
    bestDry != null ? `dry best ${formatLapTime(bestDry)}` : null,
    bestWet != null ? `wet best ${formatLapTime(bestWet)}` : null,
  ].filter(Boolean).join(", ");

  return (
    `LAP HISTORY LOG — your completed laps so far across your saved history, not just this drive (${bestSummary}; wet = Intermediate/Wet tyres, judged separately from dry):` +
    "\n- " + lines.join("\n- ")
  );
}

// ── Cross-lap trends ──────────────────────────────────────────────────────────
// labelAt(dist, lapLen) → corner/zone name or null, so findings can read
// "T3 Apex (340m)" instead of a bare distance.
export function buildTrends(laps, refSamples, opts = {}) {
  const valid = (laps || []).filter((l) => Array.isArray(l.samples) && l.samples.length > 5);
  if (valid.length < 2) return null; // a single lap is a data point, not a trend

  const ref = Array.isArray(refSamples) && refSamples.length > 5 ? refSamples : null;
  const lapLen = Math.max(
    ...valid.map((l) => l.samples[l.samples.length - 1]?.dist || 0),
    ref ? ref[ref.length - 1].dist : 0
  );
  if (!(lapLen > 0)) return null;

  const STEP = opts.step || 50;
  const need = Math.max(2, Math.ceil(valid.length * 0.6)); // "most laps" → a real habit
  const labelAt = opts.labelAt || (() => null);
  const where = (d) => labelAt(d, lapLen) || `${Math.round(d)}m`;

  const findings = [];
  for (let d = 0; d <= lapLen; d += STEP) {
    const us = valid.map((l) => sampleAt(l.samples, d)).filter(Boolean);
    if (us.length < valid.length) continue; // require every lap to cover this point
    const r = ref ? sampleAt(ref, d) : null;
    const lbl = where(d);

    const speeds = us.map((u) => u.speed ?? 0);
    const minS = Math.min(...speeds), maxS = Math.max(...speeds);
    const meanS = speeds.reduce((a, b) => a + b, 0) / speeds.length;

    // 1) Consistently slower than the reference through a corner/section.
    if (r && r.speed != null) {
      const slowLaps = us.filter((u) => (u.speed ?? 0) < r.speed - 5).length;
      if (slowLaps >= need && meanS < r.speed - 5) {
        findings.push({ d, kind: "slow", score: r.speed - meanS, label: lbl,
          text: `${lbl}: consistently ~${Math.round(r.speed - meanS)} km/h slower than the reference (you ~${Math.round(meanS)} vs ${Math.round(r.speed)} km/h) — carry more minimum speed` });
      }
    }

    // 2) Wrong gear: you hold a different gear than the reference here, lap after lap.
    if (r && r.gear != null) {
      const g = modal(us.map((u) => u.gear));
      if (g.value != null && g.value !== r.gear && g.count >= need && Math.abs(g.value - r.gear) >= 1) {
        findings.push({ d, kind: "gear", score: 4, label: lbl,
          text: `${lbl}: you take this in gear ${g.value} where the reference uses gear ${r.gear} — wrong gear` });
      }
    }

    // 3) Over-rotation: too much steering vs the reference at a genuine corner.
    if (r && typeof r.steer === "number" && Math.abs(r.steer) > 25) {
      const refSteer = Math.abs(r.steer);
      const meanSteer = us.reduce((a, u) => a + Math.abs(u.steer ?? 0), 0) / us.length;
      const overLaps = us.filter((u) => Math.abs(u.steer ?? 0) > refSteer + 15).length;
      if (overLaps >= need && meanSteer > refSteer + 15) {
        findings.push({ d, kind: "steer", score: 3, label: lbl,
          text: `${lbl}: too much steering rotation (you ~${Math.round(meanSteer)}% vs reference ${Math.round(refSteer)}%) — ease the lock and let the car run` });
      }
    }

    // 4) Inconsistency: speed at the same point swings lap-to-lap (≥3 laps to mean it).
    if (valid.length >= 3 && maxS - minS > 12) {
      findings.push({ d, kind: "consistency", score: maxS - minS, label: lbl,
        text: `${lbl}: inconsistent — speed here swings ${Math.round(minS)}–${Math.round(maxS)} km/h across your laps (±${Math.round((maxS - minS) / 2)}) — repeat the same line` });
    }
  }

  if (!findings.length) return null;

  // Strongest finding first, then keep them spread out: suppress the SAME kind of
  // issue at the same corner/sector or within 200 m (one cluster = one finding),
  // but allow two different kinds at the same corner (e.g. wrong gear AND
  // over-rotation in the same turn).
  findings.sort((a, b) => b.score - a.score);
  const picked = [];
  for (const f of findings) {
    if (picked.every((p) => p.kind !== f.kind || (p.label !== f.label && Math.abs(p.d - f.d) > 200))) picked.push(f);
    if (picked.length >= 6) break;
  }
  picked.sort((a, b) => a.d - b.d);

  return (
    `CROSS-LAP TRENDS — recurring patterns across all ${valid.length} of your saved laps${ref ? " vs the reference" : ""} (only things that happen on most laps):` +
    "\n- " + picked.map((f) => f.text).join("\n- ")
  );
}

// ── Per-corner profile history ──────────────────────────────────────────────────
// For each named corner, the figures the driver carried through it on every lap —
// minimum speed, apex gear, minimum throttle (lift depth), peak brake and peak
// steering (lock). Lets the coach answer specific recall questions ("how fast / what
// gear / how much throttle through the hairpin on lap 3?", "am I braking too hard into
// T1?") rather than only reasoning over the single most-recent lap. Corner apexes come
// from the curated per-track DB (cornerData.js, { n, name, f } with f = apex as a lap
// fraction). Returns null for unknown tracks (no corners) or when no lap carries usable
// samples — the caller then simply omits the block.
export function buildCornerProfiles(laps, opts = {}) {
  const corners = (Array.isArray(opts.corners) ? opts.corners : [])
    .filter((c) => c && typeof c.f === "number")
    .slice()
    .sort((a, b) => a.f - b.f);
  if (!corners.length) return null;

  const valid = (laps || [])
    .filter((l) => Array.isArray(l.samples) && l.samples.length > 5 && typeof l.lapTime === "number" && l.lapTime > 0)
    .slice(-(opts.max || 15));
  if (!valid.length) return null;

  // Non-overlapping window per corner: the midpoint to the previous/next apex (in lap
  // fraction), clamped to [0,1]. This partitions the lap so each corner's figures are
  // taken from its own stretch of track — robust to the hand-estimated apex positions.
  const windows = corners.map((c, i) => ({
    lo: i === 0 ? 0 : (corners[i - 1].f + c.f) / 2,
    hi: i === corners.length - 1 ? 1 : (c.f + corners[i + 1].f) / 2,
  }));

  // One pass over a lap's samples in [loFrac, hiFrac] of THIS lap (each lap has its own
  // length): min speed (+ the gear at that apex sample), min throttle, peak brake, peak
  // |steer|. null when the lap doesn't cover the window.
  const profileIn = (samples, lapLen, loFrac, hiFrac) => {
    const dLo = loFrac * lapLen, dHi = hiFrac * lapLen;
    let minSpeed = Infinity, apexGear = null, minThr = Infinity, maxBrk = -Infinity, maxSteer = -Infinity, n = 0;
    for (const s of samples) {
      if (s.dist < dLo || s.dist > dHi) continue;
      n++;
      if (typeof s.speed === "number" && s.speed < minSpeed) { minSpeed = s.speed; if (typeof s.gear === "number") apexGear = s.gear; }
      if (typeof s.throttle === "number" && s.throttle < minThr) minThr = s.throttle;
      if (typeof s.brake === "number" && s.brake > maxBrk) maxBrk = s.brake;
      if (typeof s.steer === "number" && Math.abs(s.steer) > maxSteer) maxSteer = Math.abs(s.steer);
    }
    if (!n) return null;
    return {
      speed: minSpeed === Infinity ? null : Math.round(minSpeed),
      gear: apexGear,
      throttle: minThr === Infinity ? null : Math.round(minThr),
      brake: maxBrk === -Infinity ? null : Math.round(maxBrk),
      steer: maxSteer === -Infinity ? null : Math.round(maxSteer),
    };
  };

  // Per-channel row of values across the laps, in lap order; "—" where a lap has no data.
  const chan = (profs, key) => profs.map((p) => (p && p[key] != null ? String(p[key]) : "—")).join(", ");

  const lapNums = valid.map((l) => l.lapNumber ?? "?");
  const lines = corners.map((c, i) => {
    const profs = valid.map((l) => {
      const lapLen = l.samples[l.samples.length - 1]?.dist || 0;
      return lapLen > 0 ? profileIn(l.samples, lapLen, windows[i].lo, windows[i].hi) : null;
    });
    const label = cornerLabel(c) || `T${c.n ?? i + 1}`;
    return `${label}: speed ${chan(profs, "speed")} · gear ${chan(profs, "gear")} · throttle ${chan(profs, "throttle")} · brake ${chan(profs, "brake")} · steer ${chan(profs, "steer")}`;
  });

  const order = lapNums.map((n) => `L${n}`).join(", ");
  return (
    `CORNER PROFILES — what you carried through each corner on every lap, each channel listing one value per lap ` +
    `in the order [${order}]. Channels: speed = minimum km/h (lower = slower through the corner); gear = gear at the apex; ` +
    `throttle = minimum % (lower = a bigger lift); brake = peak % (higher = harder braking); steer = peak steering lock %:` +
    "\n- " + lines.join("\n- ")
  );
}
