// ─── TELEMETRY STUDIO (Analytics ▸ Telemetry tab) ───────────────────────────
// The MoTeC-style trace studio from the cockpit design: stacked channel panels
// (Throttle/Brake, Speed, Wheel Rotation, Gear, ERS Mode/Used, Tyre Temps)
// overlaid with sector boundary lines + a white playback cursor, and a right
// column of live-vs-reference readout cards + a corner-info card. Playback
// comes in two flavours:
//   • Controlled (the combined Analytics Overview): `playhead` (0–1 lap-distance
//     fraction) + `playing` props with onSeek/onSetPlaying callbacks. The clock
//     itself lives in DrivingLinesView, so the trace cursor, the readouts and
//     the cars on the driving lines all move on ONE shared timeline — and the
//     scrubber under that map is the only one, so this component hides its own.
//   • Standalone: owns its own `cursor` (0–1) and `playing` state, swept by an
//     internal rAF loop, plus its own bottom scrubber (corner ticks + knob).
//
// Panels are driven by the PANELS registry below — visibility filtering,
// rendering, chip toggles and the readout cards all derive from it, so adding
// a channel is one new entry.
//
// Pure presentation: the driven/reference sample arrays, lap length, sector
// distances and strategy zones are supplied by BoxBoxApp's existing engine.

import { useState, useRef, useEffect, useMemo } from "react";
import { C, FONT } from "../lib/ui/tokens.js";
import { toSpeed, speedUnitLabel, toTemp, tempUnitLabel, clamp } from "../lib/format.js";
import { ERS_MODES } from "../lib/coach/config.js";
import { cornerLabel } from "../lib/cornerData.js";

const W = 1000, VH = 100;          // SVG coordinate system (stretched per panel)
const SWEEP_SECONDS = 8;           // time for Play to sweep a full lap

// Nearest sample to a lap distance (samples are sorted by dist).
function nearest(samples, dist) {
  if (!samples || !samples.length) return null;
  return samples.reduce((b, s) => Math.abs((s.dist || 0) - dist) < Math.abs((b.dist || 0) - dist) ? s : b, samples[0]);
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

const cardStyle = { background: C.surface, border: `1px solid ${C.line}`, borderRadius: 12 };
const panelStyle = { minHeight: 0, position: "relative", background: C.inset, border: `1px solid ${C.line}`, borderRadius: 9, overflow: "hidden" };
const svgStyle = { position: "absolute", inset: 0, width: "100%", height: "100%" };
const labelStyle = (color) => ({ position: "absolute", top: 7, left: 10, fontSize: 9, letterSpacing: 1, color, textTransform: "uppercase", zIndex: 2 });
const valStyle = (color, size = 12) => ({ fontFamily: FONT.mono, fontSize: size, fontWeight: 800, color });

// ─── Panel registry ──────────────────────────────────────────────────────────
// One entry per stacked trace panel. `channels` drive both path building and
// SVG paint (draw order per panel: all areas → all ref lines → all main lines,
// in channel order). `max`/`min` are literals, or `maxKey`/`minKey` name a
// dynamic value in the `scales` memo. `header` renders the top-right live
// values; `readouts` build the right-column cards. `ctx` = { units, uLabel }.
const PANELS = [
  {
    id: "inputs", flex: 1.35, chip: { label: "Thr/Brk", color: "#ffffff" },
    labelColor: C.textMuted,
    labelContent: () => (<>Throttle <span style={{ color: C.textBody2 }}>/</span> Brake</>),
    channels: [
      { key: "throttle", min: 0, max: 100, area: true, areaFill: "#ffffff12", stroke: "#ffffff", width: 2, join: true, refStroke: "#ffffff", refOpacity: 0.5 },
      { key: "brake", min: 0, max: 100, area: true, areaFill: "#ff4d5e14", stroke: C.red, width: 2, join: true, refStroke: C.red, refOpacity: 0.5 },
    ],
    header: (dS) => [
      <span key="t" style={valStyle("#fff")}>{r0(dS?.throttle)}%</span>,
      <span key="b" style={valStyle(C.red)}>{r0(dS?.brake)}%</span>,
    ],
    readouts: [
      (dS, rS) => ({ label: "Throttle", value: r0(dS?.throttle), unit: "%", color: "#fff", ref: r0(rS?.throttle) + "%" }),
      (dS, rS) => ({ label: "Brake", value: r0(dS?.brake), unit: "%", color: C.red, ref: r0(rS?.brake) + "%" }),
    ],
  },
  {
    id: "speed", flex: 1.5, chip: { label: "Speed", color: C.teal },
    labelColor: C.teal,
    labelContent: (ctx) => <>Speed · {ctx.uLabel}</>,
    channels: [
      { key: "speed", min: 0, maxKey: "maxSpeed", area: true, areaFill: "#2dd4bf14", stroke: C.teal, width: 2.2, join: true, refStroke: C.textDim },
    ],
    header: (dS, ctx) => [<span key="s" style={valStyle(C.teal, 14)}>{toSpeed(dS?.speed, ctx.units)}</span>],
    readouts: [
      (dS, rS, ctx) => ({ label: "Speed", value: toSpeed(dS?.speed, ctx.units), unit: ctx.uLabel, color: C.teal, ref: toSpeed(rS?.speed, ctx.units) + " " + ctx.uLabel }),
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
    header: (dS) => [
      <span key="w" style={valStyle(C.green)}>{steerMag(dS?.steer)} <span style={{ color: C.textDim }}>{steerDir(dS?.steer)}</span></span>,
    ],
    readouts: [
      (dS, rS) => ({ label: "Wheel Rotation", value: steerMag(dS?.steer), unit: steerDir(dS?.steer), color: C.green, ref: steerMag(rS?.steer) + steerDir(rS?.steer) }),
    ],
  },
  {
    id: "gear", flex: 1, chip: { label: "Gear", color: C.purple },
    labelColor: C.purple,
    labelContent: () => "Gear",
    channels: [
      { key: "gear", min: 0, max: 8, step: true, stroke: C.purple, width: 2, refStroke: C.purple, refOpacity: 0.5 },
    ],
    header: (dS) => [<span key="g" style={valStyle(C.purple, 13)}>{dS?.gear ?? "—"}</span>],
    readouts: [
      (dS, rS) => ({ label: "Gear", value: dS?.gear ?? "—", unit: "", color: C.purple, ref: rS?.gear ?? "—" }),
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
    header: (dS) => [
      <span key="m" style={valStyle(C.red)}>{dS ? ersName(dS.ersMode) : "—"}</span>,
      <span key="u" style={valStyle(C.ersYellow)}>{r0(dS?.ersSpent)}</span>,
    ],
    readouts: [
      (dS, rS) => ({ label: "ERS Mode", value: dS ? ersName(dS.ersMode) : "—", unit: "", color: C.red, ref: rS ? ersName(rS.ersMode) : "—" }),
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
    header: (dS, ctx) => [
      <span key="s" style={valStyle(C.orange)}>{r0(toTemp(dS?.tyreSurf, ctx.tempUnits))}°</span>,
      <span key="c" style={valStyle(C.cyan)}>{r0(toTemp(dS?.tyreCarc, ctx.tempUnits))}°</span>,
    ],
    readouts: [
      (dS, rS, ctx) => ({ label: "Tyre Temps", value: `${r0(toTemp(dS?.tyreSurf, ctx.tempUnits))}/${r0(toTemp(dS?.tyreCarc, ctx.tempUnits))}`, unit: ctx.tLabel, color: C.orange,
        ref: `${r0(toTemp(rS?.tyreSurf, ctx.tempUnits))}/${r0(toTemp(rS?.tyreCarc, ctx.tempUnits))}` }),
    ],
  },
];

// One stacked trace panel: label, top-right live values, and the channel SVG.
function TracePanel({ panel, chPaths, dS, ctx, noData }) {
  return (
    <div style={{ ...panelStyle, flex: panel.flex }}>
      <span style={labelStyle(panel.labelColor)}>{panel.labelContent(ctx)}</span>
      <div style={{ position: "absolute", top: 6, right: 10, display: "flex", gap: 10, zIndex: 2 }}>
        {panel.header(dS, ctx)}
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
function SectorButton({ name, left, zoomed, onClick }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title={zoomed ? "Back to full lap" : `Zoom to ${name}`}
      style={{
        position: "absolute", top: 6, left, transform: "translateX(-50%)", zIndex: 5,
        cursor: "pointer", appearance: "none", outline: "none",
        fontFamily: FONT.mono, fontSize: 13, fontWeight: 800, letterSpacing: 1, lineHeight: 1,
        color: zoomed ? "#fff" : hover ? C.textHi : C.textBody,
        background: zoomed
          ? "linear-gradient(180deg, #4885e0 0%, #3671C6 100%)"
          : hover
            ? "linear-gradient(180deg, #232c3e 0%, #1a2130 100%)"
            : "linear-gradient(180deg, #1a2130 0%, #141922 100%)",
        border: `1px solid ${zoomed ? C.blue : hover ? "#3d4864" : C.borderStrong}`,
        padding: "7px 15px", borderRadius: 7,
        boxShadow: zoomed
          ? "0 2px 8px rgba(54,113,198,.5), inset 0 1px 0 rgba(255,255,255,.25)"
          : "0 2px 5px rgba(0,0,0,.5), inset 0 1px 0 rgba(255,255,255,.06)",
        transition: "background .12s, border-color .12s, box-shadow .12s, color .12s",
      }}>{name}</button>
  );
}

export default function TelemetryStudio({
  compareSamples = [], referenceSamples = [], lapLength = 0,
  zones = [], sectorDists = [], units = "km/h", tempUnits = "°C", corners: cornerDb = [],
  visibleTraces = null, onToggleTrace = null,
  // Compact mode drops the right-hand readout column so the trace stack can sit
  // beside another view (the combined Analytics overview) without overflowing.
  compact = false,
  // Shared-timeline (controlled) mode — see the header comment.
  playhead = null, playing: playingProp = null, onSeek = null, onSetPlaying = null,
}) {
  const [cursorInt, setCursorInt] = useState(0.5);    // 0–1 across the visible window
  const [playingInt, setPlayingInt] = useState(false);
  const [zoomSector, setZoomSector] = useState(null); // null = full lap | 0 | 1 | 2
  const barRef = useRef(null);
  const rafRef = useRef(0);

  const controlled = typeof playhead === "number" && typeof onSeek === "function";
  const playing = controlled ? !!playingProp : playingInt;
  const setPlaying = (v) => {
    const next = typeof v === "function" ? v(playing) : v;
    if (controlled) onSetPlaying?.(next); else setPlayingInt(next);
  };

  const hasData = compareSamples.length > 1 || referenceSamples.length > 1;
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

  // The cursor as a window fraction. Controlled mode derives it from the shared
  // lap-fraction playhead (clamped to the zoom window); standalone owns it.
  const cursor = controlled
    ? (lapLength ? clamp((clamp(playhead, 0, 1) * lapLength - d0) / winSpan, 0, 1) : clamp(playhead, 0, 1))
    : cursorInt;

  // Zoom in/out, keeping the cursor at the same absolute lap distance (clamped
  // to the new window) and pausing so playback can't jump mid-frame. In
  // controlled mode the cursor re-derives from the playhead, which never moves
  // on zoom — only the window does.
  const zoomTo = (next) => {
    setPlaying(false);
    if (!controlled) {
      const oldDist = d0 + cursor * (d1 - d0);
      const [n0, n1] = domainFor(next);
      setCursorInt(n1 > n0 ? clamp((oldDist - n0) / (n1 - n0), 0, 1) : 0.5);
    }
    setZoomSector(next);
  };

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

  // ── Playback loop: advance the cursor while playing, looping at the line.
  // Sweep time scales with the window so playback speed (m/s) stays constant
  // whether viewing the full lap or one zoomed sector. Standalone only — in
  // controlled mode the shared clock (DrivingLinesView) advances the playhead. ──
  useEffect(() => {
    if (!playing || controlled) return;
    const sweep = Math.max(2.5, SWEEP_SECONDS * ((d1 - d0) / (lapLength || 1)));
    let last = performance.now();
    const tick = (now) => {
      const dt = (now - last) / 1000; last = now;
      setCursorInt((c) => { let n = c + dt / sweep; if (n >= 1) n = 0; return n; });
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [playing, controlled, d0, d1, lapLength]);

  // ── Scrubbing: pointer down on the bar seeks + starts a drag (pauses play). ──
  const scrubFrom = (clientX) => {
    const el = barRef.current; if (!el) return;
    const r = el.getBoundingClientRect();
    const wf = clamp((clientX - r.left) / r.width, 0, 1);
    // Controlled: window fraction → shared lap fraction, so the driving-line
    // cars follow the trace scrubber too.
    if (controlled) onSeek(lapLength ? (d0 + wf * winSpan) / lapLength : wf);
    else setCursorInt(wf);
  };
  const startScrub = (e) => {
    e.stopPropagation();
    setPlaying(false);
    scrubFrom(e.clientX);
    const move = (ev) => scrubFrom(ev.clientX);
    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const cursorDist = d0 + cursor * (d1 - d0);
  const dS = useMemo(() => nearest(compareSamples, cursorDist), [compareSamples, cursorDist]);
  const rS = useMemo(() => nearest(referenceSamples, cursorDist), [referenceSamples, cursorDist]);

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
    return { maxSpeed, maxErs, tyreLo, tyreHi };
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
  const cursorLapF = lapLength ? cursorDist / lapLength : cursor;
  const nearCorner = useMemo(() => {
    if (!corners.length) return null;
    return corners.reduce((b, c) => (Math.abs(c.f - cursorLapF) < Math.abs(b.f - cursorLapF) ? c : b), corners[0]);
  }, [corners, cursorLapF]);

  // Lap-fraction → window-fraction, for overlays positioned in lap terms.
  const toWindowF = (f) => (f * lapLength - d0) / winSpan;

  const cursorPct = `${(cursor * 100).toFixed(2)}%`;

  const ctx = { units, uLabel, tempUnits, tLabel };
  const readouts = visiblePanels.flatMap((pn) => pn.readouts.map((build) => build(dS, rS, ctx)));

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
      <div style={{ flex: "1.62 1 460px", minWidth: 0, ...cardStyle, padding: "14px 18px", display: "flex", flexDirection: "column" }}>
        {/* Trace chips — pick which panels this session shows. Outside the
            play/pause stack so a toggle never doubles as a play click. */}
        <div style={{ flex: "none", display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", marginBottom: 8 }}>
          {PANELS.map((pn) => {
            const on = isVisible(pn.id);
            return (
              <button key={pn.id} onClick={() => onToggleTrace?.(pn.id)}
                title={`${on ? "Hide" : "Show"} ${pn.chip.label}`}
                style={{ display: "flex", alignItems: "center", gap: 5, padding: "3px 9px", borderRadius: 999,
                  background: C.inset, border: `1px solid ${on ? pn.chip.color + "55" : C.line}`,
                  cursor: onToggleTrace ? "pointer" : "default", fontFamily: FONT.ui, fontSize: 9, fontWeight: 700,
                  letterSpacing: 1, textTransform: "uppercase", color: on ? C.textBody : C.textDim, opacity: on ? 1 : 0.45 }}>
                <span style={{ width: 7, height: 7, borderRadius: "50%", flex: "none", background: on ? pn.chip.color : "#5a6478" }} />
                {pn.chip.label}
              </button>
            );
          })}
          {zoomSector != null && (
            <button onClick={() => zoomTo(null)} title="Zoom back out to the whole lap"
              style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 5, padding: "3px 9px", borderRadius: 999,
                background: C.blue, border: `1px solid ${C.blue}`, cursor: "pointer", fontFamily: FONT.ui, fontSize: 9,
                fontWeight: 800, letterSpacing: 1, textTransform: "uppercase", color: "#fff" }}>
              Full lap
            </button>
          )}
        </div>
        {/* Trace stack — click anywhere to play/pause */}
        <div onClick={() => setPlaying((pl) => !pl)} title="Click to play / pause"
          style={{ flex: 1, minHeight: 0, position: "relative", display: "flex", flexDirection: "column", gap: 6, cursor: "pointer" }}>

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
          {/* S1/S2/S3 labels double as the zoom control: click to deep-dive that
              sector, click the (highlighted, centered) active one to zoom out.
              stopPropagation — they sit inside the play/pause click target. */}
          {sectorLabels.map((s, i) => {
            if (zoomSector != null && zoomSector !== i) return null;
            const zoomed = zoomSector === i;
            return (
              <SectorButton key={s.name} name={s.name} zoomed={zoomed}
                left={zoomed ? "50%" : `${s.f * 100}%`}
                onClick={() => zoomTo(zoomed ? null : i)} />
            );
          })}
          <div style={{ position: "absolute", top: 0, bottom: 0, left: cursorPct, width: 1, background: "#ffffff55", zIndex: 4, pointerEvents: "none" }} />

          {visiblePanels.map((pn) => (
            <TracePanel key={pn.id} panel={pn} chPaths={paths[pn.id]} dS={dS} ctx={ctx} noData={!!noData[pn.id]} />
          ))}
        </div>

        {/* Scrubber — standalone only. In controlled mode the shared timeline
            under the driving-lines map is the single scrubber for both views;
            a second one here would just be a duplicate of it. */}
        {!controlled && <div style={{ flex: "none", height: 44, marginTop: 10, display: "flex", alignItems: "center", gap: 16 }}>
          <div ref={barRef} onPointerDown={startScrub} style={{ flex: 1, position: "relative", height: 32, display: "flex", alignItems: "center", cursor: "pointer" }}>
            <div style={{ position: "absolute", left: 0, right: 0, height: 6, borderRadius: 3, background: C.line }} />
            <div style={{ position: "absolute", left: 0, height: 6, borderRadius: 3, background: C.blue, width: cursorPct }} />
            {corners.map((c, i) => {
              const wf = toWindowF(c.f); // lap-fraction tick → zoom window
              if (wf < 0 || wf > 1) return null;
              return (
                <div key={i} style={{ position: "absolute", left: `${wf * 100}%`, top: "50%", transform: "translate(-50%,-50%)", display: "flex", flexDirection: "column", alignItems: "center", gap: 3 }}>
                  <div style={{ width: 2, height: 13, background: "#39435a" }} />
                  <span style={{ fontSize: 8, color: C.textFaint, whiteSpace: "nowrap" }}>{c.name}</span>
                </div>
              );
            })}
            <div style={{ position: "absolute", left: cursorPct, top: "50%", transform: "translate(-50%,-50%)", width: 16, height: 16, borderRadius: "50%",
              background: C.blue, border: `3px solid ${C.bg}`, boxShadow: `0 0 0 1px ${C.blue},0 0 12px ${C.blue}` }} />
          </div>
        </div>}
      </div>

      {/* ── Right: live-vs-reference readouts + corner info ── */}
      {!compact && <div style={{ width: 300, flex: "none", display: "flex", flexDirection: "column", gap: 12 }}>
        {readouts.map((k) => (
          <div key={k.label} style={{ flex: 1, maxHeight: 110, ...cardStyle, padding: "9px 16px", display: "flex", flexDirection: "column", justifyContent: "center" }}>
            <div style={{ fontSize: 9, letterSpacing: 2, color: C.textDim, textTransform: "uppercase" }}>{k.label}</div>
            <div style={{ display: "flex", alignItems: "baseline", gap: 11, marginTop: 5, flexWrap: "wrap" }}>
              <span style={{ fontFamily: FONT.mono, fontWeight: 800, fontSize: 30, lineHeight: 1, color: k.color }}>
                {k.value}{k.unit ? <span style={{ fontSize: 12, color: C.textFaint, marginLeft: 4 }}>{k.unit}</span> : null}
              </span>
              <span style={{ fontFamily: FONT.mono, fontWeight: 700, fontSize: 17, lineHeight: 1, color: C.textFaint, whiteSpace: "nowrap" }}>
                <span style={{ fontSize: 8, letterSpacing: 1, marginRight: 4 }}>REF</span>{k.ref}
              </span>
            </div>
          </div>
        ))}
        <div style={{ flex: 1, maxHeight: 110, background: "#0f1420", border: "1px solid #2a3550", borderRadius: 12, padding: "9px 16px", display: "flex", flexDirection: "column", justifyContent: "center" }}>
          <div style={{ fontSize: 9, letterSpacing: 2, color: C.textDim, textTransform: "uppercase" }}>Corner</div>
          <div style={{ display: "flex", alignItems: "baseline", gap: 11, marginTop: 5 }}>
            <span style={{ fontFamily: FONT.mono, fontWeight: 800, fontSize: 18, lineHeight: 1, color: C.cyan }}>{nearCorner?.name || "—"}</span>
            <span style={{ fontWeight: 700, fontSize: 16, lineHeight: 1.2, color: C.textBody2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{nearCorner?.note || ""}</span>
          </div>
        </div>
      </div>}
    </div>
  );
}
