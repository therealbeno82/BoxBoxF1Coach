// ─── LEADERBOARD ELIGIBILITY ──────────────────────────────────────────────────
// May this lap be uploaded to a public board?
//
// THE single definition of that rule, in the same spirit as isRankable and
// isDemoLap in lib/driverStats.js — the upload button, the personal-best prompt
// and the server-side validator all ask this one function, so the answer can't
// drift between them. The client asks it to decide whether to enable a button and
// what to say when it can't; the server asks it again because a client's answer
// is a suggestion, not a fact.
//
// `reason` is written to be shown to the driver verbatim, in a tooltip or a
// disabled-state caption. Keep it a plain sentence, not a code.

import { isDemoLap, isRankable } from "../driverStats.js";
import { boardIdForLap } from "./boardKey.js";
import { plausibleLapTime, THRESHOLDS } from "./limits.js";

// → { ok: true, board } | { ok: false, reason }
export function eligibility(lap) {
  if (!lap) return { ok: false, reason: "No lap selected." };

  // Demo laps are a REPLAY of a real recorded race (src-tauri/src/telemetry/demo.rs).
  // They carry genuine lap times set by a real driver, so without this they would
  // put someone else's laps on the board under your name. Non-negotiable, and it
  // has to be the first check so nothing downstream can accidentally allow one.
  if (isDemoLap(lap)) {
    return { ok: false, reason: "Demo Mode laps are a replay, not laps you drove — they can't go on a board." };
  }

  if (!isRankable(lap)) {
    return { ok: false, reason: "The game deleted this lap for track limits, so it can't be submitted." };
  }

  // The game's own Event packet said a flashback happened during the lap. The
  // validator can only infer one from a hole in the trace; this is the game
  // saying so. (Read from the lap, or from meta on an uploaded trace.)
  if ((lap.flashbacks ?? lap.meta?.flashbacks) > 0) {
    return { ok: false, reason: "This lap used a flashback, so it can't go on a board." };
  }

  if (typeof lap.lapTime !== "number" || !(lap.lapTime > 0)) {
    return { ok: false, reason: "This lap has no recorded lap time." };
  }

  if (!Array.isArray(lap.samples) || lap.samples.length < THRESHOLDS.minSamples) {
    return { ok: false, reason: "This lap's trace is too short to be useful as a reference." };
  }

  // Sector splits are a HARD requirement in the validator (checkSectors), so
  // they have to be one here too — this function is what the publish prompt and
  // the Publish button ask, and without it a splitless lap (a mid-lap join) got
  // offered, enabled, and then refused only after the driver confirmed the
  // upload. Same predicate as checkSectors, deliberately: if the two ever
  // disagree again, the answer has drifted, which is the thing this module
  // exists to prevent.
  if (!Array.isArray(lap.sectorTimes) || lap.sectorTimes.length !== 3
      || lap.sectorTimes.some((s) => !Number.isFinite(s))) {
    return { ok: false, reason: "This lap has no complete sector splits, so it can't be verified for the board." };
  }

  const board = boardIdForLap(lap);
  if (!board.boardId) return { ok: false, reason: board.reason };

  // Catch an impossible time before spending a round trip on it.
  const plausible = plausibleLapTime(board.slug, lap.lapTime);
  if (!plausible.ok) return { ok: false, reason: plausible.reason };

  return { ok: true, board };
}
