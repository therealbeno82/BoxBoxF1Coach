// ─── OVERLAY HOST ────────────────────────────────────────────────────────────
// The full-screen transparent window that sits over the game. It owns three
// things and delegates the rest:
//
//   1. Inputs. Telemetry arrives DIRECTLY from Rust at ~30 Hz (the emitter uses
//      app.emit, which broadcasts to every webview) — it is not relayed through
//      the main window, which would add a hop and make the HUD stutter whenever
//      the main window was busy drawing a track map. Everything derived — the
//      reference curve, whether it is comparable, which cues are armed — comes
//      over the bridge (lib/overlayBridge.js) because it lives in BoxBoxApp's
//      React tree and this is a different JS context.
//
//   2. The delta. Computed HERE rather than pushed, because it changes every
//      tick: pushing it would mean a 30 Hz IPC round trip for a subtraction, and
//      the two inputs are already both in this window.
//
//   3. Placement. Widgets are absolutely positioned and scaled from the saved
//      layout; dragging is only live in edit mode.

import { useEffect, useMemo, useState } from "react";
import { useTauriEvents } from "../hooks/useTauriEvents.js";
import { inTauri } from "../lib/env.js";
import { refTimeAt } from "../lib/timeAxis.js";
import { emitCueToggle, emitRequestState, lockOverlay, EV_STATE, EV_EDIT } from "../lib/overlayBridge.js";
import { WIDGETS } from "./widgets.jsx";
import { useOverlayLayout, useDragScale } from "./useOverlayLayout.js";

/**
 * Live delta, or the reason there isn't one.
 *
 * The reasons matter as much as the number. A HUD that shows a dash is
 * indistinguishable from a broken HUD, and the three ways to get here — no
 * reference picked, a reference the coach has muted, a reference too old to
 * carry a clock — each have a different fix.
 */
function computeDelta(state, snap) {
  if (!state?.hasRef) return { v: null, why: "No reference lap loaded" };
  if (state.refReason) return { v: null, why: state.refReason };
  if (!state.refAxis) return { v: null, why: "Reference carries no lap clock" };
  const t = snap?.lapTime, d = snap?.lapDistance;
  if (!(t > 0) || typeof d !== "number" || d < 0) return { v: null, why: null };
  const ref = refTimeAt(state.refAxis, d);
  if (ref == null) return { v: null, why: null };
  return { v: t - ref, why: null };
}

/** One widget: positions it, scales it, and hosts its drag handles in edit mode. */
function Frame({ w, box, update, editing, children }) {
  const drag = useDragScale({ id: w.id, box, update, designW: w.w, enabled: editing });
  return (
    <div
      onPointerDown={(e) => drag.onPointerDown(e, "move")}
      onPointerMove={drag.onPointerMove}
      onPointerUp={drag.onPointerUp}
      style={{
        position: "absolute",
        left: box.x, top: box.y,
        width: w.w, height: w.h,
        // Scaling from the top-left keeps the anchor the same point the drag
        // moves, so resizing never also shifts the widget.
        transform: `scale(${box.scale})`,
        transformOrigin: "top left",
        cursor: editing ? "move" : "default",
        outline: editing ? "1px dashed rgba(255,255,255,.45)" : "none",
        outlineOffset: 3,
      }}>
      {children}
      {editing && (
        <>
          <div style={{
            position: "absolute", top: -19, left: 0, fontSize: 9, fontWeight: 700,
            letterSpacing: 1, color: "rgba(255,255,255,.7)", whiteSpace: "nowrap",
            textShadow: "0 1px 3px #000",
          }}>{w.name}</div>
          {/* Corner grip. stopPropagation on the down is what stops a resize from
              also being read as a move by the parent. */}
          <div
            onPointerDown={(e) => drag.onPointerDown(e, "scale")}
            onPointerMove={drag.onPointerMove}
            onPointerUp={drag.onPointerUp}
            style={{
              position: "absolute", right: -6, bottom: -6, width: 14, height: 14,
              borderRadius: 3, background: "#3671C6", border: "1px solid #fff",
              cursor: "nwse-resize",
            }} />
        </>
      )}
    </div>
  );
}

export default function OverlayApp() {
  const [snap, setSnap] = useState(null);
  const [receiving, setReceiving] = useState(false);
  const [state, setState] = useState(null);
  const [editing, setEditing] = useState(false);
  const { layout, update, toggle, reset } = useOverlayLayout(WIDGETS);

  useTauriEvents({
    telemetry: (e) => setSnap(e.payload),
    core_status: (e) => setReceiving(!!e.payload?.receiving),
    [EV_STATE]: (e) => setState(e.payload),
    [EV_EDIT]: (e) => setEditing(!!e.payload),
  });

  // Ask the main window for a resend as soon as we exist. Without this the HUD
  // would sit empty until something over there happened to change — which, with a
  // reference already loaded and the cues already set, could be the whole session.
  useEffect(() => { emitRequestState(); }, []);

  // Escape re-locks. The overlay covers the whole monitor, so while unlocked it is
  // in front of every other window — this is the same escape hatch as the Lock
  // button for the case where a widget has been dragged over the bar.
  useEffect(() => {
    if (!editing) return;
    const onKey = (e) => { if (e.key === "Escape") lockOverlay(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editing]);

  const delta = useMemo(() => computeDelta(state, snap), [state, snap]);

  return (
    <div style={{ position: "fixed", inset: 0, overflow: "hidden" }}>
      {WIDGETS.map(w => {
        const box = layout[w.id];
        if (!box?.on) return null;
        return (
          <Frame key={w.id} w={w} box={box} update={update} editing={editing}>
            <w.Render
              snap={snap}
              state={state}
              delta={delta}
              editing={editing}
              onCueToggle={emitCueToggle}
            />
          </Frame>
        );
      })}

      {editing && (
        <EditBar
          layout={layout} toggle={toggle} reset={reset}
          receiving={receiving} inTauri={inTauri}
        />
      )}
    </div>
  );
}

/** Edit-mode chrome: which widgets are shown, and a way back to defaults. Only
 *  rendered in edit mode, so nothing here is ever on screen while driving. */
function EditBar({ layout, toggle, reset, receiving, inTauri: native }) {
  const btn = (on) => ({
    padding: "5px 10px", borderRadius: 7, fontSize: 11, fontWeight: 700, cursor: "pointer",
    fontFamily: "inherit",
    background: on ? "rgba(54,113,198,.35)" : "rgba(255,255,255,.06)",
    border: `1px solid ${on ? "#3671C6" : "rgba(255,255,255,.15)"}`,
    color: on ? "#fff" : "rgba(255,255,255,.5)",
  });
  return (
    <div style={{
      position: "absolute", left: "50%", bottom: 26, transform: "translateX(-50%)",
      background: "rgba(8,11,17,.92)", border: "1px solid rgba(255,255,255,.14)",
      borderRadius: 12, padding: "11px 14px", display: "flex", flexDirection: "column",
      gap: 9, alignItems: "center", boxShadow: "0 10px 34px rgba(0,0,0,.6)",
      color: "#fff", fontFamily: '"Archivo", system-ui, sans-serif',
    }}>
      <div style={{ fontSize: 10, letterSpacing: 1.4, fontWeight: 700, color: "rgba(255,255,255,.6)" }}>
        OVERLAY UNLOCKED — DRAG TO MOVE, CORNER TO RESIZE
      </div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", justifyContent: "center" }}>
        {WIDGETS.map(w => (
          <button key={w.id} onClick={() => toggle(w.id)} style={btn(layout[w.id]?.on)}>
            {w.name}
          </button>
        ))}
        <button onClick={reset} style={{
          ...btn(false), borderColor: "rgba(255,120,120,.4)", color: "rgba(255,150,150,.9)",
        }}>Reset layout</button>
        {/* The way out. While unlocked this window is in front of everything and
            eats every click on the desktop, so the control that re-locks it has to
            live HERE — the Settings checkbox that unlocked it is unreachable. */}
        <button onClick={lockOverlay} style={{
          ...btn(true), background: "#37d67a", borderColor: "#37d67a", color: "#06210f",
        }}>✓ Lock (Esc)</button>
      </div>
      <div style={{ fontSize: 10, color: "rgba(255,255,255,.42)" }}>
        {!native ? "No native core"
          : receiving ? "Telemetry live"
          : "Waiting for telemetry — turn on Demo Mode to test without the game"}
      </div>
    </div>
  );
}
