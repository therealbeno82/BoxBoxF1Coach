// Subscribe to a set of Tauri events for the component's lifetime.
// ─────────────────────────────────────────────────────────────────────────────
// `handlers` maps event name → callback(event). The map is captured in a ref
// and re-read per event, so callers can pass fresh closures every render
// without re-subscribing. Handles the unmount-during-await race (listen() is
// async) in one place. No-op outside the Tauri webview.
//
// CONSTRAINT: the set of event *names* is read once at mount (the effect has an
// empty dep array). Callbacks may change freely every render, but the event
// names must be static — a name added conditionally on a later render will not
// get subscribed. Every current caller passes a fixed key set, which is fine.

import { useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { inTauri } from "../lib/env.js";

export function useTauriEvents(handlers) {
  const ref = useRef(handlers);
  ref.current = handlers;

  useEffect(() => {
    if (!inTauri) return;
    let disposed = false;
    const unlistens = [];
    (async () => {
      for (const name of Object.keys(ref.current)) {
        const un = await listen(name, (e) => ref.current[name]?.(e));
        // If the component unmounted while we were awaiting, detach immediately.
        if (disposed) un();
        else unlistens.push(un);
      }
    })();
    return () => {
      disposed = true;
      for (const un of unlistens) un();
    };
  }, []);
}
