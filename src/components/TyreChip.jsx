// ─── TYRE CHIP ─────────────────────────────────────────────────────────────────
// The compound tag beside a lap time (Dashboard PB rows, leaderboard rows). One
// component because the two screens had drifted into two copies of the same chip.
// Data-meaning colours, so — like every tyre chip in the app — these are fixed and
// never routed through the skin variables: wet rubber blue, dry neutral.
//
// `tyre` is the lap's tyre tag ({ visual, … }) or null. With no compound to name,
// `untagged` decides what shows: "condition" folds it into the Dry/Wet word (the
// PB tables, which bucket every lap by condition), "dash" shows a quiet dash (a
// board row, where an unknown compound is just unknown).

import { C, FONT } from "../lib/ui/tokens.js";
import { tyreLabel, tyreCondition } from "../lib/tyres.js";

export default function TyreChip({ tyre, untagged = "condition" }) {
  const label = tyreLabel(tyre);
  const wet = tyreCondition(tyre) === "wet";
  if (!label && untagged === "dash") return <span style={{ fontSize: 10, color: C.textFaintest }}>—</span>;
  return (
    <span style={{
      fontSize: 9, letterSpacing: 0.5, fontWeight: 700, textTransform: "uppercase",
      fontFamily: FONT.mono, padding: "2px 6px", borderRadius: 5, whiteSpace: "nowrap",
      color: wet ? "#bcdcff" : C.textDim, background: wet ? "rgba(68,145,210,0.18)" : C.surface,
      border: `1px solid ${wet ? "rgba(68,145,210,0.5)" : C.line}`,
    }}>{label || (wet ? "Wet" : "Dry")}</span>
  );
}
