// ─── REFERENCE MATCHING ───────────────────────────────────────────────────────
// Is the loaded reference lap actually comparable with the lap just driven?
//
// lib/lapBuckets.js already stops the coach pooling YOUR OWN laps across session
// types and compounds (a quali lap on softs and a race lap on hards are not the
// same experiment). But the REFERENCE — the lap every channel insight is measured
// against — used to be exempt from all of that: the only guard was the circuit
// name. So a wet race lap on Intermediates got analysed against a dry qualifying
// lap on Softs, and every finding it produced ("carrying 40 km/h less here",
// "brake later", "get to power sooner") was an artefact of the conditions, not of
// the driving. Confidently-worded nonsense is worse than no advice, so when the
// two laps aren't like-for-like the coach now withholds the analysis and says why.
//
// The blocking rules — each fires ONLY when both sides are positively known, so
// missing tags fail OPEN (we can't confirm a mismatch, so we don't block):
//   • TRACK      — different circuits. Nothing transfers.
//   • CONDITION  — dry vs wet running. Different grip, lines and braking points.
//   • SESSION    — race running vs a low-fuel push lap (qualifying / time trial).
//                  Fuel load and tyre management move every channel.
//   • COMPOUND   — different tyre compound, including two dry compounds. Grip and
//                  therefore the whole reference trace differ.
// Practice is deliberately NOT classified: a practice session can be run on
// qualifying sims or race stints, so its session type carries no information and
// must not block on its own.
//
// Pure — callers run it inside a useMemo. Handles both reference shapes:
//   • a stored lap        → meta.sessionType ("Qualifying") + lap.tyre (UDP code)
//   • a calibrated trace  → meta.session ("Race Pace")      + meta.tyres ("Softs")

import { tyreLabel, tyreCondition } from "../tyres.js";
import { isKnownTrackName, sameTrack } from "../trackData.js";

// Free-text compound names (calibrator dropdown, hand-edited trace files) folded
// onto the same labels tyreLabel() produces for a recorded lap, so the two shapes
// compare directly. Plurals are stripped first ("Softs" → "soft").
const COMPOUND_ALIASES = {
  soft: "Soft", supersoft: "Soft", ultrasoft: "Soft",
  medium: "Medium",
  hard: "Hard", superhard: "Super Hard",
  inter: "Inter", intermediate: "Inter",
  wet: "Wet", full_wet: "Wet", fullwet: "Wet",
};

function compoundFromText(text) {
  const raw = String(text ?? "").trim().toLowerCase().replace(/[\s-]+/g, "");
  if (!raw) return null;
  return COMPOUND_ALIASES[raw] || COMPOUND_ALIASES[raw.replace(/s$/, "")] || null;
}

const WET_COMPOUNDS = new Set(["Inter", "Wet"]);

// Coarse running type. "Push" = low fuel, maximum attack (qualifying, sprint
// shootout, time trial); "Race" = full-fuel, tyre-managed running. Anything else
// (Practice, unset, an unrecognised label) resolves to null = unclassified, which
// never blocks.
const SESSION_CLASS = {
  "qualifying": "Push",
  "sprint shootout": "Push",
  "time trial": "Push",
  "race": "Race",
  "race pace": "Race",   // the Trace Calibrator's wording
};

function sessionClassFromText(text) {
  const raw = String(text ?? "").trim().toLowerCase();
  return SESSION_CLASS[raw] || null;
}

// Normalise either shape into the four fields the rules compare. Every field is
// null when the lap doesn't carry it — that's what makes a rule fail open.
export function refProfile(lap) {
  if (!lap) return null;
  const meta = lap.meta || {};
  // Compound: a recorded lap's UDP tyre tag wins; otherwise the trace file's text.
  const compound = tyreLabel(lap.tyre) || compoundFromText(meta.tyres);
  // Condition: prefer the UDP-code answer (it knows the legacy wet codes too),
  // else derive it from the resolved compound label.
  const condition = tyreCondition(lap.tyre)
    ?? (compound ? (WET_COMPOUNDS.has(compound) ? "wet" : "dry") : null);
  return {
    track: meta.track || null,
    sessionLabel: meta.sessionType || meta.session || null,
    sessionClass: sessionClassFromText(meta.sessionType || meta.session),
    condition,
    compound,
  };
}

const COND_TEXT = { wet: "wet-weather", dry: "dry" };
const CLASS_TEXT = { Push: "a low-fuel push lap (qualifying / time trial)", Race: "full-fuel race running" };

// matchReference(userLap, ref, opts) → null when there's no reference to check,
// else { ok, reasons, user, ref }. `reasons` lists every blocking difference,
// worst first, each { kind, title, detail } ready for the mismatch panel.
// opts.drivenTrack overrides the user lap's own track name — BoxBoxApp resolves
// the live circuit more reliably than a stored lap's tag. A null userLap is
// allowed: with no lap driven yet only the track rule can fire, which is what
// flags a wrong-circuit reference the moment it's loaded.
const EMPTY_PROFILE = { track: null, sessionLabel: null, sessionClass: null, condition: null, compound: null };

export function matchReference(userLap, ref, opts = {}) {
  if (!ref) return null;
  const u = refProfile(userLap) || { ...EMPTY_PROFILE };
  const r = refProfile(ref);
  if (!r) return null;
  if (opts.drivenTrack) u.track = opts.drivenTrack;

  const reasons = [];

  if (isKnownTrackName(u.track) && isKnownTrackName(r.track) && !sameTrack(u.track, r.track)) {
    reasons.push({
      kind: "track",
      title: "Different circuit",
      detail: `The reference was set at ${r.track}, but you're driving ${u.track}.`,
    });
  }

  if (u.condition && r.condition && u.condition !== r.condition) {
    reasons.push({
      kind: "condition",
      title: "Different track conditions",
      detail: `Your lap is ${COND_TEXT[u.condition]} running on ${u.compound || "unknown rubber"}, ` +
              `the reference is ${COND_TEXT[r.condition]} on ${r.compound || "unknown rubber"}. ` +
              `Grip, lines and braking points differ everywhere.`,
    });
  }

  if (u.sessionClass && r.sessionClass && u.sessionClass !== r.sessionClass) {
    reasons.push({
      kind: "session",
      title: "Different session type",
      detail: `Your lap is ${CLASS_TEXT[u.sessionClass]}; the reference is ${CLASS_TEXT[r.sessionClass]}. ` +
              `Fuel load and tyre management move every channel.`,
    });
  }

  // Only worth stating on its own once the condition rule hasn't already fired —
  // "Soft vs Wet" is a conditions problem, not a compound one.
  const condBlocked = reasons.some((x) => x.kind === "condition");
  if (!condBlocked && u.compound && r.compound && u.compound !== r.compound) {
    reasons.push({
      kind: "compound",
      title: "Different tyre compound",
      detail: `You're on ${u.compound}, the reference is on ${r.compound}. ` +
              `Different rubber means a different grip level, so the deltas aren't yours to fix.`,
    });
  }

  return { ok: reasons.length === 0, reasons, user: u, ref: r };
}

// One-line summary of a profile for headers/labels: "Race · Medium", "Qualifying · Soft".
export function profileLabel(p) {
  if (!p) return null;
  return [p.sessionLabel, p.compound].filter(Boolean).join(" · ") || null;
}
