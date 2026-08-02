// ─── DASHBOARD SCREEN ───────────────────────────────────────────────────────
// The cockpit home: the active driver hero + their career stats, all derived from
// their persisted laps (computeDriverStats). A radial-lit dark surface per the
// handoff. Recent-lap rows jump into Analytics; PB wrench buttons open the Car
// Setup modal. The Shell already draws the brand, so this screen starts at the
// two-column main.

import { useMemo, useState } from "react";
import { C, FONT, eyebrow } from "../../lib/ui/tokens.js";
import { formatLapTime } from "../../lib/format.js";
import { computeDriverStats } from "../../lib/driverStats.js";
import LeaderboardCard from "../LeaderboardCard.jsx";
import { tyreLabel, tyreCondition } from "../../lib/tyres.js";
import { getTrackByName } from "../../lib/trackData.js";
import { inTauri } from "../../lib/env.js";

const KOFI_URL = "https://ko-fi.com/rapidbeno";

// Team-skin hero mark: skin id → logo in public/. Only these skins get a badge in
// the driver hero's top-right; the Default skin (and any unmapped skin) shows none.
const SKIN_LOGOS = {
  anthra:   { src: "/Mclaren-logo.png",  alt: "McLaren", h: 160 },
  ferrari:  { src: "/ferrari-logo.png",  alt: "Ferrari" },
  mercedes: { src: "/merc-logo.png",     alt: "Mercedes" },
  redbull:  { src: "/redbull-logo.png",  alt: "Red Bull Racing" },
  wrl:      { src: "/wrl-logo.png",      alt: "Wallaby Racing League" },
  // Square poster art rather than a wordmark — sized taller so it stays legible, and
  // `r` rounds its opaque edges (the other marks are transparent cut-outs, so no radius).
  shitkickers: { src: "/shitkickers-logo.png", alt: "Shit Kickers", h: 104, r: 12 },
};

// Opens an external URL in the OS browser when running inside the Tauri shell
// (webview links don't otherwise escape the app window); falls back to letting
// the anchor open a normal new tab in `npm run dev`.
const openExternal = (url) => async (e) => {
  if (!inTauri) return;
  e.preventDefault();
  const { openUrl } = await import("@tauri-apps/plugin-opener");
  openUrl(url);
};

// Boot-time "new version available" banner. `update` is null unless the GitHub
// release check (useUpdateCheck) found a newer tag, so this renders nothing in
// the common case. Notify-only — the CTA opens the release page in the browser;
// the ✕ hides it for the session.
const UpdateBanner = ({ update }) => {
  const [dismissed, setDismissed] = useState(false);
  if (!update || dismissed) return null;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16,
      background: "linear-gradient(135deg,#0f2418,#0d1a14)", border: "1px solid #1f5a3a",
      borderRadius: 12, padding: "12px 14px", fontFamily: FONT.ui }}>
      <span style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 34, height: 34,
        flex: "none", borderRadius: 9, background: "rgba(46,213,115,0.14)", border: "1px solid #1f5a3a" }}>
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke={C.green} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 3v12" /><path d="m7 10 5 5 5-5" /><path d="M5 21h14" />
        </svg>
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 9, letterSpacing: 2, color: C.green, textTransform: "uppercase", fontWeight: 700 }}>Update Available</div>
        <div style={{ fontSize: 13, fontWeight: 700, color: C.textHi, marginTop: 2 }}>
          Version {update.latestVersion} is ready to download
        </div>
      </div>
      <a href={update.url} target="_blank" rel="noreferrer" onClick={openExternal(update.url)} style={{
        flex: "none", textDecoration: "none", background: C.green, color: "#06120a", fontFamily: FONT.ui,
        fontSize: 12, fontWeight: 800, letterSpacing: 0.5, borderRadius: 8, padding: "9px 14px" }}>
        Get update →
      </a>
      <button onClick={() => setDismissed(true)} title="Dismiss" style={{ flex: "none", display: "flex",
        alignItems: "center", justifyContent: "center", width: 30, height: 30, borderRadius: 8,
        border: `1px solid ${C.line}`, background: C.surface, color: C.textDim, cursor: "pointer" }}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M18 6 6 18" /><path d="m6 6 12 12" />
        </svg>
      </button>
    </div>
  );
};

const fmt = (t) => formatLapTime(t, 3);
const fmtDate = (ms) => (ms ? new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "");
const gapCol = (g) => (g == null ? C.textFaint : g <= 1e-6 ? C.green : g < 0.4 ? C.yellow : C.textMid);
const gapText = (g) => (g == null ? "" : g <= 1e-6 ? "PB" : `+${g.toFixed(3)}`);

// Compound chip for a PB row. Wet/Inter laps get a blue chip, dry laps a neutral
// one; falls back to the dry/wet word when a lap predates compound tagging.
const TyreChip = ({ lap }) => {
  const label = tyreLabel(lap?.tyre);
  const cond = tyreCondition(lap?.tyre);
  // Always render a condition: laps with no compound data fold into "dry" (the
  // default racing condition), matching computeDriverStats' bucketing.
  const wet = cond === "wet";
  return (
    <span style={{ fontSize: 9, letterSpacing: 0.5, fontWeight: 700, textTransform: "uppercase",
      fontFamily: FONT.mono, padding: "2px 6px", borderRadius: 5, whiteSpace: "nowrap",
      color: wet ? "#bcdcff" : C.textDim, background: wet ? "rgba(68,145,210,0.18)" : C.surface,
      border: `1px solid ${wet ? "rgba(68,145,210,0.5)" : C.line}` }}>
      {label || (wet ? "Wet" : "Dry")}
    </span>
  );
};

// Wrench button matching the Live / Analytics setup buttons — opens the Car Setup
// modal for the lap, disabled (and dimmed) when no setup was captured with it.
const WrenchBtn = ({ onClick, has }) => (
  <button onClick={onClick} title="View car setup" disabled={!has} style={{
    flex: "none", display: "flex", alignItems: "center", justifyContent: "center",
    width: 26, height: 26, borderRadius: 7, border: `1px solid ${C.line}`, background: C.surface,
    color: has ? "#7ea6e6" : C.textFaintest, cursor: has ? "pointer" : "default", opacity: has ? 1 : 0.5 }}>
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"></path>
    </svg>
  </button>
);

// Delete button for a PB-board row — permanently removes a false/bad lap so it
// stops holding a personal best and stops skewing the tallies. Red-tinted to read
// as destructive; the caller confirms before actually deleting.
const TrashBtn = ({ onClick }) => (
  <button onClick={onClick} title="Delete this lap from the boards" style={{
    flex: "none", display: "flex", alignItems: "center", justifyContent: "center",
    width: 26, height: 26, borderRadius: 7, border: "1px solid #4a2130", background: "rgba(255,71,87,0.08)",
    color: "#ff6b7d", cursor: "pointer" }}>
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 6h18" /><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" /><path d="M10 11v6" /><path d="M14 11v6" />
    </svg>
  </button>
);

export default function DashboardScreen({ driver, avatar, update, laps = [], driverCount = 1, units,
  activeSkin = "default", onEnterCockpit, onSwitchDriver, onSelectLap, onOpenSetup, onDeleteLap,
  liveTrackSlug = null, leaderboardEnabled = true, onOpenBoard }) {
  const stats = useMemo(() => computeDriverStats(laps), [laps]);

  // Permanently drop a lap off the boards. Guarded by a confirm because deletion
  // is irreversible — the point is to purge false times that got recorded and
  // wrongly claimed a personal best, restoring the tallies' integrity. Removing
  // the lap re-derives every board (computeDriverStats), so the next-best real
  // lap slides in as the new PB.
  const confirmDelete = (lap) => {
    if (!onDeleteLap || !lap?.id) return;
    const where = lap.meta?.track || "this track";
    const type = lap.meta?.sessionType ? ` · ${lap.meta.sessionType}` : "";
    const ok = window.confirm(
      `Delete this lap from the boards?\n\n${where}${type}\n${fmt(lap.lapTime)}\n\n` +
      `This permanently removes the lap and recalculates your personal bests and tallies. This cannot be undone.`
    );
    if (ok) onDeleteLap(lap.id);
  };
  const color = driver?.color || "#3671C6";
  const name = driver?.name || "—";
  const number = driver?.number || name.slice(0, 2).toUpperCase();
  const team = driver?.team || "Unassigned";

  // Hybrid skin accent: the Default skin keeps the driver's personal livery colour
  // on the hero; a team skin's accent (+ its badge/swatch/mark tokens) takes over.
  // Under a team skin the accent is a CSS var(), so accent tints come from the
  // --accent-* ramp rather than a `${hex}33` suffix (a var() string can't take one).
  const skinned = !!activeSkin && activeSkin !== "default";
  const heroAccent = skinned ? C.accent : color;
  const tileBg     = skinned ? `linear-gradient(160deg, ${C.accent33}, ${C.accent0d})` : `linear-gradient(160deg, ${color}33, ${color}0d)`;
  const tileBorder = skinned ? C.accent55 : `${color}55`;
  const badgeBg    = skinned ? `var(--badge-bg, ${C.accent})` : color;
  const badgeFg    = skinned ? "var(--badge-fg, #06080d)" : "#06080d";
  const teamSwatch = skinned ? `var(--team-swatch, ${C.accent})` : color;
  const numItalic  = "var(--num-italic, normal)";

  return (
    <div style={{ flex: 1, minHeight: 0, background: C.bgRadial, padding: "20px 28px 26px",
      display: "flex", flexDirection: "column", fontFamily: FONT.ui }}>
      <UpdateBanner update={update} />
      <div style={{ flex: 1, minHeight: 0, display: "flex", gap: 18, alignItems: "stretch", flexWrap: "wrap" }}>

        {/* ── Left: driver hero + switch ── */}
        <div style={{ flex: "1 1 440px", maxWidth: 520, minWidth: 320, display: "flex", flexDirection: "column", gap: 16 }}>
          {/* Hero */}
          <div style={{ position: "relative",
            backgroundColor: C.surface,
            backgroundImage: `var(--tex-hero, none), linear-gradient(135deg, ${C.surface}, ${C.inset})`,
            border: `1px solid var(--hero-border, #1c2230)`, borderRadius: "var(--r-lg, 16px)", padding: 20, overflow: "hidden" }}>
            <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 4, background: heroAccent }} />
            <div style={{ position: "absolute", top: -30, right: -30, width: 220, height: 220, borderRadius: "50%",
              background: heroAccent, opacity: .10, filter: "blur(8px)" }} />
            {/* Team mark (top-right of the hero — team skins only) */}
            {SKIN_LOGOS[activeSkin] && (
              <img src={SKIN_LOGOS[activeSkin].src} alt={SKIN_LOGOS[activeSkin].alt} style={{ position: "absolute", top: 14, right: 16,
                height: SKIN_LOGOS[activeSkin].h || 80, width: "auto", objectFit: "contain", pointerEvents: "none",
                borderRadius: SKIN_LOGOS[activeSkin].r || 0 }} />
            )}

            <div style={{ display: "flex", gap: 18, alignItems: "flex-start", position: "relative" }}>
              {/* Avatar + number badge */}
              <div style={{ position: "relative", flex: "none" }}>
                <div style={{ width: 116, height: 138, borderRadius: "var(--r-md, 14px)", overflow: "hidden",
                  background: tileBg,
                  border: `1px solid ${tileBorder}`, display: "flex", alignItems: "center", justifyContent: "center" }}>
                  {avatar
                    ? <img src={avatar} alt={name} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                    : <span style={{ fontFamily: FONT.cond, fontWeight: 700, fontSize: 46, color: heroAccent, letterSpacing: 1, fontStyle: numItalic }}>
                        {name.slice(0, 2).toUpperCase()}
                      </span>}
                </div>
                <div style={{ position: "absolute", bottom: -10, left: "50%", transform: "translateX(-50%)",
                  background: badgeBg, color: badgeFg, fontFamily: FONT.cond, fontWeight: 700, fontSize: 24, lineHeight: 1,
                  padding: "4px 12px", borderRadius: 8, border: `3px solid ${C.inset}`, fontStyle: numItalic }}>{number}</div>
              </div>
              {/* Identity */}
              <div style={{ flex: 1, minWidth: 0, paddingTop: 4 }}>
                <div style={{ fontSize: 10, letterSpacing: 3, color: C.textDim, textTransform: "uppercase" }}>Active Driver</div>
                <div style={{ fontSize: 30, fontWeight: 900, letterSpacing: -.5, lineHeight: 1.05, marginTop: 6, wordBreak: "break-word" }}>{name}</div>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 10 }}>
                  <span style={{ width: 14, height: 14, borderRadius: 4, background: teamSwatch, flex: "none" }} />
                  <span style={{ fontSize: 13, color: C.textMid, fontWeight: 600 }}>{team}</span>
                </div>
              </div>
            </div>
            <button onClick={onEnterCockpit} style={{ width: "100%", marginTop: 18,
              background: `var(--cta-bg, ${C.accent})`, color: `var(--cta-fg, ${C.onAccent})`,
              border: "var(--cta-border, none)", borderRadius: "var(--r-sm, 10px)", padding: 14, fontFamily: FONT.ui, fontSize: 13, fontWeight: 800,
              letterSpacing: 2, cursor: "pointer", boxShadow: `0 8px 24px ${C.accent44}` }}>ENTER COCKPIT →</button>
          </div>

          {/* Where the driver stands on the board for the circuit they last ran.
              Renders nothing at all when offline or when the board is empty — an
              offline launch has to look like this feature isn't there, not like
              it's broken. That self-guard is also why it can sit outside the
              hasLaps branch: no laps means no board to point at, so no card. */}
          <LeaderboardCard
            laps={laps} driver={driver} preferSlug={liveTrackSlug}
            enabled={leaderboardEnabled} cardStyle={cardStyle}
            onOpenBoard={onOpenBoard}
          />

          {/* Switch driver */}
          <button onClick={onSwitchDriver} style={{ width: "100%", display: "flex", alignItems: "center", gap: 13,
            background: C.surface, border: `1px solid ${C.line}`, borderRadius: 14, padding: "13px 15px", cursor: "pointer",
            fontFamily: FONT.ui, textAlign: "left" }}>
            <span style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 40, height: 40, flex: "none",
              borderRadius: 10, background: C.elevated, border: `1px solid ${C.accent55}`, color: C.accent }}>
              <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M17 1l4 4-4 4"></path><path d="M3 11V9a4 4 0 0 1 4-4h14"></path><path d="M7 23l-4-4 4-4"></path><path d="M21 13v2a4 4 0 0 1-4 4H3"></path>
              </svg>
            </span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 9, letterSpacing: 2, color: C.textDim, textTransform: "uppercase" }}>Cockpit Sign-In</div>
              <div style={{ fontSize: 15, fontWeight: 800, letterSpacing: .3, color: C.textHi, marginTop: 2 }}>Switch Driver</div>
            </div>
            <span style={{ fontSize: 9, letterSpacing: 1.5, color: C.textDim, fontFamily: FONT.mono, flex: "none" }}>{driverCount} SIGNED</span>
          </button>

          {/* Donate */}
          <a href={KOFI_URL} target="_blank" rel="noreferrer" onClick={openExternal(KOFI_URL)} style={{ marginTop: "auto",
            display: "flex", alignItems: "center", justifyContent: "center", gap: 9, textDecoration: "none",
            background: "#1a1024", border: "1px solid #3a2550", borderRadius: 14, padding: "13px 15px",
            cursor: "pointer", fontFamily: FONT.ui }}>
            <span style={{ fontSize: 16 }}>☕</span>
            <span style={{ fontSize: 13, fontWeight: 800, letterSpacing: .3, color: "#e6b4ff" }}>
              Donate — support continued development
            </span>
          </a>
        </div>

        {/* ── Right: stats ── */}
        <div style={{ flex: "1 1 560px", minWidth: 320, display: "flex", flexDirection: "column", gap: 16 }}>
          {!stats.hasLaps ? (
            <div style={{ flex: 1, ...cardStyle, display: "flex", flexDirection: "column", alignItems: "center",
              justifyContent: "center", textAlign: "center", padding: "48px 24px" }}>
              <div style={{ fontSize: 30, marginBottom: 10 }}>📊</div>
              <div style={{ fontSize: 15, fontWeight: 800, marginBottom: 6 }}>No laps yet for {name}</div>
              <div style={{ fontSize: 12, color: C.textMid, maxWidth: 400, lineHeight: 1.55 }}>
                Start the game (or fake mode) and drive a lap — completed laps are saved to this driver's
                profile and their stats appear here.
              </div>
            </div>
          ) : (
            <>
              {/* Top: career totals */}
              <div>
                <div style={{ ...cardStyle, display: "flex", flexDirection: "column" }}>
                  <div style={eyebrow}>Career Totals</div>
                  <div style={{ flex: 1, display: "flex", alignItems: "center", gap: 6, marginTop: 6 }}>
                    {[
                      { label: "Laps", value: stats.totals.laps, color: "var(--stat-1, #34c8ff)" },
                      { label: "Sessions", value: stats.totals.sessions, color: "var(--stat-2, #b45bff)" },
                      { label: "Tracks", value: stats.perTrackBest.length, color: "var(--stat-3, #2ED573)" },
                    ].map((t) => (
                      <div key={t.label} style={{ flex: 1, textAlign: "center" }}>
                        <div style={{ fontFamily: FONT.mono, fontSize: 40, fontWeight: 800, lineHeight: 1, color: t.color, fontStyle: numItalic }}>{t.value}</div>
                        <div style={{ fontSize: 9, letterSpacing: 2, color: C.textDim, textTransform: "uppercase", marginTop: 8 }}>{t.label}</div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              {/* Recent laps + per-category PBs, side by side */}
              <div style={{ flex: 1, minHeight: 180, display: "flex", gap: 16, flexWrap: "wrap" }}>
                <div style={{ flex: "1.6 1 320px", minWidth: 280, ...cardStyle, display: "flex", flexDirection: "column" }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
                    <span style={eyebrow}>Recent Laps</span>
                    <span style={{ fontSize: 9, letterSpacing: 1, color: C.textDim, fontFamily: FONT.mono }}>CLICK → COMPARE</span>
                  </div>
                  <div style={{ flex: 1, minHeight: 0, overflowY: "auto", display: "flex", flexDirection: "column", gap: 6, paddingRight: 4 }}>
                    {stats.recent.map(({ lap, gap }) => (
                      <button key={lap.id} onClick={() => onSelectLap?.(lap.id)} title="Open in Analytics" style={{
                        display: "grid", gridTemplateColumns: "58px 1fr 96px 64px 52px", gap: 10, alignItems: "center",
                        background: C.inset, border: `1px solid ${gap != null && gap <= 1e-6 ? "var(--pb-border, #2c2150)" : C.line}`,
                        borderRadius: 8, padding: "9px 13px", cursor: "pointer", fontFamily: FONT.ui, textAlign: "left", width: "100%" }}>
                        <span style={{ fontSize: 10, letterSpacing: 1, color: C.textDim, textTransform: "uppercase" }}>Lap {lap.lapNumber ?? "?"}</span>
                        <span style={{ fontSize: 12, color: C.textMid, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {lap.meta?.track || "—"}{lap.meta?.sessionType ? <span style={{ color: C.textFaint }}> · {lap.meta.sessionType}</span> : null}{tyreLabel(lap.tyre) ? <span style={{ color: tyreCondition(lap.tyre) === "wet" ? "#7fb4e8" : C.textFaint }}> · {tyreLabel(lap.tyre)}</span> : null}
                        </span>
                        <span style={{ fontFamily: FONT.mono, fontSize: 15, fontWeight: 800, color: "#fff" }}>{fmt(lap.lapTime)}</span>
                        <span style={{ fontFamily: FONT.mono, fontSize: 12, fontWeight: 700, textAlign: "right", color: gapCol(gap) }}>{gapText(gap)}</span>
                        <span style={{ fontSize: 10, color: C.textFaint, fontFamily: FONT.mono, textAlign: "right" }}>{fmtDate(lap.recordedAt)}</span>
                      </button>
                    ))}
                  </div>
                </div>

                {/* Personal bests by category — best lap per track within each
                    featured session type (Time Trial / Qualifying / Race), stacked */}
                <div style={{ flex: "1 1 260px", minWidth: 240, ...cardStyle, display: "flex", flexDirection: "column" }}>
                  <div style={{ ...eyebrow, marginBottom: 12 }}>Personal Bests by Category</div>
                  <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", gap: 14 }}>
                    {stats.perCategoryBest.map(({ type, tracks }) => {
                      const accent = type === "Qualifying" ? "var(--cat-2, #b45bff)"
                        : type === "Race" ? "var(--cat-3, #2ED573)"
                        : "var(--cat-1, #34c8ff)";
                      return (
                        <div key={type} style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 9 }}>
                            <span style={{ width: 8, height: 8, borderRadius: 2, background: accent, flex: "none" }} />
                            <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: 1, textTransform: "uppercase", color: C.textBody2 }}>{type}</span>
                            <span style={{ fontSize: 9, color: C.textFaint, fontFamily: FONT.mono, marginLeft: "auto" }}>
                              {tracks.length} {tracks.length === 1 ? "TRACK" : "TRACKS"}
                            </span>
                          </div>
                          <div style={{ flex: 1, minHeight: 0, overflowY: "auto", display: "flex", flexDirection: "column", gap: 5, paddingRight: 2 }}>
                            {tracks.length === 0 && (
                              <div style={{ fontSize: 11, color: C.textFaint, padding: "10px 2px" }}>No {type} laps yet</div>
                            )}
                            {tracks.map((lap) => {
                              const country = getTrackByName(lap.meta?.track)?.country;
                              return (
                                <div key={lap.id} style={{ display: "flex", alignItems: "center", gap: 8, background: C.inset,
                                  border: `1px solid ${C.line}`, borderRadius: 8, padding: "7px 10px" }}>
                                  <span style={{ fontSize: 12, color: C.textBody2, fontWeight: 600, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                    {lap.meta?.track || "—"}
                                  </span>
                                  {country ? (
                                    <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: 0.5, fontFamily: FONT.mono, color: C.textFaint }}>{country}</span>
                                  ) : null}
                                  <TyreChip lap={lap} />
                                  <span style={{ fontFamily: FONT.mono, fontSize: 14, fontWeight: 800, color: C.yellow }}>{fmt(lap.lapTime)}</span>
                                  <WrenchBtn onClick={() => onOpenSetup?.(lap)} has={!!lap.setup} />
                                  {onDeleteLap && <TrashBtn onClick={() => confirmDelete(lap)} />}
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

const cardStyle = {
  background: C.surface, border: `1px solid ${C.line}`, borderRadius: "var(--r-lg, 16px)", padding: "18px 20px",
};
