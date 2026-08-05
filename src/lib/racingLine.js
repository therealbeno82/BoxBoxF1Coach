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

// ─── Centripetal Catmull-Rom ──────────────────────────────────────────────────
// Samples are 10 m distance bins, and at 55 m/s you cross one every 0.18 s. Joining
// them with STRAIGHT CHORDS cuts every corner into a run of facets — a first-person
// camera reads that as a lateral twitch each time it crosses a bin, and the drawn
// ribbons read as a polygon rather than an arc. So anything that needs a position
// BETWEEN two samples rides a centripetal Catmull-Rom (α = 0.5) instead.
//
// This adds no data and moves no sample: the curve passes exactly through every
// recorded point, and only the path between two of them changes. The straight chord
// was never the truth either — the car did not drive in a straight line from one
// 10 m bin to the next — so a curve with a continuous tangent is the more faithful
// reading of the same samples, not a prettier one.
//
// Centripetal rather than uniform because uniform Catmull-Rom forms cusps and
// self-intersections when spacing is uneven, which is exactly what a distance-binned
// lap with the odd dropped packet looks like.
// TANGENTS ARE CAPPED at the shorter of the two chords meeting the vertex, and that
// clamp is load-bearing rather than defensive. Centripetal Catmull-Rom is well behaved
// on evenly spaced points but not on wildly uneven ones, and the shipped circuit
// geometry is exactly that: the upstream ways run 8 m between vertices through a
// hairpin and 860 m down the Las Vegas Strip. Interpolating across that boundary
// unclamped, the tangent inherited from the short side stays large across the long
// one, and the curve bowed 10 m off a straight — worse than the faceting it was
// there to fix. The cap can only ever SHORTEN a tangent, and on evenly spaced points
// it never binds at all: for spacing L the natural tangent is |p2−p0|/2 ≤ L, which is
// already the limit. So recorded laps (uniform 10 m bins) are untouched by it.
const CR_ALPHA = 0.5;

const knotGap = (a, b) => Math.pow(Math.hypot(b.x - a.x, b.z - a.z), CR_ALPHA);

// One span as a CUBIC BÉZIER — its two control points, given p1 and p2 as the
// endpoints and p0/p3 as the shape neighbours. This is the single definition of the
// curve; catmullRom() evaluates this, and SVG consumes it directly, which is the
// whole win there: one `C` command per sample replaces one `L`, so a smooth path
// costs exactly the DOM weight the faceted one did.
//
// Coincident samples (a stopped car, a duplicated bin, a ring that repeats its first
// vertex) collapse a knot span and would divide by zero — those fall back to the
// chord's own thirds, which draws as the straight line it was.
export function catmullRomBezier(p0, p1, p2, p3) {
  const d1 = knotGap(p0, p1), d2 = knotGap(p1, p2), d3 = knotGap(p2, p3);
  const dx = p2.x - p1.x, dz = p2.z - p1.z;
  if (!(d1 > 0) || !(d2 > 0) || !(d3 > 0)) {
    return { c1x: p1.x + dx / 3, c1z: p1.z + dz / 3, c2x: p2.x - dx / 3, c2z: p2.z - dz / 3 };
  }
  // Barry-Goldman tangents at each end, scaled into Bézier's parameterisation.
  let m1x = dx + d2 * ((p1.x - p0.x) / d1 - (p2.x - p0.x) / (d1 + d2));
  let m1z = dz + d2 * ((p1.z - p0.z) / d1 - (p2.z - p0.z) / (d1 + d2));
  let m2x = dx + d2 * ((p3.x - p2.x) / d3 - (p3.x - p1.x) / (d2 + d3));
  let m2z = dz + d2 * ((p3.z - p2.z) / d3 - (p3.z - p1.z) / (d2 + d3));
  // Chord lengths — the real ones, not the α-powered knots, since the cap is a
  // statement about distance on the ground.
  const cA = Math.hypot(p1.x - p0.x, p1.z - p0.z);
  const cB = Math.hypot(dx, dz);
  const cC = Math.hypot(p3.x - p2.x, p3.z - p2.z);
  const lim1 = Math.min(cA, cB), lim2 = Math.min(cB, cC);
  const s1 = Math.hypot(m1x, m1z), s2 = Math.hypot(m2x, m2z);
  if (s1 > lim1) { const k = lim1 / s1; m1x *= k; m1z *= k; }
  if (s2 > lim2) { const k = lim2 / s2; m2x *= k; m2z *= k; }
  return {
    c1x: p1.x + m1x / 3, c1z: p1.z + m1z / 3,
    c2x: p2.x - m2x / 3, c2z: p2.z - m2z / 3,
  };
}

// Position at parameter t ∈ [0,1] along the p1→p2 span.
export function catmullRom(p0, p1, p2, p3, t) {
  const { c1x, c1z, c2x, c2z } = catmullRomBezier(p0, p1, p2, p3);
  const u = 1 - t;
  const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
  return {
    x: a * p1.x + b * c1x + c * c2x + d * p2.x,
    z: a * p1.z + b * c1z + c * c2z + d * p2.z,
  };
}

// Interpolated world position of a line at a track-distance fraction, along that
// curve. This is what the camera pose reads.
export function posAtFracSmooth(line, fd) {
  const { pts } = line;
  if (pts.length < 4) return posAtFrac(line, fd);
  const { i, t } = locate(line, fd);
  // Duplicate the endpoints rather than wrapping: a recorded lap is an OPEN
  // polyline (the buffer starts and ends wherever the car was), so wrapping would
  // splice the lap's end into its start.
  const at = (j) => pts[clamp(j, 0, pts.length - 1)];
  return catmullRom(at(i - 2), at(i - 1), at(i), at(i + 1), t);
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
