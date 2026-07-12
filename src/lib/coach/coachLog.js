// ─── COACH LOG (structured per-channel analysis) ────────────────────────────
// The structured view for the Coach Log screen. It groups the user-vs-reference
// deltas into per-channel insights (Braking / Throttle / ERS / Line / Gear) and a
// "potential gain" per channel.
//
// The potential gain is REAL seconds, attributed by the shared physical time model
// in lapAnalysis.js (the segment-by-segment 1/v time delta), NOT a unit-mixed
// weight — so a 0.20s braking loss and a 0.08s line loss are directly comparable.
// When both lap times are known the per-channel seconds are scaled to reconcile
// with the measured lap-time delta; otherwise the modeled estimate is shown and
// flagged as such (`estimated`). Deterministic — works with no LLM; the screen can
// still overlay an LLM next-lap focus and debrief when available.

import { analyzeLap, rankFindings, reconcile } from "./lapAnalysis.js";
import { clamp } from "../format.js";

const C = { line: "#2ED573", gear: "#b45bff", brake: "#ff4d5e", ers: "#34c8ff", throttle: "#ffffff" };
const META = {
  LINE:     { abbr: "LN", color: C.line },
  GEAR:     { abbr: "GR", color: C.gear },
  BRAKING:  { abbr: "BR", color: C.brake },
  ERS:      { abbr: "ER", color: C.ers },
  THROTTLE: { abbr: "TH", color: C.throttle },
};
// Display order on the screen.
const ORDER = ["LINE", "GEAR", "BRAKING", "ERS", "THROTTLE"];

export function buildCoachLog(userLap, refSamples, refLapTime, opts = {}) {
  const a = analyzeLap(userLap?.samples, refSamples, opts);
  if (!a) return null;

  // Real time on the table: the measured lap-time delta scaled across channels, or
  // the modeled segment-loss estimate when a lap time is missing.
  const { totalLost, scale, estimated } = reconcile(a, userLap?.lapTime, refLapTime);

  const channels = ORDER.map((name) => {
    const insights = a.findings[name];
    const secs = a.channelTime[name] * scale;
    const share = a.modeledTotalLost > 0 ? a.channelTime[name] / a.modeledTotalLost : 0;
    // "Signal" = how much evidence backs this channel (count of callouts + its
    // share of the lost time). NOT an AI/model figure — a deterministic strength.
    const signal = (insights.length || secs > 0.005)
      ? Math.round(clamp(40 + insights.length * 12 + share * 45, 0, 95)) : 0;
    return {
      name, abbr: META[name].abbr, color: META[name].color,
      potential: secs > 0.005 ? `−${secs.toFixed(2)}s` : "—",
      signal: signal > 0 ? `${signal}%` : "—",
      insights: insights.map((i) => ({
        zone: i.zone, delta: i.delta, text: i.text,
        time: i.timeLost * scale >= 0.005 ? `−${(i.timeLost * scale).toFixed(2)}s` : null,
      })),
    };
  });

  const setupSuggestions = setupHeuristics(a.channelTime, opts.setup);

  const top = rankFindings(a)[0];
  const nextLapFocus = top
    ? `${top.zone}: ${top.text}`
    : "Very closely matched to the reference — focus on consistency and the last few km/h.";

  return {
    channels,
    setupSuggestions,
    nextLapFocus,
    estimated,
    totalGain: `${estimated ? "~" : ""}−${totalLost.toFixed(2)}s`,
    lapsAnalysed: opts.lapsAnalysed ?? 1,
  };
}

// Map the dominant evidence (by seconds lost) to a few qualitative setup
// directions. Rule-of-thumb starting points, shown when there's no LLM.
function setupHeuristics(channelTime, setup) {
  const out = [];
  const push = (abbr, label, color, dir, note) => out.push({ abbr, label, color, dir, note });

  if (channelTime.LINE > 0)     push("FW", "Front Wing", "#2ED573", "+1", "More front grip to lift mid-corner minimum speed.");
  if (channelTime.BRAKING > 0)  push("BB", "Brake Bias", "#FFC400", "rearward", "Trail deeper without locking the fronts.");
  if (channelTime.THROTTLE > 0) push("DF", "On-Throttle Diff", "#34c8ff", "softer", "Smoother delivery for traction on exit.");
  if (channelTime.GEAR > 0)     push("GR", "Gearing", "#b45bff", "review", "Match the reference's gear through the load.");
  if (channelTime.ERS > 0)      push("ER", "ERS Strategy", "#FF8A3D", "deploy", "Spend the charge where the reference does.");

  // If the lap carries a real setup snapshot, surface a current value too.
  if (setup && out.length < 5 && typeof setup.m_frontWing === "number") {
    push("FW", "Front Wing (now)", "#6b7488", String(setup.m_frontWing), "Current front-wing level.");
  }
  return out.slice(0, 5);
}
