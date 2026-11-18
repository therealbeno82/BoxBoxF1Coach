// ─── LEADERBOARD SCREEN ─────────────────────────────────────────────────────
// Reference laps other drivers have published, ranked fastest-first, split by
// circuit and session type. Pick a row and it becomes your reference lap — the
// same one the corner calls, the delta traces and the debrief all measure against.
//
// The table is deliberately source-agnostic (see lib/leaderboard/entries.js): it
// renders the same row shape whether it came from the online board or from this
// driver's own stored laps. Until the online board is wired up it shows the local
// preview, which is also what the empty/offline states fall back to.
//
// Compound is NOT one of the board's axes — a board is "the fastest lap set here
// in this session type", full stop. But lib/coach/refMatch.js still refuses to
// coach against a reference on different rubber, so every row shows its compound
// and its comparability against the driver's own recent running. Picking a
// reference the coach would then mute is the one trap this screen has to avoid.

import { useMemo, useState } from "react";
import { C, FONT, fmtDelta } from "../../lib/ui/tokens.js";
import { formatLapTime } from "../../lib/format.js";
import { matchReference } from "../../lib/coach/refMatch.js";
import {
  TRACK_SLUGS, SESSION_TOKENS, SESSION_LABELS, COMPOUND_LABELS,
  trackNameForSlug, trackDisplayName, boardLabel, parseBoardId, BOARD_SEP,
} from "../../lib/leaderboard/boardKey.js";
import { localBoardEntries, entryAsRefLike, secOf } from "../../lib/leaderboard/entries.js";
import { useLeaderboard } from "../../hooks/useLeaderboard.js";
import { useViewport } from "../../hooks/useViewport.jsx";
import TyreChip from "../TyreChip.jsx";
import { assistLabels } from "../../lib/leaderboard/validate.js";
import { ConfirmDialog } from "../ModalShell.jsx";

const card = { background: C.surface, border: `1px solid ${C.line}`, borderRadius: 12 };

const eyebrow = {
  fontSize: 10, letterSpacing: 2, color: C.textMuted,
  textTransform: "uppercase", fontWeight: 600,
};
const eyebrowPhone = { ...eyebrow, fontSize: 8, letterSpacing: 1 };

// The phone variant is 32px rather than 42 to save vertical space, but it no
// longer sets `minHeight: 0` to get there. These two selects ARE the board —
// picking a circuit and a session is the only way to reach any other page of
// it — and at 32px they were the last controls on the screen under the
// coarse-pointer floor. Keeping `height: 32` means a fine pointer at the same
// width still gets the compact box; only a finger gets the taller one.
const selectStyle = (color, phone = false) => ({
  width: "100%", appearance: "none", WebkitAppearance: "none", background: C.surface,
  border: `1px solid ${C.borderStrong}`, borderRadius: phone ? 7 : 9, color, fontFamily: FONT.mono,
  fontSize: phone ? 12 : 14, fontWeight: 700,
  padding: phone ? "0 26px 0 10px" : "11px 36px 11px 14px",
  ...(phone && { height: 32 }),
  cursor: "pointer", outline: "none",
});

const caret = {
  position: "absolute", right: 14, top: "50%", transform: "translateY(-50%)",
  pointerEvents: "none", color: C.textFaint, fontSize: 11,
};
const caretPhone = { ...caret, right: 9, fontSize: 9 };

// Nine columns at ~760px minimum, which a phone cannot show. Rather than let the
// far side get silently clipped (there is no horizontal scroller here, and adding
// one would desync the header from the rows — they're separate containers), the
// narrow breakpoint drops to five columns and the cells that fall outside are
// marked `.lb-secondary` for index.html's media query to hide. Position, driver,
// lap time and gap are what a board is actually read for; sector splits and the
// tyre/date chip are detail you go to Analytics for.
const GRID = "var(--grid-board-row)";

const fmtSectorMs = (ms) => (typeof ms === "number" && ms > 0 ? (ms / 1000).toFixed(3) : "—");
const fmtDate = (ms) => (ms ? new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "—");

// Position colouring borrowed from the timing tower: the leader purple, the
// podium green, everyone else neutral.
const posColor = (pos) => (pos === 1 ? C.purple : pos <= 3 ? C.green : C.textMuted);

export default function LeaderboardScreen({
  laps = [],
  driver,
  // The lap the driver most recently ran, used only to preview whether a given
  // entry would be a usable reference. Null before anything has been driven, in
  // which case no comparability claim is made either way.
  recentLap = null,
  // Which board to open on — normally the circuit currently loaded in the game.
  initialSlug = null,
  enabled = true,
  onUseReference,
}) {
  // `phone` for layout, `coarse` for tap size — a landscape phone clears the
  // 639px breakpoint and takes the desktop controls, so width floors have to key
  // on the pointer or they never reach it.
  const { phone, coarse } = useViewport();
  const [slug, setSlug] = useState(initialSlug && TRACK_SLUGS.includes(initialSlug) ? initialSlug : TRACK_SLUGS[0]);
  const [session, setSession] = useState(SESSION_TOKENS[0]);
  const [compoundFilter, setCompoundFilter] = useState("all");

  const boardId = `${slug}${BOARD_SEP}${session}`;

  // This screen owns its board selection, so it owns the fetch for it — pushing
  // the selection up to BoxBoxApp just to hand the rows back down would buy
  // nothing, since nothing else in the app reads them.
  const board = useLeaderboard(boardId, { enabled });

  // This driver's own laps on this board, all of them ranked against each other
  // rather than collapsed to their best — the more useful view of your own
  // running, and the fallback when the online board can't be reached.
  const localEntries = useMemo(
    () => localBoardEntries(laps, boardId, { driver, onePerDriver: false }),
    [laps, boardId, driver]);

  // Offline or failed → show the driver their own laps rather than an empty
  // screen. The banner says which they're looking at, so a local preview is
  // never mistaken for the real board being empty.
  const isLive = board.status === "ready" || board.status === "loading";
  const entries = isLive ? board.entries : localEntries;

  // Compound chips offered are only the ones actually present on this board.
  const compoundsPresent = useMemo(() => {
    const set = new Set(entries.map((e) => e.compound).filter(Boolean));
    return [...set];
  }, [entries]);

  const shown = useMemo(
    () => (compoundFilter === "all" ? entries : entries.filter((e) => e.compound === compoundFilter)),
    [entries, compoundFilter]);

  // Would this entry actually work as a reference for the driver's recent
  // running? matchReference is the same gate the coach applies, so asking it here
  // means the answer shown is the answer the coach will give.
  const comparability = useMemo(() => {
    if (!recentLap) return null;
    const trackName = trackNameForSlug(slug);
    const sessionLabel = SESSION_LABELS[session];
    const map = new Map();
    for (const e of shown) {
      const verdict = matchReference(recentLap, entryAsRefLike(e, { trackName, sessionLabel }));
      map.set(e.entryId, verdict);
    }
    return map;
  }, [shown, recentLap, slug, session]);

  return (
    <div style={{
      flex: 1, minHeight: 0, background: C.bgRadial, padding: "20px var(--screen-px) 26px",
      display: "flex", flexDirection: "column", gap: 16, fontFamily: FONT.ui,
    }}>
      {/* ── Board picker ── */}
      <div style={{ display: "flex", gap: phone ? 7 : 16, alignItems: "flex-end", flexWrap: "wrap", flex: "none" }}>
        <div style={{ flex: "1 1 260px", minWidth: "min(200px, var(--col-min))", display: "flex", flexDirection: "column", gap: phone ? 2 : 5 }}>
          <label style={phone ? eyebrowPhone : eyebrow}>Circuit</label>
          <div style={{ position: "relative" }}>
            <select value={slug} onChange={(e) => setSlug(e.target.value)} style={selectStyle("#ffffff", phone)}>
              {/* In calendar order, not alphabetical — the driver is looking for
                  "the next one" far more often than for a name. */}
              {TRACK_SLUGS.map((s) => <option key={s} value={s}>{trackDisplayName(s)}</option>)}
            </select>
            <span style={phone ? caretPhone : caret}>▾</span>
          </div>
        </div>

        <div style={{ flex: "1 1 200px", minWidth: phone ? 0 : 180, display: "flex", flexDirection: "column", gap: phone ? 2 : 5 }}>
          <label style={phone ? eyebrowPhone : eyebrow}>Session</label>
          <div style={{ position: "relative" }}>
            <select value={session} onChange={(e) => setSession(e.target.value)} style={selectStyle("#ffffff", phone)}>
              {SESSION_TOKENS.map((s) => <option key={s} value={s}>{SESSION_LABELS[s]}</option>)}
            </select>
            <span style={phone ? caretPhone : caret}>▾</span>
          </div>
        </div>

        {/* Compound is a filter, not an axis — the rows are already loaded, so
            narrowing them costs nothing and no board is split by it. */}
        {compoundsPresent.length > 1 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
            <label style={eyebrow}>Tyre</label>
            <div style={{ display: "flex", gap: 6 }}>
              {["all", ...compoundsPresent].map((c) => (
                <button key={c} onClick={() => setCompoundFilter(c)} style={{
                  padding: "10px 12px", borderRadius: 8, cursor: "pointer", fontFamily: FONT.ui,
                  fontSize: 11, fontWeight: 700, letterSpacing: 0.5,
                  border: `1px solid ${compoundFilter === c ? C.blue : C.line}`,
                  background: compoundFilter === c ? C.elevated : C.surface,
                  color: compoundFilter === c ? "#fff" : C.textMid,
                }}>{c === "all" ? "All" : (COMPOUND_LABELS[c] || c)}</button>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* ── Board ── */}
      <div style={{ flex: 1, minHeight: 0, ...card, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        {/* On a phone the two selects directly above already name the circuit and
            the session, so this header only has to confirm which board loaded —
            one line at a smaller size, ellipsised rather than wrapped to two. */}
        <div style={{
          display: "flex", alignItems: "center", gap: phone ? 8 : 12, padding: phone ? "8px 10px" : "14px 18px",
          borderBottom: `1px solid ${C.line}`,
        }}>
          <div style={{ width: phone ? 4 : 5, height: phone ? 22 : 26, borderRadius: 3, background: C.accent, flex: "none" }} />
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: phone ? 11 : 15, fontWeight: 800, letterSpacing: 0.4, color: C.textHi,
              ...(phone && { whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }) }}>
              {boardLabel(boardId)}
            </div>
            <div style={{ fontSize: phone ? 8 : 10, letterSpacing: phone ? 1 : 1.4, color: statusTone(board.status), textTransform: "uppercase", marginTop: phone ? 2 : 3,
              whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              {statusLabel(board.status)}
            </div>
          </div>
          <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: phone ? 8 : 14, flex: "none" }}>
            {/* 44 wide on any TOUCH screen — `coarse`, not `phone`, because a
                landscape phone is 873px wide and takes the desktop 32px path —
                and no `minHeight: 0` opt-out, so the coarse-pointer floor in
                index.html can lift the height to match. This measured 26×26
                before, the smallest target on the screen, and it is the only way
                to re-read a stale board. A mouse still gets the compact box. */}
            {isLive && (
              <button onClick={board.reload} title="Refresh this board" aria-label="Refresh this board" style={{
                width: coarse ? 44 : 32, height: phone ? 26 : 32,
                borderRadius: phone ? 7 : 8, cursor: "pointer",
                border: `1px solid ${C.line}`, background: C.surface, color: C.textMuted,
                fontSize: phone ? 11 : 13, lineHeight: 1,
              }}>⟳</button>
            )}
            <div style={{ textAlign: "right" }}>
              <div style={{ fontFamily: FONT.mono, fontSize: phone ? 14 : 20, fontWeight: 800, color: C.purple, lineHeight: 1, whiteSpace: "nowrap" }}>
                {shown.length ? formatLapTime(secOf(shown[0].lapTimeMs), 3) : "—"}
              </div>
              <div style={{ fontSize: phone ? 8 : 9, letterSpacing: phone ? 1 : 1.5, color: C.textDim, textTransform: "uppercase", marginTop: phone ? 3 : 4, whiteSpace: "nowrap" }}>
                {shown.length} {shown.length === 1 ? "lap" : "laps"}
              </div>
            </div>
          </div>
        </div>

        {/* Column headers */}
        <div style={{
          display: "grid", gridTemplateColumns: GRID, gap: phone ? 6 : 10, padding: phone ? "6px 10px" : "10px 18px",
          borderBottom: `1px solid ${C.line}`, flex: "none",
        }}>
          {/* The four detail columns are dropped OUTRIGHT on a phone rather than
              left to `.lb-secondary`'s display:none — the matching row cells carry
              an inline `display`, which beats the stylesheet, so one of them stayed
              visible and pushed the whole row onto a second grid line. */}
          {["", "Driver", "Lap Time", "Gap", "S1", "S2", "S3", "Tyre", ""]
            .map((h, i) => [h, i]).filter(([, i]) => !(phone && i >= 4 && i <= 7)).map(([h, i]) => (
            <div key={i} className={i >= 4 && i <= 7 ? "lb-secondary" : undefined} style={{
              fontSize: 9, letterSpacing: 1, color: C.textDim, textTransform: "uppercase",
              textAlign: i >= 4 && i <= 6 ? "center" : i === 2 || i === 3 ? "right" : "left",
            }}>{h}</div>
          ))}
        </div>

        {/* Rows */}
        <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: phone ? "8px 10px 12px" : "10px 18px 16px",
          display: "flex", flexDirection: "column", gap: phone ? 5 : 7 }}>
          {shown.length === 0 ? (
            <EmptyBoard boardId={boardId} filtered={compoundFilter !== "all"} status={board.status} />
          ) : shown.map((e) => {
            const verdict = comparability?.get(e.entryId) ?? null;
            const blocked = verdict && !verdict.ok;
            return (
              <div key={e.entryId} style={{
                display: "grid", gridTemplateColumns: GRID, gap: phone ? 6 : 10, alignItems: "center",
                background: e.isYou ? C.elevated : C.inset,
                border: `1px solid ${e.isYou ? C.blue : C.line}`,
                borderRadius: 9, padding: phone ? "7px 8px" : "10px 12px",
              }}>
                <span style={{
                  fontFamily: FONT.mono, fontSize: phone ? 13 : 16, fontWeight: 800, color: posColor(e.pos),
                }}>{e.pos}</span>

                <span style={{ minWidth: 0, display: "flex", alignItems: "center", gap: phone ? 5 : 8 }}>
                  <span style={{
                    fontSize: phone ? 11 : 13, fontWeight: 700, color: e.isYou ? "#fff" : C.textBody2,
                    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                  }}>{e.displayName}</span>
                  {/* The team is dropped on a phone: it and the driver share one
                      ~110px cell, and a nowrap team name wins that fight — which
                      is how "R…" ended up standing in for a driver. */}
                  {e.team && !phone && (
                    <span style={{ fontSize: 10, color: C.textFaint, whiteSpace: "nowrap" }}>{e.team}</span>
                  )}
                  {assistLabels(e.assists).length > 0 && (
                    <span title={`Set with: ${assistLabels(e.assists).join(", ")} (as the game reported it)`}
                      style={{
                        fontSize: 7.5, fontWeight: 800, letterSpacing: 0.4, color: C.textMuted,
                        textTransform: "uppercase", border: `1px solid ${C.borderStrong}`,
                        borderRadius: 4, padding: "0 4px", whiteSpace: "nowrap",
                      }}>Aids</span>
                  )}
                  {e.verdict === "flagged" && (
                    <span title="This lap passed validation but one check was borderline."
                      style={{
                        fontSize: 7.5, fontWeight: 800, letterSpacing: 0.4, color: C.orange,
                        textTransform: "uppercase", border: `1px solid ${C.orange}`,
                        borderRadius: 4, padding: "0 4px", whiteSpace: "nowrap",
                      }}>Flagged</span>
                  )}
                </span>

                <span style={{
                  fontFamily: FONT.mono, fontSize: phone ? 13 : 15, fontWeight: 800,
                  textAlign: "right", color: "#fff", whiteSpace: "nowrap",
                }}>{formatLapTime(secOf(e.lapTimeMs), 3)}</span>

                <span style={{
                  fontFamily: FONT.mono, fontSize: phone ? 11 : 12, fontWeight: 700, textAlign: "right",
                  whiteSpace: "nowrap",
                  color: e.gapMs === 0 ? C.green : C.textMid,
                }}>{e.gapMs === 0 ? "—" : fmtDelta(e.gapMs / 1000)}</span>

                {!phone && [0, 1, 2].map((i) => (
                  <span key={i} className="lb-secondary" style={{
                    fontFamily: FONT.mono, fontSize: 12, fontWeight: 600,
                    textAlign: "center", color: C.textMuted,
                  }}>{fmtSectorMs(e.sectorMs?.[i])}</span>
                ))}

                {!phone && (
                  <span className="lb-secondary" style={{ display: "flex", alignItems: "center", gap: 7 }}>
                    <TyreChip tyre={e.tyreVisual != null ? { visual: e.tyreVisual } : null} untagged="dash" />
                    <span style={{ fontSize: 10, color: C.textFaint, fontFamily: FONT.mono }}>
                      {fmtDate(e.recordedAt)}
                    </span>
                  </span>
                )}

                <UseButton entry={e} blocked={blocked} verdict={verdict} onUse={onUseReference} phone={phone} coarse={coarse} />
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// The action that makes an entry the active reference. When matchReference says
// the coach wouldn't accept it, the button still works — the driver may well want
// to look at the traces — but it says so first, naming the actual mismatch rather
// than letting the coach go quiet later with no explanation.
//
// On a touch screen the reason can't live in a tooltip — a finger never hovers, so
// a blocked row showed a bare ⚠ and nothing else. There the tap asks first, with
// the reason written out, and "Use anyway" goes ahead.
function UseButton({ entry, blocked, verdict, onUse, phone = false, coarse = false }) {
  const reason = blocked ? verdict.reasons[0] : null;
  const [asking, setAsking] = useState(false);
  const label = reason ? `${reason.title} — ${reason.detail}` : "Load this lap as your reference";
  return (
    <>
    <button
      onClick={() => (reason && coarse ? setAsking(true) : onUse?.(entry))}
      title={label} aria-label={reason ? `Use anyway: ${label}` : label}
      style={{
        display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6,
        padding: phone ? 0 : "0 10px", height: phone ? 26 : 32, ...(phone && { width: coarse ? 44 : 32 }),
        borderRadius: 8, cursor: "pointer",
        fontFamily: FONT.ui, fontSize: phone ? 12 : 10, letterSpacing: 0.8, textTransform: "uppercase",
        fontWeight: 700, whiteSpace: "nowrap",
        border: `1px solid ${blocked ? "#4a3a12" : C.borderStrong}`,
        background: blocked ? "rgba(255,145,0,0.08)" : C.surface,
        color: blocked ? C.orange : "#9aa3b8",
      }}>
      {/* No room for the words in a 32px column — the tooltip carries them, and a
          blocked entry still declares itself with the warning glyph + colour. */}
      {phone ? (blocked ? "⚠" : "↧") : (blocked ? "⚠ Use anyway" : "↧ Use as ref")}
    </button>
    {asking && (
      <ConfirmDialog title={reason.title} confirmLabel="Use anyway"
        onConfirm={() => { setAsking(false); onUse?.(entry); }} onCancel={() => setAsking(false)}>
        {reason.detail}
        <div style={{ marginTop: 10, color: C.textMuted }}>
          You can still load it to look at the traces, but the coach won't compare your laps against it.
        </div>
      </ConfirmDialog>
    )}
    </>
  );
}

// The header's second line. Four outcomes that read very differently to a driver
// and must never be collapsed into one "no data" — an empty board is a correct
// answer, a failed request is not, and at a race weekend with no network the
// difference is the whole point.
function statusLabel(status) {
  switch (status) {
    case "loading":  return "Loading…";
    case "ready":    return "Published laps";
    case "disabled": return "Leaderboards off · showing your own laps";
    case "offline":  return "Offline · showing your own laps";
    case "error":    return "Couldn't reach the leaderboard · showing your own laps";
    default:         return "";
  }
}

function statusTone(status) {
  if (status === "error") return C.orange;
  if (status === "offline" || status === "disabled") return C.textMuted;
  return C.textDim;
}

function EmptyBoard({ boardId, filtered, status }) {
  // Prose, not a label — "a lap at Silverstone" reads better than "a lap at
  // Great Britain – Silverstone", so this is the one place that wants the short name.
  const circuit = trackNameForSlug(parseBoardId(boardId)?.slug) ?? "this circuit";
  const [title, body] =
    filtered
      ? ["Nothing on that compound", "Clear the tyre filter to see the rest of the board."]
    : status === "disabled"
      ? ["Leaderboards are turned off", `Turn them on in Settings to see laps other drivers have published at ${circuit}.`]
    : status === "offline"
      ? ["No network", `You haven't driven a Qualifying or Time Trial lap at ${circuit} either — published laps will appear here once you're back online.`]
    : status === "error"
      ? ["Couldn't load this board", "The leaderboard server didn't answer. Your own laps would show here in the meantime, but there aren't any for this board yet."]
      : ["Nobody has published a lap here yet", `Drive a Qualifying or Time Trial lap at ${circuit} and publish it to open this board.`];

  return (
    <div style={{
      margin: "auto", textAlign: "center", color: C.textFaint,
      fontSize: 12, lineHeight: 1.7, padding: "40px 20px", maxWidth: 420,
    }}>
      <div style={{ fontSize: 26, marginBottom: 12 }}>
        {status === "error" ? "⚠" : status === "offline" ? "📡" : status === "disabled" ? "🔕" : "🏁"}
      </div>
      <div style={{ fontSize: 14, fontWeight: 800, color: C.textMid, marginBottom: 6 }}>{title}</div>
      {body}
    </div>
  );
}
