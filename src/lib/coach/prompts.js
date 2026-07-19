// ─── COACH PROMPTS ────────────────────────────────────────────────────────────
// The two prompt builders (on-track tip, between-lap debrief), centralized here.
// Each carries the shared persona plus the grounding guardrail blocks, and runs
// every untrusted string (driver, track, zone names from loaded trace files)
// through sanitizeUntrusted, wrapped in << >> delimiters so the model treats it
// as data, not instructions.

import { ERS_MODES, PERSONA, GROUNDING_RULE, LOCATION_RULE } from "./config.js";
import { sanitizeUntrusted } from "./guardrails.js";
import { formatSetupForPrompt } from "../setupDisplay.js";

// "=== CAR SETUP ===" block, or "" when the lap carries no setup. `note` tailors
// the framing to the call.
function setupBlock(setup, note) {
  const body = formatSetupForPrompt(setup);
  return body ? `\n\n=== CAR SETUP (${note}) ===\n${body}` : "";
}

// On-track one-shot tip. Asks for the structured COACHING_TIP_SCHEMA object.
export function buildTipPrompt({ telemetry, refSample, zone, refMeta, evidence }) {
  const ersModeName = ERS_MODES[telemetry.ersMode] || "None";
  const refErsName = refSample ? (ERS_MODES[refSample.ersMode] || "None") : "N/A";
  const driver = sanitizeUntrusted(refMeta?.driver) || "Pro";
  const track = sanitizeUntrusted(refMeta?.track) || "this track";
  const zoneStr = zone
    ? `${sanitizeUntrusted(zone.name)} — ${
        zone.type === "brake" ? "BRAKING"
          : zone.type === "lico" ? "LIFT AND COAST"
          : "ERS " + ERS_MODES[zone.ersMode]
      }${zone.note ? " — " + sanitizeUntrusted(zone.note) : ""}`
    : "None";

  // Where the driver is, named — the active corner/zone, else a generic phrase.
  const loc = zone?.name ? sanitizeUntrusted(zone.name) : "the current corner";

  return `${PERSONA}
You are coaching a sim driver. ${GROUNDING_RULE} ${LOCATION_RULE}
Respond ONLY with the JSON object from the schema: a single short coaching sentence (max 20 words) in "tip", a "severity" of info|minor|major, the active "zone" name or null, and "grounded" true only if your tip uses figures from the data below.

REFERENCE DRIVER: <<${driver}>> at <<${track}>>, at ${loc}:
  Throttle: ${refSample?.throttle ?? "N/A"}%  Speed: ${refSample?.speed ?? "N/A"} km/h  Gear: ${refSample?.gear ?? "N/A"}  Steer: ${refSample?.steer ?? "N/A"}%  ERS: ${refErsName}  ERS spent: ${refSample?.ersSpent ?? "N/A"}kJ  Brake: ${refSample?.brake ?? "N/A"}%

YOUR DRIVER now at ${loc}:
  Throttle: ${telemetry.throttle}%  Speed: ${telemetry.speed} km/h  Gear: ${telemetry.gear}  Steer: ${telemetry.steer ?? "N/A"}%  ERS: ${ersModeName}  Brake: ${telemetry.brake}%  Battery: ${Math.round(telemetry.ersBattery)}%

ACTIVE ZONE: ${zoneStr}
${evidence ? `\n${evidence}\n` : ""}`;
}

// Between-lap debrief. Grounds ONLY in the completed-lap evidence.
export function buildDebriefPrompt({ evidence, refMeta, setup }) {
  const driver = sanitizeUntrusted(refMeta?.driver) || "Pro";
  const track = sanitizeUntrusted(refMeta?.track) || "this track";
  return `${PERSONA}
You are debriefing a sim driver who just crossed the line. ${GROUNDING_RULE} ${LOCATION_RULE}
Using the lap-comparison evidence below, respond with the JSON object from the schema: one specific, actionable improvement for the next lap in "tip" (max 20 words); a "summary" of 2-3 sentences walking through the main areas where the lap time went and what to do about them; a "severity"; the most relevant "zone" name or null; and "grounded" true if you cite figures from the data. Prefer driving changes; only suggest one specific setup change when the evidence clearly points to it.

REFERENCE: <<${driver}>> at <<${track}>>.
${evidence}${setupBlock(setup, "the driver's current garage setup — they can change this before the next lap")}`;
}
