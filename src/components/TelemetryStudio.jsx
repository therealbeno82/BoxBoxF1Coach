// ─── TELEMETRY STUDIO (Analytics ▸ Telemetry tab) ───────────────────────────
// The MoTeC-style trace studio from the cockpit design: five stacked channel
// panels (Throttle/Brake, Speed, Wheel Rotation, Gear, ERS Mode/Used) overlaid
// with sector boundary lines + a white playback cursor, a bottom scrubber with
// corner tick marks and a draggable knob, and a right column of live-vs-reference
// readout cards + a corner-info card. Owns its own playback `cursor` (0–1) and
// `playing` state so every panel value, readout and the cursor line move together
// when the scrubber is dragged or Play (click any trace) is toggled.
//
// Pure presentation: the driven/reference sample arrays, lap length, sector
// distances and strategy zones are supplied by F1CoachApp's existing engine.

import { useState, useRef, useEffect, useMemo } from "react";
import { C, FONT } from "../lib/ui/tokens.js";
import { toSpeed, speedUnitLabel } from "../lib/format.js";
import { ERS_MODES } from "../lib/coach/config.js";
import { cornerLabel } from "../lib/cornerData.js";

const W = 1000, VH = 100;          // SVG coordinate system (stretched per panel)
const SWEEP_SECONDS = 8;           // time for Play to sweep a full lap
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// Nearest sample to a lap distance (samples are sorted by dist).
function nearest(samples, dist) {
  if (!samples || !samples.length) return null;
  return samples.reduce((b, s) => Math.abs((s.dist || 0) - dist) < Math.abs((b.dist || 0) - dist) ? s : b, samples[0]);
}

// Build a channel's line path (optionally stepped for gear/ERS-mode) plus an
// optional filled area down to the panel baseline. Values normalise to [min,max].
function buildPath(samples, key, min, max, { step = false, area = false, lapLength } = {}) {
  if (!samples || samples.length < 2 || !lapLength) return { line: "", area: "" };
  const pts = [];
  for (const s of samples) {
    const v = s[key];
    if (typeof v !== "number" || Number.isNaN(v)) continue;
    const x = clamp((s.dist || 0) / lapLength, 0, 1) * W;
    const y = VH - clamp((v - min) / (max - min), 0, 1) * VH;
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

export default function TelemetryStudio({
  compareSamples = [], referenceSamples = [], lapLength = 0,
  zones = [], sectorDists = [], units = "km/h", corners: cornerDb = [],
}) {
  const [cursor, setCursor] = useState(0.5);
  const [playing, setPlaying] = useState(false);
  const barRef = useRef(null);
  const rafRef = useRef(0);

  const hasData = compareSamples.length > 1 || referenceSamples.length > 1;
  const uLabel = speedUnitLabel(units);

  // ── Playback loop: advance the cursor while playing, looping at the line. ──
  useEffect(() => {
    if (!playing) return;
    let last = performance.now();
    const tick = (now) => {
      const dt = (now - last) / 1000; last = now;
      setCursor((c) => { let n = c + dt / SWEEP_SECONDS; if (n >= 1) n = 0; return n; });
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [playing]);

  // ── Scrubbing: pointer down on the bar seeks + starts a drag (pauses play). ──
  const scrubFrom = (clientX) => {
    const el = barRef.current; if (!el) return;
    const r = el.getBoundingClientRect();
    setCursor(clamp((clientX - r.left) / r.width, 0, 1));
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

  const cursorDist = cursor * lapLength;
  const dS = useMemo(() => nearest(compareSamples, cursorDist), [compareSamples, cursorDist]);
  const rS = useMemo(() => nearest(referenceSamples, cursorDist), [referenceSamples, cursorDist]);

  // Channel scales — speed/ERS use the data's own max so the trace fills the panel.
  const maxSpeed = useMemo(() => {
    let m = 1;
    for (const s of compareSamples) if (typeof s.speed === "number") m = Math.max(m, s.speed);
    for (const s of referenceSamples) if (typeof s.speed === "number") m = Math.max(m, s.speed);
    return Math.max(60, Math.ceil(m / 20) * 20);
  }, [compareSamples, referenceSamples]);
  const maxErs = useMemo(() => {
    let m = 1;
    for (const s of compareSamples) if (typeof s.ersSpent === "number") m = Math.max(m, s.ersSpent);
    return m;
  }, [compareSamples]);

  // Paths recompute only when the data/scale changes — NOT on every cursor move.
  const p = useMemo(() => ({
    thr: buildPath(compareSamples, "throttle", 0, 100, { area: true, lapLength }),
    thrRef: buildPath(referenceSamples, "throttle", 0, 100, { lapLength }),
    brk: buildPath(compareSamples, "brake", 0, 100, { area: true, lapLength }),
    brkRef: buildPath(referenceSamples, "brake", 0, 100, { lapLength }),
    speed: buildPath(compareSamples, "speed", 0, maxSpeed, { area: true, lapLength }),
    speedRef: buildPath(referenceSamples, "speed", 0, maxSpeed, { lapLength }),
    steer: buildPath(compareSamples, "steer", -100, 100, { lapLength }),
    steerRef: buildPath(referenceSamples, "steer", -100, 100, { lapLength }),
    gear: buildPath(compareSamples, "gear", 0, 8, { step: true, lapLength }),
    gearRef: buildPath(referenceSamples, "gear", 0, 8, { step: true, lapLength }),
    ersMode: buildPath(compareSamples, "ersMode", 0, 3, { step: true, lapLength }),
    ersModeRef: buildPath(referenceSamples, "ersMode", 0, 3, { step: true, lapLength }),
    ersUsed: buildPath(compareSamples, "ersSpent", 0, maxErs, { area: true, lapLength }),
    ersUsedRef: buildPath(referenceSamples, "ersSpent", 0, maxErs, { lapLength }),
  }), [compareSamples, referenceSamples, lapLength, maxSpeed, maxErs]);

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
  const nearCorner = useMemo(() => {
    if (!corners.length) return null;
    return corners.reduce((b, c) => (Math.abs(c.f - cursor) < Math.abs(b.f - cursor) ? c : b), corners[0]);
  }, [corners, cursor]);

  // Sector boundary lines (2) + S1/S2/S3 label positions. Use the reference lap's
  // sector distances when present, else even thirds of the lap.
  const { boundaries, sectorLabels } = useMemo(() => {
    let b = [];
    if (Array.isArray(sectorDists) && sectorDists.length && lapLength) {
      b = sectorDists.map((d) => clamp(d / lapLength, 0, 1)).filter((f) => f > 0.001 && f < 0.999).sort((x, y) => x - y).slice(0, 2);
    }
    if (b.length < 2) b = [1 / 3, 2 / 3];
    const mids = [b[0] / 2, (b[0] + b[1]) / 2, (b[1] + 1) / 2];
    return { boundaries: b, sectorLabels: ["S1", "S2", "S3"].map((name, i) => ({ name, f: mids[i] })) };
  }, [sectorDists, lapLength]);

  const cursorPct = `${(cursor * 100).toFixed(2)}%`;

  const readouts = [
    { label: "Throttle", value: r0(dS?.throttle), unit: "%", color: "#fff", ref: r0(rS?.throttle) + "%" },
    { label: "Brake", value: r0(dS?.brake), unit: "%", color: C.red, ref: r0(rS?.brake) + "%" },
    { label: "Speed", value: toSpeed(dS?.speed, units), unit: uLabel, color: C.teal, ref: toSpeed(rS?.speed, units) + " " + uLabel },
    { label: "Wheel Rotation", value: steerMag(dS?.steer), unit: steerDir(dS?.steer), color: C.green, ref: steerMag(rS?.steer) + steerDir(rS?.steer) },
    { label: "Gear", value: dS?.gear ?? "—", unit: "", color: C.purple, ref: rS?.gear ?? "—" },
    { label: "ERS Mode", value: dS ? ersName(dS.ersMode) : "—", unit: "", color: C.red, ref: rS ? ersName(rS.ersMode) : "—" },
  ];

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
        {/* Trace stack — click anywhere to play/pause */}
        <div onClick={() => setPlaying((pl) => !pl)} title="Click to play / pause"
          style={{ flex: 1, minHeight: 0, position: "relative", display: "flex", flexDirection: "column", gap: 6, cursor: "pointer" }}>

          {/* Sector boundary lines + labels + the white playback cursor */}
          {boundaries.map((f, i) => (
            <div key={`b-${i}`} style={{ position: "absolute", top: 0, bottom: 0, left: `${f * 100}%`, width: 0, borderLeft: "1px dashed #4a5470", zIndex: 3, pointerEvents: "none" }} />
          ))}
          {sectorLabels.map((s) => (
            <div key={s.name} style={{ position: "absolute", top: 3, left: `${s.f * 100}%`, transform: "translateX(-50%)", zIndex: 3, pointerEvents: "none",
              fontFamily: FONT.mono, fontSize: 9, fontWeight: 800, letterSpacing: 1, color: C.textDim, background: "rgba(11,14,20,.65)", padding: "1px 6px", borderRadius: 4 }}>{s.name}</div>
          ))}
          <div style={{ position: "absolute", top: 0, bottom: 0, left: cursorPct, width: 1, background: "#ffffff55", zIndex: 4, pointerEvents: "none" }} />

          {/* Throttle + Brake */}
          <div style={{ ...panelStyle, flex: 1.35 }}>
            <span style={labelStyle(C.textMuted)}>Throttle <span style={{ color: C.textBody2 }}>/</span> Brake</span>
            <div style={{ position: "absolute", top: 6, right: 10, display: "flex", gap: 10, zIndex: 2 }}>
              <span style={valStyle("#fff")}>{r0(dS?.throttle)}%</span>
              <span style={valStyle(C.red)}>{r0(dS?.brake)}%</span>
            </div>
            <svg viewBox={`0 0 ${W} ${VH}`} preserveAspectRatio="none" style={svgStyle}>
              <path d={p.thr.area} fill="#ffffff12" />
              <path d={p.brk.area} fill="#ff4d5e14" />
              <path d={p.thrRef.line} fill="none" stroke="#ffffff" strokeWidth={1.5} strokeOpacity={0.5} strokeDasharray="6 4" vectorEffect="non-scaling-stroke" />
              <path d={p.brkRef.line} fill="none" stroke={C.red} strokeWidth={1.5} strokeOpacity={0.5} strokeDasharray="6 4" vectorEffect="non-scaling-stroke" />
              <path d={p.thr.line} fill="none" stroke="#ffffff" strokeWidth={2} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
              <path d={p.brk.line} fill="none" stroke={C.red} strokeWidth={2} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
            </svg>
          </div>

          {/* Speed (with dashed reference trace) */}
          <div style={{ ...panelStyle, flex: 1.5 }}>
            <span style={labelStyle(C.teal)}>Speed · {uLabel}</span>
            <span style={{ position: "absolute", top: 6, right: 10, zIndex: 2, ...valStyle(C.teal, 14) }}>{toSpeed(dS?.speed, units)}</span>
            <svg viewBox={`0 0 ${W} ${VH}`} preserveAspectRatio="none" style={svgStyle}>
              <path d={p.speed.area} fill="#2dd4bf14" />
              <path d={p.speedRef.line} fill="none" stroke={C.textDim} strokeWidth={1.5} strokeDasharray="6 4" vectorEffect="non-scaling-stroke" />
              <path d={p.speed.line} fill="none" stroke={C.teal} strokeWidth={2.2} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
            </svg>
          </div>

          {/* Wheel Rotation */}
          <div style={{ ...panelStyle, flex: 1 }}>
            <span style={labelStyle(C.green)}>Wheel Rotation</span>
            <span style={{ position: "absolute", top: 6, right: 10, zIndex: 2, ...valStyle(C.green) }}>{steerMag(dS?.steer)} <span style={{ color: C.textDim }}>{steerDir(dS?.steer)}</span></span>
            <svg viewBox={`0 0 ${W} ${VH}`} preserveAspectRatio="none" style={svgStyle}>
              <line x1={0} y1={VH / 2} x2={W} y2={VH / 2} stroke="#3b4458" strokeWidth={1} strokeDasharray="4 4" vectorEffect="non-scaling-stroke" />
              <path d={p.steerRef.line} fill="none" stroke={C.green} strokeWidth={1.5} strokeOpacity={0.5} strokeDasharray="6 4" vectorEffect="non-scaling-stroke" />
              <path d={p.steer.line} fill="none" stroke={C.green} strokeWidth={2} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
            </svg>
          </div>

          {/* Gear (step) */}
          <div style={{ ...panelStyle, flex: 1 }}>
            <span style={labelStyle(C.purple)}>Gear</span>
            <span style={{ position: "absolute", top: 6, right: 10, zIndex: 2, ...valStyle(C.purple, 13) }}>{dS?.gear ?? "—"}</span>
            <svg viewBox={`0 0 ${W} ${VH}`} preserveAspectRatio="none" style={svgStyle}>
              <path d={p.gearRef.line} fill="none" stroke={C.purple} strokeWidth={1.5} strokeOpacity={0.5} strokeDasharray="6 4" vectorEffect="non-scaling-stroke" />
              <path d={p.gear.line} fill="none" stroke={C.purple} strokeWidth={2} vectorEffect="non-scaling-stroke" />
            </svg>
          </div>

          {/* ERS Mode + Used */}
          <div style={{ ...panelStyle, flex: 1.35 }}>
            <span style={labelStyle(C.textMuted)}>ERS Mode <span style={{ color: C.red }}>/</span> Used · SOC</span>
            <div style={{ position: "absolute", top: 6, right: 10, display: "flex", gap: 10, zIndex: 2 }}>
              <span style={valStyle(C.red)}>{dS ? ersName(dS.ersMode) : "—"}</span>
              <span style={valStyle(C.ersYellow)}>{r0(dS?.ersSpent)}</span>
            </div>
            <svg viewBox={`0 0 ${W} ${VH}`} preserveAspectRatio="none" style={svgStyle}>
              <path d={p.ersUsed.area} fill="#FFD43B14" />
              <path d={p.ersModeRef.line} fill="none" stroke={C.red} strokeWidth={1.5} strokeOpacity={0.5} strokeDasharray="6 4" vectorEffect="non-scaling-stroke" />
              <path d={p.ersUsedRef.line} fill="none" stroke={C.ersYellow} strokeWidth={1.5} strokeOpacity={0.5} strokeDasharray="6 4" vectorEffect="non-scaling-stroke" />
              <path d={p.ersMode.line} fill="none" stroke={C.red} strokeWidth={2} vectorEffect="non-scaling-stroke" />
              <path d={p.ersUsed.line} fill="none" stroke={C.ersYellow} strokeWidth={2} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
            </svg>
          </div>
        </div>

        {/* Scrubber */}
        <div style={{ flex: "none", height: 44, marginTop: 10, display: "flex", alignItems: "center", gap: 16 }}>
          <div ref={barRef} onPointerDown={startScrub} style={{ flex: 1, position: "relative", height: 32, display: "flex", alignItems: "center", cursor: "pointer" }}>
            <div style={{ position: "absolute", left: 0, right: 0, height: 6, borderRadius: 3, background: C.line }} />
            <div style={{ position: "absolute", left: 0, height: 6, borderRadius: 3, background: C.blue, width: cursorPct }} />
            {corners.map((c, i) => (
              <div key={i} style={{ position: "absolute", left: `${c.f * 100}%`, top: "50%", transform: "translate(-50%,-50%)", display: "flex", flexDirection: "column", alignItems: "center", gap: 3 }}>
                <div style={{ width: 2, height: 13, background: "#39435a" }} />
                <span style={{ fontSize: 8, color: C.textFaint, whiteSpace: "nowrap" }}>{c.name}</span>
              </div>
            ))}
            <div style={{ position: "absolute", left: cursorPct, top: "50%", transform: "translate(-50%,-50%)", width: 16, height: 16, borderRadius: "50%",
              background: C.blue, border: `3px solid ${C.bg}`, boxShadow: `0 0 0 1px ${C.blue},0 0 12px ${C.blue}` }} />
          </div>
        </div>
      </div>

      {/* ── Right: live-vs-reference readouts + corner info ── */}
      <div style={{ width: 300, flex: "none", display: "flex", flexDirection: "column", gap: 12 }}>
        {readouts.map((k) => (
          <div key={k.label} style={{ flex: 1, ...cardStyle, padding: "9px 16px", display: "flex", flexDirection: "column", justifyContent: "center" }}>
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
        <div style={{ flex: 1, background: "#0f1420", border: "1px solid #2a3550", borderRadius: 12, padding: "9px 16px", display: "flex", flexDirection: "column", justifyContent: "center" }}>
          <div style={{ fontSize: 9, letterSpacing: 2, color: C.textDim, textTransform: "uppercase" }}>Corner</div>
          <div style={{ display: "flex", alignItems: "baseline", gap: 11, marginTop: 5 }}>
            <span style={{ fontFamily: FONT.mono, fontWeight: 800, fontSize: 18, lineHeight: 1, color: C.cyan }}>{nearCorner?.name || "—"}</span>
            <span style={{ fontWeight: 700, fontSize: 16, lineHeight: 1.2, color: C.textBody2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{nearCorner?.note || ""}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
