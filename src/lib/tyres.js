// ─── TYRE COMPOUNDS ───────────────────────────────────────────────────────────
// Resolve the F1 25/26 UDP tyre-compound codes (CarStatus packet) to a name +
// colour, and bucket a lap as dry vs wet. The bridge forwards the *visual*
// compound (the driver-facing name on the sidewall) plus the *actual* compound
// (the underlying C0–C6 spec); we label laps by the visual one. The dry/wet split
// is what lets a lap set on Intermediates or Wets be filed apart from dry laps so
// it never has to compete with a dry personal best.

// Visual compound codes the game emits (F1 22+ Format): 16 Soft · 17 Medium ·
// 18 Hard · 7 Intermediate · 8 Wet. We also keep the legacy classic-tyre codes
// (3–6, 10, 15) so older replays still resolve, plus the actual C0–C6 specs that
// appear in m_actualTyreCompound. Wet rubber is the {7,8,10,15} set.
const VISUAL = {
  7: "Intermediate", 8: "Wet",
  16: "Soft", 17: "Medium", 18: "Hard",
  // Legacy / classic visual codes
  3: "Soft", 4: "Medium", 5: "Hard", 6: "Super Hard", 10: "Wet", 15: "Wet",
};

// Actual compound (m_actualTyreCompound) → spec name, for when we want precision.
const ACTUAL = {
  7: "Intermediate", 8: "Wet",
  16: "C5", 17: "C4", 18: "C3", 19: "C2", 20: "C1", 21: "C0", 22: "C6",
};

const WET_CODES = new Set([7, 8, 10, 15]); // Intermediate + Wet (incl. legacy)

// Driver-facing name for a visual compound code, or null if unknown / absent.
export function tyreName(visualCode) {
  return VISUAL[visualCode] ?? null;
}

// Underlying spec name for an actual compound code (e.g. "C3"), or null.
export function actualTyreName(actualCode) {
  return ACTUAL[actualCode] ?? null;
}

// "wet" | "dry" | null — bucket a lap by the visual compound it was set on. Pass
// the lap's stored tyre tag (lap.tyre) or a raw visual code. null when untagged
// (laps recorded before tyre data was collected), so callers can treat history
// without compound info as "unknown" rather than mis-bucketing it as dry.
export function tyreCondition(tyreOrCode) {
  const code = typeof tyreOrCode === "number" ? tyreOrCode : tyreOrCode?.visual;
  if (typeof code !== "number" || code < 0) return null;
  return WET_CODES.has(code) ? "wet" : "dry";
}

// Short label for a lap's tyre tag, e.g. "Inter" / "Wet" / "Soft" — or null when
// the lap carries no compound. Used in the lap log and dashboard PB rows.
export function tyreLabel(tyre) {
  const name = tyreName(tyre?.visual);
  if (!name) return null;
  return name === "Intermediate" ? "Inter" : name;
}
