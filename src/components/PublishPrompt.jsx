// ─── PUBLISH PROMPT ─────────────────────────────────────────────────────────
// "That's your best lap here — put it on the board?"
//
// Appears when a freshly-recorded lap is the driver's own fastest for its board.
// Rendered from BoxBoxApp rather than a screen so it can reach the driver
// whichever tab they're on when the lap completes.
//
// It offers, it doesn't act: publishing is outward-facing and permanent, so the
// prompt only opens the confirmation dialog. Dismissing is one click and the
// same lap never asks twice.

import { C, FONT } from "../lib/ui/tokens.js";
import { formatLapTime } from "../lib/format.js";
import { boardLabel } from "../lib/leaderboard/boardKey.js";
import { boardIdForLap } from "../lib/leaderboard/boardKey.js";

export default function PublishPrompt({ lap, onPublish, onDismiss }) {
  if (!lap) return null;
  const { boardId } = boardIdForLap(lap);

  return (
    <div style={{
      position: "fixed", right: 22, bottom: 22, zIndex: 120, width: 320,
      background: C.modal, border: `1px solid ${C.borderModal}`, borderRadius: 13,
      boxShadow: "0 20px 60px rgba(0,0,0,.55)", fontFamily: FONT.ui, overflow: "hidden",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "13px 15px 0" }}>
        <span style={{ fontSize: 17 }}>🏆</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 800, color: C.textHi }}>Your best here</div>
          <div style={{ fontSize: 9, letterSpacing: 1.3, color: C.textDim,
            textTransform: "uppercase", marginTop: 2, overflow: "hidden",
            textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{boardLabel(boardId)}</div>
        </div>
        <span style={{ fontFamily: FONT.mono, fontSize: 16, fontWeight: 800, color: C.purple }}>
          {formatLapTime(lap.lapTime, 3)}
        </span>
      </div>

      <div style={{ padding: "10px 15px 0", fontSize: 12, lineHeight: 1.55, color: C.textMuted }}>
        Publish it to the leaderboard so other drivers can use it as a reference?
      </div>

      <div style={{ display: "flex", gap: 8, padding: "13px 15px 15px" }}>
        <button onClick={onDismiss} style={{
          flex: 1, padding: "9px 0", borderRadius: 8, cursor: "pointer", fontFamily: FONT.ui,
          border: `1px solid ${C.borderStrong}`, background: C.surface, color: C.textMid,
          fontSize: 11, fontWeight: 800, letterSpacing: 0.4,
        }}>Not now</button>
        <button onClick={onPublish} style={{
          flex: 1, padding: "9px 0", borderRadius: 8, cursor: "pointer", fontFamily: FONT.ui,
          border: `1px solid ${C.blue}`, background: C.blue, color: C.onAccent,
          fontSize: 11, fontWeight: 800, letterSpacing: 0.4,
        }}>Publish</button>
      </div>
    </div>
  );
}
