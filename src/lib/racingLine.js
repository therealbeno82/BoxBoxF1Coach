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

// ─── Even path ────────────────────────────────────────────────────────────────
// WHY A RESAMPLE AND NOT JUST THE SPLINE. A car placed by evaluating the spline at
// locate()'s t moves in lurches, and it is worth being precise about why, because
// there are two separate causes and fixing one alone barely helps.
//
// The first is that the playhead is parameterised by the game's ODOMETER while the
// car is drawn at its recorded POSITIONS, and per 10 m bin those two disagree by
// about ±20% (measured p5 0.86, p95 1.10 of each other). A bin where the odometer
// says 10 m passed but the positions moved 8.6 forces the car to crawl it, and the
// next bin makes it sprint. The disagreement is phase noise — the Motion and Lap
// Data packets are not sampled at the same instant — so it is error, not signal.
//
// The second is the spline itself. Catmull-Rom evaluated at a t that runs 0→1 across
// each span has a speed that varies WITHIN the span, and the spans here are 3 to 13 m
// apart because the recorder writes one sample per rounded 10 m bin and the sample
// lands wherever the tick happened. That roughly doubles what the odometer left.
//
// Together they put the ground covered per frame 31% (p5-p95) either side of its mean
// — the cars visibly surging several times a second, in every sync mode, which is
// exactly what it looked like. Resampling the same curve at even arc length fixes the
// second directly (equal steps by construction) and carries a de-jittered fraction map
// for the first. Measured on the demo laps that takes 31% down to about 11%.
//
// The odometer is smoothed only IN HERE. distAt is left exactly as recorded, so the
// ribbons, the segment cards, the sector maths and the telemetry cursor all still
// address the lap by the number the game gave. The cost is that a car can sit up to
// ~0.7 m from where the raw odometer would have put it, which is well inside the noise
// being removed and under a tenth of one bin.
const EVEN_STEP = 1.0;    // m between resampled points — sagitta at a 12 m radius is 1 cm
const SUB = 8;            // dense samples per span, before the even resample
const DEJITTER = 2;       // ± knots for the odometer residual; ±20 m, deliberately short

export function buildEvenPath(pts, distAt) {
  const n = pts?.length || 0;
  if (n < 4 || !distAt || distAt.length !== n) return null;
  const at = (j) => pts[clamp(j, 0, n - 1)];

  // Dense walk of the same curve, accumulating true arc length and each knot's arc.
  const dx = [pts[0].x], dz = [pts[0].z], da = [0];
  const knotArc = new Float64Array(n);
  let arc = 0, px = pts[0].x, pz = pts[0].z;
  for (let i = 1; i < n; i++) {
    for (let s = 1; s <= SUB; s++) {
      const p = catmullRom(at(i - 2), at(i - 1), at(i), at(i + 1), s / SUB);
      arc += Math.hypot(p.x - px, p.z - pz);
      px = p.x; pz = p.z;
      dx.push(px); dz.push(pz); da.push(arc);
    }
    knotArc[i] = arc;
  }
  if (!(arc > 0)) return null;

  // De-jitter the odometer against arc length: take each knot's residual from a
  // straight arc→fraction map, smooth it with a CENTRED window (zero phase, so the
  // lap's shape in time is not dragged either way), then pin the ends back so the
  // lap still spans exactly the fractions it did and nothing accumulates.
  const f0 = distAt[0], span = distAt[n - 1] - f0;
  const res = new Float64Array(n);
  for (let i = 0; i < n; i++) res[i] = (distAt[i] - f0) - (knotArc[i] / arc) * span;
  const kf = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let sum = 0, k = 0;
    for (let j = -DEJITTER; j <= DEJITTER; j++) {
      const m = i + j;
      if (m < 0 || m >= n) continue;
      sum += res[m]; k++;
    }
    kf[i] = f0 + (knotArc[i] / arc) * span + sum / k;
  }
  const lo = kf[0], hi = kf[n - 1], scale = hi > lo ? span / (hi - lo) : 1;
  for (let i = 0; i < n; i++) kf[i] = f0 + (kf[i] - lo) * scale;
  for (let i = 1; i < n; i++) if (!(kf[i] > kf[i - 1])) kf[i] = kf[i - 1] + 1e-9;

  // Fraction for every dense sample, linear in ARC within each span — not in the
  // spline's own parameter. That distinction is the whole point: t runs 0→1 across a
  // span at a speed the cubic chooses, so spreading the fraction evenly in t hands
  // the car back exactly the speed variation this resample exists to remove.
  const df = new Float64Array(da.length);
  df[0] = kf[0];
  for (let i = 1; i < n; i++) {
    const a0 = knotArc[i - 1], spanArc = knotArc[i] - a0;
    for (let s = 1; s <= SUB; s++) {
      const idx = (i - 1) * SUB + s;
      const u = spanArc > 0 ? (da[idx] - a0) / spanArc : s / SUB;
      df[idx] = kf[i - 1] + (kf[i] - kf[i - 1]) * u;
    }
  }

  // Resample at uniform arc length. Equal index steps are now equal ground.
  const m = Math.max(2, Math.round(arc / EVEN_STEP) + 1);
  const xs = new Float64Array(m), zs = new Float64Array(m), fs = new Float64Array(m);
  let j = 1;
  for (let k = 0; k < m; k++) {
    const target = (arc * k) / (m - 1);
    while (j < da.length - 1 && da[j] < target) j++;
    const a0 = da[j - 1], a1 = da[j];
    const u = a1 > a0 ? (target - a0) / (a1 - a0) : 0;
    xs[k] = dx[j - 1] + (dx[j] - dx[j - 1]) * u;
    zs[k] = dz[j - 1] + (dz[j] - dz[j - 1]) * u;
    fs[k] = df[j - 1] + (df[j] - df[j - 1]) * u;
  }
  for (let k = 1; k < m; k++) if (fs[k] < fs[k - 1]) fs[k] = fs[k - 1];
  return { xs, zs, fs, n: m };
}

function posAtEven(path, fd) {
  const { xs, zs, fs, n } = path;
  const f = clamp(fd, 0, 1);
  let lo = 0, hi = n - 1;
  while (lo < hi - 1) { const mid = (lo + hi) >> 1; if (fs[mid] <= f) lo = mid; else hi = mid; }
  const a = fs[lo], b = fs[hi];
  const u = b > a ? clamp((f - a) / (b - a), 0, 1) : 0;
  return { x: xs[lo] + (xs[hi] - xs[lo]) * u, z: zs[lo] + (zs[hi] - zs[lo]) * u };
}

// Interpolated world position of a line at a track-distance fraction, along that
// curve. This is what the camera pose and both car markers read. Lines that carry an
// even path (buildLines attaches one) get the resample; anything else — a calibrator
// trace, a line built somewhere that has not been through buildLines — falls back to
// evaluating the spline directly, which is what this always did.
export function posAtFracSmooth(line, fd) {
  if (line.even) return posAtEven(line.even, fd);
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
