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
import ModalShell, { modalBtn } from "../ModalShell.jsx";

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

  // Every way out — backdrop, Escape, Android back — goes inert mid-upload
  // (`dismissable`). Back still CONSUMES the press then: swallowing it during a
  // publish is the point, since the alternative is the activity dying halfway
  // through one. Escape used to do nothing here at all.
  return (
    <ModalShell onClose={onClose} dismissable={!busy} width={480}
      title={result ? (result.ok ? "Published" : "Not published") : "Publish this lap?"}
      subtitle={board ? boardLabel(board.boardId) : null}
      footer={<>
        <button onClick={onClose} disabled={busy}
          style={{ ...modalBtn("secondary"), opacity: busy ? 0.5 : 1 }}>
          {result ? "Close" : "Cancel"}
        </button>
        {elig.ok && !result && (
          <button onClick={onConfirm} disabled={busy}
            style={{ ...modalBtn("primary"), opacity: busy ? 0.6 : 1 }}>
            {busy ? "Publishing…" : "Publish"}
          </button>
        )}
      </>}>
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
    </ModalShell>
  );
}
