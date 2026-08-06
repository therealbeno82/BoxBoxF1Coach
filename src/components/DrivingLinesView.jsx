// ─── DRIVING LINES VIEW (Analytics ▸ Overview) ────────────────────────────────
// Top-down 2D "segment focus" view of both laps' racing lines — replaces the old
// 3D chase-cam scene. The viewport auto-frames the segment (or sector) the
// playhead is in and glides between segments as playback crosses a boundary;
// a mini-map inset shows where on the circuit that segment sits, a zoom slider
// widens/tightens the framing, and a bottom-left card steps segment-by-segment
// with each lap's segment time and the delta between them.
//
// Playback is CONTROLLED: `playhead` (0–1 lap-distance fraction) + `playing`
// come in as props with `onSeek`/`onSetPlaying` callbacks, and the rAF clock
// that advances the shared timeline lives HERE (it knows lap duration and
// speed; it plays through once and stops at the lap end). BoxBoxApp owns the
// state and feeds the same playhead to the
// TelemetryStudio trace stack, so pressing Play moves the telemetry cursor and
// the cars along the driving lines together.
//
// Only laps that carry their own world positions get a line + car (calibrator
// references have no x/z — their car is hidden with a note). Sync modes:
//   • Position-sync — both cars sit at the same track-distance fraction →
//     aligned in space for line/apex comparison.
//   • Pace-sync — the other car is placed at the distance IT had reached at the
//     same elapsed time (via its pace curve), so the faster car runs ahead and
//     the time gap builds instead of both cars finishing together.

import { useState, useRef, useEffect, useMemo, useCallback } from "react";
import { C, FONT } from "../lib/ui/tokens.js";
import { clamp, formatLapTime } from "../lib/format.js";
import { cornerLabel, resolveSlug, CORNER_NAMES } from "../lib/cornerData.js";
import { pedalT, pedalColor, posAtFrac, posAtFracSmooth, headingAtDeg, catmullRomBezier } from "../lib/racingLine.js";
import TrackCamView from "./TrackCamView.jsx";
import TrackOrbitView from "./TrackOrbitView.jsx";

const COMP_COLOR = "#34c8ff";   // cyan — driven / comparison lap (cockpit token)
const REF_COLOR  = "#ffffff";   // white — reference / benchmark lap (dotted on the map)
const BRAKE_ON   = 12;          // brake % that counts as "on the brakes" (matches BoxBoxApp)
const MIN_ZOOM = 0.5, MAX_ZOOM = 8; // map framing range; high end lets a single corner fill the view

// ─── Curved path segments ─────────────────────────────────────────────────────
// Laps are recorded in 10 m distance bins, so joining samples with `L` draws every
// corner as a run of chords — obvious once the map is zoomed in, and the same
// artefact the T-cam ribbons had. A cubic through the same samples costs one `C`
// instead of one `L` (identical DOM weight) and passes through every one of them.
// `p0`/`p3` are the shape neighbours, taken from the DOWNSAMPLED index list so the
// curve follows the points actually being drawn.
function curveSeg(a, b, p0, p3) {
  const { c1x, c1z, c2x, c2z } = catmullRomBezier(p0, a, b, p3);
  return ` C ${c1x.toFixed(1)},${c1z.toFixed(1)} ${c2x.toFixed(1)},${c2z.toFixed(1)} ${b.x.toFixed(1)},${b.z.toFixed(1)}`;
}

// Split a line's points into a handful of quantised-colour paths so the driven
// line renders as a smooth throttle/brake gradient with only ~BUCKETS DOM nodes
// (one <path> per colour bucket, each a bundle of M/C subpaths) rather than one
// element per segment — cheap enough to survive the per-frame camera pan.
function drivenGradientPaths(pts, maxPts = 600, buckets = 16) {
  if (!pts || pts.length < 2) return [];
  const step = Math.max(1, Math.floor(pts.length / maxPts));
  const idxs = [];
  for (let i = 0; i < pts.length; i += step) idxs.push(i);
  if (idxs[idxs.length - 1] !== pts.length - 1) idxs.push(pts.length - 1);
  const at = (k) => pts[idxs[clamp(k, 0, idxs.length - 1)]];
  const byBucket = new Map(); // bucket → concatenated subpath string
  for (let k = 1; k < idxs.length; k++) {
    const a = pts[idxs[k - 1]], b = pts[idxs[k]];
    const t = pedalT(b.throttle, b.brake);
    const bucket = Math.round(t * (buckets - 1));
    const seg = ` M ${a.x.toFixed(1)},${a.z.toFixed(1)}` + curveSeg(a, b, at(k - 2), at(k + 1));
    byBucket.set(bucket, (byBucket.get(bucket) || "") + seg);
  }
  const out = [];
  for (const [bucket, d] of byBucket)
    out.push({ d: d.trim(), color: pedalColor(bucket / (buckets - 1)) });
  return out;
}

// ─── Car marker: a top-down F1 silhouette instead of a plain dot ──────────────
// Drawn in local units with the nose pointing +x, then rotated to the car's
// heading and scaled to a constant on-screen size. Strokes use non-scaling-stroke
// so outlines stay crisp at any scale; fills are translucent so the racing lines
// and the other car read through it. `color` tints the whole car (cyan driven /
// white reference); `main` makes the driven car a touch more solid.
// Central body: nose taper → cockpit pinch → sidepod bulge → engine-cover taper.
const F1_BODY = "M22,0 L14,-2.2 L7,-3.2 L2,-4 L-2,-6.2 L-9,-6.6 L-14,-4.2 L-18,-2.6 L-18,2.6 L-14,4.2 L-9,6.6 L-2,6.2 L2,4 L7,3.2 L14,2.2 Z";
const F1_WHEELS = [[4,-14,8,4.6],[4,9.4,8,4.6],[-19,-14.6,9,5],[-19,9.6,9,5]]; // x,y,w,h
const F1_SUSP = [ // wishbone hints: bodywork → wheel hub, both sides front & rear
  [2,-3.6,8,-11.7],[11,-2.8,8,-11.7], [2,3.6,8,11.7],[11,2.8,8,11.7],
  [-12,-4,-14.5,-12.1],[-16,-3.2,-14.5,-12.1], [-12,4,-14.5,12.1],[-16,3.2,-14.5,12.1],
];
function CarMarker({ x, z, angle, color, scale, main = false }) {
  const so = main ? 0.95 : 0.85;      // outline opacity
  const fo = main ? 0.4  : 0.3;       // body fill opacity (translucent)
  const line = { stroke: color, strokeOpacity: so, strokeWidth: main ? 1.3 : 1.1,
    vectorEffect: "non-scaling-stroke" };
  const thin = { stroke: color, strokeOpacity: so * 0.75, strokeWidth: main ? 1.0 : 0.85,
    vectorEffect: "non-scaling-stroke" }; // suspension / detail lines
  return (
    <g transform={`translate(${x} ${z}) rotate(${angle})`} pointerEvents="none">
      {/* soft halo so the car stays findable over the track */}
      <circle r={17 * scale} fill={color} opacity={main ? 0.16 : 0.12} />
      <g transform={`scale(${scale})`}>
        {/* suspension wishbones, under the bodywork */}
        {F1_SUSP.map((s, i) => <line key={i} x1={s[0]} y1={s[1]} x2={s[2]} y2={s[3]} {...thin} />)}
        {/* wheels with a rim-line hint */}
        {F1_WHEELS.map((w, i) => (
          <g key={i}>
            <rect x={w[0]} y={w[1]} width={w[2]} height={w[3]} rx={1.6}
              fill={color} fillOpacity={Math.min(1, fo * 1.4)} {...line} />
            <line x1={w[0] + 1.6} y1={w[1] + w[3] / 2} x2={w[0] + w[2] - 1.6} y2={w[1] + w[3] / 2} {...thin} />
          </g>
        ))}
        {/* front wing + endplates (near the nose) */}
        <rect x={18}   y={-12.5} width={3}   height={25}  rx={1}   fill={color} fillOpacity={fo} {...line} />
        <rect x={17.4} y={-13.6} width={4.6} height={2.4} rx={0.6} fill={color} fillOpacity={fo} {...line} />
        <rect x={17.4} y={11.2}  width={4.6} height={2.4} rx={0.6} fill={color} fillOpacity={fo} {...line} />
        {/* rear wing + endplates (across the tail) */}
        <rect x={-22}  y={-11}   width={2.8} height={22}  rx={1}   fill={color} fillOpacity={fo} {...line} />
        <rect x={-23}  y={-12.1} width={4.6} height={2.4} rx={0.6} fill={color} fillOpacity={fo} {...line} />
        <rect x={-23}  y={9.7}   width={4.6} height={2.4} rx={0.6} fill={color} fillOpacity={fo} {...line} />
        {/* chassis + nose + sidepods */}
        <path d={F1_BODY} fill={color} fillOpacity={fo} strokeLinejoin="round" {...line} />
        {/* halo hoop arcing over the cockpit */}
        <path d="M6,0 A 6.5 4 0 0 1 -3,0" fill="none" {...thin} />
        {/* cockpit + driver-position dot */}
        <ellipse cx={1} cy={0} rx={3.3} ry={2.3} fill={color} fillOpacity={main ? 0.85 : 0.65} {...thin} />
        <circle cx={0} cy={0} r={1.5} fill={color} fillOpacity={main ? 0.98 : 0.85} />
      </g>
    </g>
  );
}

// ─── Line building (moved from BoxBoxApp with the old 3D panel) ───────────────

// True when a lap carries enough of ITS OWN world positions to draw a line
// (≥20 finite x/z samples). Calibrator reference JSON has no x/z, so it has no
// spatial line and is skipped here.
function lapHasLine(lap) {
  const s = lap?.samples;
  if (!Array.isArray(s)) return false;
  let n = 0;
  for (const p of s) if (typeof p.x === "number" && typeof p.z === "number" && isFinite(p.x) && isFinite(p.z)) { if (++n >= 20) return true; }
  return false;
}

// ─── Monotone cubic addressing ────────────────────────────────────────────────
// Every curve in this file is a LOOKUP TABLE that gets differentiated by the eye:
// the ghost's speed is the slope of its pace curve, so how the table interpolates
// isn't a detail of accuracy, it's what the motion LOOKS like. Read linearly, that
// slope is piecewise-constant — the ghost holds one pace for the ~11 frames it takes
// to cross a 10 m sample, then changes it inside a single frame and holds the new one.
// Replayed against real demo laps that step reaches 11 m/s of apparent speed in one
// frame. A staircase in the position table is a surge on the screen.
//
// Fritsch-Carlson gives a C1 curve through the same points, so the slope is
// continuous and the pace changes the way a car's does instead of in jumps. Measured
// worst-case single-frame step drops ~6-7× (11.3 → 2.0 m/s on the worst pair).
// Monotone-preserving is the load-bearing half of the name: an ordinary cubic
// overshoots, and an overshoot in a position table is a ghost that drives backwards
// for a few frames. No reversal appears on any lap pair tested.
//
// Slopes are precomputed per line (buildLines is memoised); evaluation is the same
// linear scan the lookups already did, so nothing gets more expensive per frame.
function monoSlopes(xs, ys) {
  const n = xs.length;
  if (n < 2) return null;
  const del = new Array(n - 1), m = new Array(n);
  for (let i = 0; i < n - 1; i++) {
    const h = xs[i + 1] - xs[i];
    del[i] = h > 0 ? (ys[i + 1] - ys[i]) / h : 0;  // a zero-width step flattens, never divides by 0
  }
  m[0] = del[0]; m[n - 1] = del[n - 2];
  for (let i = 1; i < n - 1; i++) {
    // A sign change (or a flat step) is a local extremum: pin the slope to 0, which
    // is exactly what stops the curve bulging past the data.
    if (del[i - 1] * del[i] <= 0) { m[i] = 0; continue; }
    const h0 = xs[i] - xs[i - 1], h1 = xs[i + 1] - xs[i];
    const w0 = 2 * h1 + h0, w1 = h1 + 2 * h0;
    m[i] = (w0 + w1) / (w0 / del[i - 1] + w1 / del[i]);   // weighted harmonic mean
  }
  return m;
}

// Evaluate the table (xs → ys) at x. Falls back to a plain lerp when no slope array
// was built, so every caller keeps working on a degenerate one- or two-point curve.
function monoAt(xs, ys, ms, x) {
  const f = clamp(x, 0, 1);
  let i = 1; while (i < xs.length && xs[i] < f) i++;
  i = Math.min(i, xs.length - 1);
  const lo = xs[i - 1] ?? 0, hi = xs[i] ?? 1;
  const ylo = ys[i - 1] ?? 0, yhi = ys[i] ?? 1;
  const h = hi - lo;
  if (!(h > 0)) return yhi;
  const t = clamp((f - lo) / h, 0, 1);
  if (!ms) return ylo + (yhi - ylo) * t;
  const t2 = t * t, t3 = t2 * t;
  return (2 * t3 - 3 * t2 + 1) * ylo + (t3 - 2 * t2 + t) * h * ms[i - 1]
       + (-2 * t3 + 3 * t2) * yhi + (t3 - t2) * h * ms[i];
}

// ─── The time axis ────────────────────────────────────────────────────────────
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
function recordedTimeAxis(pts) {
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
function integratedTimeAxis(pts) {
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

// Build per-lap racing lines. For each drawable lap (≥20 own x/z samples) returns
// its captured WORLD points plus the two addressing curves the timeline uses:
// distAt (lap-fraction → position-sync) and timeAt (a normalised Δdist÷speed time
// integral → pace-sync), each with its monotone-cubic slopes. `laps` is an array of
// { id, label, lap, color }; undrawable laps are dropped. Returns [] when none qualify.
function buildLines(laps) {
  const out = [];
  for (const d of laps || []) {
    if (!lapHasLine(d.lap)) continue;
    const pts = d.lap.samples
      .filter(s => typeof s.x === "number" && typeof s.z === "number" && isFinite(s.x) && isFinite(s.z))
      .sort((a, b) => (a.dist || 0) - (b.dist || 0))
      .map(s => ({
        x: s.x, z: s.z,
        // Elevation rides along when the lap has it. Only trackGeometry reads it,
        // to drape the road; laps without it leave the model flat.
        ...(typeof s.y === "number" && isFinite(s.y) ? { y: s.y } : null),
        dist: s.dist || 0, speed: s.speed || 0,
        // The game's own lap clock, when the lap was recorded with it. See below.
        ...(typeof s.t === "number" && isFinite(s.t) ? { t: s.t } : null),
        throttle: typeof s.throttle === "number" ? s.throttle : null,
        brake:    typeof s.brake    === "number" ? s.brake    : null,
      }));
    const lapLen = pts.reduce((m, p) => Math.max(m, p.dist), 0) || 1;
    const distAt = pts.map(p => p.dist / lapLen);
    const cum = recordedTimeAxis(pts) || integratedTimeAxis(pts);
    const total = cum[cum.length - 1] || 1;
    const timeAt = cum.map(t => t / total);
    out.push({ id: d.id, label: d.label, color: d.color, pts, distAt, timeAt, timeTotal: total, lapLen,
      // Both directions of the time↔distance pair, precomputed once per line.
      tdSlopes: monoSlopes(timeAt, distAt), dtSlopes: monoSlopes(distAt, timeAt) });
  }
  attachPaceCurves(out);
  return out;
}

// Pace curves for pace-sync mode. Playback runs on ONE shared clock — the anchor
// (driven) lap's track-distance fraction. Each other line gets an addressing array
// in that same anchor-distance space, holding the distance the line had reached at
// the SAME ELAPSED TIME as the anchor. The anchor maps to itself (identity).
// Mutates each line, adding `paceAt`.
function attachPaceCurves(lines) {
  const anchor = lines.find(l => l.id === "comp")
    || lines.reduce((b, l) => (!b || l.pts.length > b.pts.length ? l : b), null);
  if (!anchor) return;
  for (const l of lines) {
    if (l === anchor || !(anchor.timeTotal > 0)) {
      l.paceAt = l.distAt; l.pdSlopes = monoSlopes(l.paceAt, l.distAt); continue;
    }
    l.paceAt = l.timeAt.map((tf) =>
      clamp(timeFracToDistFrac(anchor, (tf * l.timeTotal) / anchor.timeTotal), 0, 1));
    // The curve the ghost is actually read off, so it gets slopes of its own.
    l.pdSlopes = monoSlopes(l.paceAt, l.distAt);
  }
}

// ─── Curve addressing helpers ─────────────────────────────────────────────────
// The time↔distance pair. Position, heading and the clamping rationale they all
// share live in lib/racingLine.js, which the T-cam reads too.

// Map a lap-time fraction (0..1) to the matching track-distance fraction using a
// line's own time/distance curves.
function timeFracToDistFrac(line, ft) {
  if (!line) return ft;
  return monoAt(line.timeAt, line.distAt, line.tdSlopes, ft);
}

// The inverse: track-distance fraction → lap-time fraction. Used for the elapsed
// time readout, the live delta, and per-segment times. Same curve, read the same
// way — a staircase here made the delta readout tick in steps too.
function distFracToTimeFrac(line, fd) {
  if (!line) return fd;
  return monoAt(line.distAt, line.timeAt, line.dtSlopes, fd);
}

// The reference car's track-distance fraction when the shared clock is at
// `compDistFrac` — reads the reference line's pace curve so the marker sits where
// the reference car really is on track in pace-sync. Falls back to the clock.
// This is THE ghost-motion lookup: its slope is the ghost's speed.
function refDistForCompDist(refLine, compDistFrac) {
  const paceAt = refLine?.paceAt, distAt = refLine?.distAt;
  if (!paceAt || !distAt) return compDistFrac;
  return monoAt(paceAt, distAt, refLine.pdSlopes, compDistFrac);
}

// World-space SVG path for a line's points, downsampled to keep the DOM light and
// curved through them rather than chorded (see curveSeg).
function linePathD(pts, maxPts = 800) {
  if (!pts || pts.length < 2) return "";
  const step = Math.max(1, Math.floor(pts.length / maxPts));
  const idxs = [];
  for (let i = 0; i < pts.length; i += step) idxs.push(i);
  if (idxs[idxs.length - 1] !== pts.length - 1) idxs.push(pts.length - 1);
  const at = (k) => pts[idxs[clamp(k, 0, idxs.length - 1)]];
  let d = `M ${pts[idxs[0]].x.toFixed(1)},${pts[idxs[0]].z.toFixed(1)}`;
  for (let k = 1; k < idxs.length; k++) d += curveSeg(at(k - 1), at(k), at(k - 2), at(k + 1));
  return d;
}

const fmtd = (d) => (d > 0 ? "+" : d < 0 ? "−" : "") + Math.abs(d).toFixed(3);
const fmtSeg = (t) => (typeof t === "number" && isFinite(t) ? t.toFixed(3) : "—");

export default function DrivingLinesView({
  referenceLap, comparisonLap, referenceLabel, comparisonLabel,
  trackName, trackSlug = null, zones = [], corners: cornerDb = [], lapLength = 0,
  playhead = 0, playing = false, onSeek, onSetPlaying,
}) {
  const [viewMode, setViewMode] = useState("segments"); // "segments" | "sectors"
  // "map" and "orbit" are the two views of the whole scene (flat / free camera);
  // "tcam" and "compare" are the onboard ones, which several overlays below key on.
  const [camMode, setCamMode]   = useState("map");      // "map" | "orbit" | "tcam" | "compare"
  const [zoom, setZoom]         = useState(1);
  const [syncMode, setSyncMode] = useState("pos");      // "pos" | "pace"
  const [speed, setSpeed]       = useState(1);
  // Real-circuit track model: null = still resolving, false = no lines to fit,
  // else the model from trackGeometry (status "real" or "fallback").
  const [trackModel, setTrackModel] = useState(null);

  // Captured world-space racing lines for whichever selected laps have position data.
  const lines = useMemo(
    () => buildLines([
      { id: "comp", label: comparisonLabel, lap: comparisonLap, color: COMP_COLOR },
      { id: "ref",  label: referenceLabel,  lap: referenceLap,  color: REF_COLOR },
    ]),
    [comparisonLap?.id, comparisonLap?.samples?.length, referenceLap?.id,
     referenceLap?.samples?.length, comparisonLabel, referenceLabel] // eslint-disable-line react-hooks/exhaustive-deps
  );
  const compLine = lines.find(l => l.id === "comp") || null;
  const refLine  = lines.find(l => l.id === "ref")  || null;

  // Which selected laps couldn't be drawn (chosen but no position data).
  const hidden = [];
  if (comparisonLap && !compLine) hidden.push(comparisonLabel);
  if (referenceLap && !refLine)   hidden.push(referenceLabel);

  // ── Sector bands: the lap's own splits mapped onto track-distance fractions ──
  const sectors = useMemo(() => {
    const cands = [{ lap: comparisonLap, line: compLine }, { lap: referenceLap, line: refLine }];
    const paired = cands.find(c => c.lap?.sectorTimes && c.line)
                || cands.find(c => c.lap?.sectorTimes);
    const splitLap = paired?.lap || null;
    const line = paired?.line || compLine || refLine;
    let b1 = 1 / 3, b2 = 2 / 3; // default: even thirds by distance
    if (splitLap && line) {
      const [s1, s2] = splitLap.sectorTimes;
      const total = splitLap.lapTime || splitLap.sectorTimes.reduce((a, b) => a + b, 0);
      if (total > 0 && s1 > 0 && s2 > 0) {
        b1 = timeFracToDistFrac(line, s1 / total);
        b2 = timeFracToDistFrac(line, (s1 + s2) / total);
      }
    }
    return [
      { name: "S1", start: 0,  end: b1 },
      { name: "S2", start: b1, end: b2 },
      { name: "S3", start: b2, end: 1 },
    ];
  }, [comparisonLap?.id, referenceLap?.id, lines]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Corners: numbered real-world corners when available, else brake zones ──
  // These carry LAP fractions, which is what the segment bounds and the scrub bar
  // need. The map markers themselves are placed from the fitted centerline instead
  // (see cornerMarks) so they land on the road rather than on the driven line.
  const corners = useMemo(() => {
    if (Array.isArray(cornerDb) && cornerDb.length) {
      return cornerDb.map((c) => ({ f: clamp(c.f, 0, 1), name: cornerLabel(c) })).sort((a, b) => a.f - b.f);
    }
    return (zones || []).filter((z) => z.type === "brake")
      .map((z) => ({ f: clamp((z.start + z.end) / 2, 0, 1), name: z.name }))
      .sort((a, b) => a.f - b.f);
  }, [cornerDb, zones]);

  // ── Segments: one per corner (boundaries at the midpoints between corners),
  // or the three real sectors in Sectors mode / when corners are unknown. ──
  const segments = useMemo(() => {
    if (viewMode === "segments" && corners.length >= 2) {
      const mids = [];
      for (let i = 1; i < corners.length; i++) mids.push((corners[i - 1].f + corners[i].f) / 2);
      const bounds = [0, ...mids, 1];
      return corners.map((c, i) => ({ name: `Segment ${i + 1}`, sub: c.name, start: bounds[i], end: bounds[i + 1] }));
    }
    return sectors.map((s, i) => ({ name: `Sector ${i + 1}`, sub: "", start: s.start, end: s.end }));
  }, [viewMode, corners, sectors]);

  let segIdx = segments.findIndex((s) => playhead >= s.start && playhead <= s.end);
  if (segIdx < 0) segIdx = playhead > 0.5 ? segments.length - 1 : 0;
  const seg = segments[segIdx];

  // Lap duration for the clock — comparison lap's time, else reference, else ~90 s.
  const lapDur = comparisonLap?.lapTime || referenceLap?.lapTime || referenceLap?.meta?.lapTime || 90;
  const lapLen = lapLength
    || Math.max(compLine?.lapLen || 0, refLine?.lapLen || 0);

  // ── The shared playback clock. Lives here (this panel owns duration/speed/loop)
  // but writes through onSeek so the telemetry trace cursor moves with it. Runs
  // even when no line is drawable — the trace stack still needs its Play. ──
  const phRef = useRef(playhead);
  phRef.current = playhead;
  useEffect(() => {
    if (!playing) return;
    let last = performance.now();
    let raf;
    const tick = (now) => {
      const dt = (now - last) / 1000; last = now;
      let next = phRef.current + (dt * speed) / lapDur;
      // Playback runs once: park on the flag at the lap end and stop.
      if (next >= 1) { onSeek?.(1); onSetPlaying?.(false); return; }
      onSeek?.(next);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, speed, lapDur]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Track model: real circuit geometry fitted to the recorded lines ──────────
  // Same loader/caching as the old 3D panel; a growing LIVE lap only re-fits every
  // REFIT_EVERY new samples so alignment doesn't churn per 10 m bin.
  const slug = trackSlug || resolveSlug(trackName);
  const lineIds = lines.map(l => l.id).join("|");
  const REFIT_EVERY = 64;
  const fitBucket = Math.floor(lines.reduce((s, l) => s + (l.pts?.length || 0), 0) / REFIT_EVERY);
  const fitKeyRef = useRef("");
  useEffect(() => {
    if (!lines.length) { setTrackModel(false); fitKeyRef.current = ""; return; }
    const key = `${slug}|${lineIds}`;
    if (fitKeyRef.current !== key) { fitKeyRef.current = key; setTrackModel(null); }
    let live = true;
    import("../lib/trackGeometry.js")
      .then((m) => m.loadTrackModel(slug, lines))
      .then((model) => { if (live) setTrackModel(model || false); })
      .catch(() => { if (live) setTrackModel(false); });
    return () => { live = false; };
  }, [lineIds, fitBucket, slug]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Corner markers, placed on the ROAD ─────────────────────────────────────
  // The shipped centerline carries each corner's measured apex (`apexes`, a
  // fraction of its own arc length in file order — see scripts/fit-corners.mjs).
  // The fit tells us where start/finish is and whether the file runs against the
  // racing direction, so numbering starts at the real T1 on every circuit.
  // Falls back to the driven line when the circuit has no measured apexes yet.
  const cornerMarks = useMemo(() => {
    const rows = trackModel?.centerline;
    const apexes = trackModel?.apexes;
    if (trackModel?.status === "real" && rows?.length && apexes?.length) {
      const N = rows.length;
      const marks = apexes.map((fa) => {
        const raw = Math.min(N - 1, Math.max(0, Math.round(fa * N)));
        const row = trackModel.reverse ? N - 1 - raw : raw;
        return { row, lapF: (((row - trackModel.startIndex) % N) + N) % N / N };
      }).sort((a, b) => a.lapF - b.lapF);
      // Name straight from the official numbering, not from `corners` — that list
      // can still be the legacy fallback table on a circuit we haven't fitted yet.
      const names = CORNER_NAMES[slug] || [];
      return marks.map((m, i) => ({
        x: rows[m.row].x, z: rows[m.row].z,
        name: cornerLabel({ n: i + 1, name: names[i]?.name || "" }),
      }));
    }
    const anchor = compLine || refLine;
    if (!anchor) return [];
    return corners.map((c) => {
      const p = posAtFrac(anchor, c.f);
      return { x: p.x, z: p.z, name: c.name };
    });
  }, [trackModel, corners, compLine, refLine, slug]);

  // ── Road ribbon: left/right edges swept from the model centerline + widths ──
  const road = useMemo(() => {
    if (!trackModel || !trackModel.centerline?.length) return null;
    const rows = trackModel.centerline;
    const step = Math.max(1, Math.floor(rows.length / 900));
    const pts = [];
    for (let i = 0; i < rows.length; i += step) pts.push(rows[i]);
    const closed = !!trackModel.closed;
    const m = pts.length;
    const L = [], R = [];
    for (let i = 0; i < m; i++) {
      const prev = pts[closed ? (i - 1 + m) % m : Math.max(0, i - 1)];
      const next = pts[closed ? (i + 1) % m : Math.min(m - 1, i + 1)];
      let tx = next.x - prev.x, tz = next.z - prev.z;
      const tl = Math.hypot(tx, tz) || 1; tx /= tl; tz /= tl;
      const nx = tz, nz = -tx;
      const p = pts[i];
      L.push([p.x + nx * (p.wl || 6), p.z + nz * (p.wl || 6)]);
      R.push([p.x - nx * (p.wr || 6), p.z - nz * (p.wr || 6)]);
    }
    const poly = (arr, close) =>
      "M " + arr.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" L ") + (close ? " Z" : "");
    // Closed circuit: two nested loops + evenodd fills the asphalt ring between them.
    const fill = closed
      ? poly(L, true) + " " + poly(R, true)
      : poly([...L, ...R.slice().reverse()], true);
    return { fill, edgeL: poly(L, closed), edgeR: poly(R, closed) };
  }, [trackModel]);

  // Driven line as a throttle/brake gradient (green full-throttle → red full-brake).
  const compGrad = useMemo(() => (compLine ? drivenGradientPaths(compLine.pts) : []), [compLine]);
  const refPath  = useMemo(() => (refLine  ? linePathD(refLine.pts)  : ""), [refLine]);

  // ── Reference brake points: on the ref line, the spot where the driver first
  // gets on the brakes for each corner that needs braking (a red dot). For every
  // corner we scan the ref lap from the midpoint after the previous corner up to
  // this corner's apex and take the first sample over the brake threshold; corners
  // taken flat never cross it, so they get no dot. Needs a ref lap with a brake
  // channel (live-recorded laps have one; calibrator refs without x/z have no line).
  const refBrakeMarks = useMemo(() => {
    if (!refLine || !corners.length) return [];
    const { pts, distAt } = refLine;
    if (!pts.some(p => typeof p.brake === "number")) return [];
    const marks = [];
    for (let ci = 0; ci < corners.length; ci++) {
      const cf = corners[ci].f;
      const lo = ci > 0 ? (corners[ci - 1].f + cf) / 2 : Math.max(0, cf - 0.08);
      for (let i = 0; i < pts.length; i++) {
        const f = distAt[i];
        if (f < lo) continue;
        if (f > cf) break; // distAt is monotonic — past the apex, give up on this corner
        if ((pts[i].brake || 0) > BRAKE_ON) { marks.push({ x: pts[i].x, z: pts[i].z }); break; }
      }
    }
    return marks;
  }, [refLine, corners]);

  // ── Car positions at the playhead (also steer the camera follow below) ──
  const refFrac = syncMode === "pace" ? refDistForCompDist(refLine, playhead) : playhead;
  // Ride the SMOOTH sampler, the one the T-cam camera and the drawn curves already
  // use. posAtFrac walks 10 m chords, so a car placed with it cuts every corner it is
  // drawn going round and twitches laterally at each bin — and in the onboard view the
  // ghost was doing that against a camera that wasn't.
  const compCar = compLine ? posAtFracSmooth(compLine, playhead) : null;
  const refCar  = refLine  ? posAtFracSmooth(refLine, refFrac)   : null;
  const compAngle = compLine ? headingAtDeg(compLine, playhead) : 0;
  const refAngle  = refLine  ? headingAtDeg(refLine, refFrac)   : 0;

  // The car the onboard camera rides: the driven lap, or the reference when only
  // it has positions (a calibrator reference has no x/z and gets no line at all).
  const camLine = compLine || refLine;
  const camFrac = compLine ? playhead : refFrac;
  // Compare needs two drawable lines; fall back the moment one goes away (picking
  // a position-less reference mid-session would otherwise leave an empty pane).
  const canCompare = !!(compLine && refLine);
  // The two onboard modes, which the T-cam viewport and several overlays key on.
  const onboard = camMode === "tcam" || camMode === "compare";
  useEffect(() => {
    if (camMode === "compare" && !canCompare) setCamMode("tcam");
  }, [camMode, canCompare]);
  // Sync mode is the USER'S, and it survives every camera switch. Compare used to
  // force it back to pos-sync on entry, on the reasoning that two panes at the same
  // track distance show the same corner from each seat so the difference in where the
  // tarmac sits IS the line difference. That reasoning is still right, and it's why
  // the initial state below is "pos" — which is all it ever needed to be. Forcing it
  // on every entry meant a deliberate pace-sync was destroyed by a glance at Compare
  // and did not come back on the way out, so cycling the cameras silently undid a
  // choice the driver had made. A default is a starting point, not a correction.

  // One camera per pane. Each rides its own car, but BOTH draw both ribbons — the
  // point is to see your line and theirs from each vantage, not to split them up.
  const camPanes = useMemo(() => {
    const ghost = (car, angle, color) =>
      car ? { x: car.x, z: car.z, yaw: angle * Math.PI / 180, color } : null;
    if (camMode === "compare" && compLine && refLine) {
      return [
        { line: compLine, frac: playhead, label: comparisonLabel, accent: COMP_COLOR,
          other: ghost(refCar, refAngle, REF_COLOR) },
        { line: refLine, frac: refFrac, label: referenceLabel, accent: REF_COLOR,
          other: ghost(compCar, compAngle, COMP_COLOR) },
      ];
    }
    return [{
      line: camLine, frac: camFrac,
      label: compLine ? comparisonLabel : referenceLabel,
      accent: compLine ? COMP_COLOR : REF_COLOR,
      other: compLine ? ghost(refCar, refAngle, REF_COLOR) : ghost(compCar, compAngle, COMP_COLOR),
    }];
  }, [camMode, compLine, refLine, camLine, camFrac, playhead, refFrac,
      comparisonLabel, referenceLabel, refCar, compCar, refAngle, compAngle]);

  // ── Viewport: fit the current segment's bounding box (both lines), padded;
  // the zoom slider tightens/widens the framing around the same centre. ──
  const segBox = useMemo(() => {
    const fit = [compLine, refLine].filter(Boolean);
    if (!fit.length || !seg) return null;
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    const lo = Math.max(0, seg.start - 0.005), hi = Math.min(1, seg.end + 0.005);
    for (const l of fit) {
      for (let i = 0; i < l.pts.length; i++) {
        const f = l.distAt[i];
        if (f < lo || f > hi) continue;
        const p = l.pts[i];
        if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
        if (p.z < minZ) minZ = p.z; if (p.z > maxZ) maxZ = p.z;
      }
    }
    if (!isFinite(minX)) { // degenerate window — frame the whole circuit
      for (const l of fit) for (const p of l.pts) {
        if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
        if (p.z < minZ) minZ = p.z; if (p.z > maxZ) maxZ = p.z;
      }
    }
    const pad = Math.max(maxX - minX, maxZ - minZ) * 0.18 + 16; // room for road + kerbs
    const cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2;
    let hw = (maxX - minX) / 2 + pad, hh = (maxZ - minZ) / 2 + pad;
    hw /= zoom; hh /= zoom;
    return { cx, cz, hw, hh };
  }, [compLine, refLine, seg?.start, seg?.end, zoom]); // eslint-disable-line react-hooks/exhaustive-deps

  // Pan the segment framing so the cars never leave the frame (matters when the
  // zoom slider shrinks the box below the segment's extent, and in pace-sync when
  // the reference car runs in another segment). Each car is nudged back inside an
  // inner margin; the driven car is clamped LAST so it wins when both can't fit.
  // Cheap, so recomputed per render — the playhead moves every frame anyway.
  let targetVb = null;
  if (segBox) {
    const { cx, cz, hw, hh } = segBox;
    let x = cx, y = cz;
    const mx = hw * 0.68, my = hh * 0.68;
    for (const p of [refCar, compCar]) {
      if (!p) continue;
      if (p.x < x - mx) x = p.x + mx; else if (p.x > x + mx) x = p.x - mx;
      if (p.z < y - my) y = p.z + my; else if (p.z > y + my) y = p.z - my;
    }
    targetVb = { x: x - hw, y: y - hh, w: hw * 2, h: hh * 2 };
  }

  // Glide the live viewBox toward the target. The target moves continuously while
  // the cars run (camera-follow pan), so this is per-frame exponential smoothing
  // rather than a one-shot tween — segment jumps ease in with the same motion.
  const [vb, setVb] = useState(null);
  const vbRef = useRef(null);
  vbRef.current = vb;
  const targetVbRef = useRef(null);
  targetVbRef.current = targetVb;

  // The smoothing loop is SELF-TERMINATING: it stops scheduling frames once the
  // camera is within a hair of its target, and the wake effect below restarts it
  // when the target moves again. It used to schedule a frame unconditionally for
  // as long as Analytics was open — 60 wakeups/s recomputing "nothing changed" on
  // a paused, settled camera.
  const camRafRef = useRef(0);
  const camLastRef = useRef(0);
  const startCamera = useCallback(() => {
    if (camRafRef.current) return; // already running
    camLastRef.current = performance.now();
    const TAU = 0.18; // s — camera smoothing time constant
    const step = (now) => {
      const dt = Math.min(0.1, (now - camLastRef.current) / 1000);
      camLastRef.current = now;
      const to = targetVbRef.current;
      const cur = vbRef.current;
      if (!to) { camRafRef.current = 0; return; }
      if (!cur) { camRafRef.current = 0; setVb(to); return; }
      const diff = Math.max(Math.abs(to.x - cur.x), Math.abs(to.y - cur.y),
        Math.abs(to.w - cur.w), Math.abs(to.h - cur.h));
      if (diff < 0.05) { camRafRef.current = 0; return; } // settled — sleep until the target moves
      const k = 1 - Math.exp(-dt / TAU);
      setVb({
        x: cur.x + (to.x - cur.x) * k, y: cur.y + (to.y - cur.y) * k,
        w: cur.w + (to.w - cur.w) * k, h: cur.h + (to.h - cur.h) * k,
      });
      camRafRef.current = requestAnimationFrame(step);
    };
    camRafRef.current = requestAnimationFrame(step);
  }, []);

  // Wake the camera whenever a new target exists. Deliberately has no dep array:
  // targetVb is recomputed every render, and every way it can move (playback,
  // scrubbing, a segment step, zoom, a sync-mode switch) goes through a render.
  // Costs one no-op call while the loop is already running.
  useEffect(() => { if (targetVb) startCamera(); });
  useEffect(() => () => { cancelAnimationFrame(camRafRef.current); camRafRef.current = 0; }, []);

  // ── Mini-map: whole circuit scaled into the inset, current segment highlighted ──
  const mini = useMemo(() => {
    const line = compLine || refLine;
    if (!line) return null;
    const MW = 150, MH = 104, PAD = 12;
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const p of line.pts) {
      if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
      if (p.z < minZ) minZ = p.z; if (p.z > maxZ) maxZ = p.z;
    }
    const s = Math.min((MW - 2 * PAD) / ((maxX - minX) || 1), (MH - 2 * PAD) / ((maxZ - minZ) || 1));
    const ox = (MW - (maxX - minX) * s) / 2 - minX * s;
    const oz = (MH - (maxZ - minZ) * s) / 2 - minZ * s;
    const map = (x, z) => [x * s + ox, z * s + oz];
    const step = Math.max(1, Math.floor(line.pts.length / 260));
    let d = "";
    for (let i = 0; i < line.pts.length; i += step) {
      const [u, v] = map(line.pts[i].x, line.pts[i].z);
      d += (d ? " L " : "M ") + u.toFixed(1) + "," + v.toFixed(1);
    }
    return { map, path: d + " Z", line, MW, MH };
  }, [compLine, refLine]);

  const miniSegPath = useMemo(() => {
    if (!mini || !seg) return "";
    const { line, map } = mini;
    let d = "";
    for (let i = 0; i < line.pts.length; i++) {
      const f = line.distAt[i];
      if (f < seg.start || f > seg.end) continue;
      const [u, v] = map(line.pts[i].x, line.pts[i].z);
      d += (d ? " L " : "M ") + u.toFixed(1) + "," + v.toFixed(1);
    }
    return d;
  }, [mini, seg?.start, seg?.end]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Time readouts at the playhead ──
  const compTime = comparisonLap?.lapTime || compLine?.timeTotal || 0;
  const refTime  = referenceLap?.lapTime || referenceLap?.meta?.lapTime || refLine?.timeTotal || 0;
  const elapsed = compLine && compTime
    ? distFracToTimeFrac(compLine, playhead) * compTime
    : playhead * lapDur;
  // Live gap at the playhead: driven elapsed time minus reference elapsed time at
  // the same track position (negative = driven is ahead).
  const delta = compLine && refLine && compTime && refTime
    ? distFracToTimeFrac(compLine, playhead) * compTime - distFracToTimeFrac(refLine, playhead) * refTime
    : null;

  // Per-segment times for the card.
  const segTimeOf = (line, T) => (line && T && seg
    ? (distFracToTimeFrac(line, seg.end) - distFracToTimeFrac(line, seg.start)) * T
    : null);
  const compSegT = segTimeOf(compLine, compTime);
  const refSegT  = segTimeOf(refLine, refTime);
  const segDelta = compSegT != null && refSegT != null ? compSegT - refSegT : null;

  const gotoSeg = (dir) => {
    const n = segments.length; if (!n) return;
    const i = (segIdx + dir + n) % n;
    onSeek?.(segments[i].start + 1e-4);
  };

  // ── Timeline scrubbing (pauses playback) ──
  const barRef = useRef(null);
  const scrubEnd = useRef(null);
  const scrubFrom = (clientX) => {
    const el = barRef.current; if (!el) return;
    const r = el.getBoundingClientRect();
    onSeek?.(clamp((clientX - r.left) / r.width, 0, 1));
  };
  const onBarDown = (e) => { onSetPlaying?.(false); scrubFrom(e.clientX);
    const move = ev => scrubFrom(ev.clientX);
    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); scrubEnd.current = null; };
    scrubEnd.current = up;
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up); };
  useEffect(() => () => { scrubEnd.current?.(); }, []);

  const pill = (active) => ({
    background: active ? "var(--elevated)" : "transparent",
    color: active ? "var(--text)" : "var(--text-faint)",
    border: `1px solid ${active ? "var(--border-strong)" : "transparent"}`,
    borderRadius: 6, padding: "4px 12px", fontSize: 10, fontWeight: active ? 700 : 400,
    cursor: "pointer", letterSpacing: 1, textTransform: "uppercase", fontFamily: "inherit",
  });
  // Translucent variant of `pill` for the pills that sit ON the map overlays —
  // opaque surface tokens would read as a solid block over the track.
  const glassPill = (active) => ({
    ...pill(active),
    background: active ? "rgba(255,255,255,0.10)" : "transparent",
    border: `1px solid ${active ? "rgba(255,255,255,0.16)" : "transparent"}`,
    color: active ? "#e8edf5" : "#8b94a8",
  });
  const navBtn = {
    width: 24, height: 24, display: "flex", alignItems: "center", justifyContent: "center",
    background: "transparent", color: "var(--text-mid, #cfd6e6)", border: `1px solid ${C.borderStrong}`,
    borderRadius: 6, cursor: "pointer", fontSize: 12, fontFamily: "inherit", flex: "none", padding: 0,
  };
  const overlayBox = {
    position: "absolute", zIndex: 3, background: "rgba(8,11,18,0.85)",
    border: `1px solid ${C.borderStrong}`, borderRadius: 10, backdropFilter: "blur(3px)",
  };

  if (!lines.length) {
    return (
      <div style={{flex:1,minHeight:0,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",
        textAlign:"center",padding:24,color:"var(--text-faintest)",fontSize:12,lineHeight:1.6}}>
        No racing line to draw yet.<br />
        Drive a lap live on this circuit (so the car's track positions are captured),
        then pick two such laps to compare their lines.
      </div>
    );
  }

  const vbox = vb || targetVb;
  const sc = vbox ? (vbox.w + vbox.h) / 1100 : 1; // world-units-per-pixel-ish overlay scale
  // Car marker size. Overlays like corner labels are scaled by `sc` to stay a
  // CONSTANT on-screen size — but a car that never changes size looks huge over a
  // zoomed-out track and tiny in a zoomed-in corner. So size the cars in REAL-WORLD
  // units instead (they grow/shrink with the track, ~7 m long), clamped to a sane
  // pixel range so they never vanish when zoomed out or dominate when zoomed right in.
  const CAR_WORLD = 0.16;                 // local-unit → world-metre scale (car ≈ 7 m)
  const carScale = clamp(CAR_WORLD, (11 * sc) / 44, (46 * sc) / 44); // floor 11 px, cap 46 px

  // The same two cars for the 3D view, in ITS units: heading in radians, and lap
  // distance in metres so the model's wheels roll. `main` marks the one the orbit
  // camera watches — the driven lap, since that's the car you're steering the
  // comparison from. Rebuilt per render, which is per frame while playing anyway.
  const orbitCars = [
    refCar && { x: refCar.x, z: refCar.z, yaw: refAngle * Math.PI / 180,
      color: REF_COLOR, dist: refFrac * (refLine?.lapLen || 0) },
    compCar && { x: compCar.x, z: compCar.z, yaw: compAngle * Math.PI / 180,
      color: COMP_COLOR, dist: playhead * (compLine?.lapLen || 0), main: true },
  ].filter(Boolean);

  return (
    <div style={{flex:1,minHeight:0,display:"flex",flexDirection:"column",gap:10,overflow:"hidden"}}>
      {hidden.length > 0 && (
        <div style={{fontSize:10,color:"var(--text-faintest)",textAlign:"center",lineHeight:1.5}}>
          {hidden.join(" · ")} — no position data, car hidden. Drive this lap live to capture its line.
        </div>
      )}

      {/* The map viewport */}
      <div style={{position:"relative",flex:"1 1 auto",minHeight:280,borderRadius:10,overflow:"hidden",
        border:"1px solid var(--line)",background:"radial-gradient(120% 120% at 50% 0%, #131a26 0%, #0a0d14 70%)"}}>
        {/* Onboard camera. Swaps only the VIEWPORT — every overlay below is an
            absolutely-positioned sibling and carries straight over. */}
        {onboard && camLine && (
          <TrackCamView model={trackModel || null}
            driven={compLine} reference={refLine}
            cornerMarks={cornerMarks} brakeMarks={refBrakeMarks}
            panes={camPanes} />
        )}
        {/* Free camera over the same scene. Shares the zoom control with the map —
            one slider, read as a viewBox there and as a camera distance here. */}
        {camMode === "orbit" && camLine && (
          <TrackOrbitView model={trackModel || null}
            driven={compLine} reference={refLine}
            cornerMarks={cornerMarks} brakeMarks={refBrakeMarks}
            cars={orbitCars} zoom={zoom}
            onZoomBy={(f) => setZoom((z) => clamp(z * f, MIN_ZOOM, MAX_ZOOM))} />
        )}
        {camMode === "map" && vbox && (
          <svg viewBox={`${vbox.x} ${vbox.y} ${vbox.w} ${vbox.h}`} preserveAspectRatio="xMidYMid meet"
            style={{position:"absolute",inset:0,width:"100%",height:"100%",display:"block"}}>
            {road && (
              <>
                <path d={road.fill} fill="#10151f" fillRule="evenodd" />
                <path d={road.edgeL} fill="none" stroke="#3a445c" strokeWidth={1.4} vectorEffect="non-scaling-stroke" />
                <path d={road.edgeR} fill="none" stroke="#3a445c" strokeWidth={1.4} vectorEffect="non-scaling-stroke" />
              </>
            )}
            {/* Corner markers */}
            {cornerMarks.map((c, i) => (
              <g key={i} pointerEvents="none">
                <circle cx={c.x} cy={c.z} r={3.2 * sc} fill="#0b0e14" stroke="#5b6b8c" strokeWidth={1.1 * sc} />
                <text x={c.x + 6 * sc} y={c.z + 3.5 * sc} fill="#8b94a8" fontSize={10 * sc} fontWeight={700}
                  fontFamily={FONT.mono}>{c.name}</text>
              </g>
            ))}
            {/* Racing lines: driven throttle/brake gradient underneath, reference on top */}
            {compGrad.map((g, i) => (
              <path key={i} d={g.d} fill="none" stroke={g.color} strokeWidth={2.4}
                vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" />
            ))}
            {refPath && (
              // Dash pattern is in SCREEN px here (non-scaling-stroke covers the dashes
              // too), so keep it CONSTANT — scaling it by `sc` made the slots shrink to a
              // solid line as you zoomed in.
              <path d={refPath} fill="none" stroke={REF_COLOR} strokeWidth={2.6} strokeOpacity={0.7}
                strokeDasharray="4 8" strokeLinecap="round"
                vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
            )}
            {/* Brake points on the reference line — where the ref first hits the brakes per corner */}
            {refBrakeMarks.map((m, i) => (
              <circle key={i} cx={m.x} cy={m.z} r={4 * sc} fill="#ff2d2d"
                stroke="#0b0e14" strokeWidth={1.3 * sc} pointerEvents="none" />
            ))}
            {/* Cars — top-down F1 silhouettes, pointed along their heading */}
            {refCar && (
              <CarMarker x={refCar.x} z={refCar.z} angle={refAngle} color={REF_COLOR} scale={carScale} />
            )}
            {compCar && (
              <CarMarker x={compCar.x} z={compCar.z} angle={compAngle} color={COMP_COLOR} scale={carScale} main />
            )}
          </svg>
        )}

        {/* Track label (top-left) */}
        <div style={{position:"absolute",left:12,top:11,zIndex:3,pointerEvents:"none",
          fontFamily:FONT.mono,fontSize:9,letterSpacing:1.5,color:"#5b6478",textTransform:"uppercase"}}>
          {trackName || "Track"}
          {/* A synthetic road is mildly misleading in plan view and ACTIVELY
              misleading from the seat, so say so louder in the camera modes. */}
          {trackModel && trackModel.status === "fallback"
            ? (onboard ? " · ⚠ approximate track shape" : " · approximate track")
            : ""}
          {/* Say when the road had to be moved to sit under the car. The shipped
              centerlines are OSM traces and the fit is rigid, so on some circuits
              the geometry is locally out by more than a track width — invisible on
              the map, but from the seat it's the difference between driving on the
              road and driving beside it. Don't hide the correction; report it. */}
          {camMode !== "map" && trackModel?.seated > 2
            ? ` · road seated ±${trackModel.seated.toFixed(0)} m` : ""}
        </div>
        {/* Camera mode (top-centre) */}
        <div style={{position:"absolute",left:"50%",transform:"translateX(-50%)",top:8,zIndex:3,
          display:"flex",gap:3,background:"rgba(8,11,18,0.7)",border:`1px solid ${C.borderStrong}`,
          borderRadius:8,padding:3,backdropFilter:"blur(3px)"}}>
          {[["map","Map"],["orbit","3D"],["tcam","T-Cam"],["compare","Compare"]].map(([m,l])=>(
            <button key={m} onClick={()=>setCamMode(m)}
              disabled={m === "compare" && !canCompare}
              title={m === "compare" && !canCompare ? "Needs two laps with position data" : ""}
              style={{...glassPill(camMode===m),padding:"3px 10px",
                opacity: m === "compare" && !canCompare ? 0.35 : 1,
                cursor: m === "compare" && !canCompare ? "not-allowed" : "pointer"}}>{l}</button>
          ))}
        </div>
        {/* Live delta + line legend (top-right) */}
        <div style={{...overlayBox,right:10,top:10,pointerEvents:"none",display:"flex",alignItems:"center",gap:12,padding:"5px 10px"}}>
          <span style={{fontFamily:FONT.mono,fontSize:11,color:"#8b94a8"}}>
            Delta: <span style={{fontWeight:800,color:delta==null?"#8b94a8":delta<0?C.green:delta>0?C.red:"#e8edf5"}}>
              {delta==null?"—":fmtd(delta)}</span>
          </span>
          <span style={{fontFamily:FONT.mono,fontSize:11,color:"#8b94a8"}}>⟷ {lapLen ? `${Math.round(playhead*lapLen)} m` : "—"}</span>
          <span style={{width:1,alignSelf:"stretch",background:C.borderStrong}} />
          <span style={{display:"flex",alignItems:"center",gap:6,fontSize:9,color:"#8b94a8"}}>
            <svg width="20" height="6">
              <defs><linearGradient id="drivenLegend" x1="0" y1="0" x2="1" y2="0">
                <stop offset="0%" stopColor={pedalColor(0)} />
                <stop offset="50%" stopColor={pedalColor(0.5)} />
                <stop offset="100%" stopColor={pedalColor(1)} />
              </linearGradient></defs>
              <line x1="0" y1="3" x2="20" y2="3" stroke="url(#drivenLegend)" strokeWidth="2.5"/>
            </svg>Driven</span>
          <span style={{display:"flex",alignItems:"center",gap:6,fontSize:9,color:"#8b94a8"}}>
            <svg width="20" height="6"><line x1="0" y1="3" x2="20" y2="3" stroke={REF_COLOR} strokeWidth="2.5" strokeOpacity="0.7" strokeDasharray="4 8" strokeLinecap="round"/></svg>Reference</span>
          <span style={{display:"flex",alignItems:"center",gap:6,fontSize:9,color:"#8b94a8"}}>
            <svg width="10" height="10"><circle cx="5" cy="5" r="4" fill="#ff2d2d" stroke="#0b0e14" strokeWidth="1"/></svg>Ref brake</span>
        </div>

        {trackModel === null && (
          <div style={{position:"absolute",inset:0,display:"flex",alignItems:"center",justifyContent:"center",zIndex:2,
            pointerEvents:"none",fontFamily:FONT.mono,fontSize:11,letterSpacing:1.5,
            color:"#5b6478",textTransform:"uppercase"}}>Aligning circuit…</div>
        )}

        {/* Segment card (bottom-left): prev/next + per-lap segment times */}
        {seg && (
          <div style={{...overlayBox,left:10,bottom:10,minWidth:200,maxWidth:250,padding:"8px 10px"}}>
            {/* Sync + Segments/Sectors toggles — in the card so they cost no page height */}
            <div style={{display:"flex",gap:3,background:"rgba(255,255,255,0.04)",
              border:`1px solid ${C.borderStrong}`,borderRadius:8,padding:3,marginBottom:5}}>
              {[["pos","Pos-sync"],["pace","Pace-sync"]].map(([m,l])=>(
                <button key={m} onClick={()=>setSyncMode(m)} style={{...glassPill(syncMode===m),flex:1,padding:"3px 6px"}}>{l}</button>
              ))}
            </div>
            <div style={{display:"flex",gap:3,background:"rgba(255,255,255,0.04)",
              border:`1px solid ${C.borderStrong}`,borderRadius:8,padding:3,marginBottom:7}}>
              {[["segments","Segments"],["sectors","Sectors"]].map(([m,l])=>(
                <button key={m} onClick={()=>setViewMode(m)} style={{...glassPill(viewMode===m),flex:1,padding:"3px 6px"}}>{l}</button>
              ))}
            </div>
            <div style={{display:"flex",alignItems:"center",gap:8}}>
              <button style={navBtn} title="Previous segment" onClick={()=>gotoSeg(-1)}>‹</button>
              <div style={{flex:1,textAlign:"center",display:"flex",alignItems:"baseline",justifyContent:"center",gap:8}}>
                <span style={{fontFamily:FONT.mono,fontSize:13,fontWeight:800,color:"#e8edf5"}}>{seg.name}</span>
                {segDelta != null && (
                  <span style={{fontFamily:FONT.mono,fontSize:12,fontWeight:800,
                    color:segDelta < 0 ? C.green : segDelta > 0 ? C.red : C.textMid}}>{fmtd(segDelta)}</span>
                )}
              </div>
              <button style={navBtn} title="Next segment" onClick={()=>gotoSeg(1)}>›</button>
            </div>
            {seg.sub && (
              <div style={{textAlign:"center",fontSize:9,letterSpacing:1,color:"#8b94a8",textTransform:"uppercase",marginTop:2}}>{seg.sub}</div>
            )}
            <div style={{marginTop:7,display:"flex",flexDirection:"column",gap:4}}>
              {[[comparisonLabel, compSegT, COMP_COLOR], [referenceLabel, refSegT, REF_COLOR]].map(([label, t, color], i) => (
                <div key={i} style={{display:"flex",alignItems:"center",gap:7}}>
                  <span style={{width:8,height:8,borderRadius:2,flex:"none",background:color}} />
                  <span style={{flex:1,fontSize:10,color:"#aeb8cc",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{label}</span>
                  <span style={{fontFamily:FONT.mono,fontSize:12,fontWeight:700,color:"#e8edf5"}}>{fmtSeg(t)}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Zoom (bottom-centre) — the two whole-scene views. A T-cam with a variable
            FOV is just disorienting, and the control has no natural meaning from the
            seat; in 3D it's the camera's distance, and the mouse wheel drives the
            same state so the slider tracks a scroll. */}
        {!onboard && (
        <div style={{...overlayBox,left:"50%",transform:"translateX(-50%)",bottom:10,borderRadius:999,
          display:"flex",alignItems:"center",gap:8,padding:"5px 12px"}}>
          <button style={{...navBtn,border:"none",width:18}} title="Zoom out"
            onClick={()=>setZoom(z=>clamp(z/1.25,MIN_ZOOM,MAX_ZOOM))}>−</button>
          <input type="range" min={MIN_ZOOM} max={MAX_ZOOM} step={0.01} value={zoom} title="Zoom"
            onChange={(e)=>setZoom(Number(e.target.value))} style={{width:110,accentColor:COMP_COLOR}} />
          <button style={{...navBtn,border:"none",width:18}} title="Zoom in"
            onClick={()=>setZoom(z=>clamp(z*1.25,MIN_ZOOM,MAX_ZOOM))}>＋</button>
        </div>
        )}

        {/* Mini-map (bottom-right): whole circuit + current segment. Kept in the
            camera modes, where it earns its space — an onboard view strips away
            every bit of global context about where on the lap you are. */}
        {mini && (
          <div style={{...overlayBox,right:10,bottom:10,width:mini.MW,height:mini.MH,overflow:"hidden"}}>
            <svg width="100%" height="100%" viewBox={`0 0 ${mini.MW} ${mini.MH}`}>
              <path d={mini.path} fill="none" stroke="#39435a" strokeWidth={2} strokeLinejoin="round" />
              {miniSegPath && <path d={miniSegPath} fill="none" stroke={COMP_COLOR} strokeWidth={3} strokeLinecap="round" />}
              {compCar && (() => { const [u,v] = mini.map(compCar.x, compCar.z);
                return <circle cx={u} cy={v} r={3} fill={COMP_COLOR} stroke="#0b0e14" strokeWidth={1} />; })()}
            </svg>
          </div>
        )}
      </div>

      {/* Transport: play + elapsed time + shared timeline scrubber */}
      <div style={{flex:"none",height:44,display:"flex",alignItems:"center",gap:14}}>
        <button onClick={()=>{ if (!playing && playhead >= 0.999) onSeek?.(0); onSetPlaying?.(!playing); }} title={playing?"Pause":"Play"}
          style={{width:38,height:38,borderRadius:"50%",border:"none",background:COMP_COLOR,color:"#051018",
            fontSize:13,fontWeight:800,cursor:"pointer",flex:"none",display:"flex",alignItems:"center",justifyContent:"center"}}>
          {playing?"❚❚":"▶"}</button>
        <div style={{flex:"none",display:"flex",gap:3,background:"var(--line)",borderRadius:8,padding:3}}>
          {[0.5,1].map(s=>(
            <button key={s} onClick={()=>setSpeed(s)} style={pill(speed===s)}>{s}×</button>
          ))}
        </div>
        <span style={{flex:"none",fontFamily:FONT.mono,fontSize:15,fontWeight:800,color:"#e8edf5",minWidth:82}}>
          {formatLapTime(elapsed, 3)}</span>
        <div ref={barRef} onPointerDown={onBarDown} style={{flex:1,position:"relative",height:34,display:"flex",alignItems:"center",cursor:"pointer"}}>
          <div style={{position:"absolute",left:0,right:0,height:6,borderRadius:3,background:"#1c2230"}} />
          <div style={{position:"absolute",left:0,height:6,borderRadius:3,background:COMP_COLOR,width:`${playhead*100}%`}} />
          {/* Sector dividers */}
          {sectors.slice(1).map((s,i)=>(
            <div key={`sec-${i}`} style={{position:"absolute",left:`${s.start*100}%`,top:"50%",transform:"translate(-50%,-50%)",width:1,height:16,background:"#2b3346"}} />
          ))}
          {/* Corner ticks */}
          {corners.map((c,i)=>(
            <div key={i} style={{position:"absolute",left:`${c.f*100}%`,top:"50%",transform:"translate(-50%,-50%)",width:2,height:11,background:"#2b3346"}} />
          ))}
          {/* Reference car position (diverges from the knob in pace-sync) */}
          {refLine && compLine && syncMode==="pace" && (
            <div title="Reference car" style={{position:"absolute",left:`${refFrac*100}%`,top:"50%",
              transform:"translate(-50%,-50%)",width:9,height:9,borderRadius:"50%",background:"transparent",border:`2px solid ${REF_COLOR}`}} />
          )}
          {/* Knob */}
          <div style={{position:"absolute",left:`${playhead*100}%`,top:"50%",transform:"translate(-50%,-50%)",width:16,height:16,borderRadius:"50%",
            background:COMP_COLOR,border:"3px solid #0b0e14",boxShadow:`0 0 9px ${COMP_COLOR}aa`}} />
        </div>
      </div>

    </div>
  );
}
