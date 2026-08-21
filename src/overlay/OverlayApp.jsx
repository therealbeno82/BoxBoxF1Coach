// ─── OVERLAY HUD (prototype) ────────────────────────────────────────────────
// What the driver sees on top of the game. Scope is deliberately the half of the
// problem that is free: every field here comes straight off the telemetry
// snapshot, which the Rust emitter already broadcasts to EVERY webview (lib.rs
// uses app.emit, not emit_to), so this window needs no new Rust plumbing at all.
//
// THE OTHER HALF IS NOT FREE. Delta-to-reference, mini-sector colours, the coach's
// radio calls and lap state all live in BoxBoxApp's React tree, and this is a
// separate JS context with no access to it. Getting those here means the main
// window pushing them out over a channel (invoke a command → emit_to("overlay"))
// — that bridge is the real work, and it is not in this prototype.
//
// A note on what IS shared: localStorage is per-origin, and both windows are the
// same origin, so preferences written by the main app are readable here, and its
// writes fire a `storage` event in this document. That is how the units toggle
// below stays in step without any IPC.

import { useEffect, useState } from "react";
import { useTauriEvents } from "../hooks/useTauriEvents.js";
import { inTauri } from "../lib/env.js";

// Colours are literals, not the `C` tokens: those are var()-backed and the skin
// that defines the vars is applied to the MAIN window's <html>, which this
// document never sees. Skinning the overlay means shipping the palette across.
const INK = "#ffffff";
const DIM = "rgba(255,255,255,.55)";
const PANEL = "rgba(8,11,17,.72)";
const EDGE = "rgba(255,255,255,.10)";
const GREEN = "#37d67a";
const RED = "#ff5a5f";
const ACCENT = "#3671C6";

function fmtLapTime(s) {
  if (!(s > 0)) return "--:--.---";
  const m = Math.floor(s / 60);
  const rest = s - m * 60;
  return `${m}:${rest.toFixed(3).padStart(6, "0")}`;
}

function gearLabel(g) {
  if (g === 0) return "N";
  if (g === -1) return "R";
  return String(g);
}

/** A throttle/brake trace bar. `v` is 0-100 straight off the snapshot. */
function PedalBar({ v, color }) {
  return (
    <div style={{ height: 5, background: "rgba(255,255,255,.12)", borderRadius: 3, overflow: "hidden" }}>
      <div style={{
        width: `${Math.max(0, Math.min(100, v))}%`,
        height: "100%",
        background: color,
        // No CSS transition: the snapshot already arrives at ~30 Hz, and easing
        // between samples would add lag to a readout whose whole value is being
        // instantaneous.
        borderRadius: 3,
      }} />
    </div>
  );
}

export default function OverlayApp() {
  const [snap, setSnap] = useState(null);
  const [receiving, setReceiving] = useState(false);

  // Same-origin localStorage, kept live by the `storage` event the main window's
  // write fires in this document.
  const [units, setUnits] = useState(() => localStorage.getItem("f1coach.units") || "km/h");
  useEffect(() => {
    const onStorage = (e) => {
      if (e.key === "f1coach.units") setUnits(e.newValue || "km/h");
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  useTauriEvents({
    telemetry: (e) => setSnap(e.payload),
    core_status: (e) => setReceiving(!!e.payload?.receiving),
  });

  const speedKph = snap?.speed ?? 0;
  const speed = units === "mph" ? Math.round(speedKph * 0.621371) : speedKph;
  const rpmPct = Math.max(0, Math.min(100, ((snap?.rpm ?? 0) / 13000) * 100));

  return (
    <div style={{
      height: "100%",
      padding: 12,
      display: "flex",
      flexDirection: "column",
      gap: 9,
      background: PANEL,
      border: `1px solid ${EDGE}`,
      borderRadius: 12,
      color: INK,
      // A HUD sits on bright, busy, moving tarmac. The shadow is what keeps the
      // panel edge readable against a white kerb.
      boxShadow: "0 6px 22px rgba(0,0,0,.45)",
    }}>
      {/* Shift/rev bar across the top */}
      <div style={{ height: 4, background: "rgba(255,255,255,.10)", borderRadius: 2, overflow: "hidden" }}>
        <div style={{
          width: `${rpmPct}%`,
          height: "100%",
          background: rpmPct > 92 ? RED : rpmPct > 80 ? "#ffb020" : ACCENT,
        }} />
      </div>

      <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
        <div style={{
          fontSize: 44, fontWeight: 800, lineHeight: 1, minWidth: 46,
          fontVariantNumeric: "tabular-nums",
        }}>{gearLabel(snap?.gear ?? 0)}</div>

        <div style={{ display: "flex", alignItems: "baseline", gap: 5 }}>
          <div style={{
            fontSize: 34, fontWeight: 700, lineHeight: 1,
            fontVariantNumeric: "tabular-nums",
          }}>{speed}</div>
          <div style={{ fontSize: 11, color: DIM, fontWeight: 600 }}>{units}</div>
        </div>

        <div style={{ marginLeft: "auto", textAlign: "right" }}>
          <div style={{ fontSize: 9, color: DIM, letterSpacing: 1.4, fontWeight: 600 }}>LAP {snap?.lapNumber ?? "-"}</div>
          <div style={{ fontSize: 17, fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>
            {fmtLapTime(snap?.lapTime)}
          </div>
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <PedalBar v={snap?.throttle ?? 0} color={GREEN} />
        <PedalBar v={snap?.brake ?? 0} color={RED} />
      </div>

      {/* Status line — an overlay showing stale zeroes looks identical to one
          showing a stationary car, so say which it is. */}
      <div style={{ fontSize: 9, color: DIM, letterSpacing: 1.2, fontWeight: 600 }}>
        {!inTauri ? "NO NATIVE CORE"
          : receiving ? "TELEMETRY LIVE"
          : "WAITING FOR TELEMETRY"}
      </div>
    </div>
  );
}
