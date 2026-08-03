// ─── TRACK CAM VIEW (Analytics ▸ Driving Lines ▸ T-Cam) ───────────────────────
// The onboard camera viewport. A LEAF renderer on purpose: it owns a canvas, a
// device-pixel-ratio, and a rAF, and nothing else. Every lap, line, track model
// and playhead it draws arrives as a prop from DrivingLinesView, which stays the
// single owner of the playback clock — two components each advancing the playhead
// would double-step it.
//
// Canvas rather than SVG, unlike the plan view next door. The plan view's geometry
// is fixed and only its viewBox moves, so the DOM can be built once. Here the
// camera moves, so every coordinate in the scene changes every frame: clipped
// polygons change vertex COUNT frame to frame, each quad wants its own fill
// colour, and far→near ordering is just call order. That's canvas's job
// description. (exportMapImage, TraceCalibrator and avatarImage already use 2D
// canvas here, so it isn't a new pattern in this codebase.)

import { useRef, useEffect, useCallback } from "react";
import { FONT } from "../lib/ui/tokens.js";
import { buildTCamCamera, drawTCamFrame, makeRowCursor } from "../lib/tcamScene.js";

// Settle thresholds: below these the scene is visually static, so the loop stops
// scheduling frames and the panel goes to zero wakeups until a prop moves it.
const SETTLE_YAW = 0.0015;   // rad

// `panes` is one camera each: [{ line, frac, label, accent, other }]. One pane is
// the T-Cam, two is Compare — stacked, and on ONE canvas rather than two, so there
// is a single rAF, a single DPR setup and a single settle check no matter how many
// cameras are on screen.
export default function TrackCamView({ panes, model, driven, reference, cornerMarks, brakeMarks }) {
  const wrapRef   = useRef(null);
  const canvasRef = useRef(null);
  const ctxRef    = useRef(null);
  const sizeRef   = useRef({ w: 0, h: 0, dpr: 1 });
  const rafRef    = useRef(0);
  const stRef     = useRef({ panes: [], last: 0, lastKey: null });

  // Latest props, read by the loop. Written on every render with no dep array —
  // the same deliberate depless pattern the plan view's camera uses, because every
  // way these can change (playback, scrub, segment step, lap swap) is a render.
  const pRef = useRef(null);
  pRef.current = { panes, model, driven, reference, cornerMarks, brakeMarks };

  // ── Sizing. canvas.width RESETS the transform, so setTransform has to follow
  // every resize; and it reallocates the backing store, so it must never run per
  // frame. Measured by ResizeObserver into a ref rather than read inside the loop,
  // where touching clientWidth would force a style recalc every frame. ──
  const resize = useCallback(() => {
    const wrap = wrapRef.current, canvas = canvasRef.current;
    if (!wrap || !canvas) return false;
    const w = Math.max(1, Math.round(wrap.clientWidth));
    const h = Math.max(1, Math.round(wrap.clientHeight));
    // Re-read DPR here too: dragging the window to a monitor with a different
    // scale factor changes it without changing the CSS size.
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const s = sizeRef.current;
    if (s.w === w && s.h === h && s.dpr === dpr) return false;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    ctxRef.current = canvas.getContext("2d");
    ctxRef.current.setTransform(dpr, 0, 0, dpr, 0, 0); // draw in CSS px throughout
    sizeRef.current = { w, h, dpr };
    return true;
  }, []);

  const drawOnce = useCallback((dt) => {
    const p = pRef.current;
    const { w, h } = sizeRef.current;
    const ctx = ctxRef.current;
    const list = p?.panes?.filter((q) => q?.line) || [];
    if (!ctx || !w || !h || !list.length) return true;

    const st = stRef.current;
    // Each camera carries its own smoothed yaw and row cursor. Rebuild when the
    // pane count changes so a Compare→T-Cam switch can't hand pane 0 the other
    // car's cursor and walk it across the circuit.
    if (st.panes.length !== list.length) {
      st.panes = list.map(() => ({ yaw: {}, cursor: makeRowCursor() }));
    }

    const paneH = h / list.length;
    let settled = true;
    list.forEach((pane, i) => {
      const ps = st.panes[i];
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, i * paneH, w, paneH);
      ctx.clip();
      ctx.translate(0, i * paneH);

      const { cam, rowIndex, yaw, yawTarget } = buildTCamCamera({
        line: pane.line, frac: pane.frac, model: p.model || null,
        cursor: ps.cursor, yawState: ps.yaw, dt, w, h: paneH,
      });
      drawTCamFrame(ctx, {
        cam, model: p.model || null, rowIndex, w, h: paneH,
        camDist: pane.frac * (pane.line.lapLen || 1),
        driven: p.driven || null, reference: p.reference || null,
        other: pane.other || null, egoColor: pane.accent,
        cornerMarks: p.cornerMarks || null, brakeMarks: p.brakeMarks || null,
      });

      if (pane.label) {
        ctx.font = `700 10px ${FONT.mono}`;
        ctx.fillStyle = pane.accent || "#e8edf5";
        ctx.globalAlpha = 0.9;
        ctx.fillText(pane.label.toUpperCase(), 12, paneH - 12);
        ctx.globalAlpha = 1;
      }
      ctx.restore();

      const dy = Math.abs(Math.atan2(Math.sin(yawTarget - yaw), Math.cos(yawTarget - yaw)));
      if (dy >= SETTLE_YAW) settled = false;
    });

    // A divider, so two stacked cameras don't read as one continuous scene.
    if (list.length > 1) {
      ctx.fillStyle = "rgba(0,0,0,0.85)";
      for (let i = 1; i < list.length; i++) ctx.fillRect(0, i * paneH - 1, w, 2);
    }

    const key = list.map((q) => q.frac).join("|");
    if (st.lastKey !== key) settled = false;
    st.lastKey = key;
    return settled;
  }, []);

  // Self-terminating loop, same shape as the plan view's camera smoother: it stops
  // scheduling once the scene is static and the effect below wakes it when a prop
  // moves. The `if (rafRef.current) return` guard is also what makes StrictMode's
  // double-mounted effects idempotent in dev.
  const start = useCallback(() => {
    if (rafRef.current) return;
    stRef.current.last = performance.now();
    const step = (now) => {
      const st = stRef.current;
      const dt = Math.min(0.1, (now - st.last) / 1000);
      st.last = now;
      if (drawOnce(dt)) { rafRef.current = 0; return; }
      rafRef.current = requestAnimationFrame(step);
    };
    rafRef.current = requestAnimationFrame(step);
  }, [drawOnce]);

  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const ro = new ResizeObserver(() => { if (resize()) { stRef.current.lastKey = null; start(); } });
    ro.observe(wrap);
    resize();
    start();
    return () => ro.disconnect();
  }, [resize, start]);

  // Wake on every render — a changed playhead, lap, or model all arrive that way.
  useEffect(() => { start(); });
  useEffect(() => () => { cancelAnimationFrame(rafRef.current); rafRef.current = 0; }, []);

  return (
    <div ref={wrapRef} style={{ position: "absolute", inset: 0, overflow: "hidden" }}>
      <canvas ref={canvasRef} style={{ display: "block" }} />
    </div>
  );
}
