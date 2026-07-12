// Subscribes to the in-process telemetry core's Tauri events.
// ─────────────────────────────────────────────────────────────────────────────
// Replaces the old WebSocket bridge client. The native core (src-tauri) owns the
// single UDP listener and emits two events:
//   • "telemetry"    — a snapshot, field-for-field identical to the old bridge's
//   • "core_status"  — { receiving, udpPort }
// The core is always running, so there's no connect/disconnect/backoff: we just
// listen. `onReceivingChange` fires on the rising/falling edge of "is the game
// actually sending packets", which drives the UDP pill and a fresh drive session.

import { useRef } from "react";
import { useTauriEvents } from "./useTauriEvents.js";

export function useTelemetry({ onSnapshot, onReceivingChange }) {
  const cbRef = useRef({ onSnapshot, onReceivingChange });
  cbRef.current = { onSnapshot, onReceivingChange };
  const receivingRef = useRef(false);

  useTauriEvents({
    telemetry: (e) => {
      cbRef.current.onSnapshot?.(e.payload);
    },
    core_status: (e) => {
      const recv = !!e.payload?.receiving;
      if (recv !== receivingRef.current) {
        receivingRef.current = recv;
        cbRef.current.onReceivingChange?.(recv);
      }
    },
  });
}
