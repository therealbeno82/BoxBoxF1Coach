// ─── TELEMETRY STUDIO (Analytics, beside the driving lines) ──────────────────
// The MoTeC-style trace stack: stacked channel panels (Throttle/Brake, Speed,
// Wheel Rotation, Gear, ERS Mode/Used, Tyre Temps) overlaid with sector boundary
// lines and a white playback cursor, each panel reading out both laps at the
// cursor (or at the pointer, when hovering while paused).
//
// Playback is shared: the playhead lives in lib/playheadStore.js and the clock
// that advances it in DrivingLinesView, so the trace cursor, the read-outs and
// the cars on the driving lines all move on ONE timeline. `playing` and
// `onSetPlaying` come in as props; a tap on the stack toggles them.
//
// (There used to be a standalone mode as well — its own cursor, rAF sweep,
// scrubber and a 300px column of readout cards — but the only caller always ran
// it controlled and compact, so all of that was dead weight, and the readout
// cards were still rebuilt every frame while hidden. Removed.)
//
// Panels are driven by the PANELS registry below — visibility filtering,
// rendering, chip toggles and the readouts all derive from it, so adding a
// channel is one new entry.
//
// Pure presentation: the driven/reference sample arrays, lap length, sector
// distances and strategy zones are supplied by BoxBoxApp's existing engine.

import { useState, useRef, useMemo } from "react";
import { C, FONT } from "../lib/ui/tokens.js";
import { toSpeed, speedUnitLabel, toTemp, tempUnitLabel, clamp } from "../lib/format.js";
import { ERS_MODES } from "../lib/coach/config.js";
import { cornerLabel } from "../lib/cornerData.js";
import { useViewport } from "../hooks/useViewport.jsx";
import { usePlayhead } from "../lib/playheadStore.js";
import { lapClockAxis, timeAtDist } from "../lib/timeAxis.js";

const W = 1000, VH = 100;          // SVG coordinate system (stretched per panel)

// Nearest sample to a lap distance. Binary search, not a scan: the array IS sorted
// by dist, and this runs twice per playhead or hover move — so during playback the
// linear reduce walked ~1,400 samples every frame at 60 fps to answer a question
// the ordering already settles in ~10 comparisons.
function nearest(samples, dist) {
  if (!samples || !samples.length) return null;
  let lo = 0, hi = samples.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((samples[mid].dist || 0) < dist) lo = mid + 1;
    else hi = mid;
  }
  // `lo` is the first sample at or past `dist`; the nearer of it and its
  // predecessor is the answer.
  const a = samples[lo - 1], b = samples[lo];
  if (!a) return b;
  return Math.abs((a.dist || 0) - dist) <= Math.abs((b.dist || 0) - dist) ? a : b;
}

// Build a channel's line path (optionally stepped for gear/ERS-mode) plus an
// optional filled area down to the panel baseline. Values normalise to [min,max];
// lap distance normalises over the visible window [d0,d1] (full lap or one sector).
// The window keeps exactly ONE neighbour sample outside each edge (clamped x,
// true y — a ≤10 m approximation at the bin pitch) so lines reach the panel
// border when zoomed. Do NOT "fix" that by keeping every outside sample with a
// clamped x — that smears a vertical stack of points onto the border.
function buildPath(samples, key, min, max, { step = false, area = false, d0 = 0, d1 = 0 } = {}) {
  const span = d1 - d0;
  if (!samples || samples.length < 2 || !(span > 0)) return { line: "", area: "" };
  const valid = [];
  for (const s of samples) {
    const v = s[key];
    if (typeof v !== "number" || Number.isNaN(v)) continue;
    valid.push(s);
  }
  let first = valid.length, last = -1;
  for (let i = 0; i < valid.length; i++) {
    const d = valid[i].dist || 0;
    if (d >= d0 && d <= d1) { if (i < first) first = i; last = i; }
  }
  if (last < 0) return { line: "", area: "" };
  const pts = [];
  for (let i = Math.max(0, first - 1); i <= Math.min(valid.length - 1, last + 1); i++) {
    const s = valid[i];
    const x = clamp(((s.dist || 0) - d0) / span, 0, 1) * W;
    const y = VH - clamp((s[key] - min) / (max - min), 0, 1) * VH;
    // A degenerate scale (max === min) makes the division NaN, and `clamp` is
    // Math.max/Math.min, which propagates it — one NaN anywhere in a `d`
    // attribute drops the WHOLE path with no error, so the channel just
    // silently disappears. Every scale is safe by construction today; this
    // keeps a future `scales` edit from costing an invisible trace.
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    pts.push([x, y]);
  }
  if (pts.length < 2) return { line: "", area: "" };
  let line = `M ${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}`;
  for (let i = 1; i < pts.length; i++) {
    if (step) line += ` L ${pts[i][0].toFixed(1)},${pts[i - 1][1].toFixed(1)} L ${pts[i][0].toFixed(1)},${pts[i][1].toFixed(1)}`;
    else line += ` L ${pts[i][0].toFixed(1)},${pts[i][1].toFixed(1)}`;
  }
  const areaPath = area
    ? `M ${pts[0][0].toFixed(1)},${VH} ` + pts.map((p) => `L ${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ") + ` L ${pts[pts.length - 1][0].toFixed(1)},${VH} Z`
    : "";
  return { line, area: areaPath };
}

const r0 = (v) => (v == null || Number.isNaN(v) ? "—" : Math.round(v));
const steerMag = (v) => (v == null || Number.isNaN(v) ? "—" : Math.round(Math.abs(v)));
const steerDir = (v) => (v == null || Number.isNaN(v) ? "" : v < -2 ? "L" : v > 2 ? "R" : "·");
const ersName = (v) => ERS_MODES[Math.round(clamp(v ?? 0, 0, 3))] || "None";
const fmtDt = (v) => (typeof v === "number" && Number.isFinite(v)
  ? `${v > 0.0005 ? "+" : v < -0.0005 ? "−" : ""}${Math.abs(v).toFixed(2)}` : "—");

// The driven lap's samples with a `delta` channel: seconds behind (+) or ahead (−)
// of the reference at the same lap distance — the running gap, i.e. MoTeC's time
// delta trace. Both clocks come from lib/timeAxis.js (the game's own clock where
// the lap carries it). With no reference, or none at a point, there is no delta.
// Built once per lap pair; the panel then treats it like any other channel.
function withDelta(comp, ref, compLapTime, refLapTime) {
  if (!Array.isArray(comp) || comp.length < 2 || !Array.isArray(ref) || ref.length < 2) return comp;
  const axC = lapClockAxis({ samples: comp, lapTime: compLapTime });
  const axR = lapClockAxis({ samples: ref, lapTime: refLapTime });
  if (!axC || !axR) return comp;
  return comp.map((s, i) => {
    const tr = timeAtDist(ref, axR, s.dist);
    return tr == null ? s : { ...s, delta: axC[i] - tr };
  });
}

const cardStyle = { background: C.surface, border: `1px solid ${C.line}`, borderRadius: 12 };
const panelStyle = { minHeight: 0, position: "relative", background: C.inset, border: `1px solid ${C.line}`, borderRadius: 9, overflow: "hidden" };
const svgStyle = { position: "absolute", inset: 0, width: "100%", height: "100%" };
const labelStyle = (color) => ({ position: "absolute", top: 7, left: 10, fontSize: 9, letterSpacing: 1, color, textTransform: "uppercase", zIndex: 2 });
const valStyle = (color, size = 12) => ({ fontFamily: FONT.mono, fontSize: size, fontWeight: 800, color });

// ─── Panel registry ──────────────────────────────────────────────────────────
// One entry per stacked trace panel. `channels` drive both path building and
// SVG paint (draw order per panel: all areas → all ref lines → all main lines,
// in channel order). `max`/`min` are literals, or `maxKey`/`minKey` name a
// dynamic value in the `scales` memo. `values` renders the top-right readout —
// one `fmt` per channel, called TWICE (driven sample, then reference sample) so
// the grey ref figure sits directly under its driven counterpart.
// `ctx` = { units, uLabel, tempUnits, tLabel }.
const PANELS = [
  {
    // The running gap to the reference, first because it is the one trace that
    // says where on the lap the time actually went; every panel below is why.
    id: "delta", flex: 0.9, chip: { label: "Δt", color: C.yellow },
    labelColor: C.textMuted,
    labelContent: () => (<><span style={{ color: C.yellow }}>Δ Time</span> vs ref · s <span style={{ color: C.textDim }}>(+ behind)</span></>),
    midline: true,
    noDataKey: "delta", noDataHint: "needs a reference lap",
    channels: [
      { key: "delta", minKey: "deltaLo", maxKey: "deltaHi", stroke: C.yellow, width: 2, join: true, refStroke: C.yellow, refOpacity: 0 },
    ],
    values: [
      // A gap has no reference-side value, so no grey figure under it.
      { color: C.yellow, size: 13, noRef: true, fmt: (s) => fmtDt(s?.delta) },
    ],
  },
  {
    id: "inputs", flex: 1.35, chip: { label: "Thr/Brk", color: "#ffffff" },
    labelColor: C.textMuted,
    labelContent: () => (<>Throttle <span style={{ color: C.textBody2 }}>/</span> Brake</>),
    channels: [
      { key: "throttle", min: 0, max: 100, area: true, areaFill: "#ffffff12", stroke: "#ffffff", width: 2, join: true, refStroke: "#ffffff", refOpacity: 0.5 },
      { key: "brake", min: 0, max: 100, area: true, areaFill: "#ff4d5e14", stroke: C.red, width: 2, join: true, refStroke: C.red, refOpacity: 0.5 },
    ],
    values: [
      { color: "#fff", fmt: (s) => `${r0(s?.throttle)}%` },
      { color: C.red, fmt: (s) => `${r0(s?.brake)}%` },
    ],
  },
  {
    id: "speed", flex: 1.5, chip: { label: "Speed", color: C.teal },
    labelColor: C.teal,
    labelContent: (ctx) => <>Speed · {ctx.uLabel}</>,
    channels: [
      { key: "speed", min: 0, maxKey: "maxSpeed", area: true, areaFill: "#2dd4bf14", stroke: C.teal, width: 2.2, join: true, refStroke: C.textDim },
    ],
    values: [
      { color: C.teal, size: 14, fmt: (s, ctx) => toSpeed(s?.speed, ctx.units) },
    ],
  },
  {
    id: "steer", flex: 1, chip: { label: "Wheel", color: C.green },
    labelColor: C.green,
    labelContent: () => "Wheel Rotation",
    midline: true,
    channels: [
      { key: "steer", min: -100, max: 100, stroke: C.green, width: 2, join: true, refStroke: C.green, refOpacity: 0.5 },
    ],
    values: [
      { color: C.green, fmt: (s) => <>{steerMag(s?.steer)} <span style={{ color: C.textDim }}>{steerDir(s?.steer)}</span></> },
    ],
  },
  {
    id: "gear", flex: 1, chip: { label: "Gear", color: C.purple },
    labelColor: C.purple,
    labelContent: () => "Gear",
    channels: [
      { key: "gear", min: 0, max: 8, step: true, stroke: C.purple, width: 2, refStroke: C.purple, refOpacity: 0.5 },
    ],
    values: [
      { color: C.purple, size: 13, fmt: (s) => s?.gear ?? "—" },
    ],
  },
  {
    id: "ers", flex: 1.35, chip: { label: "ERS", color: C.ersYellow },
    labelColor: C.textMuted,
    labelContent: () => (<>ERS Mode <span style={{ color: C.red }}>/</span> Used · SOC</>),
    channels: [
      { key: "ersMode", min: 0, max: 3, step: true, stroke: C.red, width: 2, refStroke: C.red, refOpacity: 0.5 },
      { key: "ersSpent", min: 0, maxKey: "maxErs", area: true, areaFill: "#FFD43B14", stroke: C.ersYellow, width: 2, join: true, refStroke: C.ersYellow, refOpacity: 0.5 },
    ],
    values: [
      { color: C.red, fmt: (s) => (s ? ersName(s.ersMode) : "—") },
      { color: C.ersYellow, fmt: (s) => r0(s?.ersSpent) },
    ],
  },
  {
    id: "tyres", flex: 1.2, chip: { label: "Tyres", color: C.orange },
    labelColor: C.textMuted,
    labelContent: (ctx) => (
      <><span style={{ color: C.orange }}>Tyre Surf</span> <span style={{ color: C.textBody2 }}>/</span> <span style={{ color: C.cyan }}>Carc</span> · {ctx.tLabel}</>
    ),
    // Old stored laps / imported traces predate tyre temp capture — show a hint
    // instead of an empty panel when neither lap carries this key.
    noDataKey: "tyreSurf", noDataHint: "no tyre data for this lap",
    channels: [
      // Shared lo/hi scale keeps the surface-vs-carcass gap physically meaningful.
      // No area fills — two overlaid worms stay readable.
      { key: "tyreSurf", minKey: "tyreLo", maxKey: "tyreHi", stroke: C.orange, width: 2, join: true, refStroke: C.orange, refOpacity: 0.5 },
      { key: "tyreCarc", minKey: "tyreLo", maxKey: "tyreHi", stroke: C.cyan, width: 2, join: true, refStroke: C.cyan, refOpacity: 0.5 },
    ],
    values: [
      { color: C.orange, fmt: (s, ctx) => `${r0(toTemp(s?.tyreSurf, ctx.tempUnits))}°` },
      { color: C.cyan, fmt: (s, ctx) => `${r0(toTemp(s?.tyreCarc, ctx.tempUnits))}°` },
    ],
  },
];

// One stacked trace panel: label, top-right values, and the channel SVG.
// Each value is a column — the driven figure in its channel colour with the
// reference figure in grey directly beneath it, so the two read as a pair.
function TracePanel({ panel, chPaths, dS, rS, hasRef, ctx, noData }) {
  return (
    <div style={{ ...panelStyle, flex: panel.flex }}>
      <span style={labelStyle(panel.labelColor)}>{panel.labelContent(ctx)}</span>
      <div style={{ position: "absolute", top: 6, right: 10, display: "flex", gap: 10, zIndex: 2 }}>
        {panel.values.map((v, i) => (
          <div key={i} style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 1 }}>
            <span style={{ ...valStyle(v.color, v.size || 12), lineHeight: 1 }}>{v.fmt(dS, ctx)}</span>
            {hasRef && !v.noRef && (
              <span style={{ ...valStyle(C.textFaint, (v.size || 12) - 2), fontWeight: 700, lineHeight: 1 }}>
                {v.fmt(rS, ctx)}
              </span>
            )}
          </div>
        ))}
      </div>
      {noData && (
        <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center",
          fontSize: 10, color: C.textFaintest, zIndex: 1 }}>{panel.noDataHint}</div>
      )}
      <svg viewBox={`0 0 ${W} ${VH}`} preserveAspectRatio="none" style={svgStyle}>
        {panel.midline && (
          <line x1={0} y1={VH / 2} x2={W} y2={VH / 2} stroke="#3b4458" strokeWidth={1} strokeDasharray="4 4" vectorEffect="non-scaling-stroke" />
        )}
        {panel.channels.map((ch, i) => (ch.area
          ? <path key={`a${i}`} d={chPaths[i].main.area} fill={ch.areaFill} />
          : null))}
        {panel.channels.map((ch, i) => (
          <path key={`r${i}`} d={chPaths[i].ref.line} fill="none" stroke={ch.refStroke} strokeWidth={1.5}
            strokeOpacity={ch.refOpacity} strokeDasharray="6 4" vectorEffect="non-scaling-stroke" />
        ))}
        {panel.channels.map((ch, i) => (
          <path key={`m${i}`} d={chPaths[i].main.line} fill="none" stroke={ch.stroke} strokeWidth={ch.width}
            vectorEffect="non-scaling-stroke" strokeLinejoin={ch.join ? "round" : undefined} />
        ))}
      </svg>
    </div>
  );
}

// S1/S2/S3 zoom control. Rendered as a proper raised button (hover + active
// states) rather than a flat text tag. Absolutely positioned over the trace
// stack; `zoomed` = this sector is the active deep-dive (centred + highlighted).
// `slim` = the phone build: the button sits in its own strip above the traces
// rather than on top of them, so it is sized for the least vertical space it can
// take — including an inline min-height that overrides the coarse-pointer tap
// floor in index.html, which would otherwise make this strip 44px tall.
function SectorButton({ name, left, zoomed, onClick, slim = false }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title={zoomed ? "Back to full lap" : `Zoom to ${name}`}
      style={{
        position: "absolute", top: slim ? 0 : 6, left, transform: "translateX(-50%)", zIndex: 5,
        cursor: "pointer", appearance: "none", outline: "none",
        ...(slim && { minHeight: 0, height: 18 }),
        fontFamily: FONT.mono, fontSize: slim ? 10 : 13, fontWeight: 800, letterSpacing: 1, lineHeight: 1,
        color: zoomed ? "#fff" : hover ? C.textHi : C.textBody,
        background: zoomed
          ? "linear-gradient(180deg, #4885e0 0%, #3671C6 100%)"
          : hover
            ? "linear-gradient(180deg, #232c3e 0%, #1a2130 100%)"
            : "linear-gradient(180deg, #1a2130 0%, #141922 100%)",
        border: `1px solid ${zoomed ? C.blue : hover ? "#3d4864" : C.borderStrong}`,
        padding: slim ? "0 9px" : "7px 15px", borderRadius: slim ? 5 : 7,
        boxShadow: zoomed
          ? "0 2px 8px rgba(54,113,198,.5), inset 0 1px 0 rgba(255,255,255,.25)"
          : "0 2px 5px rgba(0,0,0,.5), inset 0 1px 0 rgba(255,255,255,.06)",
        transition: "background .12s, border-color .12s, box-shadow .12s, color .12s",
      }}>{name}</button>
  );
}

export default function TelemetryStudio({
  compareSamples: compareRaw = [], referenceSamples = [], lapLength = 0,
  compareLapTime = null, referenceLapTime = null,
  zones = [], sectorDists = [], units = "km/h", tempUnits = "°C", corners: cornerDb = [],
  visibleTraces = null, onToggleTrace = null,
  playing = false, onSetPlaying = null,
}) {
  const playhead = usePlayhead();
  const compareSamples = useMemo(
    () => withDelta(compareRaw, referenceSamples, compareLapTime, referenceLapTime),
    [compareRaw, referenceSamples, compareLapTime, referenceLapTime]);
  const [zoomSector, setZoomSector] = useState(null); // null = full lap | 0 | 1 | 2
  const [hoverF, setHoverF] = useState(null);         // 0–1 across the visible window, null = not hovering
  const stackRef = useRef(null);
  const { phone } = useViewport();

  const setPlaying = (v) => onSetPlaying?.(typeof v === "function" ? v(playing) : v);

  const hasData = compareSamples.length > 1 || referenceSamples.length > 1;
  const hasRef = referenceSamples.length > 1;
  const uLabel = speedUnitLabel(units);
  const tLabel = tempUnitLabel(tempUnits);

  // Sector boundary fractions (2) + S1/S2/S3 label positions. Use the reference
  // lap's sector distances when present, else even thirds of the lap.
  const { boundaries, sectorLabels } = useMemo(() => {
    let b = [];
    if (Array.isArray(sectorDists) && sectorDists.length && lapLength) {
      b = sectorDists.map((d) => clamp(d / lapLength, 0, 1)).filter((f) => f > 0.001 && f < 0.999).sort((x, y) => x - y).slice(0, 2);
    }
    if (b.length < 2) b = [1 / 3, 2 / 3];
    const mids = [b[0] / 2, (b[0] + b[1]) / 2, (b[1] + 1) / 2];
    return { boundaries: b, sectorLabels: ["S1", "S2", "S3"].map((name, i) => ({ name, f: mids[i] })) };
  }, [sectorDists, lapLength]);

  // Visible window in lap-metres: the full lap, or one sector when zoomed.
  // Plain scalars (not a memoised array) — downstream memos depend on d0/d1
  // by value, so equal recomputations never churn them.
  const domainFor = (sector) => {
    if (sector == null || !lapLength) return [0, lapLength];
    const b0 = boundaries[0] * lapLength, b1 = boundaries[1] * lapLength;
    return sector === 0 ? [0, b0] : sector === 1 ? [b0, b1] : [b1, lapLength];
  };
  const [d0, d1] = domainFor(zoomSector);
  const winSpan = (d1 - d0) || 1;

  // The cursor as a window fraction: the shared lap-fraction playhead, clamped
  // to the zoom window.
  const cursor = lapLength
    ? clamp((clamp(playhead, 0, 1) * lapLength - d0) / winSpan, 0, 1)
    : clamp(playhead, 0, 1);

  // Zoom in/out, pausing so playback can't jump mid-frame. The cursor
  // re-derives from the playhead, which never moves on zoom — only the window.
  const zoomTo = (next) => {
    setPlaying(false);
    setZoomSector(next);
  };

  // S1/S2/S3 double as the zoom control: click to deep-dive that sector, click
  // the (highlighted, centered) active one to zoom out. Built here because they
  // render in one of two places — their own strip on a phone, over the traces on
  // desktop. stopPropagation lives in the button: on desktop they sit inside the
  // stack's play/pause click target.
  const sectorButtons = sectorLabels.map((s, i) => {
    if (zoomSector != null && zoomSector !== i) return null;
    const zoomed = zoomSector === i;
    return (
      <SectorButton key={s.name} name={s.name} zoomed={zoomed} slim={phone}
        left={zoomed ? "50%" : `${s.f * 100}%`}
        onClick={() => zoomTo(zoomed ? null : i)} />
    );
  });

  // Absent prop (or an id missing from it) means visible — the studio works
  // standalone and future registry ids default on.
  const isVisible = (id) => !visibleTraces || visibleTraces[id] !== false;
  const visiblePanels = PANELS.filter((pn) => isVisible(pn.id));

  // Panels whose data may simply not exist on older laps (noDataKey): true when
  // neither lap carries the key, so the panel shows its hint instead of nothing.
  const noData = useMemo(() => {
    const out = {};
    for (const pn of PANELS) {
      if (!pn.noDataKey) continue;
      const has = (arr) => arr.some((s) => typeof s[pn.noDataKey] === "number");
      out[pn.id] = !has(compareSamples) && !has(referenceSamples);
    }
    return out;
  }, [compareSamples, referenceSamples]);

  // ── Hover inspection: while paused, moving the pointer across the trace stack
  // reads out both laps at that point instead of at the playback cursor. Ignored
  // while playing — the numbers must keep following the sweeping cursor there,
  // and the pointer is parked over the stack anyway (it's the play/pause target).
  //
  // Pointer, not mouse, events: on a phone this IS the screen's purpose, and a
  // finger produces no hover at all — it scrubs. Which means one gesture has to
  // serve two jobs, and the stack's tap target is the whole stack, so the two are
  // told apart by DISTANCE AND TIME below rather than by which handler fired. ──
  const hoverActive = hoverF != null && !playing;
  const fracAt = (clientX) => {
    const el = stackRef.current; if (!el) return null;
    const r = el.getBoundingClientRect();
    if (!r.width) return null;
    return clamp((clientX - r.left) / r.width, 0, 1);
  };
  const onStackMove = (e) => {
    const f = fracAt(e.clientX);
    if (f != null) setHoverF(f);
  };

  // A tap is a press that neither moved nor lingered; anything else was a scrub
  // and must NOT also toggle playback. 8px covers the wobble of a finger leaving
  // the glass, and 250ms is short enough that a deliberate hold reads as a scrub.
  const tapRef = useRef(null);
  const TAP_SLOP = 8, TAP_MS = 250;
  const onStackDown = (e) => {
    // The sector buttons and "Full lap" sit INSIDE the stack, and their onClick
    // stopPropagation can't stop a pointerup that has already bubbled — so the
    // press that hits one is never a candidate tap in the first place.
    if (e.target?.closest?.("button")) return;
    tapRef.current = { id: e.pointerId, x: e.clientX, y: e.clientY, t: Date.now() };
    // Place the read-out on the press, so a tap-and-hold reads out immediately
    // rather than waiting for a move a finger may never make.
    onStackMove(e);
  };
  const onStackUp = (e) => {
    const t = tapRef.current;
    tapRef.current = null;
    if (!t || t.id !== e.pointerId) return;
    const moved = Math.hypot(e.clientX - t.x, e.clientY - t.y);
    if (moved <= TAP_SLOP && Date.now() - t.t <= TAP_MS) setPlaying((pl) => !pl);
  };
  const onStackLeave = (e) => {
    // Only a mouse leaving means "done reading". A finger lifting is the moment
    // the driver looks at the number they just scrubbed to, so the chip stays;
    // the next press moves it.
    if (e.pointerType === "touch") return;
    tapRef.current = null;
    setHoverF(null);
  };

  // The position everything reads from: the mouse when hovering, else the cursor.
  const readF = hoverActive ? hoverF : cursor;
  const readDist = d0 + readF * (d1 - d0);
  const dS = useMemo(() => nearest(compareSamples, readDist), [compareSamples, readDist]);
  const rS = useMemo(() => nearest(referenceSamples, readDist), [referenceSamples, readDist]);

  // Dynamic channel scales — speed/ERS use the data's own max so the trace
  // fills the panel. Referenced from the registry via minKey/maxKey.
  const scales = useMemo(() => {
    let maxSpeed = 1;
    for (const s of compareSamples) if (typeof s.speed === "number") maxSpeed = Math.max(maxSpeed, s.speed);
    for (const s of referenceSamples) if (typeof s.speed === "number") maxSpeed = Math.max(maxSpeed, s.speed);
    maxSpeed = Math.max(60, Math.ceil(maxSpeed / 20) * 20);
    let maxErs = 1;
    for (const s of compareSamples) if (typeof s.ersSpent === "number") maxErs = Math.max(maxErs, s.ersSpent);
    for (const s of referenceSamples) if (typeof s.ersSpent === "number") maxErs = Math.max(maxErs, s.ersSpent);
    // Tyre temps: shared lo/hi over surface + carcass in both laps, padded to
    // the nearest 10 °C so the worms don't hug the panel edges.
    let tMin = Infinity, tMax = -Infinity;
    for (const arr of [compareSamples, referenceSamples]) {
      for (const s of arr) {
        for (const k of ["tyreSurf", "tyreCarc"]) {
          if (typeof s[k] === "number") { tMin = Math.min(tMin, s[k]); tMax = Math.max(tMax, s[k]); }
        }
      }
    }
    const tyreLo = Number.isFinite(tMin) ? Math.floor((tMin - 5) / 10) * 10 : 60;
    const tyreHi = Number.isFinite(tMax) ? Math.ceil((tMax + 5) / 10) * 10 : 120;
    // Δt: symmetric about zero so the midline IS "level with the reference",
    // rounded out to the next 0.1 s, never tighter than ±0.2 s.
    let dMax = 0;
    for (const s of compareSamples) if (typeof s.delta === "number" && Number.isFinite(s.delta)) dMax = Math.max(dMax, Math.abs(s.delta));
    const dHi = Math.max(0.2, Math.ceil(dMax * 10) / 10);
    return { maxSpeed, maxErs, tyreLo, tyreHi, deltaLo: -dHi, deltaHi: dHi };
  }, [compareSamples, referenceSamples]);

  // Paths recompute only when the data/scale/window changes — NOT on every
  // cursor move. Built for ALL panels regardless of visibility (10 m bins are
  // a few hundred samples; cheap, and it keeps the deps stable).
  const paths = useMemo(() => {
    const out = {};
    for (const pn of PANELS) {
      out[pn.id] = pn.channels.map((ch) => {
        const min = ch.min ?? (ch.minKey ? scales[ch.minKey] : 0);
        const max = typeof ch.max === "number" ? ch.max : scales[ch.maxKey];
        return {
          main: buildPath(compareSamples, ch.key, min, max, { step: ch.step, area: ch.area, d0, d1 }),
          ref: buildPath(referenceSamples, ch.key, min, max, { step: ch.step, d0, d1 }),
        };
      });
    }
    return out;
  }, [compareSamples, referenceSamples, d0, d1, scales]);

  // Corner ticks + corner-info card source: the real-world corner DB for this
  // track ("T1 – Abbey") when available, else the brake strategy zones derived
  // from the trace (the original behaviour, kept as a graceful fallback).
  const corners = useMemo(() => {
    if (Array.isArray(cornerDb) && cornerDb.length) {
      return cornerDb
        .map((c) => ({ f: clamp(c.f, 0, 1), name: cornerLabel(c), note: "" }))
        .sort((a, b) => a.f - b.f);
    }
    return (zones || []).filter((z) => z.type === "brake")
      .map((z) => ({ f: clamp((z.start + z.end) / 2, 0, 1), name: z.name, note: z.note }))
      .sort((a, b) => a.f - b.f);
  }, [cornerDb, zones]);
  // NB: corner fractions are LAP-fractions while `cursor` is a WINDOW-fraction,
  // so compare against the cursor's lap-fraction — else the corner card names
  // the wrong corner whenever a sector zoom is active.
  const readLapF = lapLength ? readDist / lapLength : cursor;
  const nearCorner = useMemo(() => {
    if (!corners.length) return null;
    return corners.reduce((b, c) => (Math.abs(c.f - readLapF) < Math.abs(b.f - readLapF) ? c : b), corners[0]);
  }, [corners, readLapF]);
  // The hover chip only claims a corner when the read position is actually in
  // one (~150 m) — the card above always names the nearest, which on a long
  // straight would label the chip with a corner hundreds of metres away.
  const atCorner = nearCorner && lapLength
    ? Math.abs(nearCorner.f - readLapF) * lapLength < 150 : false;

  // Lap-fraction → window-fraction, for overlays positioned in lap terms.
  const toWindowF = (f) => (f * lapLength - d0) / winSpan;

  const cursorPct = `${(cursor * 100).toFixed(2)}%`;

  const ctx = { units, uLabel, tempUnits, tLabel };

  if (!hasData) {
    return (
      <div style={{ flex: 1, minHeight: 0, ...cardStyle, display: "flex", alignItems: "center", justifyContent: "center",
        color: C.textFaintest, fontSize: 12, textAlign: "center", padding: 24, lineHeight: 1.6 }}>
        Pick a driven + reference lap above to see the trace overlay.
      </div>
    );
  }

  return (
    <div style={{ flex: 1, minHeight: 0, display: "flex", gap: 16, fontFamily: FONT.ui }}>

      {/* ── Left: stacked traces + scrubber ── */}
      <div style={{ flex: "1.62 1 460px", minWidth: 0, ...cardStyle, padding: phone ? "6px 10px 10px" : "14px 18px", display: "flex", flexDirection: "column" }}>
        {/* Trace chips — pick which panels this session shows. Outside the
            play/pause stack so a toggle never doubles as a play click. */}
        {/* All six sit on ONE line on a phone — they are a row of related switches
            and wrapping them into three ~44px-tall lines (the coarse-pointer tap
            floor) costs more height than the trace panels they govern. Everything
            horizontal shrinks: text, dot, gaps — and the pill itself is dropped,
            since the outline is the widest part of a chip and the dot already
            carries both the channel's colour and its on/off state. */}
        <div style={{ flex: "none", display: "flex", alignItems: "center", gap: phone ? 3 : 6,
          flexWrap: "wrap", marginBottom: phone ? 3 : 8 }}>
          {/* The six live in their own row box so "Full lap" can still wrap below
              them on a phone without breaking the chips' single line. */}
          <div style={{ display: "flex", alignItems: "center", gap: phone ? 4 : 6,
            ...(phone && { justifyContent: "space-between" }),
            flexWrap: phone ? "nowrap" : "wrap", flex: "1 1 auto", minWidth: 0 }}>
          {PANELS.map((pn) => {
            const on = isVisible(pn.id);
            return (
              <button key={pn.id} onClick={() => onToggleTrace?.(pn.id)}
                title={`${on ? "Hide" : "Show"} ${pn.chip.label}`}
                style={{ display: "flex", alignItems: "center", justifyContent: "center",
                  gap: phone ? 3 : 5, padding: phone ? 0 : "3px 9px", borderRadius: 999,
                  ...(phone
                    // height + minHeight override index.html's 44px coarse-pointer
                    // tap floor: with no pill around it the chip is a line of text,
                    // and 44px of it is a third of a trace panel's worth of screen.
                    ? { flex: "0 1 auto", minWidth: 0, background: "none", border: "none", minHeight: 0, height: 20 }
                    : { background: C.inset, border: `1px solid ${on ? pn.chip.color + "55" : C.line}` }),
                  cursor: onToggleTrace ? "pointer" : "default", fontFamily: FONT.ui,
                  fontSize: 9, fontWeight: 700, whiteSpace: "nowrap",
                  letterSpacing: phone ? 0.4 : 1, textTransform: "uppercase", color: on ? C.textBody : C.textDim, opacity: on ? 1 : 0.45 }}>
                <span style={{ width: phone ? 6 : 7, height: phone ? 6 : 7, borderRadius: "50%", flex: "none",
                  background: on ? pn.chip.color : "#5a6478" }} />
                {pn.chip.label}
              </button>
            );
          })}
          </div>
          {zoomSector != null && !phone && (
            <button onClick={() => zoomTo(null)} title="Zoom back out to the whole lap"
              style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 5, padding: "3px 9px", borderRadius: 999,
                background: C.blue, border: `1px solid ${C.blue}`, cursor: "pointer", fontFamily: FONT.ui, fontSize: 9,
                fontWeight: 800, letterSpacing: 1, textTransform: "uppercase", color: "#fff" }}>
              Full lap
            </button>
          )}
        </div>
        {/* S1/S2/S3 zoom buttons. On a phone they get their own 18px strip ABOVE
            the stack: a panel is only ~60px tall there, so a button parked on top
            of the first one hides most of a trace. Still absolutely positioned by
            the same sector fraction, and the strip is exactly as wide as the stack
            below it, so each one still points at its sector. */}
        {phone && (
          <div style={{ flex: "none", position: "relative", height: 18, marginBottom: 2 }}>
            {sectorButtons}
            {/* Zoomed out shares the strip rather than adding a row of its own —
                on the chip line above it wrapped, and a whole 44px tap-height row
                to leave a zoom costs more than the zoom shows. */}
            {zoomSector != null && (
              <button onClick={() => zoomTo(null)} title="Zoom back out to the whole lap"
                style={{ position: "absolute", top: 0, right: 0, height: 18, minHeight: 0, padding: "0 8px",
                  borderRadius: 5, background: C.blue, border: `1px solid ${C.blue}`, cursor: "pointer",
                  fontFamily: FONT.ui, fontSize: 9, fontWeight: 800, letterSpacing: 0.6,
                  textTransform: "uppercase", color: "#fff", whiteSpace: "nowrap" }}>
                Full lap
              </button>
            )}
          </div>
        )}
        {/* Trace stack — tap/click to play/pause, drag or hover to inspect.
            `touch-action: pan-y` is the deliberate half-measure: a HORIZONTAL
            drag is ours to scrub with, while a vertical one still scrolls the
            page under it. `none` would have trapped the whole Analytics screen
            behind a panel that fills most of a phone. */}
        <div ref={stackRef}
          onPointerDown={onStackDown} onPointerMove={onStackMove}
          onPointerUp={onStackUp} onPointerCancel={() => { tapRef.current = null; }}
          onPointerLeave={onStackLeave}
          role="button" tabIndex={0} aria-label={playing ? "Pause playback" : "Play playback"}
          onKeyDown={(e) => {
            if (e.target !== e.currentTarget) return;   // a sector button inside handles its own keys
            if (e.key === " " || e.key === "Enter") { e.preventDefault(); setPlaying((pl) => !pl); }
          }}
          title="Click to play / pause · hover to read both laps"
          style={{ flex: 1, minHeight: 0, position: "relative", display: "flex", flexDirection: "column", gap: 6,
            cursor: "pointer", touchAction: "pan-y" }}>

          {/* Sector boundary lines + labels + the white playback cursor.
              Boundaries live in lap-fractions → remap into the zoom window;
              when zoomed to one sector both sit on the edges and drop out. */}
          {boundaries.map((f, i) => {
            const wf = toWindowF(f);
            if (!(wf > 0.001 && wf < 0.999)) return null;
            return (
              <div key={`b-${i}`} style={{ position: "absolute", top: 0, bottom: 0, left: `${wf * 100}%`, width: 0, borderLeft: "1px dashed #4a5470", zIndex: 3, pointerEvents: "none" }} />
            );
          })}
          {!phone && sectorButtons}
          <div style={{ position: "absolute", top: 0, bottom: 0, left: cursorPct, width: 1, background: "#ffffff55", zIndex: 4, pointerEvents: "none" }} />

          {/* Hover guide + its position chip — cyan so it never reads as the
              white playback cursor. The chip flips its anchor near the edges
              so it stays inside the stack. */}
          {hoverActive && (
            <>
              <div style={{ position: "absolute", top: 0, bottom: 0, left: `${hoverF * 100}%`, width: 0,
                borderLeft: `1px dashed ${C.cyan}`, zIndex: 5, pointerEvents: "none" }} />
              <div style={{ position: "absolute", bottom: 4, left: `${hoverF * 100}%`, zIndex: 6, pointerEvents: "none",
                transform: `translateX(${hoverF < 0.07 ? 0 : hoverF > 0.93 ? -100 : -50}%)`,
                background: "#0f1420ee", border: `1px solid ${C.cyan}55`, borderRadius: 6, padding: "3px 7px",
                fontFamily: FONT.mono, fontSize: 9, fontWeight: 700, color: C.cyan, whiteSpace: "nowrap" }}>
                {atCorner ? `${nearCorner.name} · ` : ""}{Math.round(readDist)} m
              </div>
            </>
          )}

          {visiblePanels.map((pn) => (
            <TracePanel key={pn.id} panel={pn} chPaths={paths[pn.id]} dS={dS} rS={rS} hasRef={hasRef}
              ctx={ctx} noData={!!noData[pn.id]} />
          ))}
        </div>
      </div>
    </div>
  );
}
