// ─── LAP EVIDENCE ─────────────────────────────────────────────────────────────
// The prose sibling of the Coach Log: turns a full-lap comparison (your lap vs the
// loaded esports reference) into a compact, evidential summary the coaching LLM can
// reason from — "where am I losing time, and what do I do about it".
//
// Both this and the structured Coach Log now derive from the SAME analysis core
// (coach/lapAnalysis.js), so the detection thresholds live in one place and the two
// views can't drift apart. This module just formats the findings as text, tagged
// with the real seconds each one cost.

import { analyzeLap, rankFindings, reconcile } from "./coach/lapAnalysis.js";

// opts.userLapTime / opts.refLapTime let the prose seconds reconcile with the
// measured lap-time delta — the same scaling the Coach Log screen applies — so the
// two views never disagree. Omit them and the modeled estimate is used instead.
export function buildLapEvidence(userSamples, refSamples, opts = {}) {
  const a = analyzeLap(userSamples, refSamples, opts);
  if (!a) return null;

  const { scale, estimated } = reconcile(a, opts.userLapTime, opts.refLapTime);
  const ranked = rankFindings(a);
  const avg = a.avgDeltaSpeed;
  const header =
    `LAP COMPARISON EVIDENCE — your most recent full lap vs the reference ` +
    `(avg ${avg >= 0 ? "+" : ""}${avg.toFixed(0)} km/h vs ref across the lap):`;

  if (!ranked.length) {
    return header + "\n- Very closely matched to the reference across the lap — focus on consistency and the final few km/h.";
  }

  const tilde = estimated ? "~" : "";
  const lines = ranked.slice(0, 7).map((f) => `${f.zone}: ${f.text} (${tilde}${(f.timeLost * scale).toFixed(2)}s)`);
  return header + "\n- " + lines.join("\n- ");
}
