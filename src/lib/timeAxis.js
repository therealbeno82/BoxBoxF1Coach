// ─── LAP TIME AXIS ─────────────────────────────────────────────────────────────
// When was the car where, along one recorded lap: a cumulative-seconds array
// parallel to the lap's samples (sorted by dist). Shared by everything that turns
// "a distance on the lap" into "a time on the lap":
//   • Driving Lines' pace-sync, which places the cars by it;
//   • the Live screen's running delta to the reference;
//   • the trace stack's Δt channel.
// Moved here from DrivingLinesView unchanged; lapClockAxis/timeAtDist are new.

// Pace-sync stands entirely on knowing WHEN each car was where, and there are two
// ways to know it.
//
// The good way is to have written it down. The recorder now stamps every 10 m bin
// with the game's own lap clock (BoxBoxApp), so for those laps this is a read, not a
// calculation, and it carries no error at all.
//
// The other way — the only one available for every lap recorded before that, which is
// all of the existing history — is to reconstruct it by integrating Δdistance ÷ speed.
// That works, but it is an approximation twice over: speed is a POINT sample at each
// bin while the bin spans anywhere from 3 to 13 m, and the bins are 10 m apart in a
// place where the car may be braking hard. Measured against the 25 demo laps the
// integral runs ~1.9% long, and locally it is out by order 10 ms. 10 ms at Spa's
// 66 m/s is two thirds of a metre — and since the ghost's position IS this curve,
// that error is visible as the ghost drifting fore and aft against a car it should be
// holding station with.
export function recordedTimeAxis(pts) {
  // All-or-nothing: a lap that only half-carries the clock would splice a measured
  // curve onto a derived one, and the seam is worse than either.
  if (pts.length < 2 || !pts.every(p => typeof p.t === "number")) return null;
  const t0 = pts[0].t;
  const cum = pts.map(p => p.t - t0);
  // A flashback or a stationary spell can send the clock backwards or flat; the curve
  // has to stay non-decreasing for the monotone lookups built on it.
  for (let i = 1; i < cum.length; i++) if (!(cum[i] > cum[i - 1])) cum[i] = cum[i - 1];
  return cum[cum.length - 1] > 0 ? cum : null;
}

// Trapezoid, not the end-point speed. The time to cross a bin at constant
// acceleration is its length over the MEAN of the two speeds; charging the whole bin
// at the speed it ended on overstates a braking zone and understates the exit by as
// much. Across the 25 demo laps it tightens how consistently the curve reproduces the
// game's real lap time (spread 0.338% → 0.278%), which is the figure pace-sync depends
// on. Same rule the demo session's own time axis uses (scripts/make-demo-session.mjs).
export function integratedTimeAxis(pts) {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) {
    const dd = Math.max(0, pts[i].dist - pts[i - 1].dist);
    const v1 = Math.max(pts[i].speed / 3.6, 1);       // km/h → m/s, floor 1
    const v0 = Math.max(pts[i - 1].speed / 3.6, 1);
    cum[i] = cum[i - 1] + dd / ((v0 + v1) / 2);
  }
  return cum;
}

// NOT SMOOTHED: pre-filtering the speed channel before integrating was tried and
// rejected. It does buy a little more smoothness (worst frame-to-frame jump 1.29 →
// 0.83 m/s at ±2 samples), but measured across the 25 demo laps it WIDENS the
// lap-to-lap spread of the derived lap time (0.278% → 0.317%) even as it lowers the
// mean bias. Pace-sync reads the RATIO of two laps' curves, so a bias they share
// cancels and only the spread between them survives — a filter that trades spread for
// bias is trading away the only part that matters here.


// The lap CLOCK at each sample of a lap — seconds since the lap began, so it can
// be compared directly with the game's live lapTime. Null for fewer than two
// samples.
//
// A recorded axis starts at its first sample, so the game clock at that sample is
// added back. A reconstructed one is rescaled to end on the lap's real time: the
// integral runs ~1.9% long (see above), which at the end of a 90 s lap would be a
// ~1.7 s phantom delta, while its SHAPE — where along the lap the time went — is
// what's worth keeping.
export function lapClockAxis(lap) {
  const samples = lap?.samples;
  if (!Array.isArray(samples) || samples.length < 2) return null;
  const rec = recordedTimeAxis(samples);
  if (rec) {
    const t0 = samples[0].t || 0;
    return rec.map((v) => v + t0);
  }
  const integ = integratedTimeAxis(samples);
  const end = integ[integ.length - 1];
  const lapTime = lap.lapTime ?? lap.meta?.lapTime;
  const k = lapTime > 0 && end > 0 ? lapTime / end : 1;
  return integ.map((v) => v * k);
}

// Elapsed lap time at lap distance `d`, linearly interpolated on a time axis built
// by timeAxisOf. Null outside the recorded span (beyond one bin of slack): a time
// read off a stretch the lap never covered is a guess, and a live delta that
// guesses is worse than one that stays blank for a moment.
export function timeAtDist(samples, axis, d) {
  const n = samples?.length || 0;
  if (!axis || n < 2 || !Number.isFinite(d)) return null;
  const first = samples[0].dist, last = samples[n - 1].dist;
  if (d < first - 15 || d > last + 15) return null;
  if (d <= first) return axis[0];
  if (d >= last) return axis[n - 1];
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (samples[mid].dist <= d) lo = mid; else hi = mid;
  }
  const span = samples[hi].dist - samples[lo].dist;
  const f = span > 0 ? (d - samples[lo].dist) / span : 0;
  return axis[lo] + (axis[hi] - axis[lo]) * f;
}
