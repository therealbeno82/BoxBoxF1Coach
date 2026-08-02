// ─── useLeaderboard ───────────────────────────────────────────────────────────
// Fetches one board's rows, and keeps the three outcomes that need different
// words on screen distinct:
//
//   status "loading"  — a request is in flight
//   status "ready"    — rows arrived (possibly zero: an empty board is a real,
//                       correct answer and must not read as a failure)
//   status "disabled" — the driver turned the feature off, or this build has no
//                       server configured. Telling them "no network" here would
//                       be a plain lie about their own machine.
//   status "offline"  — there is genuinely no network
//   status "error"    — we asked and didn't get an answer
//
// Collapsing those into one "no data" state is the usual way a leaderboard ends
// up looking broken at a race weekend with the router off, which CLAUDE.md's
// no-network rule makes a normal condition rather than an edge case.
//
// Never throws, never suspends, and every request is abortable — switching board
// quickly must not leave a slow earlier response to land last and win.

import { useCallback, useEffect, useRef, useState } from "react";
import { getBoard, available } from "../lib/leaderboard/api.js";
import { currentUserId } from "../lib/leaderboard/identity.js";
import { configured } from "../lib/leaderboard/config.js";

export function useLeaderboard(boardId, { enabled = true, limit = 50 } = {}) {
  const [state, setState] = useState({ status: "loading", entries: [], total: 0 });
  const reqRef = useRef(0);

  const load = useCallback(async () => {
    const seq = ++reqRef.current;
    if (!available({ enabled })) {
      // Which of the two it is matters to the driver: one they chose, the other
      // happened to them.
      const status = (!enabled || !configured) ? "disabled" : "offline";
      setState({ status, entries: [], total: 0 });
      return;
    }
    setState((s) => ({ ...s, status: "loading" }));
    const res = await getBoard(boardId, { limit, myDriverId: currentUserId(), enabled });
    // A newer request started while this one was in flight — drop this answer.
    if (seq !== reqRef.current) return;
    if (!res) {
      setState({ status: "error", entries: [], total: 0 });
      return;
    }
    setState({ status: "ready", entries: res.entries, total: res.total });
  }, [boardId, enabled, limit]);

  useEffect(() => {
    if (!boardId) { setState({ status: "ready", entries: [], total: 0 }); return; }
    load();
    // Bumping the sequence on unmount makes any in-flight response a no-op.
    return () => { reqRef.current++; };
  }, [boardId, load]);

  return { ...state, reload: load };
}
