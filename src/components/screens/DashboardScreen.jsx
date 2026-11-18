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
import { openExternal, KOFI_URL } from "../../lib/env.js";
import { useViewport } from "../../hooks/useViewport.jsx";
import { WrenchIcon, TrashIcon } from "../icons.jsx";
import DeleteLapConfirm from "../DeleteLapConfirm.jsx";
import TyreChip from "../TyreChip.jsx";

// The swap arrows on the Switch Driver control, drawn at whatever size the
// placement wants — a 19px glyph in the desktop card's tile, 17px inline in the
// phone's compact button beside ENTER COCKPIT.
const switchIcon = (size) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M17 1l4 4-4 4"></path><path d="M3 11V9a4 4 0 0 1 4-4h14"></path>
    <path d="M7 23l-4-4 4-4"></path><path d="M21 13v2a4 4 0 0 1-4 4H3"></path>
  </svg>
);

// Team-skin hero mark: skin id → logo in public/. Only these skins get a badge in
// the driver hero's top-right; the Default skin (and any unmapped skin) shows none.
const SKIN_LOGOS = {
  anthra:   { src: "/Mclaren-logo.png",  alt: "McLaren", h: 160 },
  ferrari:  { src: "/ferrari-logo.png",  alt: "Ferrari" },
  mercedes: { src: "/merc-logo.webp",    alt: "Mercedes" },
  redbull:  { src: "/redbull-logo.png",  alt: "Red Bull Racing" },
  wrl:      { src: "/wrl-logo.webp",     alt: "Wallaby Racing League" },
  // Square poster art rather than a wordmark — sized taller so it stays legible, and
  // `r` rounds its opaque edges (the other marks are transparent cut-outs, so no radius).
  shitkickers: { src: "/shitkickers-logo.webp", alt: "Shit Kickers", h: 104, r: 12 },
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

// A PB row's two buttons sit at its right end, 26px of chrome each. On a touch
// screen the coarse-pointer floor lifts them to 44 TALL but never wider, and the
// row is 275px with 2px to spare — two 44px targets side by side need 36 more
// than it has. So each grows its hit area only into space no other control owns:
// the wrench LEFT, over the (non-interactive) lap time; the delete RIGHT, into
// the row's own padding. They meet at a hard boundary rather than overlapping,
// which matters more here than anywhere else in the app — the right-hand button
// destroys a lap, and an overlapping hit area would let a tap aimed at the
// wrench land on it. `pad` is the outward growth; the margin gives it back to
// the layout so the row is unchanged.
const hitPad = (side, pad) => ({
  width: 26 + pad,
  [side === "left" ? "marginLeft" : "marginRight"]: -pad,
  justifyContent: side === "left" ? "flex-end" : "flex-start",
  padding: 0, border: "none", background: "transparent",
});

const chrome = (extra) => ({
  display: "flex", alignItems: "center", justifyContent: "center",
  width: 26, height: 26, borderRadius: 7, ...extra,
});

// Wrench button matching the Live / Analytics setup buttons — opens the Car Setup
// modal for the lap, disabled (and dimmed) when no setup was captured with it.
const WrenchBtn = ({ onClick, has }) => (
  <button onClick={onClick} title="View car setup" disabled={!has} style={{
    flex: "none", display: "flex", alignItems: "center", height: 26,
    ...hitPad("left", 18),
    cursor: has ? "pointer" : "default", opacity: has ? 1 : 0.5 }}>
    <span style={chrome({ border: `1px solid ${C.line}`, background: C.surface,
      color: has ? "#7ea6e6" : C.textFaintest })}>
      <WrenchIcon size={13} />
    </span>
  </button>
);

// Delete button for a PB-board row — permanently removes a false/bad lap so it
// stops holding a personal best and stops skewing the tallies. Red-tinted to read
// as destructive; the caller confirms before actually deleting.
const TrashBtn = ({ onClick }) => (
  <button onClick={onClick} title="Delete this lap from the boards" style={{
    flex: "none", display: "flex", alignItems: "center", height: 26,
    ...hitPad("right", 11),
    cursor: "pointer" }}>
    <span style={chrome({ border: "1px solid #4a2130", background: "rgba(255,71,87,0.08)", color: "#ff6b7d" })}>
      <TrashIcon size={13} />
    </span>
  </button>
);

export default function DashboardScreen({ driver, avatar, update, laps = [], driverCount = 1, units,
  activeSkin = "default", onEnterCockpit, onSwitchDriver, onSelectLap, onOpenSetup, onDeleteLap,
  liveTrackSlug = null, leaderboardEnabled = true, onOpenBoard }) {
  const { phone, rail } = useViewport();
  // The layouts where a control cannot afford a row of its own, and where the
  // two columns are guaranteed to WRAP onto separate flex lines: a portrait
  // phone (375 can never hold a 440 + 260 pair) and a landscape one, which has
  // the least vertical room of anything and so gains the most. Deliberately not
  // `compact`: at the 1023px tablet ceiling the columns still fit side by side
  // on ONE line, where packing to flex-start would stop them filling the height.
  const tight = phone || rail;
  const stats = useMemo(() => computeDriverStats(laps), [laps]);

  // Permanently drop a lap off the boards. Guarded by a confirm because deletion
  // is irreversible — the point is to purge false times that got recorded and
  // wrongly claimed a personal best, restoring the tallies' integrity. Removing
  // the lap re-derives every board (computeDriverStats), so the next-best real
  // lap slides in as the new PB. The same dialog guards Analytics' delete buttons.
  const [pendingDelete, setPendingDelete] = useState(null);
  const confirmDelete = (lap) => {
    if (!onDeleteLap || !lap?.id) return;
    setPendingDelete(lap);
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

  // The hero's team mark, in whichever form the width allows. Phone: an in-flow
  // flex item, capped at 64 so the avatar and the identity text keep a usable
  // share of ~315px of content. Desktop: the original absolute overlay at the
  // mark's own authored height.
  const skin = SKIN_LOGOS[activeSkin];
  const skinMark = skin && (
    <img src={skin.src} alt={skin.alt} style={{
      width: "auto", objectFit: "contain", pointerEvents: "none",
      borderRadius: skin.r || 0,
      ...(phone
        ? { height: 64, flex: "none", alignSelf: "flex-start", marginTop: 2 }
        : { height: skin.h || 80, position: "absolute", top: 14, right: 16 }),
    }} />
  );

  return (
    <div style={{ flex: 1, minHeight: 0, background: C.bgRadial, padding: "20px var(--screen-px) 26px",
      display: "flex", flexDirection: "column", fontFamily: FONT.ui }}>
      <UpdateBanner update={update} />
      {/* `alignContent: flex-start` on a phone. The two columns WRAP onto
          separate flex lines there, and the default `align-content: stretch`
          then shares the container's spare height BETWEEN those lines — which
          reads as dead space under each card rather than as a taller card. It
          was invisible while the Switch Driver card was padding the left column
          out; removing it left a 69px hole. Desktop keeps stretch, where the two
          columns sit on ONE line and stretching is what makes them equal height. */}
      <div style={{ flex: 1, minHeight: 0, display: "flex", gap: 18, alignItems: "stretch", flexWrap: "wrap",
        ...(tight && { alignContent: "flex-start" }) }}>

        {/* ── Left: driver hero + switch ── */}
        <div style={{ flex: "1 1 440px", maxWidth: 520, minWidth: "min(320px, var(--col-min))", display: "flex", flexDirection: "column", gap: 16 }}>
          {/* Hero */}
          <div style={{ position: "relative",
            backgroundColor: C.surface,
            backgroundImage: `var(--tex-hero, none), linear-gradient(135deg, ${C.surface}, ${C.inset})`,
            border: `1px solid var(--hero-border, #1c2230)`, borderRadius: "var(--r-lg, 16px)", padding: 20, overflow: "hidden" }}>
            <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 4, background: heroAccent }} />
            <div style={{ position: "absolute", top: -30, right: -30, width: 220, height: 220, borderRadius: "50%",
              background: heroAccent, opacity: .10, filter: "blur(8px)" }} />
            {/* Team mark — team skins only. Defined once, placed two ways.
                On desktop the hero is 440-520px wide and the mark sits as an
                absolute overlay in the empty space to the RIGHT of the identity
                text. A phone hero is ~355px and has no such space: the mark
                landed on top of "Active Driver" and the driver's name, covering
                99px of a 143px-wide text column and making both unreadable. So
                on a phone it stops being an overlay and becomes an ordinary flex
                sibling in the row below, where the layout cannot put it on top
                of anything, at a size the row can actually spare. */}
            {!phone && skinMark}

            <div style={{ display: "flex", gap: phone ? 12 : 18, alignItems: "flex-start", position: "relative" }}>
              {/* Avatar + number badge */}
              <div style={{ position: "relative", flex: "none" }}>
                {/* Smaller on a phone: at 116 the avatar, the mark and the text
                    cannot all have a share of 315px of content width. */}
                <div style={{ width: phone ? 88 : 116, height: phone ? 106 : 138, borderRadius: "var(--r-md, 14px)", overflow: "hidden",
                  background: tileBg,
                  border: `1px solid ${tileBorder}`, display: "flex", alignItems: "center", justifyContent: "center" }}>
                  {avatar
                    ? <img src={avatar} alt={name} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                    : <span style={{ fontFamily: FONT.cond, fontWeight: 700, fontSize: phone ? 34 : 46, color: heroAccent, letterSpacing: 1, fontStyle: numItalic }}>
                        {name.slice(0, 2).toUpperCase()}
                      </span>}
                </div>
                <div style={{ position: "absolute", bottom: -10, left: "50%", transform: "translateX(-50%)",
                  background: badgeBg, color: badgeFg, fontFamily: FONT.cond, fontWeight: 700, fontSize: phone ? 19 : 24, lineHeight: 1,
                  padding: phone ? "3px 9px" : "4px 12px", borderRadius: 8, border: `3px solid ${C.inset}`, fontStyle: numItalic }}>{number}</div>
              </div>
              {/* Identity */}
              <div style={{ flex: 1, minWidth: 0, paddingTop: 4 }}>
                <div style={{ fontSize: phone ? 9 : 10, letterSpacing: phone ? 1.5 : 3, color: C.textDim, textTransform: "uppercase",
                  overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>Active Driver</div>
                <div style={{ fontSize: phone ? 23 : 30, fontWeight: 900, letterSpacing: -.5, lineHeight: 1.05, marginTop: phone ? 4 : 6, wordBreak: "break-word" }}>{name}</div>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: phone ? 8 : 10, minWidth: 0 }}>
                  <span style={{ width: 14, height: 14, borderRadius: 4, background: teamSwatch, flex: "none" }} />
                  <span style={{ fontSize: phone ? 12 : 13, color: C.textMid, fontWeight: 600, minWidth: 0,
                    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{team}</span>
                </div>
              </div>
              {phone && skinMark}
            </div>
            {/* On a phone the two actions share one row and the standalone
                Switch Driver card below is dropped, which buys back its whole
                68px plus the 16px gap under it — the most vertical space
                available anywhere on this screen for one change. The hero's
                inner width is 277px there and "ENTER COCKPIT →" alone inks at
                155, so the CTA gives up its wide desktop tracking to make room;
                it keeps the accent fill, so it still reads as the primary
                action next to a bordered secondary one. */}
            <div style={{ display: "flex", gap: 8, marginTop: tight ? 14 : 18, alignItems: "stretch" }}>
              <button onClick={onEnterCockpit} style={{ flex: 1, minWidth: 0,
                background: `var(--cta-bg, ${C.accent})`, color: `var(--cta-fg, ${C.onAccent})`,
                border: "var(--cta-border, none)", borderRadius: "var(--r-sm, 10px)",
                padding: tight ? "13px 8px" : 14, fontFamily: FONT.ui,
                fontSize: tight ? 11.5 : 13, fontWeight: 800,
                letterSpacing: tight ? 0.6 : 2, whiteSpace: "nowrap",
                cursor: "pointer", boxShadow: `0 8px 24px ${C.accent44}` }}>ENTER COCKPIT →</button>
              {tight && (
                <button onClick={onSwitchDriver} title="Switch driver" style={{ flex: "none", display: "flex",
                  alignItems: "center", justifyContent: "center", gap: 6,
                  background: C.surface, border: `1px solid ${C.accent55}`, borderRadius: "var(--r-sm, 10px)",
                  padding: "0 10px", color: C.textHi, fontFamily: FONT.ui, fontSize: 11.5, fontWeight: 800,
                  letterSpacing: 0.3, whiteSpace: "nowrap", cursor: "pointer" }}>
                  <span style={{ display: "flex", color: C.accent, flex: "none" }}>{switchIcon(17)}</span>
                  Switch Driver
                </button>
              )}
            </div>
          </div>

          {/* Switch driver. Desktop only — on a phone this action has moved up
              beside ENTER COCKPIT, where it costs no row of its own. The eyebrow
              and the signed-driver count go with the card rather than being
              squeezed into the compact button; the roster modal states both on
              arrival ("Sign In · N Profiles On Roster"). */}
          {!tight && (
          <button onClick={onSwitchDriver} style={{ width: "100%", display: "flex", alignItems: "center", gap: 13,
            background: C.surface, border: `1px solid ${C.line}`, borderRadius: 14, padding: "13px 15px", cursor: "pointer",
            fontFamily: FONT.ui, textAlign: "left" }}>
            <span style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 40, height: 40, flex: "none",
              borderRadius: 10, background: C.elevated, border: `1px solid ${C.accent55}`, color: C.accent }}>
              {switchIcon(19)}
            </span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 9, letterSpacing: 2, color: C.textDim, textTransform: "uppercase" }}>Cockpit Sign-In</div>
              <div style={{ fontSize: 15, fontWeight: 800, letterSpacing: .3, color: C.textHi, marginTop: 2 }}>Switch Driver</div>
            </div>
            <span style={{ fontSize: 9, letterSpacing: 1.5, color: C.textDim, fontFamily: FONT.mono, flex: "none" }}>{driverCount} SIGNED</span>
          </button>
          )}

          {/* Where the driver stands on the board for the circuit they last ran.
              Renders nothing at all when offline or when the board is empty — an
              offline launch has to look like this feature isn't there, not like
              it's broken. That self-guard is also why it can sit outside the
              hasLaps branch: no laps means no board to point at, so no card.

              Desktop only. The whole card is a pointer at a screen that is
              already a nav entry one tap away, and on the layouts where rows are
              scarce a pointer is not worth a row — the same trade that moved
              Donate into the nav. */}
          {!tight && (
          <LeaderboardCard
            laps={laps} driver={driver} preferSlug={liveTrackSlug}
            enabled={leaderboardEnabled} cardStyle={cardStyle}
            onOpenBoard={onOpenBoard}
          />
          )}

          {/* Donate. Desktop only — on a phone and in landscape it has moved to
              the end of the nav, where it costs no row of the Dashboard at all.
              The full sentence goes with the card; the nav entry is the icon and
              the word, which is as much as a 62px tab cell can hold. */}
          {!tight && (
          <a href={KOFI_URL} target="_blank" rel="noreferrer" onClick={openExternal(KOFI_URL)} style={{ marginTop: "auto",
            display: "flex", alignItems: "center", justifyContent: "center", gap: 9, textDecoration: "none",
            background: "#1a1024", border: "1px solid #3a2550", borderRadius: 14, padding: "13px 15px",
            cursor: "pointer", fontFamily: FONT.ui }}>
            <span style={{ fontSize: 16 }}>☕</span>
            <span style={{ fontSize: 13, fontWeight: 800, letterSpacing: .3, color: "#e6b4ff" }}>
              Donate — support continued development
            </span>
          </a>
          )}
        </div>

        {/* ── Right: stats ── */}
        <div style={{ flex: "1 1 560px", minWidth: "min(320px, var(--col-min))", display: "flex", flexDirection: "column", gap: 16 }}>
          {!stats.hasLaps ? (
            <div style={{ flex: 1, ...cardStyle, display: "flex", flexDirection: "column", alignItems: "center",
              justifyContent: "center", textAlign: "center", padding: "48px 24px" }}>
              <div style={{ fontSize: 30, marginBottom: 10 }}>📊</div>
              <div style={{ fontSize: 15, fontWeight: 800, marginBottom: 6 }}>No laps yet for {name}</div>
              <div style={{ fontSize: 12, color: C.textMid, maxWidth: 400, lineHeight: 1.55 }}>
                Start the game (or Demo Mode in Settings) and drive a lap — completed laps are saved to this driver's
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
                {/* Recent laps. Desktop only — it is by far the tallest thing on
                    the Dashboard (ten two-line rows), and every lap in it is
                    already listed in Analytics' own lap selector, which is where
                    tapping a row was sending the driver anyway. So on a phone the
                    card costs most of a screen to duplicate a list one tap away,
                    and dropping it leaves the PBs card the whole row. */}
                {!tight && (
                <div style={{ flex: "1.6 1 320px", minWidth: "min(280px, var(--col-min))", ...cardStyle, display: "flex", flexDirection: "column" }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
                    <span style={eyebrow}>Recent Laps</span>
                    <span style={{ fontSize: 9, letterSpacing: 1, color: C.textDim, fontFamily: FONT.mono }}>CLICK → COMPARE</span>
                  </div>
                  <div style={{ flex: 1, minHeight: 0, overflowY: "auto", display: "flex", flexDirection: "column", gap: 6, paddingRight: 4 }}>
                    {stats.recent.map(({ lap, gap }) => {
                      // The five readings, named rather than inlined, so the
                      // two-line arrangement below reads as an arrangement
                      // instead of burying the data in the layout.
                      const lapNo = (
                        <span style={{ fontSize: 10, letterSpacing: 1, color: C.textDim, textTransform: "uppercase", flex: "none" }}>Lap {lap.lapNumber ?? "?"}</span>
                      );
                      const subtitle = (
                        <span style={{ fontSize: 12, color: C.textMid, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0, flex: "1 1 auto" }}>
                          {lap.meta?.track || "—"}{lap.meta?.sessionType ? <span style={{ color: C.textFaint }}> · {lap.meta.sessionType}</span> : null}{tyreLabel(lap.tyre) ? <span style={{ color: tyreCondition(lap.tyre) === "wet" ? "#7fb4e8" : C.textFaint }}> · {tyreLabel(lap.tyre)}</span> : null}
                        </span>
                      );
                      const time = (
                        <span style={{ fontFamily: FONT.mono, fontSize: 15, fontWeight: 800, color: "#fff", flex: "none" }}>{fmt(lap.lapTime)}</span>
                      );
                      const delta = (
                        <span style={{ fontFamily: FONT.mono, fontSize: 12, fontWeight: 700, textAlign: "right", color: gapCol(gap), flex: "none" }}>{gapText(gap)}</span>
                      );
                      const date = (
                        <span style={{ fontSize: 10, color: C.textFaint, fontFamily: FONT.mono, textAlign: "right", flex: "none" }}>{fmtDate(lap.recordedAt)}</span>
                      );
                      return (
                      <button key={lap.id} onClick={() => onSelectLap?.(lap.id)} title="Open in Analytics" style={{
                        // TWO LINES, at every width — this is not a phone
                        // concession. The row carries five readings and its four
                        // fixed columns plus gaps and padding needed 336px, but
                        // this card never gets that much: 329px even at a 1280
                        // desktop, because the Dashboard splits a 686px row
                        // between it and the PBs card, and 273px in a portrait
                        // phone. So the subtitle — the only elastic column, and
                        // `overflow: hidden`, which contributes ZERO to
                        // min-content — was squeezed to 0px and simply never
                        // rendered, on desktop as much as on Android. On a phone
                        // it also pushed the row into a horizontal scroll nobody
                        // could see, the list having `overflowY: auto` and so
                        // `overflow-x: auto` with it.
                        //
                        // Splitting the context (track · session · compound, and
                        // the date) onto its own line keeps every reading rather
                        // than dropping one. It costs 17px a row.
                        display: "flex", flexDirection: "column", gap: 3,
                        background: C.inset, border: `1px solid ${gap != null && gap <= 1e-6 ? "var(--pb-border, #2c2150)" : C.line}`,
                        borderRadius: 8, padding: "9px 13px", cursor: "pointer", fontFamily: FONT.ui, textAlign: "left", width: "100%" }}>
                        <div style={{ display: "flex", alignItems: "baseline", gap: 8, width: "100%", minWidth: 0 }}>
                          {lapNo}
                          <span style={{ marginLeft: "auto", display: "flex", alignItems: "baseline", gap: 8, flex: "none" }}>
                            {time}{delta}
                          </span>
                        </div>
                        <div style={{ display: "flex", alignItems: "baseline", gap: 8, width: "100%", minWidth: 0 }}>
                          {subtitle}{date}
                        </div>
                      </button>
                      );
                    })}
                  </div>
                </div>
                )}

                {/* Personal bests by category — best lap per track within each
                    featured session type (Time Trial / Qualifying / Race), stacked */}
                <div style={{ flex: "1 1 260px", minWidth: "min(240px, var(--col-min))", ...cardStyle, display: "flex", flexDirection: "column" }}>
                  <div style={{ ...eyebrow, marginBottom: 12 }}>Personal Bests by Category</div>
                  <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", gap: 14 }}>
                    {stats.perCategoryBest.map(({ type, tracks }) => {
                      const accent = type === "Qualifying" ? "var(--cat-2, #b45bff)"
                        : type === "Race" ? "var(--cat-3, #2ED573)"
                        : "var(--cat-1, #34c8ff)";
                      return (
                        // Each category takes an equal share of the card's height
                        // on desktop, where the card has a fixed height to divide
                        // and a long track list should scroll inside its own third
                        // rather than push the other two off. On a phone the card
                        // has no fixed height — the screen scrolls — so an equal
                        // share is just a squeeze: with one populated category out
                        // of three, its single 42px lap row was handed 35px and
                        // made to scroll. Size to content there instead.
                        <div key={type} style={{ ...(tight ? { flex: "none" } : { flex: 1, minHeight: 0 }), display: "flex", flexDirection: "column" }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 9 }}>
                            <span style={{ width: 8, height: 8, borderRadius: 2, background: accent, flex: "none" }} />
                            <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: 1, textTransform: "uppercase", color: C.textBody2 }}>{type}</span>
                            <span style={{ fontSize: 9, color: C.textFaint, fontFamily: FONT.mono, marginLeft: "auto" }}>
                              {tracks.length} {tracks.length === 1 ? "TRACK" : "TRACKS"}
                            </span>
                          </div>
                          <div style={{ ...(tight ? { flex: "none" } : { flex: 1, minHeight: 0, overflowY: "auto" }),
                            display: "flex", flexDirection: "column", gap: 5, paddingRight: 2 }}>
                            {tracks.length === 0 && (
                              <div style={{ fontSize: 11, color: C.textFaint, padding: "10px 2px" }}>No {type} laps yet</div>
                            )}
                            {tracks.map((lap) => {
                              const country = getTrackByName(lap.meta?.track)?.country;
                              return (
                                // TWO LINES, at every width — the same arithmetic
                                // that reflowed the recent-lap row, and this row
                                // was the worse of the two. Its five fixed columns
                                // (country, tyre, lap time, wrench, trash) plus
                                // gaps and padding need ~269px and the card never
                                // offers that: 247px at a 1280 desktop, because
                                // the Dashboard splits the row with Recent Laps,
                                // and 265px on a phone. The track NAME is the only
                                // elastic column, so it absorbed the whole
                                // shortfall — measured 4.3px at 1280 and 22.6px on
                                // a phone, i.e. the row's own identifier rendered
                                // as an ellipsis or as nothing at all.
                                //
                                // Splitting it puts the two headline readings on
                                // line 1 and the context plus the controls on
                                // line 2, which keeps every reading. The hit-area
                                // overhangs still only cover non-interactive
                                // things: the wrench now grows left over the tyre
                                // chip rather than the lap time, and the trash
                                // still grows right into the row's own padding.
                                <div key={lap.id} style={{ display: "flex", flexDirection: "column", gap: 3, background: C.inset,
                                  border: `1px solid ${C.line}`, borderRadius: 8, padding: "7px 10px" }}>
                                  <div style={{ display: "flex", alignItems: "baseline", gap: 8, width: "100%", minWidth: 0 }}>
                                    <span style={{ fontSize: 12, color: C.textBody2, fontWeight: 600, flex: "1 1 auto", minWidth: 0,
                                      overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                      {lap.meta?.track || "—"}
                                    </span>
                                    <span style={{ fontFamily: FONT.mono, fontSize: 14, fontWeight: 800, color: C.yellow, flex: "none" }}>{fmt(lap.lapTime)}</span>
                                  </div>
                                  <div style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", minWidth: 0 }}>
                                    {country ? (
                                      <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: 0.5, fontFamily: FONT.mono, color: C.textFaint, flex: "none" }}>{country}</span>
                                    ) : null}
                                    <TyreChip tyre={lap?.tyre} />
                                    <span style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8, flex: "none" }}>
                                      <WrenchBtn onClick={() => onOpenSetup?.(lap)} has={!!lap.setup} />
                                      {onDeleteLap && <TrashBtn onClick={() => confirmDelete(lap)} />}
                                    </span>
                                  </div>
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
      {pendingDelete && (
        <DeleteLapConfirm lap={pendingDelete} onCancel={() => setPendingDelete(null)}
          onConfirm={(lap) => { setPendingDelete(null); onDeleteLap(lap.id); }} />
      )}
    </div>
  );
}

const cardStyle = {
  background: C.surface, border: `1px solid ${C.line}`, borderRadius: "var(--r-lg, 16px)", padding: "18px 20px",
};
