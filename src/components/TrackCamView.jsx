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
//
// ONE EXCEPTION: the other car, which has volume and turns independently of the
// camera, is a real WebGL model (tcamCarLayer). It renders to its own offscreen
// canvas and is BLITTED into this 2D context mid-scene, so it lands in the layer
// order where the flat decal used to be. There is still exactly one visible canvas,
// one rAF and one settle check. The car layer is optional at runtime — when WebGL
// is unavailable, tcamScene paints the decal and nothing else changes.

import { useRef, useEffect, useCallback } from "react";
import { FONT } from "../lib/ui/tokens.js";
import { buildTCamCamera, drawTCamFrame, makeRowCursor, resolveOtherCar } from "../lib/tcamScene.js";

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
  const layerRef  = useRef(null);   // WebGL car layer, or null when GL is unavailable
  const egoRef     = useRef(null);  // baked ego-car overlay, or null until it loads
  const egoMaskRef = useRef(null);  // its bodywork mask, which confines the lap tint

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
    const { w, h, dpr } = sizeRef.current;
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
    const model = p.model || null;

    // ── Pass 1: advance every camera ──
    // Hoisted out of the draw loop because the GL pass below needs all of them
    // before any pane is painted. buildTCamCamera is also what STEPS the smoothed
    // yaw and the row cursor, so it must run exactly once per pane per frame —
    // calling it again inside pass 3 would double-step both.
    const built = list.map((pane, i) => buildTCamCamera({
      line: pane.line, frac: pane.frac, model,
      cursor: st.panes[i].cursor, yawState: st.panes[i].yaw, dt, w, h: paneH,
    }));
    // One resolve, shared by the GL render and the blit — see resolveOtherCar.
    const placed = built.map((b, i) => resolveOtherCar(model, b.rowIndex, b.cam, list[i].other));

    // ── Pass 2: the cars, into the layer's own offscreen buffer ──
    const layer = layerRef.current;
    layer?.resize(w, h, dpr); // cheap no-op when unchanged; keeps the blit 1:1
    // Not gated on there being a ghost any more: the ego car is always in this pass,
    // so the layer runs whenever it's ready.
    const glOk = !!layer?.alive && layer.render(
      built.map((b, i) => ({
        cam: b.cam,
        car: placed[i],
        ego: { ...b.ego, color: list[i].accent || "#34c8ff" },
        dist: list[i].frac * (list[i].line.lapLen || 1),
        rect: { x: 0, y: i * paneH, w, h: paneH },
      })),
    );

    // ── Pass 3: the 2D scene, blitting each pane's slice of that buffer ──
    let settled = true;
    list.forEach((pane, i) => {
      const { cam, rowIndex, yaw, yawTarget } = built[i];
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, i * paneH, w, paneH);
      ctx.clip();
      ctx.translate(0, i * paneH);

      drawTCamFrame(ctx, {
        cam, model, rowIndex, w, h: paneH,
        camDist: pane.frac * (pane.line.lapLen || 1),
        driven: p.driven || null, reference: p.reference || null,
        other: placed[i], egoColor: pane.accent,
        egoImage: egoRef.current, egoMask: egoMaskRef.current, egoLive: glOk,
        cornerMarks: p.cornerMarks || null, brakeMarks: p.brakeMarks || null,
        // Source rect is the pane's box in the GL canvas's DEVICE pixels; the
        // destination is CSS pixels inside the translated, clipped pane.
        drawOther: glOk ? () => ctx.drawImage(
          layer.canvas,
          0, Math.round(i * paneH * dpr), Math.round(w * dpr), Math.round(paneH * dpr),
          0, 0, w, paneH,
        ) : null,
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
    // The car layer is loaded on DEMAND, and that's a startup-cost decision, not a
    // style one: three.js is ~500 kB and would otherwise sit in the entry chunk that
    // every launch parses before the Dashboard paints — for a renderer that only
    // runs inside one tab of Analytics. Dynamically imported, Vite splits it into its
    // own chunk that is fetched the first time a T-cam mounts.
    //
    // Everything downstream already tolerates a missing layer (that's the no-WebGL
    // path), so the frames drawn before it lands simply use the flat decal. Built
    // here rather than in its own effect so the GL context is torn down by the same
    // cleanup that stops the loop — StrictMode's double mount would otherwise leak
    // one context per remount. drawOnce sizes it, so ordering doesn't matter.
    // The ego car overlay and its body mask. Vendored in public/ like every other
    // startup asset, so an offline launch never waits on them, and they fail soft the
    // same way the car layer does: no overlay and tcamScene draws its hoop instead;
    // overlay but no mask and the car renders untinted rather than wrongly tinted.
    const load = (src, ref) => {
      const im = new Image();
      im.onload = () => { ref.current = im; stRef.current.lastKey = null; start(); };
      im.src = src;
    };
    load("/tcam-ego.png", egoRef);
    load("/tcam-ego-mask.png", egoMaskRef);

    let cancelled = false;
    import("../lib/tcamCarLayer.js").then(({ createCarLayer }) => {
      if (cancelled) return;
      // The callback fires when the car model finishes loading, which is after this
      // — until then the layer reports not-ready and tcamScene draws its decal.
      layerRef.current = createCarLayer(() => { stRef.current.lastKey = null; start(); });
      stRef.current.lastKey = null;   // the loop may have settled; force one more frame
      start();
    }).catch(() => { /* no car layer — tcamScene's decal stands in */ });

    const ro = new ResizeObserver(() => { if (resize()) { stRef.current.lastKey = null; start(); } });
    ro.observe(wrap);
    resize();
    start();
    return () => {
      cancelled = true;
      ro.disconnect();
      layerRef.current?.dispose();
      layerRef.current = null;
    };
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
