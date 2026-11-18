// The live telemetry snapshot, held OUTSIDE React.
// ─────────────────────────────────────────────────────────────────────────────
// The Rust core emits a snapshot ~30×/s. It used to land in `useState` on
// BoxBoxApp — the root, and the deliberate orchestration hub for every screen —
// so one UDP packet re-rendered the whole mounted tree about thirty times a
// second. Analytics, Settings, the Coach Log and the Leaderboard all paid that
// while reading nothing from it: measured over the whole 2,750-line hub there
// were only two telemetry reads left after the render boundary, and one of them
// (`currentZone`) turned out to be dead code.
//
// So the snapshot lives here instead, in a plain module-level store, and the
// pieces that need it subscribe at the rate they actually need:
//
//   • useLiveTelemetry()     — the whole snapshot, every tick. For the LIVE tab's
//                              leaves (gauges, track map), which are supposed to
//                              move at the telemetry rate.
//   • useTelemetryIdentity() — the slow-moving session facts the hub itself needs
//                              (circuit, session type, compound, session UID,
//                              track length). The returned object keeps its
//                              identity until one of those actually changes, so
//                              the hub re-renders a handful of times a session
//                              rather than thirty times a second.
//   • subscribeTelemetry()   — the raw edge, for per-tick work that produces no
//                              render output: the lap recorder, the track-path
//                              accumulator, the real-time call engine. Those are
//                              genuinely per-tick and stay per-tick; what changed
//                              is that they no longer drag a render tree along.
//
// Module-level rather than a context provider, deliberately. There is exactly one
// telemetry core per process, and a provider would put the value back into React
// state — which is the thing being removed. `useSyncExternalStore` is React's own
// answer for this shape, and it requires getSnapshot() to be referentially
// stable, which is why both the snapshot and the identity slice are cached here
// rather than derived inside the hook.

import { useSyncExternalStore } from "react";

// Idle telemetry reading, shown before the Rust core delivers a snapshot. Frozen
// because it is handed out as the live snapshot and must never be written to.
export const EMPTY_TEL = Object.freeze({
  lapPct: 0, lapDistance: 0, throttle: 0, brake: 0, speed: 0, gear: 1, rpm: 0,
  ersMode: 0, ersDeploy: 0, ersBattery: 0, lapTime: 0,
  sector2Pct: 1 / 3, sector3Pct: 2 / 3,
  ersHarvestLimit: 0, overtakeAvailable: 0, overtakeActive: 0,
  overtakeActivationDistance: 0, activeAeroMode: 0, activeAeroAvailable: 0,
  activeAeroActivationDistance: 0, regs2026: 0, sessionUid: "0",
});

// Track length (m).
// ─────────────────────────────────────────────────────────────────────────────
// The snapshot carries the game's own `trackLength` (Session packet), and that is
// used whenever it's there. The estimate below is the fallback for a snapshot
// without it: the Rust core sets lapPct = lapDistance / trackLength
// (telemetry/state.rs), so the ratio recovers it exactly. The hysteresis is what keeps it off the hub's render path: the
// snapshot rounds lapDistance to the metre, and dividing by a small lapPct
// amplifies that rounding — half a metre at lapPct 0.02 is 25 m of estimate. A
// raw ratio would therefore flip the identity slice several times at the start of
// every lap. The real value is constant for a circuit, so one latch per session
// is all that is wanted, and 1% of any circuit (50 m at Monza) is comfortably
// wider than the noise. Once latched the value is HELD rather than dropping back
// to 0 below the gate, which is what the call engine's own track-length ref has
// always done.
const TRACK_LEN_HYSTERESIS = 0.01;
const nextTrackLen = (s, prev) => {
  if (s.trackLength > 0) return s.trackLength;
  const { lapPct, lapDistance } = s;
  if (!(lapPct > 0.02) || !(lapDistance > 0)) return prev;
  const est = lapDistance / lapPct;
  if (prev > 0 && Math.abs(est - prev) <= prev * TRACK_LEN_HYSTERESIS) return prev;
  return est;
};

const EMPTY_IDENTITY = Object.freeze({
  trackId: EMPTY_TEL.trackId, sessionType: EMPTY_TEL.sessionType,
  tyreVisual: EMPTY_TEL.tyreVisual, sessionUid: EMPTY_TEL.sessionUid,
  trackLenM: 0,
});

// Re-derive the identity slice, returning the PREVIOUS object when nothing in it
// moved. That object identity is the whole mechanism: `useSyncExternalStore`
// compares successive getSnapshot() results with Object.is, so an unchanged slice
// is not a re-render.
function deriveIdentity(s, prev) {
  const trackLenM = nextTrackLen(s, prev.trackLenM);
  if (prev.trackId === s.trackId && prev.sessionType === s.sessionType
      && prev.tyreVisual === s.tyreVisual && prev.sessionUid === s.sessionUid
      && prev.trackLenM === trackLenM) return prev;
  return {
    trackId: s.trackId, sessionType: s.sessionType,
    tyreVisual: s.tyreVisual, sessionUid: s.sessionUid, trackLenM,
  };
}

const listeners = new Set();
let snapshot = EMPTY_TEL;
let identity = EMPTY_IDENTITY;
// The car setup arrives on its own `car_setup` event (it used to ride in every
// snapshot at ~35% of its size). Held here and attached to each snapshot as
// `setup`, so readers — the lap recorder — see the same shape they always did.
let carSetup = null;

// Called once per snapshot from the core's "telemetry" event (see useTelemetry).
// Updating the module state before notifying means every subscriber — a hook
// re-render or an imperative per-tick callback — sees the same frame.
export function publishTelemetry(next) {
  if (next && next.setup === undefined) next.setup = carSetup;  // a fresh event payload; ours to tag
  snapshot = next || EMPTY_TEL;
  identity = deriveIdentity(snapshot, identity);
  for (const l of listeners) l();
}

// From the core's "car_setup" event. Taken on the next snapshot; no notify of
// its own, since nothing renders it live.
export function publishCarSetup(setup) {
  carSetup = setup ?? null;
}

// A module function, not a closure: `useSyncExternalStore` re-subscribes whenever
// the subscribe function's identity changes.
export function subscribeTelemetry(onChange) {
  listeners.add(onChange);
  return () => { listeners.delete(onChange); };
}

export const getTelemetry = () => snapshot;
export const getTelemetryIdentity = () => identity;

// The whole snapshot, per tick. Only for leaves that are meant to move at the
// telemetry rate — anything mounted on every tab will re-render thirty times a
// second if it calls this.
export function useLiveTelemetry() {
  return useSyncExternalStore(subscribeTelemetry, getTelemetry, getTelemetry);
}

// The slow-moving session facts. Safe to call from the hub: see deriveIdentity.
export function useTelemetryIdentity() {
  return useSyncExternalStore(subscribeTelemetry, getTelemetryIdentity, getTelemetryIdentity);
}
