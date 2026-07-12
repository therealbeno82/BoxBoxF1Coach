// ─── COACH PROMPTS ────────────────────────────────────────────────────────────
// The three prompt builders (conversational system prompt, on-track tip, between-
// lap debrief), centralized here. Each carries the shared persona/style plus the
// grounding and scope guardrail blocks, and runs every untrusted string (driver,
// track, zone names from loaded trace files) through sanitizeUntrusted, wrapped in
// << >> delimiters so the model treats it as data, not instructions.

import { ERS_MODES, PERSONA, STYLE_RULES, GROUNDING_RULE, LOCATION_RULE, SCOPE_RULE, ERA_2026_RULE } from "./config.js";
import { sanitizeUntrusted } from "./guardrails.js";
import { formatSetupForPrompt } from "../setupDisplay.js";
import { formatLapTime, boostStateName, aeroModeName } from "../format.js";

function fmtSector(s) {
  return typeof s === "number" && s > 0 ? `${s.toFixed(1)}s` : "—";
}

// Live sector context: which sector the driver is in plus the two completed
// splits (each reads "—" until the car crosses that sector line this lap).
function sectorLine(tel) {
  const cur = typeof tel.currentSector === "number" ? `S${tel.currentSector + 1}` : "—";
  return `Sector: ${cur} (live) | S1 ${fmtSector(tel.sector1Time)} | S2 ${fmtSector(tel.sector2Time)}`;
}

// 2026 boost / active-aero / energy-budget context line for the live telemetry
// block. Labels come from the shared format.js helpers — the same mapping the
// Live screen's status ribbon renders — so the coach never describes a state
// that contradicts what the driver sees. Empty for pre-2026 cars.
function boostLine(tel) {
  if (!tel.regs2026) return "";
  return `Overtake boost: ${boostStateName(tel)} | Active aero: ${aeroModeName(tel)} | ERS this lap ${Math.round(tel.ersDeploy ?? 0)} of ${Math.round(tel.ersHarvestLimit ?? 0)} kJ harvest cap\n`;
}

// "=== CAR SETUP ===" block, or "" when the lap carries no setup. `note` tailors
// the framing to the call (mid-session chat vs. between-lap debrief).
function setupBlock(setup, note) {
  const body = formatSetupForPrompt(setup);
  return body ? `\n\n=== CAR SETUP (${note}) ===\n${body}` : "";
}

// Conversational coach system prompt.
// ctx = { tel, refSample, zone, trace, evidence, lapLog, trends, cornerProfiles, posLabel, trackMismatch }.
export function buildChatSystemPrompt(ctx = {}) {
  const tel = ctx.tel || {};
  const ref = ctx.refSample;
  const zone = ctx.zone;
  const trace = ctx.trace;
  const evidence = ctx.evidence;
  const mismatch = ctx.trackMismatch;

  const driver = sanitizeUntrusted(trace?.driver) || "pro";
  const track = trace?.track ? " @ " + sanitizeUntrusted(trace.track) : "";

  const zoneStr = zone
    ? `${sanitizeUntrusted(zone.name)} — ${
        zone.type === "lico"
          ? "LIFT & COAST"
          : "ERS DEPLOY (" + (ERS_MODES[zone.ersMode] || "?") + ")"
      }${zone.note ? " — " + sanitizeUntrusted(zone.note) : ""}`
    : "open track (no active strategy zone)";

  // When the loaded reference belongs to a different circuit, never compare against
  // it — the corners don't align and any lap-time read would be nonsense. Tell the
  // driver the track names don't match instead; general driving advice is still fine.
  const refStr = mismatch
    ? `TRACK MISMATCH: the loaded reference lap is from <<${sanitizeUntrusted(mismatch.refTrack) || "another circuit"}>>, a DIFFERENT track from the one being driven (<<${sanitizeUntrusted(mismatch.drivenTrack) || "this circuit"}>>). Do NOT compare the driver to this reference. If they ask for reference or lap-time comparison, tell them the track names do not match and to load a reference for this circuit (or clear it). You may still give general driving advice.`
    : ref
    ? `Reference <<${driver}${track}>> at the same point on track:
  Speed ${ref.speed ?? "?"} km/h | Gear ${ref.gear ?? "?"} | Throttle ${ref.throttle ?? "?"}% | Brake ${ref.brake ?? "?"}% | Steer ${ref.steer ?? "?"}% | ERS ${ERS_MODES[ref.ersMode] ?? "?"} | ERS spent ${ref.ersSpent ?? "?"} kJ`
    : "No reference lap loaded — coach from general F1 25/26 knowledge.";

  const evidenceStr = evidence
    ? `\n\n=== LAP EVIDENCE (use this to back up your advice with specifics) ===\n${evidence}`
    : "";

  return `${PERSONA}

${STYLE_RULES}

${SCOPE_RULE}

${GROUNDING_RULE}

${LOCATION_RULE}

${tel.regs2026 ? ERA_2026_RULE + "\n\n" : ""}Use the LIVE TELEMETRY below in your answers. When a REFERENCE lap is loaded, compare the driver to it and say specifically where the lap time is.

=== LIVE TELEMETRY (driver, right now) ===
Track position: ${ctx.posLabel || zoneStr}  |  ${zoneStr}
Speed ${tel.speed ?? "?"} km/h | Gear ${tel.gear ?? "?"} | Throttle ${tel.throttle ?? "?"}% | Brake ${tel.brake ?? "?"}% | Steer ${tel.steer ?? "?"}%
ERS mode: ${ERS_MODES[tel.ersMode] ?? "?"} | Battery ${Math.round(tel.ersBattery ?? 0)}% | Lap time so far ${formatLapTime(tel.lapTime)}
${boostLine(tel)}${sectorLine(tel)}

=== REFERENCE (pro lap) ===
${refStr}${evidenceStr}${setupBlock(tel.setup, "the driver's current garage setup — use it for any setup question; they can only change it in the garage, not on track")}${
    ctx.lapLog
      ? `\n\n=== LAP HISTORY (this circuit) ===\nRULES: a bare lap number ("lap 2", "my third lap") ALWAYS means the CURRENT/LAST SESSION block. PREVIOUS SESSIONS laps are labelled with their session type and date — use them only for trends, progress or comparisons, and always name that session when citing one. If the asked-for lap number is not in the current session, say this session has no such lap — do NOT substitute a lap from an older session.\n${ctx.lapLog}`
      : ""
  }${
    ctx.trends
      ? `\n\n=== CROSS-LAP TRENDS (recurring patterns across the driver's recent laps on THIS track, possibly spanning sessions — lean on these for "you keep…" coaching) ===\n${ctx.trends}`
      : ""
  }${
    ctx.cornerProfiles
      ? `\n\n=== CORNER PROFILES (per-lap speed/gear/throttle/brake/steering at each corner THIS SESSION — use these to answer specific "how fast / what gear / how much throttle through T#/the hairpin on lap N" questions and corner-to-corner comparisons) ===\n${ctx.cornerProfiles}`
      : ""
  }`;
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
