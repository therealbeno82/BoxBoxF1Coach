// ─── FORCE FEEDBACK SCREEN ──────────────────────────────────────────────────
// Mirrors the original F1 FFB app's cockpit, reskinned in the F1 Coach theme:
//   • A controls band across the top — Wheel Device + Profile.
//   • Below it, two columns:
//       LEFT  = live monitor (wheel torque + clip, output-history scope, the four
//               grip arc-gauges, telemetry grid + driver-input bars)
//       RIGHT = the grouped FFB parameter sliders (with hover hints).
// All data comes from the useFfbEngine hook (Tauri commands + events).

import { useEffect, useRef, useState } from "react";
import { C, FONT, eyebrow, accentBar } from "../../lib/ui/tokens.js";
import { sessionTypeName, clamp } from "../../lib/format.js";
import { inTauri } from "../../lib/env.js";
import { useFfbGauges } from "../../hooks/useFfbEngine.js";

// run_state (from the engine) → status-pill label + colour, mirroring the original.
const RUN_STATE = {
  0: ["WAITING…", C.textDim],
  1: ["CONNECTED", C.green],
  2: ["PAUSED · FFB RELEASED", C.yellow],
  3: ["AI DRIVING · FFB RELEASED", C.yellow],
  4: ["AI START · FFB HELD", C.yellow],
};

const DRIVER_STATUS = { 0: "garage", 1: "flying", 2: "inlap", 3: "outlap", 4: "ontrack" };

// FFB parameter groups + sliders — same set, order and grouping as the original,
// with the original's per-control hover hints. kind "pct" stores a 0..1 (or 0..2)
// fraction but displays ×100 as a percentage.
const PARAM_GROUPS = [
  { title: "STRENGTH", rows: [
    { k: "overallStrength", label: "Overall Strength", kind: "pct", lo: 0, hi: 1,
      hint: "Master GAIN — multiplies all force evenly (scales). Different from Max Output, which only caps the top." },
    { k: "maxOutput", label: "Max Output (Safety)", kind: "pct", lo: 0, hi: 1,
      hint: "Hard CEILING applied last — the wheel can NEVER exceed this (great for a kids profile). Only flattens peaks; doesn't scale everything down." },
    { k: "maxForceN", label: "Full-Scale Force", kind: "raw", lo: 4000, hi: 20000, step: 100, unit: "N",
      hint: "In-game front-tyre force that fills the wheel to 100%. HIGHER = lighter (more headroom); LOWER = stronger (clips sooner). Scales the force, doesn't cap it." },
    { kind: "autoMaxForce" },
    { k: "loadSensitivity", label: "Load Sensitivity", kind: "pct", lo: 0, hi: 1,
      hint: "EXPERIMENTAL. Weights the wheel by front vertical load — lighter when unloaded, full under load. 0 = off. Only ever lightens." },
    { k: "loadRefN", label: "Load Reference", kind: "raw", lo: 3000, hi: 15000, step: 100, unit: "N",
      hint: "Front vertical load treated as fully weighted. Only matters when Load Sensitivity > 0." },
  ]},
  { title: "CUES", rows: [
    { k: "gripLossStrength", label: "Grip Loss Feel", kind: "pct", lo: 0, hi: 2,
      hint: "How strongly front slip lightens the wheel near the limit (>100% = exaggerated)." },
    { k: "understeerStrength", label: "Understeer Cue", kind: "pct", lo: 0, hi: 2,
      hint: "Wheel lightening as the front slides — concentrated at the limit for a defined breakaway edge (>100% = exaggerated)." },
    { k: "oversteerStrength", label: "Oversteer Cue", kind: "pct", lo: 0, hi: 1,
      hint: "Counter-kick when the rear breaks away." },
    { k: "peakEmphasis", label: "Peak Load-Up", kind: "pct", lo: 0, hi: 1,
      hint: "EXPERIMENTAL. Extra weight just before the grip limit so breakaway is a build-then-release. Can add clipping — watch the CLIP meter. 0 = off." },
    { k: "brakingStrength", label: "Braking Weight", kind: "pct", lo: 0, hi: 1,
      hint: "Adds damping under braking — the wheel gets heavier to TURN while you're on the brakes. Felt as you steer (trail-braking). If it oscillates, tick Invert Braking Weight." },
  ]},
  { title: "RUMBLE EFFECTS (SINE)",
    note: "Vibration cues — need a wheel base that supports the sine (periodic) FFB effect. Most direct-drive and belt bases do. Use “Test rumble” in the Wheel Device panel to check yours.",
    rows: [
      { k: "lockupStrength", label: "Lockup Judder", kind: "pct", lo: 0, hi: 1,
        hint: "Front-wheel lockup vibration under braking." },
      { k: "lockupHz", label: "Lockup Pitch", kind: "raw", lo: 10, hi: 60, step: 1, unit: "Hz",
        hint: "Vibration frequency of the lockup judder (severity adds up to +30% on top). Tune until a lockup feels like a sharp judder, clearly faster than Wheelspin Pitch." },
      { k: "wheelspinStrength", label: "Wheelspin Rumble", kind: "pct", lo: 0, hi: 1,
        hint: "Rear-wheel spin vibration on power." },
      { k: "wheelspinHz", label: "Wheelspin Pitch", kind: "raw", lo: 5, hi: 40, step: 1, unit: "Hz",
        hint: "Vibration frequency of the wheelspin rumble (severity adds up to +30% on top). Keep it well below Lockup Pitch so the two effects feel distinct — a slow axle tramp vs a fast brake judder." },
      { k: "scrubStrength", label: "Front Scrub", kind: "pct", lo: 0, hi: 1,
        hint: "Vibration when the front tyres slide past grip — marks the understeer limit on a separate channel from the wheel going light. Gated by speed and cornering load." },
      { k: "scrubHz", label: "Scrub Pitch", kind: "raw", lo: 20, hi: 70, step: 1, unit: "Hz",
        hint: "Vibration frequency of the front scrub (severity adds up to +30% on top). A mid buzz — sits between the slow wheelspin tramp and the fast lockup judder." },
  ]},
  { title: "OUTPUT", rows: [
    { k: "smoothing", label: "Smoothing", kind: "pct", lo: 0, hi: 0.5,
      hint: "Latency-vs-smoothness trade: higher = smoother but laggier (up to ~40ms at max). Keep low for the crispest feel; raise to calm DD oscillation." },
    { k: "minForce", label: "Min Force", kind: "pct", lo: 0, hi: 0.3,
      hint: "Lifts small forces past a wheel deadzone. Raise for belt/gear wheels; 0 for direct drive." },
    { k: "softStartSec", label: "Soft Start", kind: "raw", lo: 0, hi: 2, step: 0.05, unit: "s",
      hint: "Ease force in over this long after connecting / unpausing." },
    { k: "ttStartHoldSec", label: "AI Start Hold", kind: "raw", lo: 0, hi: 10, step: 0.5, unit: "s",
      hint: "SAFETY (Time Trial / One-Shot & Hot-Lap Qualifying). Force is held OFF for this long after a lap start so unexpected forces can't catch your hands. 0 = off. Doesn't affect race starts or a mid-lap unpause." },
    { k: "runUpReleaseM", label: "Flying-Lap Release", kind: "raw", lo: 100, hi: 2000, step: 50, unit: "m",
      hint: "SAFETY (GP-weekend Qualifying flying lap). Force is held OFF during the AI run-up and restored when the car is this many metres before the start/finish line. Raise it if feedback returns too late; lower it if force comes back while the AI is still driving." },
    { k: "ffbUpdateHz", label: "Update Rate", kind: "raw", lo: 30, hi: 360, step: 1, unit: "Hz",
      hint: "Output ceiling. 60–90 Hz suits most wheels; some drop force if updated too fast. Raise gradually." },
    { k: "invertForce", label: "Invert Force Direction", kind: "bool",
      hint: "Flip wheel pull direction if torque fights your steering." },
    { k: "brakingInvert", label: "Invert Braking Weight", kind: "bool",
      hint: "Flip Braking Weight direction if the wheel pulls AWAY from centre under braking instead of firming up." },
  ]},
];

// ── Small building blocks ──
const panel = { background: C.surface, border: `1px solid ${C.line}`, borderRadius: 12, padding: "14px 16px", display: "flex", flexDirection: "column", gap: 10 };

function PanelTitle({ children, right, rightColor = C.textMuted }) {
  return (
    <div>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between" }}>
        <span style={eyebrow}>{children}</span>
        {right ? <span style={{ fontFamily: FONT.mono, fontSize: 11, fontWeight: 800, color: rightColor }}>{right}</span> : null}
      </div>
      <div style={{ height: 1, background: C.line, marginTop: 9 }} />
    </div>
  );
}

function Toggle({ on, onClick }) {
  return (
    <span onClick={onClick} style={{ width: 34, height: 19, flex: "none", borderRadius: 11, background: on ? C.blue : C.borderInput, position: "relative", transition: "background .15s", display: "inline-block", cursor: "pointer" }}>
      <span style={{ position: "absolute", top: 2, left: on ? 17 : 2, width: 15, height: 15, borderRadius: "50%", background: "#fff", transition: "left .15s" }} />
    </span>
  );
}

const miniBtn = (extra = {}) => ({ padding: "6px 11px", borderRadius: 7, border: `1px solid ${C.borderInput}`, background: C.inset, color: C.textBody, fontSize: 11, fontWeight: 700, letterSpacing: 0.3, cursor: "pointer", fontFamily: FONT.ui, ...extra });

// Bipolar wheel-torque bar (blue right / orange left, red at clip), with rails.
function TorqueBar({ value }) {
  const v = clamp(value || 0, -1, 1);
  const clipping = Math.abs(v) > 0.98;
  const col = clipping ? C.red : v >= 0 ? C.blue : C.orange;
  const half = Math.abs(v) * 50;
  return (
    <div>
      <div style={{ position: "relative", height: 26, borderRadius: 5, background: C.inset, overflow: "hidden" }}>
        <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: "4%", background: "rgba(255,77,94,.16)" }} />
        <div style={{ position: "absolute", right: 0, top: 0, bottom: 0, width: "4%", background: "rgba(255,77,94,.16)" }} />
        <div style={{ position: "absolute", left: "50%", top: 0, bottom: 0, width: 1, background: "rgba(232,236,245,.28)" }} />
        <div style={{ position: "absolute", top: 3, bottom: 3, background: col, borderRadius: 2, transition: "all .05s linear", left: v >= 0 ? "50%" : `${50 - half}%`, width: `${half}%` }} />
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", fontFamily: FONT.mono, fontSize: 9, color: C.textFaint, marginTop: 3 }}>
        <span>−FULL</span><span>0</span><span>+FULL</span>
      </div>
    </div>
  );
}

// Rolling output-history oscilloscope (client-side ring buffer).
const SCOPE_N = 200;
function Scope({ gauges, channel }) {
  const buf = useRef({ torque: new Array(SCOPE_N).fill(0), friction: new Array(SCOPE_N).fill(0), rumble: new Array(SCOPE_N).fill(0) });
  useEffect(() => {
    if (!gauges) return;
    const b = buf.current;
    for (const ch of ["torque", "friction", "rumble"]) {
      b[ch].push(gauges[ch] || 0);
      if (b[ch].length > SCOPE_N) b[ch].shift();
    }
  }, [gauges]);
  const data = buf.current[channel];
  const bipolar = channel === "torque";
  const W = 100, H = 40;
  const pts = data.map((v, i) => {
    const x = (i / (SCOPE_N - 1)) * W;
    const norm = bipolar ? (clamp(v, -1, 1) + 1) / 2 : clamp(v, 0, 1);
    const y = H - norm * H;
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  }).join(" ");
  const color = channel === "torque" ? C.blue : C.cyan;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ width: "100%", height: 96, background: "#0a0d13", borderRadius: 6 }}>
      {bipolar && <line x1="0" y1={H / 2} x2={W} y2={H / 2} stroke="rgba(232,236,245,.14)" strokeWidth="0.4" />}
      <polyline points={pts} fill="none" stroke={color} strokeWidth="0.9" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

// 270° arc gauge (opening at the bottom), matching the original.
function ArcGauge({ label, value, color, size = 100 }) {
  const v = clamp(value || 0, 0, 1);
  const cx = size / 2, cy = size / 2, r = size * 0.38;
  const START = 135, SWEEP = 270;
  const polar = (deg) => { const a = (deg * Math.PI) / 180; return [cx + r * Math.cos(a), cy + r * Math.sin(a)]; };
  const arc = (frac) => {
    const a1 = START + SWEEP * frac;
    const [x0, y0] = polar(START);
    const [x1, y1] = polar(a1);
    const large = SWEEP * frac > 180 ? 1 : 0;
    return `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
  };
  return (
    <svg width={size} height={size} style={{ overflow: "visible" }}>
      <path d={arc(1)} stroke={C.borderStrong} strokeWidth="6" fill="none" strokeLinecap="round" />
      {v > 0.005 && <path d={arc(v)} stroke={color} strokeWidth="6" fill="none" strokeLinecap="round" />}
      <text x={cx} y={cy} textAnchor="middle" dominantBaseline="central" fontFamily={FONT.mono} fontSize="15" fontWeight="800" fill={C.textHi}>{Math.round(v * 100)}%</text>
      <text x={cx} y={cy + r * 0.78} textAnchor="middle" fontFamily={FONT.ui} fontSize="9" fontWeight="700" letterSpacing="1" fill={color}>{label}</text>
    </svg>
  );
}

function StatCell({ label, value, color = C.textBody }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      <span style={{ fontSize: 9, letterSpacing: 1, color: C.textDim, textTransform: "uppercase" }}>{label}</span>
      <span style={{ fontFamily: FONT.mono, fontSize: 13, fontWeight: 800, color }}>{value}</span>
    </div>
  );
}

function InputBar({ label, value, color, bipolar = false }) {
  const v = clamp(value || 0, bipolar ? -1 : 0, 1);
  const half = Math.abs(v) * 50;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
      <span style={{ width: 30, fontSize: 10, fontWeight: 700, color: C.textMuted }}>{label}</span>
      <div style={{ position: "relative", flex: 1, height: 9, borderRadius: 3, background: C.inset, overflow: "hidden" }}>
        {bipolar && <div style={{ position: "absolute", left: "50%", top: 0, bottom: 0, width: 1, background: "rgba(232,236,245,.25)" }} />}
        {bipolar
          ? <div style={{ position: "absolute", top: 0, bottom: 0, background: color, left: v >= 0 ? "50%" : `${50 - half}%`, width: `${half}%` }} />
          : <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, background: color, width: `${clamp(v, 0, 1) * 100}%` }} />}
      </div>
      <span style={{ width: 30, textAlign: "right", fontFamily: FONT.mono, fontSize: 11, color: C.textMid }}>{Math.round(v * 100)}</span>
    </div>
  );
}

// One tuning row: percentage / raw-unit slider, or a toggle. The row carries the
// original's hint as a native hover tooltip.
function ParamRow({ row, settings, setSetting }) {
  if (row.kind === "bool") {
    return (
      <div title={row.hint} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, padding: "3px 0" }}>
        <span style={{ fontSize: 12, color: C.textBody }}>{row.label}</span>
        <Toggle on={!!settings[row.k]} onClick={() => setSetting(row.k, !settings[row.k])} />
      </div>
    );
  }
  const pct = row.kind === "pct";
  const raw = settings[row.k] ?? 0;
  const val = pct ? raw * 100 : raw;
  const min = pct ? row.lo * 100 : row.lo;
  const max = pct ? row.hi * 100 : row.hi;
  const step = pct ? 1 : row.step;
  const disp = pct ? `${Math.round(val)}%` : `${row.step < 1 ? val.toFixed(2) : Math.round(val)}${row.unit ? " " + row.unit : ""}`;
  return (
    <div title={row.hint} style={{ display: "flex", flexDirection: "column", gap: 4, padding: "2px 0" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <span style={{ fontSize: 12, color: C.textBody }}>{row.label}</span>
        <span style={{ fontFamily: FONT.mono, fontSize: 12, fontWeight: 800, color: C.cyan }}>{disp}</span>
      </div>
      <input type="range" min={min} max={max} step={step} value={val} title={row.hint}
        onChange={(e) => { const nv = parseFloat(e.target.value); setSetting(row.k, pct ? nv / 100 : nv); }}
        style={{ width: "100%", accentColor: C.blue, cursor: "pointer" }} />
    </div>
  );
}

export default function FfbScreen({ ffb }) {
  const {
    settings, setSetting, resetSettings, status, devices, refreshDevices,
    openDevice, closeDevice, resetPeak, enabled, setEnabled,
    profiles, activeProfile, dirty, saveProfileAs, saveActive, loadProfile, deleteProfile,
  } = ffb;
  // Subscribed here (not in useFfbEngine) so the ~30 Hz gauge stream only
  // re-renders this screen while it's mounted — never the whole app.
  const gauges = useFfbGauges();
  const [scopeCh, setScopeCh] = useState("torque");
  const [newProfile, setNewProfile] = useState("");

  const g = gauges || {};
  const [stateLabel, stateColor] = RUN_STATE[g.runState ?? 0] || RUN_STATE[0];
  const clipPct = (g.clip || 0) * 100;
  const clipColor = clipPct < 2 ? C.textMuted : clipPct < 15 ? C.yellow : C.red;
  const torque = g.torque || 0;
  const rumbleTxt = (g.rumble || 0) > 0.005 ? `${(g.rumble).toFixed(2)} @ ${Math.round(g.rumbleHz || 0)}Hz` : (g.rumble || 0).toFixed(2);
  const profileNames = Object.keys(profiles);

  // ── Wheel Device panel (used in the top controls band) ──
  const devicePanel = (
    <div style={panel}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span style={eyebrow}>WHEEL DEVICE</span>
        <button onClick={refreshDevices} style={miniBtn()}>Rescan</button>
      </div>
      <div style={{ height: 1, background: C.line }} />
      {devices.length === 0 ? (
        <div style={{ fontSize: 12, color: C.textDim, lineHeight: 1.6 }}>
          No FFB devices found. Power on the wheel + install drivers, then click Rescan.
        </div>
      ) : devices.map((d) => {
        const active = status.activeIndex === d.index && status.deviceOpen;
        return (
          <button key={d.index} onClick={() => (active ? closeDevice() : openDevice(d.index))}
            style={{ display: "flex", alignItems: "center", gap: 9, textAlign: "left", padding: "9px 11px", borderRadius: 8, cursor: "pointer", fontFamily: FONT.ui,
              border: `1px solid ${active ? C.blue : C.borderInput}`, background: active ? C.elevated : C.inset, color: "#fff" }}>
            <span style={{ width: 8, height: 8, borderRadius: "50%", flex: "none", background: active ? C.green : C.textFaint, boxShadow: active ? `0 0 8px ${C.green}` : "none" }} />
            <span style={{ flex: 1, minWidth: 0, fontSize: 12, fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{d.name}</span>
            <span style={{ fontSize: 10, fontWeight: 700, color: active ? C.green : C.textDim }}>{active ? "CONNECTED" : "OPEN"}</span>
          </button>
        );
      })}
      {status.error ? <div style={{ fontSize: 11, color: C.red, lineHeight: 1.6 }}>{status.error}</div> : null}
      <div style={{ display: "flex", gap: 8 }}>
        <button title="Sends a constant force so you can confirm the wheel responds, independent of telemetry."
          onMouseDown={() => setSetting("testForce", 0.25)} onMouseUp={() => setSetting("testForce", 0)} onMouseLeave={() => setSetting("testForce", 0)}
          style={{ ...miniBtn({ flex: 1, padding: "8px 10px", border: `1px solid ${C.blue}`, background: "#16243f", color: "#fff" }) }}>
          Test force (hold)
        </button>
        <button title="Vibrates the wheel at the Lockup Pitch frequency — confirms the sine/rumble channel works on your base."
          onMouseDown={() => setSetting("testRumble", 0.5)} onMouseUp={() => setSetting("testRumble", 0)} onMouseLeave={() => setSetting("testRumble", 0)}
          style={{ ...miniBtn({ flex: 1, padding: "8px 10px" }) }}>
          Test rumble (hold)
        </button>
      </div>
      <div style={{ fontSize: 10, color: C.textDim, lineHeight: 1.6 }}>
        The game's UDP port is set in <span style={{ color: C.textMuted }}>Settings → Telemetry</span>. Set in-game FFB strength to 0%.
      </div>
    </div>
  );

  // ── Profile panel (used in the top controls band) ──
  const profilePanel = (
    <div style={panel}>
      <PanelTitle right={dirty ? "MODIFIED" : null} rightColor={C.yellow}>PROFILE</PanelTitle>
      <select value={activeProfile} onChange={(e) => loadProfile(e.target.value)}
        style={{ width: "100%", background: C.inset, border: `1px solid ${C.borderInput}`, borderRadius: 8, padding: "9px 11px", color: C.textBody, fontSize: 12, fontFamily: FONT.ui, outline: "none" }}>
        <option value="">(no profile)</option>
        {profileNames.map((nm) => <option key={nm} value={nm}>{nm}</option>)}
      </select>
      <div style={{ display: "flex", gap: 8 }}>
        <button onClick={saveActive} disabled={!activeProfile} title="Overwrite the active profile with the current sliders" style={miniBtn({ opacity: activeProfile ? 1 : 0.4, border: `1px solid ${C.blue}`, background: "#16243f", color: "#fff" })}>Save</button>
        <button onClick={() => deleteProfile(activeProfile)} disabled={!activeProfile} style={miniBtn({ opacity: activeProfile ? 1 : 0.4, color: C.red })}>Delete</button>
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <input value={newProfile} onChange={(e) => setNewProfile(e.target.value)} placeholder="New profile name"
          onKeyDown={(e) => { if (e.key === "Enter" && newProfile.trim()) { saveProfileAs(newProfile); setNewProfile(""); } }}
          style={{ flex: 1, minWidth: 0, background: C.inset, border: `1px solid ${C.borderInput}`, borderRadius: 8, padding: "8px 11px", color: C.textBody, fontSize: 12, fontFamily: FONT.ui, outline: "none" }} />
        <button onClick={() => { if (newProfile.trim()) { saveProfileAs(newProfile); setNewProfile(""); } }} title="Save the current tuning as a new named profile" style={miniBtn()}>Save As</button>
      </div>
    </div>
  );

  return (
    <div style={{ flex: 1, minHeight: 0, background: C.bg, padding: "16px 24px 20px", display: "flex", flexDirection: "column", gap: 14, fontFamily: FONT.ui, color: C.textBody }}>

      {/* Top bar */}
      <div style={{ display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap", flex: "none" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 13 }}>
          <div style={accentBar(C.blue)} />
          <div>
            <div style={{ fontSize: 21, fontWeight: 800, letterSpacing: 1, lineHeight: 1, color: "#fff" }}>FORCE FEEDBACK</div>
            <div style={{ fontSize: 11, letterSpacing: 2, color: C.textDim, textTransform: "uppercase", marginTop: 5 }}>Physics-driven wheel forces · F1 26</div>
          </div>
        </div>
        <div style={{ flex: 1 }} />
        <div style={{ display: "flex", alignItems: "center", gap: 9, background: C.surface, border: `1px solid ${C.line}`, borderRadius: 9, padding: "7px 13px" }}>
          <span style={{ fontSize: 11, color: C.textMid, fontWeight: 700, letterSpacing: 1 }}>FFB</span>
          <Toggle on={enabled} onClick={() => setEnabled(!enabled)} />
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, background: C.surface, border: `1px solid ${C.line}`, borderRadius: 9, padding: "7px 13px" }}>
          <span style={{ width: 8, height: 8, borderRadius: "50%", background: stateColor, boxShadow: `0 0 8px ${stateColor}` }} />
          <span style={{ fontSize: 12, fontWeight: 700, letterSpacing: 0.5, color: stateColor }}>{stateLabel}</span>
        </div>
      </div>

      {!inTauri && (
        <div style={{ ...panel, borderColor: "#3a2d1d", color: C.yellow, fontSize: 12 }}>
          Force feedback needs the native app. Run <span style={{ fontFamily: FONT.mono }}>npm run tauri dev</span> (the browser preview can't drive a wheel).
        </div>
      )}

      {/* Scroll body */}
      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", display: "flex", flexDirection: "column", gap: 14 }}>

        {/* Two-column body: controls + live monitor (left) · parameters (right) */}
        <div style={{ display: "flex", gap: 14, flexWrap: "wrap", alignItems: "flex-start" }}>

          {/* LEFT: Wheel Device + Profile, then the live monitor */}
          <div style={{ display: "flex", flexDirection: "column", gap: 14, flex: "1 1 470px", minWidth: 400 }}>

            {devicePanel}
            {profilePanel}

            {/* Wheel torque */}
            <div style={panel}>
              <PanelTitle right={clipPct < 2 ? "CLIP  --" : `CLIP ${Math.round(clipPct)}%`} rightColor={clipColor}>WHEEL TORQUE</PanelTitle>
              <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
                <div style={{ textAlign: "center", minWidth: 96 }}>
                  <div style={{ fontFamily: FONT.mono, fontSize: 34, fontWeight: 800, lineHeight: 1, color: Math.abs(torque) > 0.98 ? C.red : C.blue }}>
                    {torque >= 0 ? "+" : "−"}{Math.abs(torque).toFixed(2)}
                  </div>
                  <div style={{ fontSize: 10, letterSpacing: 2, color: C.textMuted, marginTop: 4 }}>{torque >= 0 ? "RIGHT" : "LEFT"}</div>
                </div>
                <div style={{ flex: 1 }}><TorqueBar value={torque} /></div>
              </div>
            </div>

            {/* Output history scope */}
            <div style={panel}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <span style={eyebrow}>OUTPUT HISTORY</span>
                <div style={{ display: "flex", gap: 4 }}>
                  {["torque", "friction", "rumble"].map((ch) => (
                    <button key={ch} onClick={() => setScopeCh(ch)} style={miniBtn({
                      padding: "4px 9px", color: scopeCh === ch ? C.blue : C.textFaint,
                      border: `1px solid ${scopeCh === ch ? C.blue : "transparent"}`,
                      background: scopeCh === ch ? "rgba(54,113,198,.12)" : "transparent",
                    })}>{ch.toUpperCase()}</button>
                  ))}
                </div>
              </div>
              <Scope gauges={gauges} channel={scopeCh} />
            </div>

            {/* Live signals — arc gauges */}
            <div style={panel}>
              <PanelTitle>LIVE SIGNALS</PanelTitle>
              <div style={{ display: "flex", justifyContent: "space-around", flexWrap: "wrap", gap: 8 }}>
                <ArcGauge label="UNDERSTEER" value={g.understeer} color={C.red} />
                <ArcGauge label="OVERSTEER" value={g.oversteer} color={C.yellow} />
                <ArcGauge label="FRONT SLIP" value={g.frontSlip} color={C.cyan} />
                <ArcGauge label="REAR SLIP" value={g.rearSlip} color={C.green} />
              </div>
            </div>

            {/* Telemetry grid + inputs */}
            <div style={panel}>
              <PanelTitle right={`${settings.ffbUpdateHz} Hz`}>TELEMETRY</PanelTitle>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "12px 10px" }}>
                <StatCell label="Speed" value={`${Math.round(g.speed || 0)} km/h`} color={C.green} />
                <StatCell label="Lat G" value={`${Math.abs(g.lateralG || 0).toFixed(1)} G`} color={C.green} />
                <StatCell label="Front" value={`${Math.round(g.frontForce || 0)} N`} color={C.green} />
                <StatCell label="Vert Load" value={`${Math.round(g.vertLoad || 0)} N`} color={C.green} />
                <StatCell label="Sideslip" value={`${(g.sideslipDeg || 0).toFixed(1)}°`} color={C.yellow} />
                <StatCell label="Friction" value={(g.friction || 0).toFixed(2)} color={C.cyan} />
                <StatCell label="Rumble" value={rumbleTxt} color={C.cyan} />
                <StatCell label="UDP Pkt" value={g.udpPackets || 0} color={C.textMuted} />
                <StatCell label="Session" value={sessionTypeName(g.sessionType || 0)} color={C.textMuted} />
                <StatCell label="Control" value={g.aiControl ? "AI" : "YOU"} color={g.aiControl ? C.yellow : C.green} />
                <StatCell label="Driver" value={`${DRIVER_STATUS[g.driverStatus] || "--"}${g.pitStatus ? " (pit)" : ""}`} color={C.textMuted} />
                <StatCell label="Slip F/R" value={`${(g.frontSlipRatio || 0) >= 0 ? "+" : ""}${(g.frontSlipRatio || 0).toFixed(2)} / ${(g.rearSlipRatio || 0) >= 0 ? "+" : ""}${(g.rearSlipRatio || 0).toFixed(2)}`} color={C.yellow} />
              </div>
              <div style={{ height: 1, background: C.line, margin: "4px 0" }} />
              <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
                <InputBar label="THR" value={g.throttle} color={C.green} />
                <InputBar label="BRK" value={g.brake} color={C.red} />
                <InputBar label="STR" value={g.steer} color={C.cyan} bipolar />
              </div>
            </div>
          </div>

          {/* RIGHT: FFB parameters */}
          <div style={{ display: "flex", flexDirection: "column", gap: 14, flex: "1 1 400px", minWidth: 340 }}>
            <div style={panel}>
              <PanelTitle right={activeProfile || null} rightColor={C.blue}>FFB PARAMETERS</PanelTitle>
              {PARAM_GROUPS.map((grp) => (
                <div key={grp.title} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  <div style={{ marginTop: 6 }}>
                    <span style={{ ...eyebrow, color: C.blue, fontSize: 11 }}>{grp.title}</span>
                    <div style={{ height: 1, background: C.line, marginTop: 6 }} />
                  </div>
                  {grp.note ? <div style={{ fontSize: 10.5, color: C.textDim, lineHeight: 1.6 }}>{grp.note}</div> : null}
                  {grp.rows.map((row, i) => {
                    if (row.kind === "autoMaxForce") {
                      const peak = g.peakForce || 0;
                      return (
                        <div key="auto" title="Set Full-Scale Force to the peak cornering force seen this session, so the hardest corner just reaches 100%. Drive 2–3 clean laps first."
                          style={{ display: "flex", alignItems: "center", gap: 8, background: C.inset, borderRadius: 8, padding: "8px 10px" }}>
                          <span style={{ flex: 1, fontSize: 11, color: C.textMuted, fontFamily: FONT.mono }}>
                            Peak: {peak > 1 ? `${Math.round(peak)} N` : "--"}
                          </span>
                          <button onClick={() => setSetting("maxForceN", clamp(peak, 4000, 20000))} disabled={peak < 2000}
                            style={miniBtn({ opacity: peak < 2000 ? 0.4 : 1, padding: "5px 9px" })}>Auto-Set</button>
                          <button onClick={resetPeak} style={miniBtn({ padding: "5px 9px" })}>Reset</button>
                        </div>
                      );
                    }
                    return <ParamRow key={row.k || i} row={row} settings={settings} setSetting={setSetting} />;
                  })}
                </div>
              ))}
              <button onClick={resetSettings} style={miniBtn({ marginTop: 6 })}>Reset all to defaults</button>
            </div>
          </div>
        </div>
      </div>

      {/* Footer */}
      <div style={{ flex: "none", borderTop: `1px solid ${C.line}`, paddingTop: 10, fontSize: 10.5, color: C.textDim, fontFamily: FONT.mono }}>
        In-game: Telemetry ON · UDP format 2026 · 60 Hz · Your Telemetry = Unrestricted · in-game FFB strength 0%
      </div>
    </div>
  );
}
