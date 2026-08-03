// ─── RACING LINE ADDRESSING ───────────────────────────────────────────────────
// Pure geometry for reading a position, a heading or a pedal colour off a built
// racing line — the `{ pts, distAt, lapLen }` shape buildLines() produces.
//
// This left DrivingLinesView because two views now read the same lines: the
// top-down plan view and the T-cam. Keeping one copy is what stops the two from
// disagreeing about where a car is or what colour full throttle is.
//
// Everything here INTERPOLATES, never extrapolates — the segment fraction is
// clamped to [0,1]. A live in-progress lap doesn't start at distance 0 (the
// recorder's buffer begins wherever the car was), so a playhead of 0 sits BEFORE
// the first sample; an unclamped fraction went negative there and ran the curve
// backwards off its own start.

import { clamp } from "./format.js";

// ─── Pedal-input colouring ────────────────────────────────────────────────────
// A single scalar t (0 = bright green, 1 = bright red) driven by the pedals:
// throttle owns the green half, brake the red half, meeting at yellow when the
// car is coasting off both pedals into a corner. Branchless so it stays smooth as
// the driver trails off the brake and rolls back onto the throttle at corner exit.
export function pedalT(throttle, brake) {
  const thr = typeof throttle === "number" ? clamp(throttle, 0, 100) : 100;
  const brk = typeof brake    === "number" ? clamp(brake, 0, 100)    : 0;
  return clamp(0.5 * (1 - thr / 100) + 0.5 * (brk / 100), 0, 1);
}
// t → CSS colour along a green→yellow→red hue ramp (130° green … 0° red).
export const pedalColor = (t) => `hsl(${Math.round(130 * (1 - t))}, 85%, 52%)`;

// ─── Angles ───────────────────────────────────────────────────────────────────
// Shortest-arc wrap of an angle difference into (−π, π]. JS `%` keeps the
// DIVIDEND's sign (−1 % 4 === −1, not 3), hence the branch — without it a
// negative delta comes back out the far side and a camera easing toward it
// takes the long way around.
export function wrapPi(a) {
  const m = (a + Math.PI) % (2 * Math.PI);
  return (m < 0 ? m + 2 * Math.PI : m) - Math.PI;
}

// ─── Curve addressing ─────────────────────────────────────────────────────────
export const lerpT = (f, lo, hi) => (hi > lo ? clamp((f - lo) / (hi - lo), 0, 1) : 0);

// The index of the first sample at or past a track-distance fraction, plus the
// sub-segment fraction within it. Shared by both position samplers.
function locate(line, fd) {
  const { distAt, pts } = line;
  const f = clamp(fd, 0, 1);
  let i = 1; while (i < distAt.length && distAt[i] < f) i++;
  i = Math.min(i, pts.length - 1);
  return { i, t: lerpT(f, distAt[i - 1] ?? 0, distAt[i] ?? 1) };
}

// Interpolated world position of a line at a track-distance fraction. Linear —
// this is where the car ACTUALLY was, so it's what the drawn ribbons use.
export function posAtFrac(line, fd) {
  const { pts } = line;
  const { i, t } = locate(line, fd);
  return {
    x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * t,
    z: pts[i - 1].z + (pts[i].z - pts[i - 1].z) * t,
  };
}

// ─── Smoothed position (camera pose only) ─────────────────────────────────────
// Samples are 10 m distance bins, and at 55 m/s you cross one every 0.18 s. A
// linear read CUTS EACH CHORD through a corner, which a first-person camera shows
// as a low-frequency lateral facet — a POSITION artefact that no amount of yaw
// smoothing touches. So the camera rides a centripetal Catmull-Rom (α = 0.5)
// through the same samples, which passes through every point but arrives with a
// continuous tangent. Centripetal rather than uniform because uniform Catmull-Rom
// forms cusps and self-intersections when spacing is uneven, which is exactly what
// a distance-binned lap with the odd dropped packet looks like.
//
// Deliberately NOT used for the drawn lines: those must show where the car really
// was, not a prettier curve through it.
const CR_ALPHA = 0.5;

export function posAtFracSmooth(line, fd) {
  const { pts } = line;
  if (pts.length < 4) return posAtFrac(line, fd);
  const { i, t } = locate(line, fd);
  // Duplicate the endpoints rather than wrapping: a recorded lap is an OPEN
  // polyline (the buffer starts and ends wherever the car was), so wrapping would
  // splice the lap's end into its start.
  const at = (j) => pts[clamp(j, 0, pts.length - 1)];
  const p0 = at(i - 2), p1 = at(i - 1), p2 = at(i), p3 = at(i + 1);

  const knot = (a, b, acc) => {
    const d = Math.hypot(b.x - a.x, b.z - a.z);
    return acc + Math.pow(d, CR_ALPHA);
  };
  const t0 = 0;
  const t1 = knot(p0, p1, t0);
  const t2 = knot(p1, p2, t1);
  const t3 = knot(p2, p3, t2);
  // Coincident samples (a stopped car, a duplicated bin) collapse a knot span and
  // would divide by zero — fall back to the linear read, which is right anyway
  // when there's no movement to interpolate.
  if (!(t1 > t0) || !(t2 > t1) || !(t3 > t2)) return posAtFrac(line, fd);

  const tt = t1 + (t2 - t1) * t;
  const mix = (a, b, ta, tb) => {
    const w = (tb - tt) / (tb - ta), v = (tt - ta) / (tb - ta);
    return { x: a.x * w + b.x * v, z: a.z * w + b.z * v };
  };
  const a1 = mix(p0, p1, t0, t1);
  const a2 = mix(p1, p2, t1, t2);
  const a3 = mix(p2, p3, t2, t3);
  const b1 = mix(a1, a2, t0, t2);
  const b2 = mix(a2, a3, t1, t3);
  return mix(b1, b2, t1, t2);
}

// ─── Heading ──────────────────────────────────────────────────────────────────
// Direction of travel from a chord around the point, measured in METRES rather
// than lap fraction. A fixed fraction is a different chord on every circuit —
// ±0.0025 spans ±14.5 m at Spa but ±8.25 m at Monaco — so the same constant gave
// a steady heading on one track and a jittery one on another.
//
// ±12 m spans ~1.2 bins each side: long enough to average out bin-boundary noise,
// short enough that a Monaco hairpin (R ≈ 12 m) isn't badly cut.
export const HEADING_CHORD_M = 24;

export function headingAtMeters(line, fd, chordM = HEADING_CHORD_M) {
  const half = chordM / 2 / Math.max(1, line?.lapLen || 1);
  // Slide the window inward at the lap ends instead of clamping both endpoints
  // onto the same sample, which would collapse the chord to atan2(0,0).
  let lo = fd - half, hi = fd + half;
  if (lo < 0) { hi = Math.min(1, hi - lo); lo = 0; }
  if (hi > 1) { lo = Math.max(0, lo - (hi - 1)); hi = 1; }
  const a = posAtFracSmooth(line, lo);
  const b = posAtFracSmooth(line, hi);
  return Math.atan2(b.z - a.z, b.x - a.x);
}

// Degrees, for SVG `rotate()`. The plan view's car markers want this.
export const headingAtDeg = (line, fd, chordM) =>
  headingAtMeters(line, fd, chordM) * 180 / Math.PI;
