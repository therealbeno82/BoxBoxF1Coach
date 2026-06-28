// ─── LAP ANALYSIS (shared core) ───────────────────────────────────────────────
// Single source of truth for "your lap vs the reference". Both the structured
// Coach Log screen (buildCoachLog) and the prose LLM evidence (buildLapEvidence)
// derive from this — so the detection thresholds live in ONE place and can't drift
// apart between the two views.
//
// What it produces, per channel (Line / Braking / Throttle / ERS / Gear):
//   - findings: the specific, human-readable callouts (the worst offenders)
//   - channelTime: REAL seconds lost, attributed to that channel
//
// The time model is physical, not a unit-mixed weight. For each grid segment of
// length STEP, the time delta is STEP/v_you − STEP/v_ref (speeds in m/s). That's
// the actual time you bleed crossing that piece of track. Every lossy segment is
// attributed to the one channel most responsible for it, so the per-channel
// seconds are directly comparable and sum to the modeled total loss.

import { ERS_MODES } from "./config.js";

export const CHANNELS = ["LINE", "BRAKING", "THROTTLE", "ERS", "GEAR"];

const SPEED_FLOOR_KMH = 12; // guard the 1/v time model against pit/standstill samples

function ord(n) { return n === 1 ? "st" : n === 2 ? "nd" : n === 3 ? "rd" : "th"; }

// Interpolated sample at track distance `d`. Continuous channels (speed, throttle,
// brake, steer) are linearly interpolated between the two bracketing samples;
// discrete ones (gear, ERS mode) snap to the nearer sample — you can't be in gear
// 4.5. Samples are sorted by dist, so we binary-search the bracket.
function sampleAt(samples, d) {
  const last = samples.length - 1;
  if (d <= samples[0].dist) return samples[0];
  if (d >= samples[last].dist) return samples[last];
  let lo = 0, hi = last;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (samples[mid].dist <= d) lo = mid; else hi = mid;
  }
  const a = samples[lo], b = samples[hi];
  const span = (b.dist - a.dist) || 1;
  const t = (d - a.dist) / span;
  const lerp = (x, y) => (x ?? 0) + ((y ?? 0) - (x ?? 0)) * t;
  const near = (x, y) => (t < 0.5 ? x : y);
  return {
    dist: d,
    speed: lerp(a.speed, b.speed),
    throttle: lerp(a.throttle, b.throttle),
    brake: lerp(a.brake, b.brake),
    steer: lerp(a.steer, b.steer),
    gear: near(a.gear, b.gear),
    ersMode: near(a.ersMode, b.ersMode),
    ersSpent: lerp(a.ersSpent, b.ersSpent),
  };
}

// Keep picked rows at least `minGap` m apart so findings span the track.
function spread(rows, n, minGap) {
  const out = [];
  for (const r of rows) {
    if (out.every((p) => Math.abs(p.d - r.d) > minGap)) out.push(r);
    if (out.length >= n) break;
  }
  return out;
}

// Which channel is most responsible for time lost in this segment. Order =
// actionability: a braking-point error trumps a raw min-speed deficit, etc.
function causeOf(x) {
  if ((x.uBr > 20 && x.rBr < 5) || (x.rBr > 25 && x.uBr < 5)) return "BRAKING";
  if (x.rThr > 85 && x.uThr < x.rThr - 20) return "THROTTLE";
  if (typeof x.uGear === "number" && typeof x.rGear === "number" &&
      x.uGear !== x.rGear && x.rSpeed > 80) return "GEAR";
  if (x.rErs > x.uErs) return "ERS";
  return "LINE";
}

// Build a finding object for a row, phrased for its channel.
function describe(channel, x, where) {
  const zone = where(x.d);
  const ds = Math.round(x.dSpeed);
  switch (channel) {
    case "LINE":
      return { d: x.d, zone, delta: `${ds} km/h`,
        text: `Carrying ${Math.abs(ds)} km/h less here (${Math.round(x.uSpeed)} vs ${Math.round(x.rSpeed)}) — more minimum speed.` };
    case "BRAKING":
      return x.uBr > x.rBr
        ? { d: x.d, zone, delta: `${Math.round(x.uBr)}%`,
            text: `Braking ${Math.round(x.uBr)}% where the reference is off the brake — too early.` }
        : { d: x.d, zone, delta: `${Math.round(x.rBr)}%`,
            text: `Reference brakes ${Math.round(x.rBr)}% here and you don't — review the braking point.` };
    case "THROTTLE":
      return { d: x.d, zone, delta: `${Math.round(x.uThr)} → ${Math.round(x.rThr)}%`,
        text: `Throttle ${Math.round(x.uThr)}% vs reference ${Math.round(x.rThr)}% — get to power sooner.` };
    case "ERS":
      return { d: x.d, zone, delta: `${ERS_MODES[x.uErs]}→${ERS_MODES[x.rErs]}`,
        text: `Reference runs ${ERS_MODES[x.rErs]} where you're in ${ERS_MODES[x.uErs]} — deploy more here.` };
    case "GEAR":
      return { d: x.d, zone, delta: `${x.uGear} vs ${x.rGear}`,
        text: `You're in ${x.uGear}${ord(x.uGear)} where the reference holds ${x.rGear}${ord(x.rGear)} — match the gear for drive.` };
    default:
      return { d: x.d, zone, delta: "", text: "" };
  }
}

const PER_CHANNEL = { LINE: 2, BRAKING: 2, THROTTLE: 2, ERS: 1, GEAR: 1 };

// analyzeLap(userSamples, refSamples, opts) → null | {
//   findings: { LINE:[…], BRAKING:[…], … }   // each item { zone, delta, text, timeLost }
//   channelTime: { LINE:s, … }               // real seconds lost, by channel
//   modeledTotalLost: number                 // Σ positive segment time deltas (s)
//   avgDeltaSpeed: number                    // mean (you − ref) km/h across the lap
//   lapLen, where
// }
export function analyzeLap(userSamples, refSamples, opts = {}) {
  if (!Array.isArray(userSamples) || !Array.isArray(refSamples)) return null;
  if (userSamples.length < 5 || refSamples.length < 5) return null;

  const lapLen = Math.max(
    userSamples[userSamples.length - 1]?.dist || 0,
    refSamples[refSamples.length - 1]?.dist || 0
  );
  if (lapLen <= 0) return null;

  const labelAt = opts.labelAt;
  const where = (d) => (labelAt && labelAt(d, lapLen)) || `${Math.round(d)}m`;

  const STEP = opts.step || 50;
  const segM = STEP; // segment length each row stands for (m)
  const rows = [];
  for (let d = 0; d <= lapLen; d += STEP) {
    const u = sampleAt(userSamples, d), r = sampleAt(refSamples, d);
    if (!u || !r) continue;
    const vu = Math.max(SPEED_FLOOR_KMH, u.speed ?? 0) / 3.6; // m/s
    const vr = Math.max(SPEED_FLOOR_KMH, r.speed ?? 0) / 3.6;
    const dt = segM / vu - segM / vr;                          // s, +ve = you slower
    rows.push({
      d, dSpeed: (u.speed ?? 0) - (r.speed ?? 0), uSpeed: u.speed, rSpeed: r.speed,
      uThr: u.throttle ?? 0, rThr: r.throttle ?? 0, uBr: u.brake ?? 0, rBr: r.brake ?? 0,
      uErs: u.ersMode ?? 0, rErs: r.ersMode ?? 0, uGear: u.gear, rGear: r.gear,
      dt, dtLost: Math.max(0, dt),
    });
  }
  if (!rows.length) return null;

  // Attribute each lossy segment's time to the channel most responsible for it.
  const channelTime = { LINE: 0, BRAKING: 0, THROTTLE: 0, ERS: 0, GEAR: 0 };
  for (const x of rows) {
    if (x.dtLost <= 0) continue;
    x.cause = causeOf(x);
    channelTime[x.cause] += x.dtLost;
  }
  const modeledTotalLost = CHANNELS.reduce((s, c) => s + channelTime[c], 0);

  // Findings = the worst-offending segments for each channel, spread across the
  // track, each tagged with the seconds it actually cost.
  const findings = {};
  for (const c of CHANNELS) {
    const picked = spread(
      rows.filter((x) => x.cause === c && x.dtLost > 0).sort((a, b) => b.dtLost - a.dtLost),
      PER_CHANNEL[c], 200
    );
    findings[c] = picked.map((x) => ({ ...describe(c, x, where), timeLost: x.dtLost }));
  }

  const avgDeltaSpeed = rows.reduce((s, x) => s + x.dSpeed, 0) / rows.length;

  return { findings, channelTime, modeledTotalLost, avgDeltaSpeed, lapLen, where };
}

// Reconcile the modeled per-segment loss with the measured lap-time delta. When
// both lap times are known, `scale` maps modeled seconds onto the real measured
// loss (so per-channel/per-finding seconds sum to it); otherwise it's the modeled
// estimate (scale 1, `estimated` true). Shared by the structured screen and the
// prose evidence so their seconds agree.
export function reconcile(analysis, userLapTime, refLapTime) {
  const isNum = (v) => typeof v === "number" && !Number.isNaN(v);
  const measuredLost = (isNum(userLapTime) && isNum(refLapTime) && userLapTime > refLapTime)
    ? userLapTime - refLapTime : null;
  const estimated = measuredLost == null;
  const totalLost = estimated ? Math.min(3.0, analysis.modeledTotalLost) : measuredLost;
  const scale = (!estimated && analysis.modeledTotalLost > 0) ? measuredLost / analysis.modeledTotalLost : 1;
  return { measuredLost, totalLost, scale, estimated };
}

// Flatten every finding into one list, biggest time loss first.
export function rankFindings(analysis) {
  const all = [];
  for (const c of CHANNELS) for (const f of analysis.findings[c]) all.push({ ...f, channel: c });
  all.sort((a, b) => b.timeLost - a.timeLost);
  return all;
}
