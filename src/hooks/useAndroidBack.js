// ─── ANDROID HARDWARE BACK ────────────────────────────────────────────────────
// A stack of things the back button can close, newest first.
//
// The press arrives from Kotlin (`MainActivity.kt`), which asks the page whether
// it wants it and destroys the activity if the answer isn't a clear yes. That is
// why a handler must RETURN TRUE to claim the press: silence has to mean "I
// didn't handle it", or a wedged page would turn back into a dead key.
//
// A stack rather than a single handler because layers nest — a modal opened from
// a non-default tab must close before back starts changing tabs. Registration
// order is mount order, and the newest mounted layer is the innermost one, so
// walking from the top is the same thing as walking inwards.
//
// Desktop keeps its Escape key; this is additional, not a replacement. On desktop
// `isAndroid` folds to false, the bridge is never installed and every hook call
// here is inert.

import { useEffect, useRef } from "react";
import { isAndroid } from "../lib/env.js";

const stack = [];

if (isAndroid && typeof window !== "undefined") {
  window.__f1AndroidBack = () => {
    for (let i = stack.length - 1; i >= 0; i--) {
      try {
        if (stack[i]() === true) return true;
      } catch (e) {
        // A throwing handler must not swallow the press — try the next layer.
        console.warn("back handler threw:", e);
      }
    }
    return false;
  };
}

/**
 * Claim the hardware back button while `active`.
 *
 * @param handler  called on back; return true if it consumed the press. A plain
 *                 `onClose` works — the hook treats "didn't say no" as consumed,
 *                 since a registered layer is by definition closable.
 * @param active   defaults true; pass the modal's own open flag when the hook
 *                 can't be called conditionally.
 */
export function useAndroidBack(handler, active = true) {
  // The handler is read through a ref so an inline arrow — which every caller
  // passes — doesn't re-register on every render. Re-registering would push the
  // layer back to the TOP of the stack each time its parent re-rendered, which
  // for a modal over a live-telemetry screen is 30 times a second, and would
  // quietly invert the nesting.
  const ref = useRef(handler);
  ref.current = handler;

  useEffect(() => {
    if (!isAndroid || !active) return;
    const entry = () => {
      const fn = ref.current;
      if (typeof fn !== "function") return false;
      return fn() !== false;
    };
    stack.push(entry);
    return () => {
      const i = stack.indexOf(entry);
      if (i >= 0) stack.splice(i, 1);
    };
  }, [active]);
}
