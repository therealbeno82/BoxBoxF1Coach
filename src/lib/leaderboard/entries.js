// ─── LEADERBOARD ENTRIES ──────────────────────────────────────────────────────
// The row shape a board is made of, and the two ways to produce one: from a lap
// this driver has stored locally, or from a row the server returned.
//
// Both paths converge on ONE shape so the table doesn't care where its rows came
// from — which is what lets the whole Leaderboard screen be built and checked
// against local laps before any server exists.
//
//   {
//     entryId, driverId, displayName, team,
//     lapTimeMs, sectorMs: [s1,s2,s3] | null,
//     compound, condition, tyreVisual, tyreAge,
//     recordedAt, verdict, isYou,
//     lap,        // the source lap, LOCAL ROWS ONLY — null for server rows
//   }
//
// Times are integer MILLISECONDS on an entry, not float seconds. Ranking a board
// is an exact sort, and two laps that tie should tie rather than depending on
// which way a float rounded.
//
// Pure.

import { boardIdForLap, compoundToken, conditionToken } from "./boardKey.js";
import { tyreLabel } from "../tyres.js";

export const msOf = (seconds) =>
  (typeof seconds === "number" && isFinite(seconds) && seconds > 0) ? Math.round(seconds * 1000) : null;
export const secOf = (ms) => (typeof ms === "number" && ms > 0 ? ms / 1000 : null);

// A locally-stored lap → an entry. `driver` is the local driver profile so the
// row can carry a name and team the same way a server row does.
export function entryFromLap(lap, { driver } = {}) {
  const ms = msOf(lap?.lapTime);
  if (ms == null) return null;
  return {
    entryId: lap.id,
    driverId: null,
    displayName: driver?.name || lap.meta?.driver || "You",
    team: driver?.team || null,
    lapTimeMs: ms,
    sectorMs: Array.isArray(lap.sectorTimes) && lap.sectorTimes.length === 3
      ? lap.sectorTimes.map(msOf) : null,
    compound: compoundToken(lap),
    condition: conditionToken(lap),
    tyreVisual: lap.tyre?.visual ?? null,
    tyreAge: lap.tyre?.age ?? null,
    recordedAt: lap.recordedAt ?? null,
    verdict: "ok",
    isYou: true,
    lap,
  };
}

// A server row → an entry. Keeps the same field names the table already reads.
export function entryFromRow(row, { myDriverId } = {}) {
  if (!row) return null;
  return {
    entryId: `${row.board_id}:${row.driver_id}`,
    driverId: row.driver_id,
    displayName: row.display_name || "—",
    team: row.team || null,
    lapTimeMs: row.lap_time_ms,
    sectorMs: (row.s1_ms != null && row.s2_ms != null && row.s3_ms != null)
      ? [row.s1_ms, row.s2_ms, row.s3_ms] : null,
    compound: row.compound || null,
    condition: row.condition || null,
    tyreVisual: row.tyre_visual ?? null,
    tyreAge: row.tyre_age ?? null,
    recordedAt: row.created_at ? Date.parse(row.created_at) : null,
    verdict: row.verdict || "ok",
    isYou: !!myDriverId && row.driver_id === myDriverId,
    boardId: row.board_id,
    tracePath: row.trace_path || null,
    lap: null,
  };
}

// The minimal lap-shaped object lib/coach/refMatch.js needs to judge whether an
// entry would actually be usable as a reference. A server row has no lap and no
// samples, but refProfile only reads meta.track, meta.sessionType and lap.tyre —
// so a stub carrying those three is enough to preview comparability BEFORE the
// user spends a download on a reference the coach would then refuse to use.
export function entryAsRefLike(entry, { trackName, sessionLabel }) {
  if (!entry) return null;
  return {
    meta: { track: trackName || null, sessionType: sessionLabel || null },
    tyre: entry.tyreVisual != null ? { visual: entry.tyreVisual } : null,
  };
}

// Rank a set of entries: fastest first, each tagged with its position and its gap
// (in ms) to the leader. Equal times share a position, as a timing sheet does.
export function rankEntries(entries = []) {
  const sorted = [...entries].filter(Boolean).sort((a, b) => a.lapTimeMs - b.lapTimeMs);
  const leader = sorted.length ? sorted[0].lapTimeMs : 0;
  let lastTime = null, lastPos = 0;
  return sorted.map((e, i) => {
    const pos = (e.lapTimeMs === lastTime) ? lastPos : i + 1;
    lastTime = e.lapTimeMs; lastPos = pos;
    return { ...e, pos, gapMs: e.lapTimeMs - leader };
  });
}

// ─── Local preview ────────────────────────────────────────────────────────────
// The driver's own laps, grouped into the boards they'd land on. Used by the
// Leaderboard screen before (and alongside) the online boards, and by the
// Dashboard card to work out where the driver's own best would sit.
//
// `onePerDriver` mirrors the server's one-entry-per-driver-per-board rule; the
// screen turns it OFF for the local preview so the driver can see all their own
// laps ranked against each other, which is a more useful local view.
export function localBoardEntries(laps = [], boardId, { driver, onePerDriver = false } = {}) {
  const mine = [];
  for (const lap of laps) {
    if (lap?.archived) continue;
    const board = boardIdForLap(lap);
    if (board.boardId !== boardId) continue;
    const entry = entryFromLap(lap, { driver });
    if (entry) mine.push(entry);
  }
  const ranked = rankEntries(mine);
  return onePerDriver ? ranked.slice(0, 1) : ranked;
}

// Every board the driver has at least one lap on, fastest-first within each.
// → Map<boardId, entry[]>
export function localBoardIndex(laps = [], { driver } = {}) {
  const byBoard = new Map();
  for (const lap of laps) {
    if (lap?.archived) continue;
    const { boardId } = boardIdForLap(lap);
    if (!boardId) continue;
    const entry = entryFromLap(lap, { driver });
    if (!entry) continue;
    if (!byBoard.has(boardId)) byBoard.set(boardId, []);
    byBoard.get(boardId).push(entry);
  }
  for (const [k, v] of byBoard) byBoard.set(k, rankEntries(v));
  return byBoard;
}

// Display label for an entry's compound, e.g. "Soft" / "Inter" / null.
export function entryCompoundLabel(entry) {
  return entry?.tyreVisual != null ? tyreLabel({ visual: entry.tyreVisual }) : null;
}
