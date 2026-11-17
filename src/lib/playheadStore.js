// ─── ANALYTICS PLAYHEAD ──────────────────────────────────────────────────────
// The shared playback position for Analytics (0–1 lap-distance fraction), held
// OUTSIDE React — the same pattern as lib/telemetryStore.js, and for the same
// reason.
//
// It used to be `useState` on BoxBoxApp. DrivingLinesView's playback clock writes
// it on every animation frame, so at 60 Hz playback re-rendered the whole hub,
// Shell, and all of AnalyticsScreen — both lap selects with every option, the
// consistency matrix, the publish button's eligibility check — to move a cursor
// that only two components draw: the driving lines and the trace stack. Those two
// now subscribe here (usePlayhead) and nothing else re-renders on a frame.
//
// Anything that wants to MOVE the playhead (the scrubbers, the segment steppers,
// a Coach Log finding that jumps to a spot on the lap) calls setPlayhead.
// `playing` stays React state on the hub: it flips on play/pause, not per frame.

import { useSyncExternalStore } from "react";

let playhead = 0;
const listeners = new Set();

export const getPlayhead = () => playhead;

export function setPlayhead(v) {
  const next = typeof v === "function" ? v(playhead) : v;
  if (typeof next !== "number" || !Number.isFinite(next)) return;
  const clamped = next < 0 ? 0 : next > 1 ? 1 : next;
  if (clamped === playhead) return;
  playhead = clamped;
  for (const fn of listeners) fn();
}

export function subscribePlayhead(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function usePlayhead() {
  return useSyncExternalStore(subscribePlayhead, getPlayhead, getPlayhead);
}
