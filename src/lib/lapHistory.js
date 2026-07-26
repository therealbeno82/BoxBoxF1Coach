// ─── LAP HISTORY ──────────────────────────────────────────────────────────────
// A history view of the driver's completed laps for the coaching LLM, so it can
// reason beyond the single most-recent lap that buildLapEvidence sees:
//
//   buildTrends — cross-lap pattern detection: issues that recur across MOST of
//     the laps rather than appearing once, which is what makes "you KEEP doing
//     X in turn 3" coaching honest. Detects consistently-slow corners, a wrong
//     gear held lap after lap, persistent over-rotation, and inconsistency.
//
// The laps it is handed are already scoped to one circuit, one bucket
// (qualifying, or a race stint on one compound — see lib/lapBuckets.js) AND past
// that bucket's pace gate, so a "trend" here is always drawn from comparable laps
// that were all the same exercise.
//
// WHY IT IS CORNER-ANCHORED, NOT GRID-ANCHORED
// An earlier version compared speeds every 50 m of track. That reads fine on
// paper and is badly wrong in a braking zone, where speed falls about 1 km/h per
// metre: braking 15 m later than the reference shows up as a 15 km/h "deficit"
// that costs nothing at all, and those artefacts out-ranked every real finding
// because the ranking was in km/h. Corners are now detected from the reference's
// own speed minima and each lap is compared MINIMUM-SPEED-TO-MINIMUM-SPEED
// through the corner — the number a driver actually recognises, and one that is
// immune to where in the braking zone the sample happened to land.
//
// Everything is then ranked by the SECONDS it costs (the same 1/v segment model
// coach/lapAnalysis.js uses), not by raw km/h, so the biggest number can no
// longer beat the most expensive problem.
//
// Laps share the reference-trace sample shape
// ({ dist, throttle, brake, speed, steer, gear, ersMode, ersSpent }).

import { isRankable } from "./driverStats.js";

const GRID_STEP = 25;          // m, resolution the reference speed curve is read at
const CORNER_HALF = 90;        // m either side of an apex that counts as "the corner"
const CORNER_LEN = 2 * CORNER_HALF;
const MIN_CORNER_GAP = 250;    // m, two apexes closer than this are one corner
const SPEED_FLOOR_KMH = 12;    // guards the 1/v time model against pit/standstill samples
const MAX_TREND_LAPS = 10;     // the recent laps a trend is drawn from (see buildTrends)

// A systematic deficit this large across EVERY corner isn't driving — it's a
// reference on different fuel, a different setup or a different car. Beyond it we
// stop reporting corners as if each were its own fixable problem.
const BASELINE_OFFSET_KMH = 3.5;

// ── small numeric helpers ────────────────────────────────────────────────────

const asc = (nums) => [...nums].sort((a, b) => a - b);

function quantile(sortedAsc, q) {
  if (!sortedAsc.length) return null;
  const pos = (sortedAsc.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return lo === hi ? sortedAsc[lo] : sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (pos - lo);
}
const median = (nums) => quantile(asc(nums), 0.5);

// Seconds lost covering `len` metres at `vu` instead of `vr` (km/h in, s out).
// Positive = slower than the reference. The same physical model as lapAnalysis.
function timeCost(vu, vr, len = CORNER_LEN) {
  const a = Math.max(SPEED_FLOOR_KMH, vu) / 3.6;
  const b = Math.max(SPEED_FLOOR_KMH, vr) / 3.6;
  return len / a - len / b;
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

// ── sampling ─────────────────────────────────────────────────────────────────

// Interpolated sample at track distance `d`, or NULL when `d` falls outside the
// span this lap actually recorded. The null matters: the old nearest-sample
// lookup clamped instead, so a lap whose recording started late or ended early
// had its first/last sample compared against reference data hundreds of metres
// away — the single largest source of impossible speed gaps.
function sampleAt(samples, d) {
  const last = samples.length - 1;
  if (d < samples[0].dist || d > samples[last].dist) return null;
  let lo = 0, hi = last;
  if (d === samples[0].dist) return samples[0];
  if (d === samples[last].dist) return samples[last];
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (samples[mid].dist <= d) lo = mid; else hi = mid;
  }
  const a = samples[lo], b = samples[hi];
  const t = (d - a.dist) / ((b.dist - a.dist) || 1);
  const lerp = (x, y) => (x ?? 0) + ((y ?? 0) - (x ?? 0)) * t;
  return {
    dist: d,
    speed: lerp(a.speed, b.speed), throttle: lerp(a.throttle, b.throttle),
    brake: lerp(a.brake, b.brake), steer: lerp(a.steer, b.steer),
    gear: t < 0.5 ? a.gear : b.gear,
    ersMode: t < 0.5 ? a.ersMode : b.ersMode,
  };
}

// How a lap behaves through one corner window: its own slowest point (wherever it
// falls inside the window), the gear held there, and how hard it was steering.
// Null when the lap doesn't cover the whole window.
function cornerPass(samples, d0, d1) {
  let slowest = null, steerSum = 0, speedSum = 0, n = 0;
  for (let d = d0; d <= d1; d += GRID_STEP) {
    const s = sampleAt(samples, d);
    if (!s) return null;
    if (!slowest || (s.speed ?? Infinity) < slowest.speed) slowest = s;
    steerSum += Math.abs(s.steer ?? 0);
    speedSum += s.speed ?? 0;
    n++;
  }
  if (!slowest || !n) return null;
  // vMin is the headline (the number the driver recognises); vMean is what the
  // time cost is computed from — you are only down on the apex figure AT the apex,
  // so pricing the whole corner at the apex deficit would overstate every finding.
  return { vMin: slowest.speed ?? 0, dMin: slowest.dist, gear: slowest.gear,
    steer: steerSum / n, vMean: speedSum / n };
}

// ── corner detection ─────────────────────────────────────────────────────────

// Apexes = local minima of the reference speed curve, at least MIN_CORNER_GAP
// apart and meaningfully slower than the lap's top speed (so a slight lift on a
// straight isn't promoted to a corner). Detected from the reference when there is
// one, otherwise from the driver's own most recent lap, so the trends still work
// with no reference loaded.
function findCorners(samples, from, to) {
  const curve = [];
  for (let d = from; d <= to; d += GRID_STEP) {
    const s = sampleAt(samples, d);
    if (s) curve.push({ d, v: s.speed ?? 0 });
  }
  if (curve.length < 10) return [];
  const vMax = Math.max(...curve.map((p) => p.v));
  const win = Math.max(2, Math.round(CORNER_HALF / GRID_STEP));

  const mins = [];
  for (let i = win; i < curve.length - win; i++) {
    const v = curve[i].v;
    if (v > vMax * 0.92) continue; // still essentially flat out — not a corner
    let isMin = true;
    for (let j = i - win; j <= i + win; j++) {
      if (curve[j].v < v) { isMin = false; break; }
    }
    if (isMin) mins.push(curve[i]);
  }
  // Collapse clusters: keep the slowest point of each group of nearby minima.
  const corners = [];
  for (const m of mins) {
    const prev = corners[corners.length - 1];
    if (prev && m.d - prev.d < MIN_CORNER_GAP) {
      if (m.v < prev.v) corners[corners.length - 1] = m;
      continue;
    }
    corners.push(m);
  }
  return corners.map((c) => ({ d: c.d, vMin: c.v }));
}

// ── Cross-lap trends ──────────────────────────────────────────────────────────
// labelAt(dist, lapLen) → corner/zone name or null, so findings can read
// "T3 Apex (340m)" instead of a bare distance.
//
// opts: { step, labelAt, maxLaps }
export function buildTrends(laps, refSamples, opts = {}) {
  const all = (laps || []).filter((l) => isRankable(l) && Array.isArray(l.samples) && l.samples.length > 5);
  if (all.length < 2) return null;

  // A partially recorded lap (telemetry joined late, app started mid-lap) would
  // otherwise drag the analysable window down to its own span and blind the coach
  // to a third of the circuit. Drop those laps instead of shrinking the track.
  const span = (l) => (l.samples[l.samples.length - 1]?.dist ?? 0) - (l.samples[0]?.dist ?? 0);
  const fullSpan = Math.max(...all.map(span));
  const complete = all.filter((l) => span(l) >= fullSpan * 0.9);

  // A trend describes how you're driving NOW; twenty laps back is history. The
  // caller's window may be wider (evidence and the pace read want it), so the
  // trend takes only the most recent slice of it.
  const valid = complete.slice(-(opts.maxLaps || MAX_TREND_LAPS));
  if (valid.length < 2) return null; // a single lap is a data point, not a trend

  const ref = Array.isArray(refSamples) && refSamples.length > 5 ? refSamples : null;

  // Only ever look at track every lap in the set actually recorded. Taking the
  // MAXIMUM lap length (as this once did) meant the shortest recording in the set
  // decided nothing and got clamped everywhere past its own end.
  const from = Math.max(...valid.map((l) => l.samples[0]?.dist ?? 0), ref ? ref[0].dist : 0);
  const to = Math.min(...valid.map((l) => l.samples[l.samples.length - 1]?.dist ?? 0),
    ref ? ref[ref.length - 1].dist : Infinity);
  const lapLen = Math.max(...valid.map((l) => l.samples[l.samples.length - 1]?.dist || 0));
  if (!(to - from > 500)) return null; // the laps barely overlap — nothing honest to say

  const labelAt = opts.labelAt || (() => null);
  const where = (d) => labelAt(d, lapLen) || `${Math.round(d)}m`;

  // Corners come from the reference when it's comparable, else from the newest lap.
  const corners = findCorners(ref || valid[valid.length - 1].samples, from + CORNER_HALF, to - CORNER_HALF);
  if (!corners.length) return null;

  // Per corner: every lap's pass through it, plus the reference's.
  const rows = [];
  for (const c of corners) {
    const d0 = c.d - CORNER_HALF, d1 = c.d + CORNER_HALF;
    const passes = valid.map((l) => cornerPass(l.samples, d0, d1));
    if (passes.some((p) => !p)) continue; // not every lap covers it — say nothing
    const rp = ref ? cornerPass(ref, d0, d1) : null;
    rows.push({ d: c.d, label: where(c.d), passes, ref: rp });
  }
  if (!rows.length) return null;

  // ── Is the reference even a like-for-like car? ─────────────────────────────
  // Fuel load and setup are invisible to refMatch (nothing in the packets carries
  // them), so a low-fuel qualifying reference against a heavy race stint is
  // genuinely slower EVERYWHERE — and the corner rules would then flag all twenty
  // corners as if each were a separate mistake. Measure that baseline once, and
  // when it's real, compare each corner against it rather than against zero.
  let baseline = 0;
  if (ref) {
    const perCorner = rows.filter((r) => r.ref).map((r) => median(r.passes.map((p) => p.vMin)) - r.ref.vMin);
    if (perCorner.length >= 3) {
      const m = median(perCorner);
      if (m < -BASELINE_OFFSET_KMH) baseline = m; // negative = down on the reference everywhere
    }
  }

  const need = Math.max(2, Math.ceil(valid.length * 0.6)); // "most laps" → a real habit
  const findings = [];

  for (const r of rows) {
    const vMins = r.passes.map((p) => p.vMin);
    const sorted = asc(vMins);
    const medV = median(vMins);
    const q1 = quantile(sorted, 0.25), q3 = quantile(sorted, 0.75);
    const meansAsc = asc(r.passes.map((p) => p.vMean));
    const medMean = quantile(meansAsc, 0.5);

    if (r.ref) {
      const target = r.ref.vMin + baseline;  // the reference, brought onto your baseline

      // 1) Consistently slower through the corner than the reference. The median
      //    (not the mean) and the requirement that the upper quartile is also down
      //    mean one bad lap in the set can no longer invent a "recurring" issue.
      const slowLaps = r.passes.filter((p) => p.vMin < target - 3).length;
      if (slowLaps >= need && medV < target - 4 && q3 < target - 2) {
        const cost = timeCost(medMean, r.ref.vMean + baseline);
        findings.push({ d: r.d, kind: "slow", cost, label: r.label,
          text: `${r.label}: consistently ~${Math.round(target - medV)} km/h slower through the corner (you ~${Math.round(medV)} vs ${Math.round(target)} km/h at the apex, ~${cost.toFixed(2)}s) — carry more minimum speed` });
      }

      // 2) Wrong gear at the apex, lap after lap.
      if (r.ref.gear != null) {
        const g = modal(r.passes.map((p) => p.gear));
        if (g.value != null && g.value !== r.ref.gear && g.count >= need) {
          findings.push({ d: r.d, kind: "gear", cost: 0.05, label: r.label,
            text: `${r.label}: you apex this in gear ${g.value} where the reference uses gear ${r.ref.gear} — wrong gear` });
        }
      }

      // 3) Over-rotation: more lock than the reference through a genuine corner.
      if (r.ref.steer > 25) {
        const medSteer = median(r.passes.map((p) => p.steer));
        const overLaps = r.passes.filter((p) => p.steer > r.ref.steer + 15).length;
        if (overLaps >= need && medSteer > r.ref.steer + 15) {
          findings.push({ d: r.d, kind: "steer", cost: 0.04, label: r.label,
            text: `${r.label}: too much steering rotation (you ~${Math.round(medSteer)}% vs reference ${Math.round(r.ref.steer)}%) — ease the lock and let the car run` });
        }
      }
    }

    // 4) Inconsistency: the corner speed itself swings lap to lap. Measured on the
    //    interquartile band, so it describes the body of your laps rather than the
    //    single best and single worst of them. Self-referential — no reference needed.
    if (valid.length >= 3 && q3 - q1 > 7) {
      findings.push({ d: r.d, kind: "consistency",
        cost: timeCost(quantile(meansAsc, 0.25), quantile(meansAsc, 0.75)), label: r.label,
        text: `${r.label}: inconsistent — apex speed sits anywhere from ${Math.round(q1)} to ${Math.round(q3)} km/h across your laps (worst to best ${Math.round(sorted[0])}–${Math.round(sorted[sorted.length - 1])}) — repeat the same line` });
    }
  }

  if (!findings.length) return null;

  // Most expensive first, then keep them spread out: one finding of each kind per
  // corner (a corner may still raise both a wrong gear AND over-rotation).
  findings.sort((a, b) => b.cost - a.cost);
  const picked = [];
  for (const f of findings) {
    if (picked.every((p) => p.kind !== f.kind || (p.label !== f.label && Math.abs(p.d - f.d) > 200))) picked.push(f);
    if (picked.length >= 6) break;
  }
  picked.sort((a, b) => a.d - b.d);

  const scope = `CROSS-LAP TRENDS — recurring patterns across your last ${valid.length} comparable laps on this track, possibly spanning sessions` +
    `${ref ? ", vs the reference" : ""} (corner apex speeds, only things that happen on most laps):`;
  const caveat = baseline
    ? `\n- NOTE: the reference is about ${Math.abs(Math.round(baseline))} km/h quicker through EVERY corner, which is a fuel load, setup or car difference rather than driving. ` +
      `The corner figures below are measured against that baseline, so they are the corners that are worse than your own average — do not quote the raw gap to the reference as time the driver can take back.`
    : "";

  return scope + caveat + "\n- " + picked.map((f) => f.text).join("\n- ");
}
