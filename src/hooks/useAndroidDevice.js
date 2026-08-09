// ─── ANDROID DEVICE CONCERNS ──────────────────────────────────────────────────
// Two things a phone-as-second-screen needs that a desktop window never did, both
// driven from state the app already has. Kept in a hook rather than in
// BoxBoxApp's body because, like useFfbEngine and useTelemetry, its whole job is
// the Tauri boundary — and on desktop `HAS_ANDROID_BRIDGE` folds to false, so the
// hook stays mounted and does nothing rather than being conditionally called.
//
// Deliberately NOT here: a foreground service. Android 12+ freezes a backgrounded
// app's threads within seconds, so recording with the screen off would need a
// service with a notification channel and a declared `connectedDevice` type — days
// of work for a use case nobody has asked for. Keeping the screen on is what makes
// "app in front for the whole stint" comfortable instead.

import { useEffect } from "react";
import {
  HAS_ANDROID_BRIDGE, setKeepAwake, acquireMulticastLock, releaseMulticastLock,
} from "../lib/androidBridge.js";

/**
 * @param receiving  true while telemetry is arriving — the screen is held awake
 *                   exactly then, so a phone left on the desk still sleeps.
 */
export function useAndroidDevice(receiving) {
  useEffect(() => {
    if (!HAS_ANDROID_BRIDGE) return;
    setKeepAwake(!!receiving);
    // No cleanup that clears the flag: the effect re-runs on every change of
    // `receiving` and sets the flag either way, and clearing it on unmount would
    // fight the plugin's own teardown.
  }, [receiving]);

  useEffect(() => {
    if (!HAS_ANDROID_BRIDGE) return;
    // Broadcast telemetry only survives Wi-Fi power save while this is held, and
    // it costs battery — so it tracks foreground, not app lifetime. The plugin
    // also drops it in onPause, for the case where the page is frozen before this
    // listener runs.
    const sync = () => {
      if (document.visibilityState === "visible") acquireMulticastLock();
      else releaseMulticastLock();
    };
    sync();
    document.addEventListener("visibilitychange", sync);
    return () => {
      document.removeEventListener("visibilitychange", sync);
      releaseMulticastLock();
    };
  }, []);
}
