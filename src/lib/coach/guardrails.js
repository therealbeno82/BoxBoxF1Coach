// ─── COACH GUARDRAILS ─────────────────────────────────────────────────────────
// Input gating, output shaping, prompt-injection sanitization, and numeric
// grounding — the deterministic guardrails that wrap every LLM call so the small
// local model can't coach on garbage telemetry, leak markdown/preamble, follow
// instructions hidden in a trace file, or cite figures the data doesn't support.

// ── Output shaping ──
const LEAD_FILLER =
  /^(?:sure|ok(?:ay)?|alright|right|well|so|now|here(?:'s| is)[^:]*:|as your (?:race )?engineer[,:]?|copy(?: that)?|roger)[\s,.:!-]+/i;

// Strip preamble/markdown/quotes and clamp to a radio-length reply.
export function cleanOutput(text, { maxSentences = 3, maxWords = 80 } = {}) {
  let s = String(text ?? "").trim();
  if (!s) return "";
  s = s.replace(/[*_`#>]+/g, " ");             // markdown emphasis / code / headings
  s = s.replace(/^\s*[-•]\s+/gm, "");          // bullet markers
  s = s.replace(/\s+/g, " ").trim();           // collapse newlines/whitespace
  s = s.replace(/^["'“”‘’]+/, "").replace(/["'“”‘’]+$/, "").trim();
  for (let i = 0; i < 3 && LEAD_FILLER.test(s); i++) s = s.replace(LEAD_FILLER, "").trim();
  const parts = s.match(/[^.!?]+[.!?]?/g) || [s];
  s = parts.slice(0, maxSentences).join(" ").replace(/\s+/g, " ").trim();
  const words = s.split(" ");
  if (words.length > maxWords) s = words.slice(0, maxWords).join(" ").replace(/[,;:]+$/, "") + "…";
  return s.trim();
}

// ── Untrusted-data sanitization ──
// Trace/ref metadata (driver, track, zone names) is interpolated into prompts and
// could carry injected instructions; neutralize newlines, delimiters, role
// markers, and override phrases before it enters a prompt (it's wrapped in << >>).
export function sanitizeUntrusted(str, max = 80) {
  let s = String(str ?? "");
  // Replace control characters (code point < 32, incl. newlines) with a space —
  // preserving word boundaries — without a literal control-range regex.
  s = Array.from(s).map((c) => (c.codePointAt(0) < 32 ? " " : c)).join("");
  s = s.replace(/[<>`]/g, " ");                             // delimiter chars
  s = s.replace(/\b(?:system|assistant|user)\s*:/gi, " ");  // role markers
  s = s.replace(/\bignore (?:all |the )?(?:previous|prior|above)[^.]*/gi, " "); // override phrases
  s = s.replace(/\s+/g, " ").trim();
  return s.slice(0, max);
}

// ── Numeric grounding ──
// Gather every figure the model is allowed to cite into a tolerance-checkable set.
// `ctx.evidence` is the lap-comparison block joined with the pace-by-bucket block,
// so the debrief's per-session/compound figures survive grounding instead of being
// stripped as fabricated. (This used to also harvest the live telemetry snapshot
// and the reference sample, for the on-track tip call that no longer exists —
// every figure the remaining debrief may quote is in the evidence text.)
export function collectAllowedNumbers(ctx = {}) {
  const set = new Set();
  const add = (v) => { if (typeof v === "number" && !Number.isNaN(v)) set.add(Math.round(v)); };
  if (ctx.evidence) {
    for (const m of String(ctx.evidence).matchAll(/\d+(?:\.\d+)?/g)) add(parseFloat(m[0]));
  }
  return set;
}

function isGrounded(value, allowed) {
  const tol = Math.max(2, value * 0.06);
  for (const a of allowed) if (Math.abs(a - value) <= tol) return true;
  return false;
}

// Drop numeric figures (>= 10, with their unit) that the model cites but the data
// doesn't support. Small numbers (gears, "1-3 sentences") and figures inside a
// lap-time pattern (1:23.4) are left alone to avoid false positives. Returns the
// cleaned text plus whether every checked figure was supported.
//
// The unit group is ordered longest-first and terminated by (?![a-z]): without
// both, dropping an ungrounded figure ate the front of the following word —
// "sec" matched inside "seconds" ("14 seconds" → "onds"), and the bare "m"
// matched any m-word ("30 mistakes" → "istakes").
export function enforceGrounding(text, allowed) {
  let grounded = true;
  const src = String(text ?? "");
  const out = src.replace(
    /(\d+(?:\.\d+)?)(\s?(?:km\/h|kph|kmh|mph|metres|meters|seconds|secs|sec|kj|m|%|s)(?![a-z]))?/gi,
    (whole, numStr, _unit, offset) => {
      // Skip figures that are part of a clock-style time (1:23.4).
      if (src[offset - 1] === ":" || src[offset + whole.length] === ":") return whole;
      // Skip corner/sector references ("Turn 13", "Sector 2", "apex 4", "T13", "S2") —
      // these are place names, not telemetry figures, so they must never be stripped
      // just because a high corner number isn't in the data (tracks have >9 corners).
      const tail = src.slice(Math.max(0, offset - 12), offset);
      const attachedTurn = (tail.endsWith("T") || tail.endsWith("S")) && !/[A-Za-z]/.test(src[offset - 2] || "");
      if (/(?:turn|corner|sector|apex)\s+$/i.test(tail) || attachedTurn) return whole;
      const v = parseFloat(numStr);
      if (v < 10) return whole;                 // trivial — keep
      if (isGrounded(v, allowed)) return whole; // supported — keep
      grounded = false;
      return "";                                // fabricated — drop figure + unit
    }
  );
  const cleaned = out.replace(/\s{2,}/g, " ").replace(/\s+([.,;:])/g, "$1").trim();
  return { text: cleaned, grounded };
}
