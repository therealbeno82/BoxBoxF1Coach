// ─── T-CAM PROJECTION ─────────────────────────────────────────────────────────
// A pinhole camera for the onboard view: world metres → canvas pixels.
//
// Deliberately zero imports. The whole file is arithmetic on plain numbers, so it
// can be reasoned about (and checked in node) without a canvas, a track model or
// React anywhere near it.
//
// FRAME. World x/z is the ground plane and y is up, matching the recorder. The
// plan view maps x→screen-right and z→screen-down, and headings are atan2(Δz, Δx),
// so forward is f = (cos ψ, sin ψ). Every normal in this codebase — the road memo,
// buildHeuristicTrack — uses the LEFT normal (tz, −tx), which makes the driver's
// right r = (−fz, fx). Sanity: ψ=0 → f=(1,0) → r=(0,1)=+z. Heading east, your right
// hand points south. That is the convention; don't flip one without the others.
//
// PROJECTION. For a world point P, with sp/cp the sine/cosine of the pitch:
//
//   fwd = (Px−camX)·fx + (Pz−camZ)·fz     metres in front
//   lat = −(Px−camX)·fz + (Pz−camZ)·fx    metres to the driver's right
//   dy  = Py − camY                        signed height vs the eye
//
//   zc = fwd·cp − dy·sp                    depth along the view axis
//   yc = fwd·sp + dy·cp                    up
//
//   sx = w/2 + focal·lat/zc
//   sy = h/2 − focal·yc/zc
//
// On flat ground dy = −height and this reduces to the pure ground-plane form, so
// elevation needs no special case — just pass a real Py.
//
// zc is AFFINE in (Px, Py, Pz). That's the load-bearing property: it makes the
// near-plane crossing a single exact lerp rather than a search.

// Tuning constants. All of these are meant to be adjusted by eye — a T-cam either
// feels right or it doesn't, and no amount of derivation settles it.
export const CAM_HEIGHT  = 1.25;  // m above the road — roughly airbox height
export const CAM_SETBACK = 0.35;  // m behind the recorded point (that's the car's
                                  // reference position, i.e. its centre). Was 0.6,
                                  // where the ego car's own engine cover filled the
                                  // bottom of the frame; 0.35 sits between the roll
                                  // hoop and the cockpit, looking out THROUGH the
                                  // halo, whose crown is at 1.11 m against a 1.25 m
                                  // eye. Judge any change to this at a real pane's
                                  // vertical FOV (~50°), not the 68° cap — the extra
                                  // 18° is all below the frame, which is precisely
                                  // where the halo lives.
export const CAM_PITCH   = 14;    // degrees down. Larger than a real onboard on
                                  // purpose: with no scenery, a level camera fills
                                  // half the frame with empty sky — and now that the
                                  // ego car occupies the lower frame, more so.
export const FOV_H       = 78;    // degrees horizontal. A real onboard is nearer
                                  // 90-100° — that wide angle is WHY onboards read
                                  // as fast. 65° feels telephoto and undersells speed.
export const FOV_V_MAX   = 68;    // degrees vertical cap, for narrow panes
export const NEAR        = 1.0;   // m. See clipping note below.
export const YAW_TAU     = 0.12;  // s — camera yaw smoothing time constant
export const SNAP_YAW    = Math.PI * 100 / 180; // hard-snap threshold
export const SNAP_DIST   = 60;    // m — ditto, for position jumps

const DEG = Math.PI / 180;

// Build the immutable per-frame camera. `pitchDeg` is positive looking down.
//
// FOCAL. The pane aspect varies a lot (a full-width map pane vs a stacked compare
// pane), so anchor on horizontal FOV but cap the derived vertical and take
// whichever constraint bites harder — a larger focal is a narrower view, so max()
// picks the tighter one. Without the cap, a short wide pane shows an absurd
// vertical wedge; without the horizontal anchor, a tall pane goes fisheye.
export function makeCamera({ x, y, z, yaw, w, h,
  height = CAM_HEIGHT, pitchDeg = CAM_PITCH, fovH = FOV_H, fovVMax = FOV_V_MAX, near = NEAR }) {
  const p = pitchDeg * DEG;
  return {
    x, z, y: y + height,
    fx: Math.cos(yaw), fz: Math.sin(yaw),
    sp: Math.sin(p), cp: Math.cos(p),
    focal: Math.max((w / 2) / Math.tan(fovH * DEG / 2), (h / 2) / Math.tan(fovVMax * DEG / 2)),
    w, h, near, yaw, pitch: p,
  };
}

// Depth alone — a cheap prefilter that skips the divide and the screen mapping.
export function depth(cam, px, py, pz) {
  const dx = px - cam.x, dz = pz - cam.z;
  return (dx * cam.fx + dz * cam.fz) * cam.cp - (py - cam.y) * cam.sp;
}

// World → screen. Returns zc so callers can depth-sort, scale text, or reject.
// Does NOT clip: a point behind the camera comes back with zc ≤ 0 and garbage
// sx/sy. Clip first (clipSeg / clipPolyNear) or prefilter with depth().
export function project(cam, px, py, pz) {
  const dx = px - cam.x, dz = pz - cam.z, dy = py - cam.y;
  const fwd = dx * cam.fx + dz * cam.fz;
  const lat = -dx * cam.fz + dz * cam.fx;
  const zc = fwd * cam.cp - dy * cam.sp;
  const yc = fwd * cam.sp + dy * cam.cp;
  const s = cam.focal / zc;
  return { sx: cam.w / 2 + lat * s, sy: cam.h / 2 - yc * s, zc };
}

// The screen row the ground meets the sky. As fwd → ∞ the ratio yc/zc → tan(pitch)
// regardless of height, so this is exact rather than a far-plane approximation.
export function horizonY(cam) {
  return cam.h / 2 - cam.focal * Math.tan(cam.pitch);
}

// ─── Near-plane clipping ──────────────────────────────────────────────────────
// Points with zc ≤ 0 project through infinity: the sign flips and the point lands
// mirrored on the far side of the frame, dragging a polygon edge across the whole
// canvas. So this isn't optional tidiness — without it the road tears apart at
// every frame the camera is inside its own geometry, which is always.
//
// NEAR = 1.0 m rather than a hair above zero, and it provably never crops. Take the
// WORST case — the vertical FOV cap, where the frame's bottom edge looks down
// CAM_PITCH + FOV_V_MAX/2 = 48° — and the ground enters frame at 1.25/tan 48° =
// 1.13 m. NEAR = 1.0 is measured along the view axis, so for a ground point it sits
// at fwd = (1 − 1.25·sin 14°)/cos 14° = 0.72 m, still nearer. (At the old 8° pitch
// those were 1.84 m and 0.83 m; raising the pitch closes the gap but doesn't shut
// it.) What NEAR buys is a bound on the worst-case projected |sx| — thousands of
// pixels instead of tens of thousands — which keeps the rasteriser honest.

// Clip a segment to zc ≥ near, lerping in WORLD space so any per-vertex attribute
// can be carried with the same t. Mutates nothing; returns null when fully behind.
export function clipSeg(cam, ax, ay, az, bx, by, bz) {
  const za = depth(cam, ax, ay, az), zb = depth(cam, bx, by, bz);
  const n = cam.near;
  if (za < n && zb < n) return null;
  if (za < n) {
    const t = (n - za) / (zb - za);
    return { ax: ax + (bx - ax) * t, ay: ay + (by - ay) * t, az: az + (bz - az) * t, bx, by, bz, ta: t, tb: 1 };
  }
  if (zb < n) {
    const t = (n - zb) / (za - zb);
    return { ax, ay, az, bx: bx + (ax - bx) * t, by: by + (ay - by) * t, bz: bz + (az - bz) * t, ta: 0, tb: 1 - t };
  }
  return { ax, ay, az, bx, by, bz, ta: 0, tb: 1 };
}

// Sutherland-Hodgman against the single plane zc ≥ near. `poly` is a flat
// [x,y,z, x,y,z, …]; returns a flat array (3, 4 or 5 vertices from a quad) or null.
export function clipPolyNear(cam, poly) {
  const n = cam.near;
  const m = poly.length / 3;
  if (m < 3) return null;
  const out = [];
  for (let i = 0; i < m; i++) {
    const j = (i + 1) % m;
    const ax = poly[i * 3], ay = poly[i * 3 + 1], az = poly[i * 3 + 2];
    const bx = poly[j * 3], by = poly[j * 3 + 1], bz = poly[j * 3 + 2];
    const za = depth(cam, ax, ay, az), zb = depth(cam, bx, by, bz);
    const ain = za >= n, bin = zb >= n;
    if (ain) out.push(ax, ay, az);
    if (ain !== bin) {
      const t = (n - za) / (zb - za);
      out.push(ax + (bx - ax) * t, ay + (by - ay) * t, az + (bz - az) * t);
    }
  }
  return out.length >= 9 ? out : null;
}

// Project a clipped flat polygon straight into a canvas path. Returns false when
// nothing was drawable, so callers can skip the fill.
export function pathPoly(ctx, cam, poly) {
  const clipped = clipPolyNear(cam, poly);
  if (!clipped) return false;
  for (let i = 0; i < clipped.length; i += 3) {
    const p = project(cam, clipped[i], clipped[i + 1], clipped[i + 2]);
    if (i === 0) ctx.moveTo(p.sx, p.sy); else ctx.lineTo(p.sx, p.sy);
  }
  return true;
}

// ─── Yaw smoothing ────────────────────────────────────────────────────────────
// Filter the DIRECTION VECTOR, not the angle. Easing an angle scalar toward a
// target breaks at the ±π seam — a step from +179° to −179° is 2° of real rotation
// but reads as −358°, and the camera whips the long way round. Smoothing
// (cos, sin) and atan2-ing the result has no seam to break at; it degenerates only
// on an exact instantaneous 180° flip, which the snap below already covers.
//
// τ = 0.12 s is ≈5.4° of lag at a 45°/s yaw rate — reads as a natural camera.
// Longer feels like a rubber band in chicanes; shorter lets 10 m bin noise through.
//
// `st` is a mutable { cx, cz, init } carried across frames by the caller.
export function smoothYaw(st, target, dt, tau = YAW_TAU) {
  const tx = Math.cos(target), tz = Math.sin(target);
  if (!st.init) { st.cx = tx; st.cz = tz; st.init = true; return target; }
  // Snap rather than ease through a discontinuity — a segment jump or a scrub
  // teleports the camera, and easing across that spins the whole world.
  if (tx * st.cx + tz * st.cz < Math.cos(SNAP_YAW)) {
    st.cx = tx; st.cz = tz;
    return target;
  }
  const k = 1 - Math.exp(-dt / tau);
  st.cx += (tx - st.cx) * k;
  st.cz += (tz - st.cz) * k;
  return Math.atan2(st.cz, st.cx);
}
