// ─── PUBLISH LAP ────────────────────────────────────────────────────────────
// Confirms sending one of your laps to a public leaderboard.
//
// This dialog exists because publishing is the one irreversible, outward-facing
// thing the app does: the lap becomes visible to everyone, under a name, and the
// driver should see exactly what is about to leave their machine before it does.
//
// It deliberately does NOT ask whether to include the car setup. The file export
// asks that, because a file goes to one person you chose; a board row is public
// and permanent, so the setup is stripped unconditionally and the dialog just
// says so.

import { C, FONT } from "../../lib/ui/tokens.js";
import { formatLapTime } from "../../lib/format.js";
import { tyreLabel, tyreCondition } from "../../lib/tyres.js";
import { boardLabel } from "../../lib/leaderboard/boardKey.js";
import { eligibility } from "../../lib/leaderboard/eligibility.js";

const btn = (border, bg, color) => ({
  padding: "11px 22px", borderRadius: 9, border: `1px solid ${border}`, background: bg,
  color, fontSize: 12, fontWeight: 800, letterSpacing: 0.5, cursor: "pointer", fontFamily: FONT.ui,
});

const Row = ({ label, children }) => (
  <div style={{ display: "flex", alignItems: "baseline", gap: 12, padding: "7px 0" }}>
    <span style={{ fontSize: 9, letterSpacing: 1.5, color: C.textDim, textTransform: "uppercase",
      width: 92, flex: "none" }}>{label}</span>
    <span style={{ fontSize: 13, color: C.textBody2, minWidth: 0 }}>{children}</span>
  </div>
);

export default function PublishLapModal({ lap, driver, busy, result, onConfirm, onClose }) {
  if (!lap) return null;

  const elig = eligibility(lap);
  const board = elig.ok ? elig.board : null;
  const compound = tyreLabel(lap.tyre);
  const wet = tyreCondition(lap.tyre) === "wet";

  return (
    <div onClick={busy ? undefined : onClose} style={{
      position: "fixed", inset: 0, zIndex: 150, background: "rgba(5,7,11,.74)",
      backdropFilter: "blur(4px)", display: "flex", alignItems: "center", justifyContent: "center",
      fontFamily: FONT.ui, padding: 24,
    }}>
      <div onClick={(e) => e.stopPropagation()} style={{
        width: 480, maxWidth: "100%", background: C.modal, border: `1px solid ${C.borderModal}`,
        borderRadius: 16, boxShadow: "0 30px 80px rgba(0,0,0,.6)", overflow: "hidden",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "20px 24px",
          borderBottom: `1px solid ${C.line}` }}>
          <div style={{ width: 5, height: 34, borderRadius: 3, background: C.accent }} />
          <div>
            <div style={{ fontSize: 17, fontWeight: 800, letterSpacing: 0.5, color: C.textHi }}>
              {result ? (result.ok ? "Published" : "Not published") : "Publish this lap?"}
            </div>
            {board && (
              <div style={{ fontSize: 10, letterSpacing: 1.4, color: C.textDim,
                textTransform: "uppercase", marginTop: 3 }}>{boardLabel(board.boardId)}</div>
            )}
          </div>
        </div>

        <div style={{ padding: "16px 24px" }}>
          {/* ── Refused before it left the machine ── */}
          {!elig.ok && !result && (
            <div style={{ fontSize: 13, lineHeight: 1.65, color: C.orange }}>{elig.reason}</div>
          )}

          {/* ── What's about to be sent ── */}
          {elig.ok && !result && (
            <>
              <Row label="Lap">
                <span style={{ fontFamily: FONT.mono, fontSize: 17, fontWeight: 800, color: "#fff" }}>
                  {formatLapTime(lap.lapTime, 3)}
                </span>
                {compound && (
                  <span style={{ marginLeft: 10, fontSize: 11, color: wet ? "#7fb4e8" : C.textFaint }}>
                    {compound}
                  </span>
                )}
              </Row>
              <Row label="Published as">{driver?.name || lap.meta?.driver || "You"}</Row>
              <Row label="Includes">
                Speed, throttle, brake, gear, steering and ERS traces, plus your racing line.
              </Row>
              <Row label="Excludes">
                <span style={{ color: C.green }}>Your car setup.</span>{" "}
                <span style={{ color: C.textMuted }}>Never sent to a board.</span>
              </Row>
              <div style={{ marginTop: 12, padding: "11px 13px", borderRadius: 9,
                background: C.inset, border: `1px solid ${C.line}`,
                fontSize: 12, lineHeight: 1.6, color: C.textMuted }}>
                Anyone can see this lap and download it as their reference. You can only hold one
                lap per board — publishing a faster one later replaces this.
              </div>
            </>
          )}

          {/* ── Outcome ── */}
          {result?.ok && (
            <div style={{ fontSize: 13, lineHeight: 1.7, color: C.textMid }}>
              {result.improved ? (
                <>
                  <div style={{ fontFamily: FONT.mono, fontSize: 30, fontWeight: 800, color: C.purple, lineHeight: 1 }}>
                    P{result.pos}
                  </div>
                  <div style={{ marginTop: 8 }}>
                    of {result.total} {result.total === 1 ? "lap" : "laps"} on this board.
                  </div>
                  {result.verdict === "flagged" && (
                    <div style={{ marginTop: 12, fontSize: 12, color: C.orange }}>
                      One validation check was borderline, so the entry is marked. It still ranks.
                    </div>
                  )}
                </>
              ) : (
                <>{result.reason} You're currently P{result.pos} of {result.total}.</>
              )}
            </div>
          )}
          {result && !result.ok && (
            <div style={{ fontSize: 13, lineHeight: 1.65, color: C.orange }}>{result.reason}</div>
          )}
        </div>

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 12, padding: "16px 24px",
          borderTop: `1px solid ${C.line}`, background: C.bg }}>
          <button onClick={onClose} disabled={busy}
            style={{ ...btn(C.borderStrong, C.surface, C.textMid), opacity: busy ? 0.5 : 1 }}>
            {result ? "Close" : "Cancel"}
          </button>
          {elig.ok && !result && (
            <button onClick={onConfirm} disabled={busy}
              style={{ ...btn(C.blue, C.blue, C.onAccent), opacity: busy ? 0.6 : 1 }}>
              {busy ? "Publishing…" : "Publish"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
