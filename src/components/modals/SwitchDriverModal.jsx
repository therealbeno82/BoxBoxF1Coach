// ─── SWITCH DRIVER MODAL ────────────────────────────────────────────────────
// Pick the active cockpit driver. Each roster row shows the driver's livery
// number tile, name/team, and their best lap + lap count (loaded per-driver from
// the lap store on open). Footer jumps to the Settings roster to sign a new one.

import { useEffect, useState } from "react";
import { C, FONT } from "../../lib/ui/tokens.js";
import { formatLapTime } from "../../lib/format.js";
import * as lapStore from "../../lib/lapStore.js";

export default function SwitchDriverModal({ drivers = [], activeDriver, avatars = {}, onPick, onClose, onSignUp }) {
  // name → { best:number|null, laps:number }
  const [stats, setStats] = useState({});

  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const out = {};
      for (const d of drivers) {
        const laps = await lapStore.getLaps(d.name);
        const valid = laps.filter(l => typeof l.lapTime === "number" && l.lapTime > 0);
        out[d.name] = {
          best: valid.length ? Math.min(...valid.map(l => l.lapTime)) : null,
          laps: laps.length,
        };
      }
      if (!cancelled) setStats(out);
    })();
    return () => { cancelled = true; };
  }, [drivers]);

  return (
    <div onClick={onClose} style={{
      position: "fixed", inset: 0, zIndex: 130, background: "rgba(5,7,11,.74)",
      backdropFilter: "blur(4px)", display: "flex", alignItems: "center", justifyContent: "center",
      fontFamily: FONT.ui, padding: 24,
    }}>
      <div onClick={(e) => e.stopPropagation()} style={{
        width: 560, maxWidth: "100%", maxHeight: "84%", background: C.modal,
        border: `1px solid ${C.borderModal}`, borderRadius: 16, boxShadow: "0 30px 80px rgba(0,0,0,.6)",
        display: "flex", flexDirection: "column", overflow: "hidden",
      }}>
        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: "20px 24px", borderBottom: `1px solid ${C.line}` }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <div style={{ width: 5, height: 34, borderRadius: 3, background: C.blue }} />
            <div>
              <div style={{ fontSize: 17, fontWeight: 800, letterSpacing: .5 }}>Switch Driver</div>
              <div style={{ fontSize: 10, letterSpacing: 2, color: C.textDim, textTransform: "uppercase", marginTop: 3 }}>
                Sign In · {drivers.length} {drivers.length === 1 ? "Profile" : "Profiles"} On Roster
              </div>
            </div>
          </div>
          <button onClick={onClose} aria-label="Close" style={closeBtn}>✕</button>
        </div>

        {/* Roster */}
        <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "16px 20px",
          display: "flex", flexDirection: "column", gap: 7 }}>
          {drivers.map((d) => {
            const active = d.name === activeDriver;
            const st = stats[d.name];
            return (
              <div key={d.name} onClick={() => { onPick(d.name); onClose(); }} style={{
                display: "flex", alignItems: "center", gap: 13,
                background: active ? d.color + "16" : C.inset,
                border: `1px solid ${active ? d.color : C.line}`, borderRadius: 11,
                padding: "11px 13px", cursor: "pointer",
              }}>
                <div style={{
                  width: 42, height: 42, flex: "none", borderRadius: 10, overflow: "hidden",
                  background: d.color + "1f", border: `1px solid ${d.color}`,
                  display: "flex", alignItems: "center", justifyContent: "center",
                  fontFamily: FONT.cond, fontWeight: 700, fontSize: 21, color: d.color,
                }}>{avatars[d.name]
                  ? <img src={avatars[d.name]} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                  : (d.number || d.name.slice(0, 2).toUpperCase())}</div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 15, fontWeight: 800, letterSpacing: .3 }}>{d.name}</div>
                  <div style={{ fontSize: 11, color: C.textDim, marginTop: 2 }}>{d.team || "Unassigned"}</div>
                </div>
                <div style={{ textAlign: "right", flex: "none" }}>
                  <div style={{ fontFamily: FONT.mono, fontSize: 14, fontWeight: 700, color: C.yellow }}>
                    {st && st.best != null ? formatLapTime(st.best, 3) : "—"}
                  </div>
                  <div style={{ fontSize: 9, letterSpacing: 1, color: C.textFaint, textTransform: "uppercase", marginTop: 2 }}>
                    {st ? st.laps : 0} laps
                  </div>
                </div>
                <span style={{
                  width: 9, height: 9, borderRadius: "50%", flex: "none",
                  background: active ? d.color : "#222a39",
                  boxShadow: active ? `0 0 9px ${d.color}` : "none",
                }} />
              </div>
            );
          })}
        </div>

        {/* Footer */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 14,
          padding: "16px 22px", borderTop: `1px solid ${C.line}`, background: C.bg }}>
          <span style={{ fontSize: 11, color: C.textDim }}>Need a new profile?</span>
          <button onClick={() => { onSignUp?.(); onClose(); }} style={{
            display: "flex", alignItems: "center", gap: 8, padding: "11px 18px", borderRadius: 9,
            border: `1px dashed ${C.borderStrong}`, background: "transparent", color: C.textBody2,
            fontSize: 12, fontWeight: 700, letterSpacing: .5, cursor: "pointer", fontFamily: FONT.ui,
          }}>
            <span style={{ display: "inline-flex", alignItems: "center", justifyContent: "center",
              width: 20, height: 20, borderRadius: 6, background: C.blue, color: "#fff", fontSize: 15, lineHeight: 1 }}>+</span>
            Sign Up New Driver
          </button>
        </div>
      </div>
    </div>
  );
}

const closeBtn = {
  width: 34, height: 34, borderRadius: 8, border: `1px solid ${C.borderModal}`,
  background: C.surface, color: "#9aa3b5", fontSize: 16, cursor: "pointer", lineHeight: 1,
};
