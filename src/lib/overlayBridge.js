// ─── OVERLAY BRIDGE ──────────────────────────────────────────────────────────
// The main window and the overlay window are two separate JS contexts. Telemetry
// reaches both on its own (the Rust emitter uses app.emit, which broadcasts to
// every webview), but everything DERIVED — the reference lap, whether it is even
// comparable, which cue categories are armed — lives in BoxBoxApp's React tree
// and has to be carried across explicitly. This module is that channel.
//
// It rides Tauri's own event bus rather than a Rust command, because a JS emit()
// already broadcasts to every webview in the app. That means no new command, no
// new capability beyond the overlay's core:event:default, and the same code path
// in both directions.
//
// WHAT DELIBERATELY DOES NOT GO THROUGH HERE: the telemetry snapshot. It arrives
// in the overlay directly from Rust at ~30 Hz. Relaying it through the main
// window would add a hop, a serialization, and a React render to a value the
// overlay can already read — and would make the HUD stutter whenever the main
// window was busy drawing a track map.

import { emit } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { inTauri } from "./env.js";

/** Main → overlay: everything derived that the HUD needs. Sent on change. */
export const EV_STATE = "overlay_state";
/** Overlay → main: a cue category was toggled on the HUD. */
export const EV_CUE_TOGGLE = "overlay_cue_toggle";
/**
 * Overlay → main: "I just mounted, send me everything."
 * Without this the overlay would render empty until the next time something in
 * the main window happened to change — which, mid-session with a reference
 * already loaded and the cues already set, could be never.
 */
export const EV_REQUEST_STATE = "overlay_request_state";
/**
 * Rust → overlay: click-through was turned off (edit mode) or back on.
 * Emitted by set_overlay_interactive itself rather than by whoever called it, so
 * the handles the page draws can never disagree with the clicks it can receive.
 */
export const EV_EDIT = "overlay_edit";

export function emitOverlayState(state) {
  if (!inTauri) return;
  emit(EV_STATE, state).catch(() => {});   // fails soft: no overlay open is normal
}

export function emitCueToggle(key, on) {
  if (!inTauri) return;
  emit(EV_CUE_TOGGLE, { key, on }).catch(() => {});
}

export function emitRequestState() {
  if (!inTauri) return;
  emit(EV_REQUEST_STATE, {}).catch(() => {});
}

/**
 * Re-arm click-through, called BY THE OVERLAY on itself.
 *
 * This is not a convenience. The overlay covers the whole monitor, so while it is
 * unlocked it swallows every click on the desktop — including the one on the
 * Settings checkbox that unlocked it. Without a way out from inside, unlocking
 * the overlay locks the user out of the app that controls it.
 *
 * Custom commands are not capability-gated in Tauri 2 (only plugin `core:` ones
 * are), so the overlay can call this despite holding nothing but event permissions.
 */
export function lockOverlay() {
  if (!inTauri) return;
  invoke("set_overlay_interactive", { interactive: false }).catch(() => {});
}
