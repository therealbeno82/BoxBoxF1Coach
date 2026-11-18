// Subscribes to the in-process telemetry core's Tauri events.
// ─────────────────────────────────────────────────────────────────────────────
// Replaces the old WebSocket bridge client. The native core (src-tauri) owns the
// single UDP listener and emits two events:
//   • "telemetry"    — a snapshot, field-for-field identical to the old bridge's
//   • "core_status"  — { receiving, udpPort, bindError, wrongFormat }
// The core is always running, so there's no connect/disconnect/backoff: we just
// listen. `onReceivingChange` fires on the rising/falling edge of "is the game
// actually sending packets", which drives the UDP pill and a fresh drive session;
// `onStatus` gets the whole status object (Settings explains a bind failure or a
// wrong UDP format with it).
//
// "core_status" is only emitted when the status CHANGES, and the core starts
// emitting before this page has loaded — so a game already streaming at launch
// changed it to "receiving" with nobody listening. The current value is
// therefore also ASKED for on mount (`get_core_status`), and once more shortly
// after, to cover a change that lands between that answer and the listener
// attaching. An event always wins over an answer: once one has arrived, the
// answers are ignored, since they may be older.

import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useTauriEvents } from "./useTauriEvents.js";
import { inTauri } from "../lib/env.js";
import { publishCarSetup } from "../lib/telemetryStore.js";

export function useTelemetry({ onSnapshot, onReceivingChange, onStatus }) {
  const cbRef = useRef({ onSnapshot, onReceivingChange, onStatus });
  cbRef.current = { onSnapshot, onReceivingChange, onStatus };
  const receivingRef = useRef(false);
  const sawEventRef = useRef(false);

  const applyStatus = (st) => {
    if (!st) return;
    cbRef.current.onStatus?.(st);
    const recv = !!st.receiving;
    if (recv !== receivingRef.current) {
      receivingRef.current = recv;
      cbRef.current.onReceivingChange?.(recv);
    }
  };

  useTauriEvents({
    telemetry: (e) => {
      cbRef.current.onSnapshot?.(e.payload);
    },
    core_status: (e) => {
      sawEventRef.current = true;
      applyStatus(e.payload);
    },
    // Sent on change and re-sent every few seconds by the core (lib.rs), so a
    // page that subscribes late still gets it.
    car_setup: (e) => publishCarSetup(e.payload),
  });

  useEffect(() => {
    if (!inTauri) return;
    let cancelled = false;
    const ask = () => invoke("get_core_status")
      .then((st) => { if (!cancelled && !sawEventRef.current) applyStatus(st); })
      .catch(() => { /* older core without the command — events still work */ });
    ask();
    const again = setTimeout(ask, 1500);
    return () => { cancelled = true; clearTimeout(again); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
