// ─── STRATEGY ZONES FROM A REFERENCE TRACE ────────────────────────────────────
// Pure: a reference lap's samples in, the braking / lift-and-coast / lift / ERS
// zones the call engine speaks out. Lived inside BoxBoxApp.jsx, which made the
// single most consequential piece of coaching logic — the one that decides what
// the driver HEARS — impossible to exercise outside a running app. Moved here
// unchanged so it can be tested (tests/zones.test.mjs).

import { ERS_MODES } from "./config.js";
import { clamp } from "../format.js";

// Thresholds for turning one telemetry sample into a call/zone type, used by the
// reference zone-derivation (deriveZonesFromTrace) so the dashboard map and voice
// calls classify identically.
const BRAKE_ON = 12, COAST_THR = 15, LIFT_HI = 85, ERS_THR = 85;
// Shortest zone worth announcing, in METRES. Deliberately not a fraction of the lap:
// a fraction moves the floor with the circuit, so the same 35 m squirt of Medium was
// announced at Monaco and silently dropped at Spa (0.6% of 7 km is 42 m). A braking
// zone and an ERS application are physical things — neither gets longer because the
// lap does. Traces are distance-binned every 10 m, so the ERS floor keeps runs of 3
// bins or more and rejects a single-sample blip.
const ERS_MIN_M = 20, PEDAL_MIN_M = 50;
// Classify a single sample into a pseudo-zone { type, ersMode } consumable by
// zoneFill(). hasBrake=false (trace with no brake channel) treats
// every off-throttle stretch as braking, matching deriveZonesFromTrace. Priority:
// braking > full coast > ERS deploy > partial lift.
export function classifySample(s, hasBrake = true) {
  const thr  = typeof s?.throttle === "number" ? s.throttle : 100;
  const brk  = typeof s?.brake === "number" ? s.brake : 0;
  const mode = Math.round(clamp(s?.ersMode ?? 0, 0, 3));
  if (hasBrake && brk > BRAKE_ON)           return { type: "brake", ersMode: mode };
  if (thr < COAST_THR)                      return { type: hasBrake ? "lico" : "brake", ersMode: mode };
  if (thr >= ERS_THR && mode >= 1)          return { type: "ers", ersMode: mode };
  if (thr < LIFT_HI)                        return { type: hasBrake ? "lift" : "normal", ersMode: mode };
  return { type: "normal", ersMode: mode };
}

// ── Derive strategy zones FROM a loaded reference trace ─────────────────────
// A trace (exported by the Trace Calibrator) carries throttle, brake + ERS
// channels sampled by lap distance. We segment the lap into three call types:
//   • brake — brake actually applied
//   • lico  — off throttle but not yet braking (the coast before a corner)
//   • ers   — on throttle while the reference is deploying ERS, split BY MODE
//             (Medium / Hotlap / Boost) so the call IS the ERS mode itself.
// There is deliberately no separate "deploy" concept — deploying ERS and the
// ERS mode are one and the same.
//
// A trace that yields nothing usable yields NO zones. It used to fall back to a
// hard-coded set of nine invented zones ("T6 Hairpin" at 42% of the lap…), which
// the call engine then SPOKE — "Brake" at an arbitrary point on whatever circuit
// the driver was actually on. Silence is the honest answer to a reference that
// carries no braking or throttle data.
function mostCommon(arr) {
  const counts = {};
  let best = arr[0] ?? 0, bestC = 0;
  for (const v of arr) {
    counts[v] = (counts[v] || 0) + 1;
    if (counts[v] > bestC) { bestC = counts[v]; best = v; }
  }
  return best;
}

// Smooth a numeric channel with a centred moving average (~`win` either side).
function smoothChannel(pts, key, win) {
  const N = pts.length;
  return pts.map((_, i) => {
    let sum = 0, c = 0;
    for (let j = Math.max(0, i - win); j <= Math.min(N - 1, i + win); j++) {
      const v = pts[j][key];
      if (typeof v === "number") { sum += v; c++; }
    }
    return c ? sum / c : 0;
  });
}

export function deriveZonesFromTrace(trace) {
  const raw = trace?.samples;
  if (!Array.isArray(raw) || raw.length < 8) return [];

  const pts = raw
    .filter(s => s && typeof s.dist === "number" && typeof s.throttle === "number")
    .sort((a, b) => a.dist - b.dist);
  const N = pts.length;
  const totalDist = N ? pts[N - 1].dist : 0;
  if (N < 8 || !(totalDist > 0)) return [];

  // Smooth throttle + brake (~1% of lap window) so noise — an image-extracted trace,
  // or a real one where the brake dips under the threshold mid-zone — can't fragment
  // a run. This is for SEGMENTATION ONLY; the edges come back off the raw channels
  // below, because a centred average shifts them earlier by up to half a window.
  const win = Math.max(1, Math.round(N * 0.01));
  const thr = smoothChannel(pts, "throttle", win);
  const brk = smoothChannel(pts, "brake", win);
  // If the trace has no brake channel at all we can't tell coasting from braking,
  // so we treat every off-throttle stretch as a brake call (old behaviour).
  const hasBrake = pts.some(p => typeof p.brake === "number");

  // Classify each sample. Priority: braking > full coast > ERS deploy > partial lift.
  //  • brake — brake actually applied (from the brake trace)
  //  • lico  — (near-)zero throttle, NOT braking (the full coast before a corner)
  //  • ers   — on full throttle while deploying (mode ≥ 1); the mode labels the zone
  //  • lift  — throttle eased (partial) but still applied, NOT braking
  // Classify on the SMOOTHED throttle/brake but the raw ERS mode (via
  // classifySample, defined near zoneFill).
  const classOf = (i) =>
    classifySample({ throttle: thr[i], brake: brk[i], ersMode: pts[i].ersMode }, hasBrake).type;
  // The same test on the UNSMOOTHED sample. Smoothing is what makes the SEGMENTATION
  // robust — one dropped-out sample in the brake trace must not chop a braking zone
  // into three — but a centred moving average also drags every EDGE half a window
  // earlier, and `win` is ~1% of the lap. Measured against the recorded demo laps,
  // that opened each brake zone ~30 m (up to 42 m) before the reference actually
  // touched the pedal, so the voice call went out that much early ON TOP of its lead
  // time. So: the smoothed channels decide where the runs ARE, the raw ones decide
  // where each run BEGINS and ENDS.
  const rawClassOf = (i) => classifySample(pts[i], hasBrake).type;

  // Group contiguous same-class runs. ERS runs additionally break on a change of
  // ERS MODE, so a straight that ramps Medium → Boost becomes two ERS zones (and
  // therefore two distinct mode calls), not one averaged blob.
  const runs = [];
  for (let i = 0; i < N; i++) {
    const cls = classOf(i);
    const mode = cls === "ers" ? Math.round(clamp(pts[i].ersMode ?? 0, 0, 3)) : null;
    const key  = cls === "ers" ? `ers${mode}` : cls;
    const last = runs[runs.length - 1];
    if (last && last.key === key) last.endI = i;
    else runs.push({ cls, key, mode, startI: i, endI: i });
  }

  // Pull a run's edges onto the nearest RAW crossing into/out of its class, looking
  // no further than the smoothing window that displaced them. -1 means the raw
  // channels never do this thing anywhere near the run — i.e. the run exists only
  // because the average invented it (a corner-exit throttle ramp averaging down into
  // a "lift" while the reference is flat, which is how a Lift call ended up being
  // spoken 140 m up the straight). Those are dropped rather than announced.
  const rawStart = (i0, cls) => {
    for (let d = 0; d <= win; d++)
      for (const i of (d ? [i0 + d, i0 - d] : [i0]))
        if (i >= 0 && i < N && rawClassOf(i) === cls && (i === 0 || rawClassOf(i - 1) !== cls)) return i;
    return -1;
  };
  const rawEnd = (i1, cls) => {
    for (let d = 0; d <= win; d++)
      for (const i of (d ? [i1 - d, i1 + d] : [i1]))
        if (i >= 0 && i < N && rawClassOf(i) === cls && (i === N - 1 || rawClassOf(i + 1) !== cls)) return i;
    return -1;
  };

  const modeAt = (i) => Math.round(clamp(pts[i].ersMode ?? 0, 0, 3));

  const zones = [];
  for (const r of runs) {
    if (r.cls === "normal") continue;
    // ERS zones come from the mode channel itself, not from a smoothed threshold,
    // so their edges are already exact — only the pedal-derived ones need correcting.
    if (r.cls !== "ers") {
      const s = rawStart(r.startI, r.cls), e = rawEnd(r.endI, r.cls);
      if (s < 0 || e < 0) continue;
      if (s <= e) { r.startI = s; r.endI = e; }
    }
    // A partial lift is only a real coaching call when the driver eased off near-full
    // power and held it — not when throttle merely ramps back up on a corner exit.
    // Read on the RAW trace at the corrected edge: the smoothed value here is an
    // average reaching half a window up the road, which let corner exits pass.
    if (r.cls === "lift" && !(pts[Math.max(0, r.startI - 1)].throttle >= ERS_THR)) continue;
    const start = pts[r.startI].dist / totalDist;
    const end   = pts[r.endI].dist / totalDist;
    if ((end - start) * totalDist < (r.cls === "ers" ? ERS_MIN_M : PEDAL_MIN_M)) continue;

    // The zone's ERS mode: for an ERS run it IS the run; for a pedal zone it's
    // whatever mode the reference mostly held through it.
    const ersVals = [];
    for (let i = r.startI; i <= r.endI; i++) ersVals.push(Math.round(pts[i].ersMode ?? 0));
    if (r.cls === "brake") {
      zones.push({ start, end, type: "brake", ersMode: mostCommon(ersVals),
        note: "Braking zone (from reference)" });
    } else if (r.cls === "lico") {
      zones.push({ start, end, type: "lico", ersMode: mostCommon(ersVals),
        note: "Lift and coast — off throttle, no brake" });
    } else if (r.cls === "lift") {
      zones.push({ start, end, type: "lift", ersMode: mostCommon(ersVals),
        note: "Partial throttle lift (from reference)" });
    } else {
      const mode = Math.max(1, r.mode);
      // Silent when the reference was ALREADY in this mode before the zone opened:
      // then this isn't a change, it's the far side of a corner that split one long
      // deployment into two runs, and calling "Medium" at a driver already in Medium
      // is noise. It still colours the map — it just doesn't speak. The transition
      // loop below un-silences any zone that turns out to carry a real mode change.
      zones.push({ start, end, type: "ers", ersMode: mode,
        silent: r.startI > 0 && modeAt(r.startI - 1) === mode,
        note: `Reference runs ${ERS_MODES[mode]} here` });
    }
  }

  // ERS mode markers. The mode is a DISCRETE state the driver sets, so the call is
  // the CHANGE itself — and a change is a change however briefly it lasts and whatever
  // the throttle is doing. The runs above can only see a deployment that is BOTH long
  // enough to clear the floor AND held near full throttle (classifySample gates the
  // "ers" class on throttle ≥ ERS_THR, since a mid-braking-zone ERS colour would hide
  // the braking call), so a quick tap of Medium, or one taken at part throttle on a
  // corner exit, produced no call at all. These markers catch every transition no zone
  // already covers — including the drop back to None, which is all this loop used to
  // do. Built AFTER the length filter so a short application survives it.
  const trans = [];
  for (let i = 1; i < N; i++) if (modeAt(i) !== modeAt(i - 1)) trans.push(i);
  for (let t = 0; t < trans.length; t++) {
    const mode = modeAt(trans[t]);
    const at   = pts[trans[t]].dist / totalDist;
    // The stretch this mode is held for. Any zone the runs above derived for it must
    // begin inside that stretch — and it can begin LATER than the change itself, since
    // an "ers" run only opens once throttle is back to full: set Medium on a corner
    // exit and the zone appears a few bins up the road. Same event, so one call.
    const until = t + 1 < trans.length ? pts[trans[t + 1]].dist / totalDist : 1;
    const zone = zones.find(z => z.type === "ers" && z.ersMode === mode && z.start >= at && z.start < until);
    // Covered: keep the zone's extent for the map, but move its CALL onto the change.
    // The two are not the same place — a mode set through a corner complex has had its
    // zone open as much as 450 m later, which is where the call was going out.
    if (zone) { zone.callAt = Math.min(zone.start, at); zone.silent = false; continue; }
    zones.push({ start: at, end: Math.min(1, at + 0.01), type: "ers", ersMode: mode,
      note: mode === 0 ? "Stop deploying — ERS off" : `Reference switches to ${ERS_MODES[mode]} here` });
  }

  // Number each category in TRACK order. The two loops above build independently, so
  // numbering inside them would put a marker called "Medium 1" downstream of a zone
  // called "Medium 3".
  const seenN = {};
  zones.sort((a, b) => a.start - b.start).forEach((z, i) => {
    z.id = i + 1;
    const base = z.type === "ers"  ? ERS_MODES[z.ersMode]
               : z.type === "brake" ? "Brake"
               : z.type === "lico"  ? "Lift & Coast" : "Lift";
    seenN[base] = (seenN[base] || 0) + 1;
    z.name = `${base} ${seenN[base]}`;
  });

  return zones;
}
