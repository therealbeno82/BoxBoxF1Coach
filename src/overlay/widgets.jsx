// ─── OVERLAY WIDGETS ─────────────────────────────────────────────────────────
// Each widget declares a DESIGN size and draws itself at that size; the host
// scales the whole box (see useOverlayLayout). So everything in here is written
// at one fixed size and never has to reflow — a widget is a picture, not a
// responsive layout.
//
// Colours are literals, not the `C` tokens: those are var()-backed and the skin
// that defines the vars is applied to the MAIN window's <html>, which this
// document never sees. Carrying the palette across is a bridge job for later.

import { LIVE_LEGEND } from "../lib/cues.js";

const INK = "#ffffff";
const DIM = "rgba(255,255,255,.55)";
const FAINT = "rgba(255,255,255,.32)";
const PANEL = "rgba(8,11,17,.72)";
const EDGE = "rgba(255,255,255,.10)";
const GREEN = "#37d67a";
const RED = "#ff5a5f";
const ACCENT = "#3671C6";
// Matches FONT.mono in lib/ui/tokens.js. Named here rather than imported because
// tokens.js is var()-backed against the main window's skin, which this document
// never sees — but the FAMILY must still be one the app actually vendors
// (public/fonts/), or an offline launch silently falls back to a proportional face
// and every digit shifts as the numbers change.
const MONO = '"JetBrains Mono", ui-monospace, monospace';

const panel = {
  width: "100%", height: "100%", boxSizing: "border-box",
  background: PANEL, border: `1px solid ${EDGE}`, borderRadius: 12,
  color: INK, padding: 11, display: "flex", flexDirection: "column", gap: 7,
  // A HUD sits on bright, busy, moving tarmac. The shadow is what keeps the panel
  // edge readable against a white kerb.
  boxShadow: "0 6px 22px rgba(0,0,0,.45)",
};
const capStyle = { fontSize: 9, letterSpacing: 1.4, color: DIM, fontWeight: 700, textTransform: "uppercase" };

function fmtLapTime(s) {
  if (!(s > 0)) return "--:--.---";
  const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(3).padStart(6, "0")}`;
}
const gearLabel = (g) => (g === 0 ? "N" : g === -1 ? "R" : String(g ?? "-"));

// ── Delta to reference ──────────────────────────────────────────────────────
// The headline readout: how far up or down you are on the reference lap, right
// now, at this point on the road. Negative and green is ahead.
function DeltaWidget({ delta }) {
  const v = delta?.v;
  const has = typeof v === "number" && isFinite(v);
  const color = !has ? FAINT : v <= 0 ? GREEN : RED;
  // Bar saturates at ±1.5 s. Beyond that the exact magnitude stops being useful
  // mid-corner and the number itself carries it.
  const mag = has ? Math.min(1, Math.abs(v) / 1.5) : 0;

  return (
    <div style={panel}>
      <div style={capStyle}>Delta to reference</div>
      <div style={{
        fontSize: 40, fontWeight: 800, lineHeight: 1, color,
        fontVariantNumeric: "tabular-nums", fontFamily: MONO,
      }}>
        {has ? (v <= 0 ? "−" : "+") + Math.abs(v).toFixed(2) : "—"}
      </div>
      {/* Centre-anchored bar: ahead grows left, behind grows right. */}
      <div style={{ position: "relative", height: 5, background: "rgba(255,255,255,.10)", borderRadius: 3 }}>
        <div style={{ position: "absolute", left: "50%", top: -2, width: 1, height: 9, background: FAINT }} />
        {has && (
          <div style={{
            position: "absolute", top: 0, height: "100%", background: color, borderRadius: 3,
            left: v <= 0 ? `${50 - mag * 50}%` : "50%",
            width: `${mag * 50}%`,
          }} />
        )}
      </div>
      {delta?.why && (
        <div style={{ fontSize: 9, color: FAINT, lineHeight: 1.4 }}>{delta.why}</div>
      )}
    </div>
  );
}

// ── Audible cue toggles ─────────────────────────────────────────────────────
// The same seven categories as the Live screen's legend chips, each gating its
// own voice cue. Clicks only land in edit mode — the window is click-through
// while driving — so in drive mode this is a state readout, which is still the
// thing you want at a glance ("why is it not calling my braking points?").
function CuesWidget({ state, editing, onCueToggle }) {
  const cues = state?.cues || {};
  return (
    <div style={panel}>
      <div style={{ ...capStyle, display: "flex", justifyContent: "space-between" }}>
        <span>Audible cues</span>
        {!editing && <span style={{ color: FAINT, letterSpacing: 1 }}>UNLOCK TO EDIT</span>}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 4 }}>
        {LIVE_LEGEND.map(([color, label, key]) => {
          const on = cues[key] !== false;
          return (
            <button
              key={key}
              onClick={() => editing && onCueToggle(key, !on)}
              style={{
                padding: "4px 2px", borderRadius: 6, fontSize: 9, fontWeight: 700,
                letterSpacing: .2, fontFamily: "inherit",
                cursor: editing ? "pointer" : "default",
                background: on ? color + "33" : "rgba(255,255,255,.05)",
                border: `1px solid ${on ? color : "rgba(255,255,255,.12)"}`,
                color: on ? INK : FAINT,
                // Struck through when muted, so "off" reads at a glance without
                // relying on a colour difference seen out of the corner of an eye.
                textDecoration: on ? "none" : "line-through",
              }}>{label}</button>
          );
        })}
      </div>
    </div>
  );
}

// ── Speed / gear / pedals ───────────────────────────────────────────────────
function ReadoutWidget({ snap, state }) {
  const units = state?.units === "mph" ? "mph" : "km/h";
  const kph = snap?.speed ?? 0;
  const speed = units === "mph" ? Math.round(kph * 0.621371) : kph;
  const rpmPct = Math.max(0, Math.min(100, ((snap?.rpm ?? 0) / 13000) * 100));

  return (
    <div style={panel}>
      <div style={{ height: 4, background: "rgba(255,255,255,.10)", borderRadius: 2, overflow: "hidden" }}>
        <div style={{
          width: `${rpmPct}%`, height: "100%",
          background: rpmPct > 92 ? RED : rpmPct > 80 ? "#ffb020" : ACCENT,
        }} />
      </div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
        <div style={{ fontSize: 40, fontWeight: 800, lineHeight: 1, minWidth: 40, fontVariantNumeric: "tabular-nums" }}>
          {gearLabel(snap?.gear)}
        </div>
        <div style={{ display: "flex", alignItems: "baseline", gap: 4 }}>
          <div style={{ fontSize: 32, fontWeight: 700, lineHeight: 1, fontVariantNumeric: "tabular-nums", fontFamily: MONO }}>
            {speed}
          </div>
          <div style={{ fontSize: 10, color: DIM, fontWeight: 600 }}>{units}</div>
        </div>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
        {[[snap?.throttle ?? 0, GREEN], [snap?.brake ?? 0, RED]].map(([v, c], i) => (
          <div key={i} style={{ height: 5, background: "rgba(255,255,255,.12)", borderRadius: 3, overflow: "hidden" }}>
            {/* No CSS transition: the snapshot already arrives at ~30 Hz, and easing
                between samples would add lag to a readout whose whole value is
                being instantaneous. */}
            <div style={{ width: `${Math.max(0, Math.min(100, v))}%`, height: "100%", background: c }} />
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Lap clock ───────────────────────────────────────────────────────────────
function LapWidget({ snap }) {
  return (
    <div style={panel}>
      <div style={{ ...capStyle, display: "flex", justifyContent: "space-between" }}>
        <span>Lap {snap?.lapNumber ?? "-"}</span>
        {snap?.lapInvalid ? <span style={{ color: RED }}>INVALID</span> : null}
      </div>
      <div style={{ fontSize: 26, fontWeight: 700, lineHeight: 1, fontVariantNumeric: "tabular-nums", fontFamily: MONO }}>
        {fmtLapTime(snap?.lapTime)}
      </div>
      <div style={{ fontSize: 10, color: DIM, fontFamily: MONO }}>
        LAST {fmtLapTime(snap?.lastLapTime)}
      </div>
    </div>
  );
}

// The registry. `defaults` is only consulted for a widget the saved layout has
// never seen, so adding one here places it without disturbing an existing HUD.
export const WIDGETS = [
  { id: "delta",   name: "Delta to reference", w: 240, h: 116, Render: DeltaWidget,   defaults: { x: 28,  y: 28,  scale: 1, on: true } },
  { id: "cues",    name: "Audible cues",       w: 268, h: 92,  Render: CuesWidget,    defaults: { x: 28,  y: 156, scale: 1, on: true } },
  { id: "readout", name: "Speed & gear",       w: 300, h: 132, Render: ReadoutWidget, defaults: { x: 28,  y: 260, scale: 1, on: true } },
  { id: "lap",     name: "Lap clock",          w: 200, h: 100, Render: LapWidget,     defaults: { x: 28,  y: 404, scale: 1, on: false } },
];
