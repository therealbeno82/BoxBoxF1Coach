// ─── LEADERBOARD VALIDATION ───────────────────────────────────────────────────
// Structural checks on a submitted lap's trace. Nothing in a lap file is signed,
// so anyone can hand-edit an exported JSON and re-import it — these are what stop
// an edited file reaching a public board.
//
// What they DO catch: a hand-edited lap time (the trace no longer integrates to
// the claim), a flashback-stitched lap (holes in the distance axis, a rewound ERS
// counter), a truncated or padded trace, impossible speeds, an inconsistent
// sector split.
//
// What they DO NOT catch, and no amount of tuning will: a genuinely-driven lap
// with traction control and ABS on. The game sends those assist flags in the
// Session packet, but the Rust parser doesn't read them yet, so a board cannot
// currently tell an assisted lap from a clean one. That's the honest limit of
// v1 and the single highest-value follow-up.
//
// Pure. Runs identically in the app (as a pre-check) and in the Edge Function
// (as the decision). Returns findings rather than throwing, so the caller can
// distinguish "reject" from "accept but flag".

import { THRESHOLDS as T } from "./limits.js";
import { plausibleLapTime } from "./limits.js";

const SPEED_FLOOR_MS = 1; // stopped-car guard on the 1/v integrand

// ─── (a) Lap time re-derived from the trace ───────────────────────────────────
// The samples carry no timestamp — a lap is purely distance-indexed — so the only
// way to check a claimed lap time against its own trace is to integrate ds/v.
//
// QUADRATURE. DrivingLinesView does this with a left-endpoint Riemann sum, which
// is fine for drawing a playhead but biased for validation: it holds v constant
// across each 10 m bin, so it under-counts time in braking zones and over-counts
// under acceleration. Those don't cancel — braking decelerations are far sharper
// than accelerations. Concretely, one bin where v falls 30 → 22 m/s gives
// 10/30 = 0.333 s against a true ~0.388 s, an 0.055 s error in a single bin.
//
// The harmonic mean below is exact for uniform acceleration across a slice, and a
// 10 m slice essentially is uniform. One extra term, error well under 0.5%.
//
//   dt = 2 * dd / (v_i + v_i+1)
//
// HEAD AND TAIL. The recorder's first bin lands 0-10 m past the line and the last
// one up to 10 m short of it, so a raw integral is systematically short by up to
// ~0.3 s. Both corrections need the true track length; without it we fall back to
// the last sample's distance and the tail term vanishes, which is why laps with
// no meta.trackLengthM need the tolerance to stay loose.
export function integrateLapTime(samples, trackLengthM = null) {
  if (!Array.isArray(samples) || samples.length < 2) return null;

  const ms = (kmh) => Math.max((Number(kmh) || 0) / 3.6, SPEED_FLOOR_MS);
  let total = 0;

  // Head: from the start/finish line to the first sample.
  const first = samples[0];
  if (first.dist > 0) total += first.dist / ms(first.speed);

  for (let i = 1; i < samples.length; i++) {
    const dd = samples[i].dist - samples[i - 1].dist;
    if (!(dd > 0)) continue; // non-monotonic: covered by checkCoverage, skip here
    total += (2 * dd) / (ms(samples[i - 1].speed) + ms(samples[i].speed));
  }

  // Tail: from the last sample back to the line.
  const last = samples[samples.length - 1];
  if (trackLengthM > last.dist) total += (trackLengthM - last.dist) / ms(last.speed);

  return total;
}

// → { ok, flagged, ratio, derived, reason }
//
// Compared as a RATIO against an off-centre window, not as a symmetric error —
// see the long note on integralRatio* in limits.js. A ratio below the window
// means the trace is too slow for the claimed time (the usual shape of an edited
// lap time); above it means the trace doesn't reach the claimed distance in the
// claimed time at all.
export function checkLapTimeIntegral(samples, claimedS, trackLengthM = null) {
  const derived = integrateLapTime(samples, trackLengthM);
  if (derived == null || !(claimedS > 0)) {
    return { ok: false, flagged: false, derived, ratio: null, reason: "The trace is too short to check against its lap time." };
  }
  const ratio = derived / claimedS;
  if (ratio < T.integralRatioMin || ratio > T.integralRatioMax) {
    return {
      ok: false, flagged: false, derived, ratio,
      reason: `This lap claims ${claimedS.toFixed(3)}s, but its own speed trace describes a ${derived.toFixed(3)}s lap — they aren't the same lap.`,
    };
  }
  const clean = ratio >= T.integralRatioPassMin && ratio <= T.integralRatioPassMax;
  return { ok: true, flagged: !clean, derived, ratio, reason: null };
}

// ─── (b) Distance coverage ────────────────────────────────────────────────────
// A flashback or a burst of dropped packets leaves a hole in the distance axis; a
// clean lap has ~95% of its gaps at exactly the recorder's 10 m bin width.
export function checkCoverage(samples, trackLengthM = null) {
  if (!Array.isArray(samples) || samples.length < T.minSamples) {
    return { ok: false, reason: `Only ${samples?.length ?? 0} trace samples — too few to be a full lap.` };
  }
  const first = samples[0], last = samples[samples.length - 1];

  if (first.dist > T.firstDistMaxM) {
    return { ok: false, reason: `The trace starts ${Math.round(first.dist)}m past the line — it isn't a complete lap.` };
  }

  let maxGap = 0;
  for (let i = 1; i < samples.length; i++) {
    const dd = samples[i].dist - samples[i - 1].dist;
    if (!(dd > 0)) {
      return { ok: false, reason: "The trace doubles back on itself — distance must always increase." };
    }
    if (dd > maxGap) maxGap = dd;
  }
  if (maxGap > T.maxGapM) {
    return { ok: false, reason: `There's a ${Math.round(maxGap)}m hole in the trace — a flashback or lost telemetry.` };
  }

  const span = last.dist - first.dist;
  if (trackLengthM > 0) {
    if (span < trackLengthM * T.coverageMin) {
      return { ok: false, reason: `The trace covers ${Math.round(span)}m of a ${Math.round(trackLengthM)}m lap.` };
    }
    const expected = trackLengthM / 10;
    const ratio = samples.length / expected;
    if (ratio < T.sampleCountMin || ratio > T.sampleCountMax) {
      return { ok: false, reason: `The trace has ${samples.length} samples where this circuit should give about ${Math.round(expected)}.` };
    }
  }
  return { ok: true, reason: null, span, maxGap };
}

// ─── (c) ERS deployment monotonicity ──────────────────────────────────────────
// ersSpent is a per-lap cumulative counter the game resets at the line, so within
// one lap it can only rise. A flashback rewinds the car AND the counter — but the
// recorder's bins are keyed by distance, so re-driven bins get overwritten with
// lower post-flashback values while bins beyond the flashback point still hold
// the higher pre-flashback ones. The tell is a descending step.
//
// This is a WEAK signal and the code should be read as such. If the re-drive is
// faster everywhere the counter stays monotone, and in Time Trial a smooth
// automatic ERS ramp hides it entirely. It costs one pass and sometimes catches
// something; it is not a flashback detector.
export function checkErs(samples) {
  if (!Array.isArray(samples) || samples.length < 2) return { ok: true, flagged: false, drops: 0 };

  let drops = 0, totalDrop = 0, worst = 0;
  for (let i = 1; i < samples.length; i++) {
    // Skip the start/finish reset window — see ersResetZoneM in limits.js.
    if ((Number(samples[i].dist) || 0) < T.ersResetZoneM) continue;
    const prev = Number(samples[i - 1].ersSpent) || 0;
    const cur = Number(samples[i].ersSpent) || 0;
    const drop = prev - cur;
    if (drop > T.ersDropKj) {
      drops++;
      totalDrop += drop;
      if (drop > worst) worst = drop;
    }
  }

  if (drops >= T.ersDropCountReject || worst > T.ersDropSingleRejectKj) {
    return { ok: false, flagged: false, drops, reason: "The ERS counter rewinds during this lap — that's the signature of a flashback." };
  }
  const flagged = drops >= T.ersDropCountFlag || totalDrop > T.ersDropTotalFlagKj;
  return { ok: true, flagged, drops, reason: null };
}

// ─── (d) Sector sum ───────────────────────────────────────────────────────────
// The recorder builds S3 as (lapTime - s1 - s2), so for any lap that genuinely
// came from it the three sectors sum to the lap time to float precision. Laps
// that arrived via a session file or a profile import preserve the relation too.
// That makes this the tightest check here and the cheapest to run — an edited lap
// time almost always forgets to move the sectors with it.
export function checkSectors(sectorTimes, lapTimeS) {
  if (!Array.isArray(sectorTimes) || sectorTimes.length !== 3 || sectorTimes.some((s) => typeof s !== "number")) {
    return { ok: true, flagged: true, reason: null }; // untagged: skip, but flag
  }
  const [s1, s2, s3] = sectorTimes;
  if (s1 < T.sectorMinS || s2 < T.sectorMinS || s3 < T.sectorMinS) {
    return { ok: false, flagged: false, reason: "One of this lap's sector times is impossibly short." };
  }
  const sum = s1 + s2 + s3;
  if (Math.abs(sum - lapTimeS) > T.sectorSumMaxS) {
    return { ok: false, flagged: false, reason: `The sector times add up to ${sum.toFixed(3)}s but the lap claims ${lapTimeS.toFixed(3)}s.` };
  }
  return { ok: true, flagged: false, reason: null };
}

// ─── (f) Speed sanity ─────────────────────────────────────────────────────────
export function checkSpeed(samples) {
  if (!Array.isArray(samples) || !samples.length) return { ok: false, reason: "The trace has no samples." };
  let max = 0, crawl = 0;
  for (const s of samples) {
    const v = Number(s.speed) || 0;
    if (v < 0) return { ok: false, reason: "The trace contains negative speeds." };
    if (v > max) max = v;
    if (v < T.crawlSpeedKmh) crawl++;
  }
  if (max > T.speedMaxKmh) {
    return { ok: false, reason: `The trace reaches ${Math.round(max)} km/h, which no F1 car does.` };
  }
  if (crawl / samples.length > T.crawlFractionMax) {
    return { ok: false, reason: "The car is stationary for too much of this trace to call it a lap." };
  }
  return { ok: true, reason: null, maxSpeed: max };
}

// ─── (g) Display name ─────────────────────────────────────────────────────────
// Strip control and zero-width characters, collapse whitespace, refuse anything
// that looks like an advert. Returns the cleaned name or null.
export function sanitizeDisplayName(raw) {
  const cleaned = String(raw ?? "")
    // Control chars, then the zero-width / bidi-override block that lets a name
    // render as something other than what it stores.
    .replace(/[\u0000-\u001F\u007F]/g, "")
    .replace(/[\u200B-\u200F\u2028\u2029\u202A-\u202E\uFEFF]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, T.nameMaxLen);
  if (cleaned.length < T.nameMinLen) return null;
  if (/https?:\/\/|www\.|\.(com|net|org|io|gg)\b/i.test(cleaned)) return null;
  return cleaned;
}

// ─── The whole battery ────────────────────────────────────────────────────────
// → { ok, verdict: "ok"|"flagged", reason, checks }
// `reason` is written to be shown to the driver verbatim when ok is false.
export function validateSubmission({ samples, lapTime, sectorTimes, trackLengthM, slug }) {
  const checks = {};

  const plausible = plausibleLapTime(slug, lapTime);
  if (!plausible.ok) return { ok: false, verdict: null, reason: plausible.reason, checks };

  const coverage = checkCoverage(samples, trackLengthM);
  checks.coverage = { span: coverage.span ?? null, maxGap: coverage.maxGap ?? null };
  if (!coverage.ok) return { ok: false, verdict: null, reason: coverage.reason, checks };

  const speed = checkSpeed(samples);
  checks.maxSpeed = speed.maxSpeed ?? null;
  if (!speed.ok) return { ok: false, verdict: null, reason: speed.reason, checks };

  const sectors = checkSectors(sectorTimes, lapTime);
  if (!sectors.ok) return { ok: false, verdict: null, reason: sectors.reason, checks };

  const integral = checkLapTimeIntegral(samples, lapTime, trackLengthM);
  checks.derivedLapTime = integral.derived ?? null;
  checks.integralRatio = integral.ratio ?? null;
  if (!integral.ok) return { ok: false, verdict: null, reason: integral.reason, checks };

  const ers = checkErs(samples);
  checks.ersDrops = ers.drops;
  if (!ers.ok) return { ok: false, verdict: null, reason: ers.reason, checks };

  const flagged = integral.flagged || sectors.flagged || ers.flagged;
  return { ok: true, verdict: flagged ? "flagged" : "ok", reason: null, checks };
}
