// ─── SHELL ──────────────────────────────────────────────────────────────────
// The persistent app chrome for the redesigned "Cockpit" GUI: a brand mark, the
// floating centre switcher (Dashboard / Live / Analytics / Coach + ⚙ Settings)
// with the UDP + AI status pills, and a right-hand driver chip. Each screen draws
// its own top bar below this; the body is a single scroll area holding `children`.
//
// Screen ids map the handoff's D/A/B/C/S onto the app's internal tab values:
//   Dashboard→"dashboard"  Live→"live"  Analytics→"compare"  Coach→"coach"  ⚙→"setup"
//
// THREE LAYOUTS, not one that stretches. On desktop/tablet the nav is a floating
// pill centred in the top chrome. On a PHONE that row cannot fit — six buttons
// plus three status pills plus a gear, all `whiteSpace: nowrap` — so the nav
// moves to a fixed bottom tab bar and the header collapses to ~52px. That is a
// structural change, which is why it keys off `useViewport()` rather than a
// media query (inline style objects can't carry one).
//
// The third is LANDSCAPE, and it exists because a rotated phone is 873×393 CSS
// px — wide enough to clear the 639px phone breakpoint, so it used to get the
// desktop chrome. Two things were wrong with that. The header's contents measure
// 903px, so the driver chip ran 17px off the right edge and was clipped; and the
// 93px brand block ate 24% of the screen's height, which in landscape is the
// scarce axis. So the nav turns ninety degrees with the phone: a side RAIL costs
// no vertical space at all, carries the same five labels, and gives the content
// the full height. Nothing else about the screens changes.

import { C, FONT } from "../lib/ui/tokens.js";
import { isAndroid, openExternal, KOFI_URL } from "../lib/env.js";
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
//
// 9px labels, not 10. The Donate entry makes SIX cells on a 375px bar, which
// leaves each about 62px — and "Leaderboard" inks at 63px at 10px, so it would
// have ellipsised to "Leaderboar…". Shrinking the type by a point keeps every
// label whole, which matters more than the point: an abbreviated nav label is
// read wrong once and mistrusted after.
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
  fontSize: 9,
  fontWeight: 700,
  letterSpacing: 0.2,
  fontFamily: FONT.ui,
  cursor: "pointer",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
});

// Rail tab. The bottom bar's cell turned on its side: the accent moves from the
// top edge to the LEFT edge, so the lit edge is the one nearest the screen it
// opens. 78px is set by the longest label — "Leaderboard" at 10px needs 62px of
// the 66px inside the padding — and keeping the labels identical across all
// three navs is worth those few pixels.
const railBtn = (active) => ({
  flex: "none",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  minHeight: 44,
  padding: "8px 6px",
  border: "none",
  borderLeft: `2px solid ${active ? C.blue : "transparent"}`,
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
  const { phone, rail } = useViewport();
  const settingsActive = tab === "setup";
  const initials = (activeDriver || "?").slice(0, 2).toUpperCase();

  // The telemetry dot and the driver chip, shared by the phone header and the
  // landscape rail. Defined once and placed twice rather than forked, the way
  // Driving Lines' overlay clusters are.
  const udpDot = (size) => (
    <span title={`Telemetry ${wsConnected ? "connected" : "offline"}`} style={{
      width: size, height: size, borderRadius: "50%", flex: "none",
      background: wsConnected ? C.green : C.red,
      boxShadow: `0 0 8px ${wsConnected ? C.green : C.red}`,
      animation: wsConnected ? "blink 1.6s infinite" : "none",
    }} />
  );
  // No inline minHeight: the coarse-pointer rule lifts this to a full 44px tap
  // target on a touch screen, which is what it should be. Width is a parameter
  // only because the rail has 78px to spend and the 52px header has not.
  // Donate, at the end of the compact navs. It is NOT a tab — there is no screen
  // to be "on" — so it never takes the active treatment, sits in a `flex: none`
  // cell rather than taking an equal share, and is an anchor so a plain browser
  // opens it in a tab while the Tauri build hands it to the OS (openExternal).
  // It replaces the Dashboard's donate card on these layouts, which cost a whole
  // row there.
  const donateEntry = (railForm) => (
    <a href={KOFI_URL} target="_blank" rel="noreferrer" onClick={openExternal(KOFI_URL)}
      title="Donate — support continued development"
      style={{
        ...tabBtn(false),
        flex: "none",
        flexDirection: "row",
        gap: 4,
        padding: railForm ? "8px 6px" : "9px 8px 7px",
        color: "#c99bf0",
        textDecoration: "none",
        ...(railForm && { minHeight: 44, borderTop: "none" }),
      }}>
      <span style={{ fontSize: 11, lineHeight: 1 }}>☕</span>
      Donate
    </a>
  );

  const driverChip = (w) => (
    <button onClick={onDriverChip} title="Switch driver" aria-label="Switch driver" style={{
      width: w, height: 30, borderRadius: 8, flex: "none",
      background: driverColor + "1f", border: `1px solid ${driverColor}`,
      display: "flex", alignItems: "center", justifyContent: "center",
      fontFamily: FONT.cond, fontWeight: 700, fontSize: 13, color: driverColor, cursor: "pointer",
    }}>{initials}</button>
  );

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
          {udpDot(9)}

          {/* Both 44 wide, as they already are 44 tall via the coarse-pointer
              floor. They were 30 and 33, which is a tall thin sliver rather than
              a target, and the header has the width to spare — the title beside
              them flexes. */}
          {driverChip(44)}

          <button onClick={onSettings} title="Settings" aria-label="Settings"
            style={{ ...gearBtn("7px 8px"), width: 44 }}>
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
          {donateEntry(false)}
        </nav>
      </div>
    );
  }

  // ── Landscape: nav down the left edge, content gets the full height ────────
  if (rail) {
    return (
      <div style={{
        height: "100dvh", overflow: "hidden", background: C.bg, color: "#fff",
        fontFamily: FONT.ui, display: "flex", flexDirection: "row",
      }}>
        <nav style={{
          flex: "none", width: 78, display: "flex", flexDirection: "column",
          alignItems: "stretch", gap: 6,
          background: "rgba(7,9,14,.96)", borderRight: `1px solid ${C.borderModal}`,
          // Rotating a phone moves the notch to one of the SIDES and the gesture
          // pill to the bottom of a now-short screen, but the activity draws
          // edge-to-edge either way, so the status bar can still own the top.
          // The rail touches all three of those edges and pays for all three;
          // whichever insets are 0 on a given device cost nothing.
          padding: "8px 0",
          paddingTop: "calc(8px + env(safe-area-inset-top))",
          paddingLeft: "env(safe-area-inset-left)",
          paddingBottom: "calc(8px + env(safe-area-inset-bottom))",
        }}>
          {/* No brand mark here, unlike the phone header. The rail was at exact
              capacity with five entries — 251px of column for 251px of tabs — so
              the sixth had to come from somewhere, and a 28px logo is the only
              purely decorative thing in it. A nav that scrolls is a functional
              cost paid on every tap; missing branding on a screen you are
              already inside is not. */}
          {/* The tab column SCROLLS rather than squashing. Six 44px entries plus
              the brand and the footer cluster need ~408px against the ~251 a
              393px landscape phone leaves, and a clipped entry is a screen you
              cannot reach.
              `scrollbarWidth: none` because a CLASSIC scrollbar takes its width
              out of a 78px rail — 11px of it — which is enough to ellipsise
              "Leaderboard" at 10px. Android's WebView overlays its scrollbars and
              would never have shown that, so it would have shipped as a
              desktop-browser-only defect. The column is dragged, not clicked, on
              every device that can reach this layout. */}
          <div style={{ flex: 1, minHeight: 0, overflowY: "auto", scrollbarWidth: "none",
            display: "flex", flexDirection: "column", gap: 2 }}>
            {NAV.map(([id, label]) => (
              <button key={id} onClick={() => onTab(id)} style={railBtn(tab === id)}>{label}</button>
            ))}
            {donateEntry(true)}
          </div>

          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8, flex: "none" }}>
            {udpDot(9)}
            {driverChip(44)}
            <button onClick={onSettings} title="Settings" aria-label="Settings"
              style={{ ...gearBtn("7px 8px"), width: 44, justifyContent: "center" }}>
              <GearIcon />
            </button>
          </div>
        </nav>

        <div style={{
          flex: 1, minWidth: 0, minHeight: 0, overflowY: "auto",
          display: "flex", flexDirection: "column",
          // The other half of the notch: whichever way round the phone is
          // turned, one of these two insets is the cutout and the other is 0.
          paddingRight: "env(safe-area-inset-right)",
          paddingTop: "env(safe-area-inset-top)",
        }}>
          {children}
        </div>
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
