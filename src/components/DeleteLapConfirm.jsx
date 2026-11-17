// ─── DELETE-LAP CONFIRMATION ────────────────────────────────────────────────
// The one question asked before a lap is destroyed, wherever the delete button
// lives (Dashboard PB rows, Analytics' lap selectors). Deleting is irreversible:
// the lap leaves IndexedDB and every board and tally is re-derived without it.
// Both screens ask the same question in the same words, so the answer a driver
// learns on one holds on the other.

import { C, FONT } from "../lib/ui/tokens.js";
import { formatLapTime } from "../lib/format.js";
import { ConfirmDialog } from "./ModalShell.jsx";

export default function DeleteLapConfirm({ lap, onConfirm, onCancel }) {
  if (!lap) return null;
  const where = lap.meta?.track || "this track";
  const type = lap.meta?.sessionType ? ` · ${lap.meta.sessionType}` : "";
  return (
    <ConfirmDialog title="Delete this lap?" danger confirmLabel="Delete lap"
      onConfirm={() => onConfirm(lap)} onCancel={onCancel}>
      <div style={{ color: C.textHi, fontWeight: 700 }}>{where}{type}</div>
      <div style={{ fontFamily: FONT.mono, fontSize: 17, fontWeight: 800, color: "#fff", margin: "4px 0 12px" }}>
        {formatLapTime(lap.lapTime, 3)}
      </div>
      This permanently removes the lap and recalculates your personal bests and tallies.
      It cannot be undone.
    </ConfirmDialog>
  );
}
