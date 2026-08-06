// ─── TRACK ORBIT VIEW (Analytics ▸ Driving Lines ▸ 3D) ────────────────────────
// The plan view's scene with the camera let off its leash: same road, same two
// racing lines, same two cars, but seen from any bearing and height you drag it to.
// Looking along a corner from just above the kerb is the one vantage that shows how
// two lines differ in the part that matters — the plan view flattens the whole
// entry-to-apex sequence into one picture, and the T-cam can only ever show it from
// inside one of the two cars.
//
// A LEAF renderer, exactly like TrackCamView: it owns a canvas, a DPR, a rAF and the
// orbit pose, and nothing else. Every lap, line, model and car position arrives as a
// prop from DrivingLinesView, which stays the single owner of the playback clock.
//
// The scene itself is three.js and lives in lib/orbitScene.js, dynamically imported
// for the same reason the T-cam's car layer is: ~560 kB of three has no business in
// the entry chunk that every launch parses before the Dashboard paints. Until it
// lands (and permanently, if WebGL is unavailable) this renders a note and the other
// camera modes carry on working.

import { useRef, useEffect, useState, useCallback } from "react";
import { FONT } from "../lib/ui/tokens.js";
import { clamp } from "../lib/format.js";

const DEG = Math.PI / 180;
// Elevation stops short of straight down and of ground level: at 90° the orbit's
// azimuth becomes meaningless and the view snaps as you cross it, and below ~6° the
// road is edge-on and there is nothing to see.
const MIN_EL = 6 * DEG, MAX_EL = 87 * DEG;
const EL0 = 32 * DEG;             // default: low enough to read a corner's shape
// Camera distance from the shared zoom slider. Slightly super-linear so the same
// 0.5–8 range that frames a segment on the map runs from most of a straight (320 m)
// down to standing beside the two cars (15 m), which is the end of it this view is
// actually for.
const ORBIT_BASE_M = 150, ORBIT_ZOOM_POW = 1.1;
const DRAG_AZ = 0.007;            // rad per px, horizontal
const DRAG_EL = 0.005;            // rad per px, vertical
const TARGET_TAU = 0.22;          // s — camera-target smoothing
const SNAP_M = 120;               // a jump this big is a scrub, not motion: cut, don't glide
const SETTLE_M = 0.02;            // target this close to its mark counts as arrived

export default function TrackOrbitView({
  model, driven, reference, cornerMarks, brakeMarks, cars, zoom = 1, onZoomBy,
}) {
  const wrapRef   = useRef(null);
  const canvasRef = useRef(null);
  const sceneRef  = useRef(null);
  const sizeRef   = useRef({ w: 0, h: 0, dpr: 1 });
  const rafRef    = useRef(0);
  const lastRef   = useRef(0);
  const keyRef    = useRef(null);
  const targetRef = useRef(null);   // smoothed look-at point, in world units
  const trackRef  = useRef({});     // last inputs the static geometry was built from
  const [failed, setFailed] = useState(false);

  // Orbit pose. `az` starts null and is seeded from the car's heading on the first
  // frame, so the view opens looking up the road rather than at an arbitrary compass
  // bearing; after that it is WORLD-fixed, so the corner holds still while the cars
  // drive through it. Double-click puts it back.
  const poseRef = useRef({ az: null, el: EL0 });

  // Latest props, read by the loop — the same depless pattern the other two views
  // use, because every way these change (playback, scrub, lap swap) is a render.
  const pRef = useRef(null);
  pRef.current = { model, driven, reference, cornerMarks, brakeMarks, cars, zoom };
  const zoomByRef = useRef(onZoomBy);
  zoomByRef.current = onZoomBy;

  // canvas.width reallocates the backing store, so it must never run per frame;
  // measured by ResizeObserver into a ref rather than read inside the loop, where
  // touching clientWidth would force a style recalc every frame.
  const resize = useCallback(() => {
    const wrap = wrapRef.current, canvas = canvasRef.current;
    if (!wrap || !canvas) return false;
    const w = Math.max(1, Math.round(wrap.clientWidth));
    const h = Math.max(1, Math.round(wrap.clientHeight));
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const s = sizeRef.current;
    if (s.w === w && s.h === h && s.dpr === dpr) return false;
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    sizeRef.current = { w, h, dpr };
    sceneRef.current?.resize(w, h, dpr);
    return true;
  }, []);

  const drawOnce = useCallback((dt) => {
    const scene = sceneRef.current;
    const p = pRef.current;
    const { w, h } = sizeRef.current;
    if (!scene || !scene.alive || !w || !h) return true;

    // Static geometry is rebuilt only when its inputs change IDENTITY. Everything
    // upstream is memoised, so this is one reference comparison per frame against a
    // rebuild that walks a few thousand centerline rows.
    const t = trackRef.current;
    if (t.model !== p.model || t.driven !== p.driven || t.reference !== p.reference
        || t.cornerMarks !== p.cornerMarks || t.brakeMarks !== p.brakeMarks) {
      trackRef.current = { model: p.model, driven: p.driven, reference: p.reference,
        cornerMarks: p.cornerMarks, brakeMarks: p.brakeMarks };
      scene.setTrack(trackRef.current);
      keyRef.current = null;
    }

    const list = (p.cars || []).filter(Boolean);
    scene.setCars(list);

    // The camera watches ONE car — the driven lap's — rather than the midpoint of
    // the two. In pos-sync the two are metres apart and it makes no difference; in
    // pace-sync they can be half a circuit apart, and a camera splitting the
    // difference would be pointed at empty tarmac between them.
    const focus = list.find((c) => c.main) || list[0] || null;
    const pose = poseRef.current;
    if (focus && pose.az == null) pose.az = focus.yaw + Math.PI;   // open from behind the car

    let moving = false;
    if (focus) {
      const fx = focus.x, fz = focus.z, fy = scene.roadY(fx, fz);
      const cur = targetRef.current;
      if (!cur) { targetRef.current = { x: fx, y: fy, z: fz }; moving = true; }
      else {
        const gap = Math.hypot(fx - cur.x, fz - cur.z);
        const k = gap > SNAP_M ? 1 : 1 - Math.exp(-dt / TARGET_TAU);
        cur.x += (fx - cur.x) * k; cur.y += (fy - cur.y) * k; cur.z += (fz - cur.z) * k;
        if (gap > SETTLE_M) moving = true;
      }
    }

    const dist = ORBIT_BASE_M / Math.pow(Math.max(0.05, p.zoom || 1), ORBIT_ZOOM_POW);
    const tgt = targetRef.current || { x: 0, y: 0, z: 0 };
    scene.setCamera(tgt.x, tgt.y, tgt.z, pose.az ?? 0, pose.el, dist);
    scene.render();

    // Nothing below moves on its own, so the loop can sleep until a prop, a drag or
    // the zoom moves one of them.
    const key = `${pose.az}|${pose.el}|${dist}|`
      + list.map((c) => `${c.x.toFixed(2)},${c.z.toFixed(2)},${c.yaw.toFixed(3)}`).join(";");
    const settled = !moving && keyRef.current === key;
    keyRef.current = key;
    return settled;
  }, []);

  // Self-terminating loop, the same shape as the T-cam's and the plan view's.
  const start = useCallback(() => {
    if (rafRef.current) return;
    lastRef.current = performance.now();
    const step = (now) => {
      const dt = Math.min(0.1, (now - lastRef.current) / 1000);
      lastRef.current = now;
      if (drawOnce(dt)) { rafRef.current = 0; return; }
      rafRef.current = requestAnimationFrame(step);
    };
    rafRef.current = requestAnimationFrame(step);
  }, [drawOnce]);

  useEffect(() => {
    const wrap = wrapRef.current, canvas = canvasRef.current;
    if (!wrap || !canvas) return;
    let cancelled = false;
    import("../lib/orbitScene.js").then(({ createOrbitScene }) => {
      if (cancelled) return;
      // onReady fires when the car model lands, which is after this — the loop may
      // well have settled by then, so it forces one more frame.
      const scene = createOrbitScene(canvas, () => { keyRef.current = null; start(); });
      if (!scene) { setFailed(true); return; }   // no WebGL — say so, don't fail silently
      sceneRef.current = scene;
      // A new scene has an empty world, so the record of what was built into the last
      // one has to go with it — these two are only ever correct as a pair.
      trackRef.current = {};
      sizeRef.current = { w: 0, h: 0, dpr: 1 };  // force resize() to size the new renderer
      resize();
      keyRef.current = null;
      start();
    }).catch(() => { if (!cancelled) setFailed(true); });

    const ro = new ResizeObserver(() => { if (resize()) { keyRef.current = null; start(); } });
    ro.observe(wrap);
    return () => {
      cancelled = true;
      ro.disconnect();
      sceneRef.current?.dispose();
      sceneRef.current = null;
    };
  }, [resize, start]);

  // Wheel zoom. Registered natively and non-passively: React routes onWheel through
  // a passive root listener, where preventDefault is a no-op, and without it the
  // Analytics page scrolls out from under the drag.
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const onWheel = (e) => {
      e.preventDefault();
      zoomByRef.current?.(Math.exp(-e.deltaY * 0.0016));
      keyRef.current = null;
      start();
    };
    wrap.addEventListener("wheel", onWheel, { passive: false });
    return () => wrap.removeEventListener("wheel", onWheel);
  }, [start]);

  // Wake on every render — a moved playhead, a lap swap or a zoom all arrive that way.
  useEffect(() => { start(); });
  useEffect(() => () => { cancelAnimationFrame(rafRef.current); rafRef.current = 0; }, []);

  const dragRef = useRef(null);
  const onPointerDown = (e) => {
    if (e.button !== 0) return;
    dragRef.current = { id: e.pointerId, x: e.clientX, y: e.clientY };
    // Capture keeps the orbit alive when the cursor leaves the panel mid-drag, which
    // is most drags — but it is an optimisation, not the mechanism, so a browser that
    // refuses it must not take the drag down with it.
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* drag still works */ }
  };
  const onPointerMove = (e) => {
    const d = dragRef.current;
    if (!d || d.id !== e.pointerId) return;
    const pose = poseRef.current;
    pose.az = (pose.az ?? 0) + (e.clientX - d.x) * DRAG_AZ;
    pose.el = clamp(pose.el - (e.clientY - d.y) * DRAG_EL, MIN_EL, MAX_EL);
    d.x = e.clientX; d.y = e.clientY;
    start();
  };
  const endDrag = (e) => {
    if (dragRef.current?.id !== e.pointerId) return;
    dragRef.current = null;
    try { e.currentTarget.releasePointerCapture?.(e.pointerId); } catch { /* never captured */ }
  };

  return (
    <div ref={wrapRef}
      onPointerDown={onPointerDown} onPointerMove={onPointerMove}
      onPointerUp={endDrag} onPointerCancel={endDrag}
      onDoubleClick={() => { poseRef.current = { az: null, el: EL0 }; keyRef.current = null; start(); }}
      title="Drag to orbit · scroll to zoom · double-click to reset"
      style={{ position: "absolute", inset: 0, overflow: "hidden", touchAction: "none",
        cursor: failed ? "default" : "grab" }}>
      <canvas ref={canvasRef} style={{ display: "block" }} />
      {failed && (
        <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center",
          justifyContent: "center", textAlign: "center", padding: 24, lineHeight: 1.6,
          fontFamily: FONT.mono, fontSize: 11, letterSpacing: 1, color: "#5b6478" }}>
          3D view unavailable — no WebGL on this display.<br />Use Map or T-Cam instead.
        </div>
      )}
    </div>
  );
}
