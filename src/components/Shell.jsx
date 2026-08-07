// ─── SHELL ──────────────────────────────────────────────────────────────────
// The persistent app chrome for the redesigned "Cockpit" GUI: a brand mark, the
// floating centre switcher (Dashboard / Live / Analytics / Coach + ⚙ Settings)
// with the UDP + AI status pills, and a right-hand driver chip. Each screen draws
// its own top bar below this; the body is a single scroll area holding `children`.
//
// Screen ids map the handoff's D/A/B/C/S onto the app's internal tab values:
//   Dashboard→"dashboard"  Live→"live"  Analytics→"compare"  Coach→"coach"  ⚙→"setup"
//
// TWO LAYOUTS, not one that stretches. On desktop/tablet the nav is a floating
// pill centred in the top chrome. On a PHONE that row cannot fit — six buttons
// plus three status pills plus a gear, all `whiteSpace: nowrap` — so the nav
// moves to a fixed bottom tab bar and the header collapses to ~52px. That is a
// structural change, which is why it keys off `useViewport()` rather than a
// media query (inline style objects can't carry one).

import { C, FONT } from "../lib/ui/tokens.js";
import { isAndroid } from "../lib/env.js";
import { useViewport } from "../hooks/useViewport.jsx";

// FFB is desktop-only — the Rust engine behind it is cfg'd out of the Android
// build, so the tab would open on a panel that can only ever say "WAITING…".
// Dropping it also leaves exactly five tabs, which is what a tab bar wants.
const NAV = [
  ["dashboard", "Dashboard"],
  ["live",      "Live"],
  ["compare",   "Analytics"],
  ["coach",     "Coach"],
  ["board",     "Leaderboard"],
  ...(isAndroid ? [] : [["ffb", "FFB"]]),
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

// Bottom-bar tab. Full width share, generous vertical hit area (the whole cell is
// the target, so it clears 44px without a min-height fight), and an accent bar on
// top rather than a border box — a box at this size reads as clutter.
const tabBtn = (active) => ({
  flex: 1,
  minWidth: 0,
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  gap: 3,
  padding: "9px 2px 7px",
  border: "none",
  borderTop: `2px solid ${active ? C.blue : "transparent"}`,
  background: active ? "rgba(54,113,198,.10)" : "transparent",
  color: active ? "#fff" : "#8b94a8",
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: 0.2,
  fontFamily: FONT.ui,
  cursor: "pointer",
  overflow: "hidden",
  textOverflow: "ellipsis",
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
  const { phone } = useViewport();
  const settingsActive = tab === "setup";
  const initials = (activeDriver || "?").slice(0, 2).toUpperCase();

  const gearBtn = (size) => ({
    display: "flex", alignItems: "center", justifyContent: "center",
    padding: size, borderRadius: 8,
    border: `1px solid ${settingsActive ? C.blue : "transparent"}`,
    background: settingsActive ? C.elevated : "transparent",
    color: settingsActive ? "#fff" : "#7b8499", cursor: "pointer", fontFamily: FONT.ui,
  });

  // ── Phone: 52px header + fixed bottom tab bar ──────────────────────────────
  if (phone) {
    return (
      <div style={{
        // dvh, not vh: mobile browsers count the collapsing URL bar in vh, so a
        // 100vh shell is taller than the visible viewport and the tab bar sits
        // just off the bottom of the screen until you scroll.
        height: "100dvh", overflow: "hidden", background: C.bg, color: "#fff",
        fontFamily: FONT.ui, display: "flex", flexDirection: "column",
      }}>
        <div style={{
          display: "flex", alignItems: "center", gap: 10, padding: "8px 12px",
          flex: "none", borderBottom: `1px solid ${C.line}`,
          // Below the status bar / notch. The Android activity draws edge-to-edge.
          paddingTop: "calc(8px + env(safe-area-inset-top))",
        }}>
          <div style={{
            width: 30, height: 30, borderRadius: 8, background: C.blue, flex: "none",
            display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden",
          }}>
            <img src="/brand-logo.png" alt="F1 Coach"
              style={{ width: "100%", height: "100%", objectFit: "contain", padding: 2, boxSizing: "border-box" }} />
          </div>
          <div style={{ fontSize: 13, fontWeight: 900, letterSpacing: 1, flex: 1, minWidth: 0 }}>F1 Coach</div>

          {/* Just the dot on a phone — the "UDP" caption is redundant beside a
              Settings screen that spells the state out in words. */}
          <span title={`Telemetry ${wsConnected ? "connected" : "offline"}`} style={{
            width: 9, height: 9, borderRadius: "50%", flex: "none",
            background: wsConnected ? C.green : C.red,
            boxShadow: `0 0 8px ${wsConnected ? C.green : C.red}`,
            animation: wsConnected ? "blink 1.6s infinite" : "none",
          }} />

          <button onClick={onDriverChip} title="Switch driver" aria-label="Switch driver" style={{
            width: 30, height: 30, borderRadius: 8, flex: "none",
            background: driverColor + "1f", border: `1px solid ${driverColor}`,
            display: "flex", alignItems: "center", justifyContent: "center",
            fontFamily: FONT.cond, fontWeight: 700, fontSize: 13, color: driverColor, cursor: "pointer",
          }}>{initials}</button>

          <button onClick={onSettings} title="Settings" aria-label="Settings" style={gearBtn("7px 8px")}>
            <GearIcon />
          </button>
        </div>

        <div style={{ flex: 1, minHeight: 0, overflowY: "auto", display: "flex", flexDirection: "column" }}>
          {children}
        </div>

        <nav style={{
          flex: "none", display: "flex", alignItems: "stretch",
          background: "rgba(7,9,14,.96)", borderTop: `1px solid ${C.borderModal}`,
          // Gesture-nav pill sits over the bottom edge otherwise.
          paddingBottom: "env(safe-area-inset-bottom)",
        }}>
          {NAV.map(([id, label]) => (
            <button key={id} onClick={() => onTab(id)} style={tabBtn(tab === id)}>{label}</button>
          ))}
        </nav>
      </div>
    );
  }

  // ── Desktop / tablet: the original floating switcher ───────────────────────
  return (
    <div style={{
      // Fixed viewport height (not min-height): the shell must never grow past
      // the window, so panels with their own scroll area (Live's Session Laps)
      // scroll internally instead of pushing the whole page taller.
      height: "100dvh", overflow: "hidden", background: C.bg, color: "#fff",
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
            <img src="/brand-logo.png" alt="F1 Coach"
              style={{ width: "100%", height: "100%", objectFit: "contain", padding: 3, boxSizing: "border-box" }} />
          </div>
          <div>
            <div style={{ fontSize: 15, fontWeight: 900, letterSpacing: 1.5, lineHeight: 1 }}>F1 Coach</div>
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
          {/* AI and FFB are desktop-only features — no pill for something the
              build doesn't contain. */}
          {!isAndroid && <StatusPill on={llmConnected} label="AI" />}
          {!isAndroid && <StatusPill on={ffbConnected} label="FFB" />}
          <button onClick={onSettings} title="Settings" aria-label="Settings" style={gearBtn("7px 9px")}>
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
            {initials}
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
