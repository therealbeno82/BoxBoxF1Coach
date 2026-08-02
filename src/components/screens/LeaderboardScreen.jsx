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
import { tyreLabel, tyreCondition } from "../../lib/tyres.js";
import { matchReference } from "../../lib/coach/refMatch.js";
import {
  TRACK_SLUGS, SESSION_TOKENS, SESSION_LABELS, COMPOUND_LABELS,
  trackNameForSlug, boardLabel, BOARD_SEP,
} from "../../lib/leaderboard/boardKey.js";
import { localBoardEntries, entryAsRefLike, secOf } from "../../lib/leaderboard/entries.js";
import { useLeaderboard } from "../../hooks/useLeaderboard.js";

const card = { background: C.surface, border: `1px solid ${C.line}`, borderRadius: 12 };

const eyebrow = {
  fontSize: 10, letterSpacing: 2, color: C.textMuted,
  textTransform: "uppercase", fontWeight: 600,
};

const selectStyle = (color) => ({
  width: "100%", appearance: "none", WebkitAppearance: "none", background: C.surface,
  border: `1px solid ${C.borderStrong}`, borderRadius: 9, color, fontFamily: FONT.mono,
  fontSize: 14, fontWeight: 700, padding: "11px 36px 11px 14px", cursor: "pointer", outline: "none",
});

const caret = {
  position: "absolute", right: 14, top: "50%", transform: "translateY(-50%)",
  pointerEvents: "none", color: C.textFaint, fontSize: 11,
};

const GRID = "48px 1fr 108px 92px repeat(3, 70px) 96px 128px";

const fmtSectorMs = (ms) => (typeof ms === "number" && ms > 0 ? (ms / 1000).toFixed(3) : "—");
const fmtDate = (ms) => (ms ? new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "—");

// Position colouring borrowed from the timing tower: the leader purple, the
// podium green, everyone else neutral.
const posColor = (pos) => (pos === 1 ? C.purple : pos <= 3 ? C.green : C.textMuted);

// Compound chip. Data-meaning colours, so — like every tyre chip in the app —
// these are fixed and never routed through the skin variables.
const TyreChip = ({ visual }) => {
  const label = visual != null ? tyreLabel({ visual }) : null;
  const wet = visual != null && tyreCondition({ visual }) === "wet";
  if (!label) return <span style={{ fontSize: 10, color: C.textFaintest }}>—</span>;
  return (
    <span style={{
      fontSize: 9, letterSpacing: 0.5, fontWeight: 700, textTransform: "uppercase",
      fontFamily: FONT.mono, padding: "2px 6px", borderRadius: 5, whiteSpace: "nowrap",
      color: wet ? "#bcdcff" : C.textDim, background: wet ? "rgba(68,145,210,0.18)" : C.surface,
      border: `1px solid ${wet ? "rgba(68,145,210,0.5)" : C.line}`,
    }}>{label}</span>
  );
};

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
      flex: 1, minHeight: 0, background: C.bgRadial, padding: "20px 28px 26px",
      display: "flex", flexDirection: "column", gap: 16, fontFamily: FONT.ui,
    }}>
      {/* ── Board picker ── */}
      <div style={{ display: "flex", gap: 16, alignItems: "flex-end", flexWrap: "wrap", flex: "none" }}>
        <div style={{ flex: "1 1 260px", minWidth: 200, display: "flex", flexDirection: "column", gap: 5 }}>
          <label style={eyebrow}>Circuit</label>
          <div style={{ position: "relative" }}>
            <select value={slug} onChange={(e) => setSlug(e.target.value)} style={selectStyle("#ffffff")}>
              {TRACK_SLUGS.map((s) => <option key={s} value={s}>{trackNameForSlug(s)}</option>)}
            </select>
            <span style={caret}>▾</span>
          </div>
        </div>

        <div style={{ flex: "1 1 200px", minWidth: 180, display: "flex", flexDirection: "column", gap: 5 }}>
          <label style={eyebrow}>Session</label>
          <div style={{ position: "relative" }}>
            <select value={session} onChange={(e) => setSession(e.target.value)} style={selectStyle("#ffffff")}>
              {SESSION_TOKENS.map((s) => <option key={s} value={s}>{SESSION_LABELS[s]}</option>)}
            </select>
            <span style={caret}>▾</span>
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
        <div style={{
          display: "flex", alignItems: "center", gap: 12, padding: "14px 18px",
          borderBottom: `1px solid ${C.line}`,
        }}>
          <div style={{ width: 5, height: 26, borderRadius: 3, background: C.accent, flex: "none" }} />
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 15, fontWeight: 800, letterSpacing: 0.4, color: C.textHi }}>
              {boardLabel(boardId)}
            </div>
            <div style={{ fontSize: 10, letterSpacing: 1.4, color: statusTone(board.status), textTransform: "uppercase", marginTop: 3 }}>
              {statusLabel(board.status)}
            </div>
          </div>
          <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 14 }}>
            {isLive && (
              <button onClick={board.reload} title="Refresh this board" style={{
                width: 32, height: 32, borderRadius: 8, cursor: "pointer",
                border: `1px solid ${C.line}`, background: C.surface, color: C.textMuted,
                fontSize: 13, lineHeight: 1,
              }}>⟳</button>
            )}
            <div style={{ textAlign: "right" }}>
              <div style={{ fontFamily: FONT.mono, fontSize: 20, fontWeight: 800, color: C.purple, lineHeight: 1 }}>
                {shown.length ? formatLapTime(secOf(shown[0].lapTimeMs), 3) : "—"}
              </div>
              <div style={{ fontSize: 9, letterSpacing: 1.5, color: C.textDim, textTransform: "uppercase", marginTop: 4 }}>
                {shown.length} {shown.length === 1 ? "lap" : "laps"}
              </div>
            </div>
          </div>
        </div>

        {/* Column headers */}
        <div style={{
          display: "grid", gridTemplateColumns: GRID, gap: 10, padding: "10px 18px",
          borderBottom: `1px solid ${C.line}`, flex: "none",
        }}>
          {["", "Driver", "Lap Time", "Gap", "S1", "S2", "S3", "Tyre", ""].map((h, i) => (
            <div key={i} style={{
              fontSize: 9, letterSpacing: 1, color: C.textDim, textTransform: "uppercase",
              textAlign: i >= 4 && i <= 6 ? "center" : i === 2 || i === 3 ? "right" : "left",
            }}>{h}</div>
          ))}
        </div>

        {/* Rows */}
        <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "10px 18px 16px",
          display: "flex", flexDirection: "column", gap: 7 }}>
          {shown.length === 0 ? (
            <EmptyBoard boardId={boardId} filtered={compoundFilter !== "all"} status={board.status} />
          ) : shown.map((e) => {
            const verdict = comparability?.get(e.entryId) ?? null;
            const blocked = verdict && !verdict.ok;
            return (
              <div key={e.entryId} style={{
                display: "grid", gridTemplateColumns: GRID, gap: 10, alignItems: "center",
                background: e.isYou ? C.elevated : C.inset,
                border: `1px solid ${e.isYou ? C.blue : C.line}`,
                borderRadius: 9, padding: "10px 12px",
              }}>
                <span style={{
                  fontFamily: FONT.mono, fontSize: 16, fontWeight: 800, color: posColor(e.pos),
                }}>{e.pos}</span>

                <span style={{ minWidth: 0, display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{
                    fontSize: 13, fontWeight: 700, color: e.isYou ? "#fff" : C.textBody2,
                    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                  }}>{e.displayName}</span>
                  {e.team && (
                    <span style={{ fontSize: 10, color: C.textFaint, whiteSpace: "nowrap" }}>{e.team}</span>
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
                  fontFamily: FONT.mono, fontSize: 15, fontWeight: 800,
                  textAlign: "right", color: "#fff",
                }}>{formatLapTime(secOf(e.lapTimeMs), 3)}</span>

                <span style={{
                  fontFamily: FONT.mono, fontSize: 12, fontWeight: 700, textAlign: "right",
                  color: e.gapMs === 0 ? C.green : C.textMid,
                }}>{e.gapMs === 0 ? "—" : fmtDelta(e.gapMs / 1000)}</span>

                {[0, 1, 2].map((i) => (
                  <span key={i} style={{
                    fontFamily: FONT.mono, fontSize: 12, fontWeight: 600,
                    textAlign: "center", color: C.textMuted,
                  }}>{fmtSectorMs(e.sectorMs?.[i])}</span>
                ))}

                <span style={{ display: "flex", alignItems: "center", gap: 7 }}>
                  <TyreChip visual={e.tyreVisual} />
                  <span style={{ fontSize: 10, color: C.textFaint, fontFamily: FONT.mono }}>
                    {fmtDate(e.recordedAt)}
                  </span>
                </span>

                <UseButton entry={e} blocked={blocked} verdict={verdict} onUse={onUseReference} />
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
function UseButton({ entry, blocked, verdict, onUse }) {
  const reason = blocked ? verdict.reasons[0] : null;
  return (
    <button
      onClick={() => onUse?.(entry)}
      title={reason ? `${reason.title} — ${reason.detail}` : "Load this lap as your reference"}
      style={{
        display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6,
        padding: "0 10px", height: 32, borderRadius: 8, cursor: "pointer",
        fontFamily: FONT.ui, fontSize: 10, letterSpacing: 0.8, textTransform: "uppercase",
        fontWeight: 700, whiteSpace: "nowrap",
        border: `1px solid ${blocked ? "#4a3a12" : C.borderStrong}`,
        background: blocked ? "rgba(255,145,0,0.08)" : C.surface,
        color: blocked ? C.orange : "#9aa3b8",
      }}>
      {blocked ? "⚠ Use anyway" : "↧ Use as ref"}
    </button>
  );
}

// The header's second line. Four outcomes that read very differently to a driver
// and must never be collapsed into one "no data" — an empty board is a correct
// answer, a failed request is not, and at a race weekend with no network the
// difference is the whole point.
function statusLabel(status) {
  switch (status) {
    case "loading": return "Loading…";
    case "ready":   return "Published laps";
    case "offline": return "Offline · showing your own laps";
    case "error":   return "Couldn't reach the leaderboard · showing your own laps";
    default:        return "";
  }
}

function statusTone(status) {
  if (status === "error") return C.orange;
  if (status === "offline") return C.textMuted;
  return C.textDim;
}

function EmptyBoard({ boardId, filtered, status }) {
  const circuit = boardLabel(boardId)?.split(" · ")[0];
  const [title, body] =
    filtered
      ? ["Nothing on that compound", "Clear the tyre filter to see the rest of the board."]
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
      <div style={{ fontSize: 26, marginBottom: 12 }}>{status === "error" ? "⚠" : status === "offline" ? "📡" : "🏁"}</div>
      <div style={{ fontSize: 14, fontWeight: 800, color: C.textMid, marginBottom: 6 }}>{title}</div>
      {body}
    </div>
  );
}
