// ─── The time axis ────────────────────────────────────────────────────────────
// When was the car where. Lifted out of DrivingLinesView unchanged when the game
// overlay needed the same answer for its live delta: the overlay asks "what time
// had the reference set by this point on the road", which is this curve read at
// one distance instead of walked frame by frame. Two callers, one all-or-nothing
// rule — duplicating it is how the two would quietly drift apart.
//
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

// ─── Reference time axis, for the overlay's live delta ───────────────────────
// Collapse a reference lap's samples into the two parallel arrays a delta lookup
// needs: distance along the lap, and the time the reference had set by there. The
// preference order is the one above — measured clock if the lap carries it whole,
// the integral otherwise — so a v4 lap and a legacy one both work and neither
// gets a spliced curve.
//
// Returned as plain arrays rather than the sample objects because this crosses a
// window boundary: it is structured-cloned to the overlay webview, where the
// other forty fields per sample would be pure freight.
export function buildRefAxis(samples) {
  const pts = (samples || [])
    .filter(s => s && typeof s.dist === "number" && isFinite(s.dist))
    .sort((a, b) => a.dist - b.dist);
  if (pts.length < 20) return null;               // too sparse to read a delta off
  const cum = recordedTimeAxis(pts) || integratedTimeAxis(pts);
  if (!cum || !(cum[cum.length - 1] > 0)) return null;
  return { dist: pts.map(p => p.dist), t: cum, lapTime: cum[cum.length - 1] };
}

// Time the reference had set by `d` metres, linearly between the two bins either
// side. Linear is right here where the playback path needs a monotone cubic: this
// is read once per frame for a NUMBER on screen, not to place a car, so the
// slope discontinuities that make a ghost surge are invisible — and the delta is
// a difference of two clocks, where an interpolation that overshoots would read
// as the driver gaining time they had not gained.
export function refTimeAt(axis, d) {
  if (!axis || !(d >= 0)) return null;
  const { dist, t } = axis;
  const n = dist.length;
  if (d <= dist[0]) return t[0];
  if (d >= dist[n - 1]) return t[n - 1];
  // Binary search — called every telemetry tick, and a reference lap is ~600 bins.
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (dist[mid] <= d) lo = mid; else hi = mid;
  }
  const span = dist[hi] - dist[lo];
  if (!(span > 0)) return t[lo];
  return t[lo] + (t[hi] - t[lo]) * ((d - dist[lo]) / span);
}
