// ─── ANDROID BRIDGE ───────────────────────────────────────────────────────────
// The thin JS side of `tauri-plugin-f1android`. Everything here is a WebView
// capability gap, not a feature: a page served from http://tauri.localhost is not
// a secure context, so `navigator.wakeLock` doesn't exist, and nothing in the web
// platform can reach Android's Wi-Fi power-save filter at all.
//
// `isAndroid` is a build-time constant, so on desktop Rollup folds every call
// here into a resolved promise and the module costs nothing. Nothing throws:
// these are comfort features, and a phone that won't take the multicast lock
// should still coach.

import { inTauri, isAndroid } from "./env.js";

/** True only where the plugin's commands actually exist. */
export const HAS_ANDROID_BRIDGE = isAndroid;

let _invoke = null;
async function call(cmd, args) {
  if (!isAndroid || !inTauri) return null;
  if (!_invoke) ({ invoke: _invoke } = await import("@tauri-apps/api/core"));
  try {
    return await _invoke(`plugin:f1android|${cmd}`, args);
  } catch (e) {
    console.warn(`f1android ${cmd} failed:`, e);
    return null;
  }
}

/**
 * Hold the screen on. The use case is a phone propped against the wheel rim for
 * a whole stint, where the display timeout is the difference between a second
 * screen and a black rectangle.
 */
export function setKeepAwake(enabled) {
  return call("set_keep_awake", { enabled: !!enabled });
}

/**
 * Take the Wi-Fi multicast lock.
 *
 * Only BROADCAST telemetry needs it — if the driver enters the phone's own IP in
 * the game (which is what the Settings network card pushes), the frames are
 * unicast and Android never filters them. It costs battery, so it is held only
 * while the app is in front; the plugin also drops it on `onPause` in case the
 * page never gets to.
 */
export const acquireMulticastLock = () => call("acquire_multicast_lock");
export const releaseMulticastLock = () => call("release_multicast_lock");

/** Raw access for the TTS client, which lives under lib/tts/. */
export const callPlugin = call;
