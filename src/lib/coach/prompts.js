// ─── COACH PROMPTS ────────────────────────────────────────────────────────────
// The between-lap debrief prompt — the only prompt the app builds. It carries the
// shared persona plus the grounding guardrail blocks, and runs every untrusted
// string (driver and track names from loaded trace files) through
// sanitizeUntrusted, wrapped in << >> delimiters so the model treats it as data,
// not instructions.
//
// There was a second builder here (an on-track one-shot tip, grounded in the live
// telemetry point vs the reference sample). Its only caller was the Race Engineer
// chat panel and it went dead when that was removed — the deterministic rule
// engine owns everything mid-corner, so nothing replaced it.

import { PERSONA, GROUNDING_RULE, LOCATION_RULE } from "./config.js";
import { sanitizeUntrusted } from "./guardrails.js";

// Between-lap debrief. Grounds ONLY in the completed-lap evidence, the per-bucket
// pace picture (qualifying vs each race compound — see lib/lapBuckets.js) and the
// cross-lap trends (lib/lapHistory.js). `bucket` names the kind of running the lap
// belongs to, so the debrief judges a race lap on hards as a race lap on hards and
// never against a quali time.
//
// The trends block is what separates "you were slow in T4 this lap" from "you are
// ALWAYS slow in T4" — the second is worth a driver changing their approach over,
// the first might just be traffic. It carries its own caveat line when the
// reference isn't a like-for-like car, which the model must respect rather than
// quote around.
export function buildDebriefPrompt({ evidence, refMeta, pace, bucket, trends }) {
  const driver = sanitizeUntrusted(refMeta?.driver) || "Pro";
  const track = sanitizeUntrusted(refMeta?.track) || "this track";
  const kind = bucket ? sanitizeUntrusted(bucket) : null;
  return `${PERSONA}
You are debriefing a sim driver who just crossed the line. ${GROUNDING_RULE} ${LOCATION_RULE}
Using the lap-comparison evidence below, respond with the JSON object from the schema: one specific, actionable improvement for the next lap in "tip" (max 20 words); a "summary" of 2-3 sentences walking through the main areas where the lap time went and what to do about them; a "severity"; the most relevant "zone" name or null; and "grounded" true if you cite figures from the data. Coach the DRIVING — never suggest car-setup changes.
${kind ? `This lap was ${kind} running. Judge it against the driver's other laps of that same kind only; a qualifying time and a race time on a different compound are not comparable, and race pace is expected to be slower.\n` : ""}${trends ? `A problem the cross-lap trends show RECURRING is worth more than a one-off from this lap alone — prefer it for the tip when both are on the table, and say that it keeps happening. Any NOTE line in that block is a constraint on what you may claim, not something to quote.\n` : ""}
REFERENCE: <<${driver}>> at <<${track}>>.
${evidence}${pace ? `\n\n${pace}` : ""}${trends ? `\n\n${trends}` : ""}`;
}
