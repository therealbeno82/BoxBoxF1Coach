// ─── TYRE COMPOUNDS ───────────────────────────────────────────────────────────
// Resolve the F1 25/26 UDP tyre-compound codes (CarStatus packet) to a name +
// colour, and bucket a lap as dry vs wet. The telemetry core forwards the *visual*
// compound (the driver-facing name on the sidewall) plus the *actual* compound
// (the underlying C0–C6 spec); we label laps by the visual one. The dry/wet split
// is what lets a lap set on Intermediates or Wets be filed apart from dry laps so
// it never has to compete with a dry personal best.

// Visual compound codes the game emits (F1 22+ Format): 16 Soft · 17 Medium ·
// 18 Hard · 7 Intermediate · 8 Wet. We also keep the legacy classic-tyre codes
// (3–6, 10, 15) so older replays still resolve. Wet rubber is the {7,8,10,15} set.
const VISUAL = {
  7: "Intermediate", 8: "Wet",
  16: "Soft", 17: "Medium", 18: "Hard",
  // Legacy / classic visual codes
  3: "Soft", 4: "Medium", 5: "Hard", 6: "Super Hard", 10: "Wet", 15: "Wet",
};

const WET_CODES = new Set([7, 8, 10, 15]); // Intermediate + Wet (incl. legacy)

// Driver-facing name for a visual compound code, or null if unknown / absent.
export function tyreName(visualCode) {
  return VISUAL[visualCode] ?? null;
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

// The sidewall colours F1 uses for each compound. These carry DATA meaning (which
// rubber is on the car), so — like flags and ERS modes — they stay fixed and are
// never routed through the skin vars.
const COMPOUND_COLOR = {
  Soft: "#e8283c", Medium: "#f5d020", Hard: "#e8e8e8",
  "Super Hard": "#e8e8e8", Intermediate: "#3fc45f", Wet: "#2f7fe0",
};
export function tyreColor(tyre) {
  return COMPOUND_COLOR[tyreName(typeof tyre === "number" ? tyre : tyre?.visual)] || null;
}

// Worst-wheel wear % for a lap's tyre tag — the number that actually limits a
// stint. null when the lap carries no wear data (laps recorded before wear was
// collected, or a game that never sent Car Damage).
export function tyreWearPct(tyre) {
  const w = tyre?.wear;
  if (!Array.isArray(w) || w.length !== 4) return null;
  const max = Math.max(...w.map((v) => (typeof v === "number" && isFinite(v) ? v : 0)));
  return isFinite(max) ? max : null;
}

// Per-wheel wear % for a lap's tyre tag, as { fl, fr, rl, rr } — what the lap log
// actually prints, since a front-limited stint and a rear-limited one need
// opposite fixes. The stored array is the game's Car Damage wheel order
// (RL RR FL FR); this is the only place that ordering is decoded. null when the
// lap carries no wear data.
export function tyreWearWheels(tyre) {
  const w = tyre?.wear;
  if (!Array.isArray(w) || w.length !== 4) return null;
  const num = (v) => (typeof v === "number" && isFinite(v) ? v : null);
  const [rl, rr, fl, fr] = w.map(num);
  if (rl == null && rr == null && fl == null && fr == null) return null;
  return { fl, fr, rl, rr };
}
