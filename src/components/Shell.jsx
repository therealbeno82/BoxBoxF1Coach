// ─── SHELL ──────────────────────────────────────────────────────────────────
// The persistent app chrome for the redesigned "Cockpit" GUI: a brand mark, the
// floating centre switcher (Dashboard / Live / Analytics / Coach + ⚙ Settings)
// with the UDP + AI status pills, and a right-hand driver chip. Each screen draws
// its own top bar below this; the body is a single scroll area holding `children`.
//
// Screen ids map the handoff's D/A/B/C/S onto the app's internal tab values:
//   Dashboard→"dashboard"  Live→"live"  Analytics→"compare"  Coach→"coach"  ⚙→"setup"

import { C, FONT } from "../lib/ui/tokens.js";

const NAV = [
  ["dashboard", "Dashboard"],
  ["live",      "Live"],
  ["compare",   "Analytics"],
  ["coach",     "Coach"],
  ["ffb",       "FFB"],
];

const navBtn = (active) => ({
  padding: "7px 14px",
  borderRadius: 8,
  border: `1px solid ${active ? C.blue : "transparent"}`,
  background: active ? C.elevated : "transparent",
  color: active ? "#fff" : "#9aa3b5",
  fontSize: 13,
  fontWeight: 700,
  letterSpacing: 0.3,
  cursor: "pointer",
  fontFamily: FONT.ui,
  whiteSpace: "nowrap",
});

function StatusPill({ on, label, blink }) {
  const color = on ? C.green : C.red;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "0 2px" }}
      title={`${label} ${on ? "connected" : "offline"}`}>
      <span style={{
        width: 7, height: 7, borderRadius: "50%", background: color,
        boxShadow: `0 0 8px ${color}`,
        animation: on && blink ? "blink 1.6s infinite" : "none",
      }} />
      <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: 1, color: C.textBody2 }}>{label}</span>
    </div>
  );
}

const GearIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="3"></circle>
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
  </svg>
);

export default function Shell({
  tab, onTab, onSettings,
  wsConnected, llmConnected, ffbConnected = false,
  activeDriver, driverColor = "#3671C6", driverCount = 1, onDriverChip,
  children,
}) {
  const settingsActive = tab === "setup";
  return (
    <div style={{
      minHeight: "100vh", background: C.bg, color: "#fff",
      fontFamily: FONT.ui, display: "flex", flexDirection: "column",
    }}>
      {/* ── Top chrome ── */}
      <div style={{
        display: "flex", alignItems: "center", gap: 16, padding: "12px 20px",
        flex: "none", position: "relative", zIndex: 20,
      }}>
        {/* Brand */}
        <div style={{ display: "flex", alignItems: "center", gap: 11 }}>
          <div style={{
            width: 69, height: 69, borderRadius: 16, background: C.blue,
            display: "flex", alignItems: "center", justifyContent: "center",
            boxShadow: `0 0 20px ${C.accentGlow}`, flex: "none", overflow: "hidden",
          }}>
            <img src="/brand-logo.png" alt="Box, Box"
              style={{ width: "100%", height: "100%", objectFit: "contain", padding: 3, boxSizing: "border-box" }} />
          </div>
          <div>
            <div style={{ fontSize: 15, fontWeight: 900, letterSpacing: 1.5, lineHeight: 1 }}>Box, Box</div>
            <div style={{ fontSize: 8, letterSpacing: 2.5, color: C.textFaint, textTransform: "uppercase", marginTop: 3 }}>
              Telemetry &amp; AI Coach
            </div>
          </div>
        </div>

        <div style={{ flex: 1 }} />

        {/* Centre switcher */}
        <div style={{
          display: "flex", alignItems: "center", gap: 6,
          background: "rgba(7,9,14,.82)", backdropFilter: "blur(10px)",
          border: `1px solid ${C.borderModal}`, borderRadius: 12, padding: 6,
          boxShadow: "0 8px 30px rgba(0,0,0,.5)",
        }}>
          {NAV.map(([id, label]) => (
            <button key={id} onClick={() => onTab(id)} style={navBtn(tab === id)}>{label}</button>
          ))}
          <div style={{ width: 1, height: 20, background: C.borderModal, margin: "0 2px" }} />
          <StatusPill on={wsConnected} label="UDP" blink />
          <StatusPill on={llmConnected} label="AI" />
          <StatusPill on={ffbConnected} label="FFB" />
          <button onClick={onSettings} title="Settings" aria-label="Settings" style={{
            display: "flex", alignItems: "center", justifyContent: "center",
            padding: "7px 9px", borderRadius: 8,
            border: `1px solid ${settingsActive ? C.blue : "transparent"}`,
            background: settingsActive ? C.elevated : "transparent",
            color: settingsActive ? "#fff" : "#7b8499", cursor: "pointer", fontFamily: FONT.ui,
          }}>
            <GearIcon />
          </button>
        </div>

        <div style={{ flex: 1 }} />

        {/* Driver chip */}
        <button onClick={onDriverChip} title="Switch driver" style={{
          display: "flex", alignItems: "center", gap: 9, padding: "6px 12px 6px 8px",
          borderRadius: 10, border: `1px solid ${C.line}`, background: C.surface,
          cursor: "pointer", fontFamily: FONT.ui,
        }}>
          <span style={{
            width: 26, height: 26, borderRadius: 7, flex: "none",
            background: driverColor + "1f", border: `1px solid ${driverColor}`,
            display: "flex", alignItems: "center", justifyContent: "center",
            fontFamily: FONT.cond, fontWeight: 700, fontSize: 13, color: driverColor,
          }}>
            {(activeDriver || "?").slice(0, 2).toUpperCase()}
          </span>
          <div style={{ textAlign: "left", minWidth: 0 }}>
            <div style={{ fontSize: 8, letterSpacing: 1.5, color: C.textDim, textTransform: "uppercase" }}>Driver</div>
            <div style={{ fontSize: 12, fontWeight: 800, color: C.textHi, maxWidth: 120, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {activeDriver || "—"}
            </div>
          </div>
        </button>
      </div>

      {/* ── Body ── */}
      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", display: "flex", flexDirection: "column" }}>
        {children}
      </div>
    </div>
  );
}
