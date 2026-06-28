// ─── TRACE CONFIGURATOR MODAL ───────────────────────────────────────────────
// Toggle which telemetry channels the trace pipeline records. Display/config only —
// the bridge forwards whatever the game sends; this records the driver's preference
// and an estimated bandwidth. Opened from the Settings "Trace Configurator" button.

import { useEffect } from "react";
import { C, FONT } from "../../lib/ui/tokens.js";

const CHANNELS = [
  { id: "throttle", label: "Throttle", unit: "0–100 %", addr: "0x14" },
  { id: "brake", label: "Brake", unit: "0–100 %", addr: "0x18" },
  { id: "steering", label: "Steering", unit: "−1.0 … 1.0", addr: "0x1C" },
  { id: "gear", label: "Gear", unit: "N · 1–8", addr: "0x20" },
  { id: "speed", label: "Speed", unit: "km/h", addr: "0x24" },
  { id: "rpm", label: "Engine RPM", unit: "rev/min", addr: "0x28" },
  { id: "ers", label: "ERS Deploy", unit: "kJ", addr: "0x2C" },
  { id: "drs", label: "DRS State", unit: "0 · 1", addr: "0x30" },
  { id: "tyreTemp", label: "Tyre Temp", unit: "°C ×4", addr: "0x34" },
  { id: "gforce", label: "G-Force", unit: "lat · lon · g", addr: "0x38" },
];

export default function TraceConfiguratorModal({ channels = {}, setChannels, onClose }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const active = CHANNELS.filter((c) => channels[c.id]).length;
  const bandwidth = (active * 4 * 60 / 1024).toFixed(1);
  const toggle = (id) => setChannels((c) => ({ ...c, [id]: !c[id] }));

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 120, background: "rgba(5,7,11,.74)",
      backdropFilter: "blur(4px)", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: FONT.ui, padding: 24 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: 760, maxWidth: "100%", maxHeight: "86%", background: C.modal,
        border: `1px solid ${C.borderModal}`, borderRadius: 16, boxShadow: "0 30px 80px rgba(0,0,0,.6)", display: "flex", flexDirection: "column", overflow: "hidden" }}>
        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "20px 24px", borderBottom: `1px solid ${C.line}` }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <div style={{ width: 5, height: 34, borderRadius: 3, background: C.blue }} />
            <div>
              <div style={{ fontSize: 17, fontWeight: 800, letterSpacing: .5 }}>Trace Configurator</div>
              <div style={{ fontSize: 10, letterSpacing: 2, color: C.textDim, textTransform: "uppercase", marginTop: 3 }}>Channel Decoder</div>
            </div>
          </div>
          <button onClick={onClose} aria-label="Close" style={closeBtn}>✕</button>
        </div>

        {/* Channels */}
        <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "20px 24px", display: "flex", flexDirection: "column", gap: 9 }}>
          {CHANNELS.map((c) => {
            const on = !!channels[c.id];
            return (
              <button key={c.id} onClick={() => toggle(c.id)} style={{ display: "flex", alignItems: "center", gap: 14, padding: "12px 14px",
                borderRadius: 9, cursor: "pointer", fontFamily: FONT.ui, background: C.inset, border: `1px solid ${on ? "#243349" : C.line}`, color: C.textBody, textAlign: "left" }}>
                <span style={{ fontFamily: FONT.mono, fontSize: 10, color: C.textDim, width: 60, flex: "none", textAlign: "left" }}>{c.addr}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 700 }}>{c.label}</div>
                  <div style={{ fontSize: 11, color: C.textDim }}>{c.unit}</div>
                </div>
                <span style={{ width: 34, height: 19, flex: "none", borderRadius: 11, background: on ? C.blue : C.borderInput, position: "relative", display: "inline-block" }}>
                  <span style={{ position: "absolute", top: 2, left: on ? 17 : 2, width: 15, height: 15, borderRadius: "50%", background: "#fff", transition: "left .15s" }} />
                </span>
              </button>
            );
          })}
        </div>

        {/* Footer */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 14, padding: "16px 24px", borderTop: `1px solid ${C.line}`, background: C.bg }}>
          <span style={{ fontSize: 12, color: C.textDim, fontFamily: FONT.mono }}>{active} / {CHANNELS.length} channels · ~{bandwidth} kB/s</span>
          <button onClick={onClose} style={{ padding: "11px 22px", borderRadius: 9, border: `1px solid ${C.blue}`, background: C.blue, color: "#fff", fontSize: 12, fontWeight: 800, letterSpacing: .5, cursor: "pointer", fontFamily: FONT.ui }}>Done</button>
        </div>
      </div>
    </div>
  );
}

const closeBtn = {
  width: 34, height: 34, borderRadius: 8, border: `1px solid ${C.borderModal}`,
  background: C.surface, color: "#9aa3b5", fontSize: 16, cursor: "pointer", lineHeight: 1,
};
