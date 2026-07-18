// ─── COACHING-TIP SCHEMA ──────────────────────────────────────────────────────
// The structured shape for the on-track tip and between-lap debrief. Exported as
// a JSON Schema (passed to OpenRouter's response_format) plus a JS validator.
// `repairTip` is the fallback when a model returns non-JSON, so the pipeline
// never hard-fails.

import { cleanOutput } from "./guardrails.js";

export const COACHING_TIP_SCHEMA = {
  type: "object",
  properties: {
    tip: { type: "string", description: "One short coaching sentence, max ~20 words." },
    severity: { type: "string", enum: ["info", "minor", "major"] },
    zone: { anyOf: [{ type: "string" }, { type: "null" }] },
    grounded: { type: "boolean" },
  },
  required: ["tip", "severity", "zone", "grounded"],
  additionalProperties: false,
};

// Between-lap debrief: the tip fields plus a short multi-sentence read of the lap
// shown on the Coach Log screen. `summary` is cleaned + numerically grounded by the
// caller, same as the tip, so it can't fabricate figures.
export const DEBRIEF_SCHEMA = {
  type: "object",
  properties: {
    tip: { type: "string", description: "One short coaching sentence, max ~20 words." },
    summary: { type: "string", description: "2-3 sentences on the main areas to work on next lap." },
    severity: { type: "string", enum: ["info", "minor", "major"] },
    zone: { anyOf: [{ type: "string" }, { type: "null" }] },
    grounded: { type: "boolean" },
  },
  required: ["tip", "summary", "severity", "zone", "grounded"],
  additionalProperties: false,
};

const SEVERITIES = new Set(["info", "minor", "major"]);
// maxWords is deliberately looser than the "max 20 words" the prompt asks for
// (prompts.js): the prompt sets the target, this hard cap only trims runaways.
const TIP_LIMITS = { maxSentences: 1, maxWords: 24 };
const SUMMARY_LIMITS = { maxSentences: 3, maxWords: 60 };

// Coerce/clean the debrief `summary` field. Returns "" when there's nothing usable.
export function cleanSummary(raw) {
  return cleanOutput(String(raw ?? ""), SUMMARY_LIMITS);
}

// Coerce/validate a parsed JSON object into a clean tip. Returns { ok:false } if
// there's no usable tip text.
export function validateTip(obj) {
  if (!obj || typeof obj !== "object") return { ok: false };
  const tip = cleanOutput(String(obj.tip ?? ""), TIP_LIMITS);
  if (!tip) return { ok: false };
  return {
    ok: true,
    tip: {
      tip,
      severity: SEVERITIES.has(obj.severity) ? obj.severity : "info",
      zone: typeof obj.zone === "string" && obj.zone.trim() ? obj.zone.trim() : null,
      grounded: obj.grounded === true,
    },
  };
}

// Fallback for non-JSON output: treat the cleaned raw text as the tip.
export function repairTip(rawText) {
  const tip = cleanOutput(String(rawText ?? ""), TIP_LIMITS);
  if (!tip) return { ok: false };
  return { ok: true, tip: { tip, severity: "info", zone: null, grounded: false } };
}
