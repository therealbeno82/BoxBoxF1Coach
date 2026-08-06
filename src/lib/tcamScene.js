// ─── T-CAM SCENE ──────────────────────────────────────────────────────────────
// Turns a track model + a playhead into a painted onboard frame.
//
// The world here is a flat-ish ribbon with no scenery, no barriers and no
// buildings — everything that makes it read as a circuit rather than a void has to
// come out of data the app already has: the centerline's own widths, its curvature
// channel (kerbs), and the height draped onto it from the laps.
//
// WHY A ROW CURSOR AND NOT ARITHMETIC. It's tempting to get the camera's row from
// the lap fraction (`startIndex + round(f·N)`), the inverse of what cornerMarks
// does. That's a fine SEED and a wrong ANSWER, for two reasons:
//   • a live in-progress lap doesn't start at distance 0 — the recorder's buffer
//     opens wherever the car was — so at playhead 0 the fraction points hundreds of
//     metres from the car;
//   • the driven line's arc length isn't the centerline's. It runs long around the
//     outside of corners and short through the inside. Locally that's metres of
//     slop: harmless for picking a window, useless for placing a brake gate.
// So: seed from the fraction, then walk downhill to the genuinely nearest row. At
// racing speed that's 0-3 steps a frame.

import {
  makeCamera, project, depth, horizonY, clipPolyNear, pathPoly, smoothYaw,
  SNAP_DIST, CAM_SETBACK, FOV_H,
} from "./tcamProjection.js";
import { posAtFracSmooth, headingAtMeters, pedalT, pedalColor, catmullRom } from "./racingLine.js";

const BEHIND_M = 30;   // the road behind is clipped away, but the quads STRADDLING
                       // the camera must exist to be clipped rather than dropped
const AHEAD_M  = 250;  // at focal ~426 a 12 m road is ~20 px wide here; fog covers on
const REACQUIRE_M = 40; // a walk that ends this far out means the cursor is lost

// Palette — deliberately the panel's own tokens, so the T-cam and the plan view
// look like the same product.
const SKY_TOP    = "#0d1420";
const SKY_HORIZ  = "#1b2434";
// The plan view can afford near-black tarmac because its road is a thin ribbon on
// a large empty field. Here the road IS the subject and fills most of the frame, so
// it needs real separation from the runoff — the plan view's #10151f on #0c1017 is
// a 4-value difference and simply disappears from the seat.
const GROUND     = "#090c12";
const ROAD       = "#171d29";
const EDGE       = "rgba(200,208,224,0.45)";
const EDGE_W     = 0.15;        // m — painted line width

// A real painted line is ~10-12 cm. These are wider so they stay legible at
// distance, but not so wide they read as a lane rather than a line.
const DRIVEN_HW  = 0.13;        // m half-width of the racing-line ribbons
const REF_HW     = 0.11;
const REF_COLOR  = "#ffffff";
const PEDAL_BUCKETS = 16;       // same quantisation as the plan view's gradient
const MIN_LINE_PX = 1.1;        // see widthFloor()
const DASH_ON = 3.0, DASH_OFF = 4.0;  // m — world-space, so they compress with depth
const RIBBON_LIFT = 0.02;       // m — hold the ribbons a hair above the tarmac so
                                // they never z-fight the road quad they sit on

export function makeRowCursor() {
  return { i: 0, x: 0, z: 0, valid: false };
}

// ─── Row lookup ───────────────────────────────────────────────────────────────
const wrapIdx = (i, n, closed) =>
  closed ? ((i % n) + n) % n : Math.max(0, Math.min(n - 1, i));

function nearestRow(rows, closed, cur, x, z, seed) {
  const n = rows.length;
  const d2 = (i) => { const dx = rows[i].x - x, dz = rows[i].z - z; return dx * dx + dz * dz; };
  const scan = () => { let bi = 0, bd = Infinity; for (let k = 0; k < n; k++) { const d = d2(k); if (d < bd) { bd = d; bi = k; } } return bi; };

  let i;
  // Cold start, or the camera teleported (a scrub, a segment jump, a lap swap) —
  // the previous row tells us nothing, so pay the O(n) scan. It's a few thousand
  // squared distances and it happens on user input, not per frame.
  if (!cur.valid || Math.hypot(x - cur.x, z - cur.z) > SNAP_DIST) {
    i = typeof seed === "number" ? wrapIdx(seed, n, closed) : scan();
  } else {
    i = wrapIdx(cur.i, n, closed);
  }

  let best = d2(i);
  for (let steps = 0; steps < 64; steps++) {
    const fi = wrapIdx(i + 1, n, closed), bi = wrapIdx(i - 1, n, closed);
    const df = d2(fi), db = d2(bi);
    if (df < best && df <= db) { i = fi; best = df; }
    else if (db < best) { i = bi; best = db; }
    else break;
  }
  // Walked and still nowhere near the road: the seed was bad (or we're off-track).
  if (best > REACQUIRE_M * REACQUIRE_M) { i = scan(); }

  cur.i = i; cur.x = x; cur.z = z; cur.valid = true;
  return i;
}

// Fractional row index — the camera sits BETWEEN rows, and reading height from the
// nearest one is piecewise-constant, which pops the eye height ~14×/s at speed.
function rowFracAt(rows, closed, i, x, z) {
  const n = rows.length;
  const along = (p, q) => {
    const ex = q.x - p.x, ez = q.z - p.z;
    const L2 = ex * ex + ez * ez;
    return L2 > 0 ? ((x - p.x) * ex + (z - p.z) * ez) / L2 : 0;
  };
  const here = rows[i];
  const fwd = along(here, rows[wrapIdx(i + 1, n, closed)]);
  if (fwd >= 0) return i + Math.min(1, fwd);
  const back = along(rows[wrapIdx(i - 1, n, closed)], here);
  return i - 1 + Math.max(0, Math.min(1, back));
}

function elevAt(rows, closed, fi) {
  const n = rows.length;
  const i0 = Math.floor(fi), t = fi - i0;
  const a = rows[wrapIdx(i0, n, closed)].y || 0;
  const b = rows[wrapIdx(i0 + 1, n, closed)].y || 0;
  return a + (b - a) * t;
}

function meanSpacing(rows, closed) {
  const n = rows.length;
  if (n < 2) return 2.5;
  // Sample rather than sum the loop: spacing is uniform by construction (both row
  // builders resample), and this runs per frame.
  let total = 0, count = 0;
  const step = Math.max(1, Math.floor(n / 24));
  for (let k = 0; k < n - 1; k += step) {
    const a = rows[k], b = rows[wrapIdx(k + 1, n, closed)];
    total += Math.hypot(b.x - a.x, b.z - a.z); count++;
  }
  return count ? total / count : 2.5;
}

// ─── Camera ───────────────────────────────────────────────────────────────────
// Position comes from the SMOOTHED line (a linear read cuts each 10 m chord and
// facets visibly in first person); yaw is filtered; height is the draped road plus
// the camera offset, never the lap's own y — raw y carries ride height and
// suspension travel and would bob the camera for no informational gain.
export function buildTCamCamera({ line, frac, model, cursor, yawState, dt, w, h, seedRow }) {
  const yawTarget = headingAtMeters(line, frac);
  const yaw = smoothYaw(yawState, yawTarget, dt);
  const p = posAtFracSmooth(line, frac);

  const rows = model?.centerline;
  let y = 0, rowIndex = 0, rowFrac = 0;
  if (rows?.length) {
    rowIndex = nearestRow(rows, !!model.closed, cursor, p.x, p.z, seedRow);
    rowFrac = rowFracAt(rows, !!model.closed, rowIndex, p.x, p.z);
    y = elevAt(rows, !!model.closed, rowFrac);
  }

  const cam = makeCamera({
    // Set the eye back along the heading: the recorded x/z is the car's reference
    // point (its centre) and the camera sits behind it. Read from the constant rather
    // than repeated here — this was a literal 0.6 silently shadowing CAM_SETBACK, so
    // editing the constant changed nothing.
    x: p.x - Math.cos(yaw) * CAM_SETBACK,
    z: p.z - Math.sin(yaw) * CAM_SETBACK,
    y, yaw, w, h,
  });
  // `ego` is where the driver's OWN car sits: at the recorded point itself, on the
  // road, facing the smoothed heading. The camera is the same pose pulled back by
  // CAM_SETBACK and raised by CAM_HEIGHT, so a car drawn here lands rigidly in frame.
  return { cam, rowIndex, rowFrac, yawTarget, yaw, ego: { x: p.x, y, z: p.z, yaw } };
}

// ─── Road geometry ────────────────────────────────────────────────────────────
// Both edges of one row, offset along the row's normal. Matches the plan view's
// convention exactly (left normal = (tz, −tx), `wl || 6` fallback) so the two views
// never disagree about which side of the road something is on.
function edgesOf(rows, n, closed, i) {
  const r = rows[i];
  const prev = rows[wrapIdx(i - 1, n, closed)];
  const next = rows[wrapIdx(i + 1, n, closed)];
  let tx = next.x - prev.x, tz = next.z - prev.z;
  const tl = Math.hypot(tx, tz) || 1; tx /= tl; tz /= tl;
  const nx = tz, nz = -tx;
  const wl = r.wl || 6, wr = r.wr || 6;
  const y = r.y || 0;
  return {
    lx: r.x + nx * wl, lz: r.z + nz * wl,
    rx: r.x - nx * wr, rz: r.z - nz * wr,
    nx, nz, y, wl, wr, cx: r.x, cz: r.z, k: r.k || 0,
  };
}

// The window of rows around the camera, pre-resolved to edges so every consumer
// (road, edge lines, kerbs) walks the same list once.
//
// Bounded by DEPTH, not by arc length — and that distinction is not academic. On a
// tight complex (Singapore's Turn 1-3 is the case that caught this) 250 m of road
// wraps right back past the camera: measured depths ran 17 m → 64 m → 72 m → 51 m →
// −0.4 m, so the "far" end of an arc-length window is physically beside the car and
// paints as a wall of tarmac across a frame it has no business being in.
//
// The stop rule keeps hairpins intact, which matters — the far side of a hairpin is
// exactly what you want to see. It only cuts the road once it has genuinely come
// back BEHIND the camera, which no amount of corner is.
export function roadWindow(model, rowIndex, cam) {
  const rows = model?.centerline;
  if (!rows?.length) return null;
  const n = rows.length, closed = !!model.closed;
  const spacing = meanSpacing(rows, closed);
  const behind = Math.ceil(BEHIND_M / spacing);
  const maxAhead = Math.ceil(AHEAD_M / spacing);
  const inBounds = (idx) => closed || (idx >= 0 && idx < n);
  const at = (idx) => edgesOf(rows, n, closed, wrapIdx(idx, n, closed));

  const out = [];
  // Behind the camera: a fixed short run, purely so the quads STRADDLING the near
  // plane exist to be clipped rather than dropped. They cover the lower frame.
  for (let k = -behind; k <= 0; k++) if (inBounds(rowIndex + k)) out.push(at(rowIndex + k));
  const tailArc = () => {   // running arc length, for anything striped along the road
    for (let i = 1; i < out.length; i++)
      out[i].s = out[i - 1].s + Math.hypot(out[i].cx - out[i - 1].cx, out[i].cz - out[i - 1].cz);
  };
  if (out.length) out[0].s = 0;

  let wasAhead = false;
  for (let k = 1; k <= maxAhead; k++) {
    const idx = rowIndex + k;
    if (!inBounds(idx)) break;
    const e = at(idx);
    const zc = cam ? depth(cam, e.cx, e.y, e.cz) : k * spacing;
    if (zc > 2) wasAhead = true;
    else if (wasAhead) break;   // the road has doubled back past us
    if (zc > AHEAD_M) break;    // far enough to be lost in the fog anyway
    out.push(e);
  }
  tailArc();
  return { edges: out, spacing };
}

// ─── Painting ─────────────────────────────────────────────────────────────────
// Sky and ground cover the whole frame every time, so there is no clearRect.
function paintBackdrop(ctx, cam, w, h) {
  const hy = horizonY(cam);
  const skyBottom = Math.max(0, Math.min(h, hy));
  if (skyBottom > 0) {
    const g = ctx.createLinearGradient(0, 0, 0, skyBottom);
    g.addColorStop(0, SKY_TOP);
    g.addColorStop(1, SKY_HORIZ);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, skyBottom);
  }
  if (skyBottom < h) {
    ctx.fillStyle = GROUND;
    ctx.fillRect(0, skyBottom, w, h - skyBottom);
  }
  return hy;
}

// One quad per row pair, all in a SINGLE path, filled once. Not one strip polygon:
// a strip that doubles back inside the 250 m window (any hairpin) self-intersects
// and nonzero winding would flood the infield. Not per-quad fills either: filling
// separately antialiases every shared edge against the background and the road
// comes out with visible seams. One path, many subpaths, one fill — overlapping
// same-coloured quads are invisible and interior edges never get antialiased.
function paintRoad(ctx, cam, win) {
  const e = win.edges;
  ctx.beginPath();
  let any = false;
  for (let i = 1; i < e.length; i++) {
    const a = e[i - 1], b = e[i];
    if (pathPoly(ctx, cam, [
      a.lx, a.y, a.lz,
      b.lx, b.y, b.lz,
      b.rx, b.y, b.rz,
      a.rx, a.y, a.rz,
    ])) { ctx.closePath(); any = true; }
  }
  if (any) { ctx.fillStyle = ROAD; ctx.fill(); }
}

// Painted edge lines as constant-WORLD-width ribbons. Not strokes: a constant
// screen width would make the far edge as thick as the near one and kill the
// convergence cue that tells you how fast you're going.
function paintEdgeLines(ctx, cam, win) {
  const e = win.edges;
  ctx.beginPath();
  let any = false;
  for (let i = 1; i < e.length; i++) {
    const a = e[i - 1], b = e[i];
    for (const side of ["l", "r"]) {
      const sx = side === "l" ? 1 : -1;
      const ax = a[side + "x"], az = a[side + "z"];
      const bx = b[side + "x"], bz = b[side + "z"];
      if (pathPoly(ctx, cam, [
        ax, a.y, az,
        bx, b.y, bz,
        bx - b.nx * EDGE_W * sx, b.y, bz - b.nz * EDGE_W * sx,
        ax - a.nx * EDGE_W * sx, a.y, az - a.nz * EDGE_W * sx,
      ])) { ctx.closePath(); any = true; }
    }
  }
  if (any) { ctx.fillStyle = EDGE; ctx.fill(); }
}

// ─── Kerbs ────────────────────────────────────────────────────────────────────
// Drawn from the centerline's own curvature channel — no kerb data is shipped, but
// `k` (smoothed signed curvature, written onto every model by finishModel) says
// where the corners are, and that's the same thing.
//
// The band geometry falls out for free. trackGeometry adds EDGE_MARGIN = 1.0 m to
// each shipped edge precisely because "the shipped widths stop at the white line,
// but kerbs are drivable" — so the outer metre of the road ribbon on the inside of
// a corner already IS the kerb. Mirror that constant rather than guessing another.
const KERB_W     = 1.0;         // = trackGeometry's EDGE_MARGIN
const KERB_K_ON  = 1 / 120;     // curvature where a kerb starts to appear (R 120 m)
const KERB_K_FULL = 1 / 60;     // ...and where it's fully opaque
const KERB_STRIPE = 2.0;        // m per red/white block
const KERB_RED   = "#d43b3b";
const KERB_WHITE = "#e8edf5";

function paintKerbs(ctx, cam, win) {
  const e = win.edges;
  // Two passes so the whole kerb costs two fills rather than one per block.
  for (const which of [0, 1]) {
    ctx.beginPath();
    let any = false;
    for (let i = 1; i < e.length; i++) {
      const a = e[i - 1], b = e[i];
      const k = (a.k + b.k) / 2;
      if (Math.abs(k) < KERB_K_ON) continue;
      if (Math.floor((a.s || 0) / KERB_STRIPE) % 2 !== which) continue;
      // k > 0 curves toward +z, and the left normal points toward −z, so a positive
      // k turns AWAY from the left normal — the inside of the corner is the wr side.
      const right = k > 0;
      const wIn = right ? b.wr : b.wl;
      const wInA = right ? a.wr : a.wl;
      const sgn = right ? -1 : 1;      // which way the normal points to that edge
      if (wIn <= KERB_W) continue;
      if (pathPoly(ctx, cam, [
        a.cx + a.nx * sgn * wInA, a.y, a.cz + a.nz * sgn * wInA,
        b.cx + b.nx * sgn * wIn,  b.y, b.cz + b.nz * sgn * wIn,
        b.cx + b.nx * sgn * (wIn - KERB_W),  b.y, b.cz + b.nz * sgn * (wIn - KERB_W),
        a.cx + a.nx * sgn * (wInA - KERB_W), a.y, a.cz + a.nz * sgn * (wInA - KERB_W),
      ])) { ctx.closePath(); any = true; }
    }
    if (!any) continue;
    // Ramp the alpha in with curvature instead of switching at a threshold — a kerb
    // that pops into existence as you approach a corner reads as a glitch.
    const kMid = e.length > 2 ? Math.abs(e[Math.min(8, e.length - 1)].k || 0) : 0;
    const t = Math.max(0, Math.min(1, (kMid - KERB_K_ON) / (KERB_K_FULL - KERB_K_ON)));
    ctx.globalAlpha = 0.35 + 0.5 * t;
    ctx.fillStyle = which ? KERB_WHITE : KERB_RED;
    ctx.fill();
    ctx.globalAlpha = 1;
  }
}

// ─── Distance fog ─────────────────────────────────────────────────────────────
// One rect with a cached gradient, and the cheapest thing in the whole file that
// makes a flat, sceneryless world read as deep: without it the road just stops.
let fogCache = null;
function paintFog(ctx, hy, w, h) {
  const top = Math.max(0, Math.min(h, hy));
  const depth = Math.max(1, (h - top) * 0.30);
  const key = `${top}|${depth}`;
  if (!fogCache || fogCache.key !== key) {
    const g = ctx.createLinearGradient(0, top, 0, top + depth);
    // Must be the SKY's horizon colour, not an arbitrary dark. Haze works by the
    // far road taking on the colour of the air above it; anything darker just reads
    // as a shadow band pinned across the middle of the frame.
    g.addColorStop(0, "rgba(27,36,52,0.88)");
    g.addColorStop(1, "rgba(27,36,52,0)");
    fogCache = { key, g };
  }
  ctx.fillStyle = fogCache.g;
  ctx.fillRect(0, top, w, depth);
}

// ─── Brake gates ──────────────────────────────────────────────────────────────
// The reference driver's brake point, as a band across the full road rather than
// the plan view's dot. From the seat a dot is meaningless; a gate coming toward you
// is the single most actionable thing in the frame.
function paintBrakeGates(ctx, cam, marks, rows, n, closed, rowIndex) {
  if (!marks?.length || !rows) return;
  for (const m of marks) {
    const i = walkTo(rows, n, closed, rowIndex, m.x, m.z);
    const e = edgesOf(rows, n, closed, i);
    // walkTo is a BOUNDED walk from the camera's row, so a mark on the far side of
    // the circuit doesn't resolve to its own row — it stops partway and returns one
    // that's still near the camera. Drawn unchecked that paints a brake gate across
    // the road right in front of you for a corner two kilometres away. Only trust
    // the match when it actually landed on the mark.
    if (Math.hypot(e.cx - m.x, e.cz - m.z) > 25) continue;
    const zc = depth(cam, e.cx, e.y, e.cz);
    if (zc < cam.near || zc > AHEAD_M) continue;
    // 1.5 m deep, measured along the road so it foreshortens like paint.
    const tx = -e.nz, tz = e.nx;   // tangent = normal rotated 90°
    const D = 0.75;
    ctx.beginPath();
    if (pathPoly(ctx, cam, [
      e.lx + tx * D, e.y, e.lz + tz * D,
      e.rx + tx * D, e.y, e.rz + tz * D,
      e.rx - tx * D, e.y, e.rz - tz * D,
      e.lx - tx * D, e.y, e.lz - tz * D,
    ])) {
      ctx.closePath();
      ctx.fillStyle = "#ff2d2d"; ctx.globalAlpha = 0.5; ctx.fill(); ctx.globalAlpha = 1;
    }
    if (zc < 140) {
      const p = project(cam, e.lx, e.y + 2.4, e.lz);
      const size = Math.max(8, Math.min(16, (cam.focal * 2.2) / zc));
      ctx.font = `700 ${size}px ui-monospace, monospace`;
      ctx.fillStyle = "#ff6b6b";
      ctx.globalAlpha = Math.max(0.25, 1 - zc / 160);
      ctx.fillText("BRAKE", p.sx, p.sy);
      ctx.globalAlpha = 1;
    }
  }
}

// ─── Start / finish ───────────────────────────────────────────────────────────
// A chequered band across the road at the model's own startIndex. Free orientation
// cue: on a lap that opens mid-circuit it's the one landmark that says where the
// timing line actually is.
function paintStartFinish(ctx, cam, rows, n, closed, startIndex) {
  if (!rows || typeof startIndex !== "number") return;
  const e = edgesOf(rows, n, closed, wrapIdx(startIndex, n, closed));
  const zc = depth(cam, e.cx, e.y, e.cz);
  if (zc < cam.near || zc > AHEAD_M) return;
  const tx = -e.nz, tz = e.nx;
  const D = 0.5;                       // 1 m deep
  const CELLS = 12;
  for (const which of [0, 1]) {
    ctx.beginPath();
    let any = false;
    for (let c = 0; c < CELLS; c++) {
      if (c % 2 !== which) continue;
      const t0 = c / CELLS, t1 = (c + 1) / CELLS;
      const at = (t) => ({ x: e.lx + (e.rx - e.lx) * t, z: e.lz + (e.rz - e.lz) * t });
      const p0 = at(t0), p1 = at(t1);
      if (pathPoly(ctx, cam, [
        p0.x + tx * D, e.y, p0.z + tz * D,
        p1.x + tx * D, e.y, p1.z + tz * D,
        p1.x - tx * D, e.y, p1.z - tz * D,
        p0.x - tx * D, e.y, p0.z - tz * D,
      ])) { ctx.closePath(); any = true; }
    }
    if (any) { ctx.fillStyle = which ? "#e8edf5" : "#11151d"; ctx.globalAlpha = 0.85; ctx.fill(); ctx.globalAlpha = 1; }
  }
}

// ─── Corner posts ─────────────────────────────────────────────────────────────
// The apex marker, billboarded above the road with a tick down to the ground so it
// reads as a post rather than text floating in the sky. Depth-sorted among itself,
// the one set in the scene that needs it.
function paintCornerPosts(ctx, cam, marks, rows, n, closed, rowIndex) {
  if (!marks?.length) return;
  const vis = [];
  for (const m of marks) {
    // Same bounded-walk caveat as the brake gates, but harmless here: the post is
    // drawn at the MARK's own position and only its height comes from the row, so a
    // walk that fell short costs a metre or two of elevation, not a misplaced post.
    // A post is world-static so it can't judder the way the ghost did, but it shares
    // the drape for the same reason the ribbon does — one road surface, one answer.
    let y = 0;
    if (rows) y = roadYAt(rows, n, closed, rowIndex, m.x, m.z);
    const zc = depth(cam, m.x, y, m.z);
    if (zc < cam.near || zc > AHEAD_M) continue;
    vis.push({ m, y, zc });
  }
  vis.sort((a, b) => b.zc - a.zc);   // far → near
  for (const { m, y, zc } of vis) {
    const base = project(cam, m.x, y, m.z);
    const top = project(cam, m.x, y + 3.2, m.z);
    const alpha = Math.max(0.2, 1 - zc / (AHEAD_M * 0.9));
    ctx.globalAlpha = alpha;
    ctx.beginPath();
    ctx.moveTo(base.sx, base.sy); ctx.lineTo(top.sx, top.sy);
    ctx.strokeStyle = "#5b6b8c"; ctx.lineWidth = 1.4; ctx.stroke();
    const size = Math.max(8, Math.min(18, (cam.focal * 2.6) / zc));
    ctx.font = `700 ${size}px ui-monospace, monospace`;
    ctx.fillStyle = "#8b94a8";
    ctx.textAlign = "center";
    ctx.fillText(m.name, top.sx, top.sy - 2);
    ctx.textAlign = "left";
    ctx.globalAlpha = 1;
  }
}

// ─── Racing-line ribbons ──────────────────────────────────────────────────────
// A constant-world-width ribbon rather than a stroke. Canvas strokes (like SVG's
// non-scaling-stroke next door) are a constant SCREEN width, which in perspective
// makes the line 250 m away exactly as thick as the one under your nose and throws
// away the strongest depth cue in the frame.
//
// The catch at the far end is the opposite one: 0.40 m at 250 m is 0.68 px, so the
// line fades to nothing and appears to stop. Rather than fix that after projection
// (where a clipped polygon has an awkward variable vertex count), widen in WORLD
// space by depth — the screen width of a world width w at depth z is focal·w/z, so
// inverting that gives the half-width which guarantees a floor.
function widthFloor(cam, hw, zc) {
  return Math.max(hw, (MIN_LINE_PX * zc) / (2 * cam.focal));
}

// Walk to the nearest row from a known-good starting index. Same downhill walk as
// the camera cursor, but local — the caller steps along a line whose points are
// already in order, so each point starts from the previous point's row.
function walkTo(rows, n, closed, i, x, z) {
  const d2 = (j) => { const dx = rows[j].x - x, dz = rows[j].z - z; return dx * dx + dz * dz; };
  let best = d2(i);
  for (let s = 0; s < 32; s++) {
    const f = wrapIdx(i + 1, n, closed), b = wrapIdx(i - 1, n, closed);
    const df = d2(f), db = d2(b);
    if (df < best && df <= db) { i = f; best = df; }
    else if (db < best) { i = b; best = db; }
    else break;
  }
  return i;
}

// The draped road height under an arbitrary world point — INTERPOLATED between rows,
// exactly as buildTCamCamera already does for the eye.
//
// Taking `rows[nearest].y` instead is a step function, and for anything that MOVES
// along the road that step is a visible judder. Rows sit 2.5 m apart, so a car at
// racing speed crosses one every ~2-3 frames at 60 Hz; each crossing teleports it by
// the whole height difference between neighbouring rows. Spa is the worst case on the
// calendar — Eau Rouge climbs about 17%, so that's ~0.4 m a step, and at 30 m up the
// road it throws the ghost roughly 10 px up the screen between one frame and the next
// while the tarmac beneath it slides by perfectly smoothly. That mismatch is the
// surging: the camera was interpolating its own height and the ghost was not.
function roadYAt(rows, n, closed, seedRow, x, z) {
  const i = walkTo(rows, n, closed, seedRow, x, z);
  return elevAt(rows, closed, rowFracAt(rows, closed, i, x, z));
}

// The stretch of a line inside the camera's window, with each point lifted onto the
// draped ROAD surface rather than its own recorded y. Deliberate: raw y carries ride
// height, kerb strikes and suspension travel, so two laps over the same tarmac would
// sit at visibly different heights and the ribbons would cross in mid-air. Lifting
// both onto the road keeps the only difference between them the one that matters —
// where on the road they are.
//
// SUBDIVIDED, because a 10 m bin is a 10 m straight. From the seat that's the single
// most visible artefact in the frame: a 30 m-radius corner turns 19° per sample, so
// the ribbon arrives as a run of flat panels rather than an arc. Sub-points come off
// the same centripetal Catmull-Rom the camera rides, so the ribbon and the eye follow
// one curve — and the curve still passes through every recorded sample, so nothing is
// moved off where the car was. SUB_M is the facet length that survives: 2.5 m keeps
// the tightest corner on the calendar under ~5° a step, which reads as smooth.
const SUB_M = 2.5;
const SUB_MAX = 8;     // cap, so a dropped-packet gap can't explode into work

function lineWindow(line, camDist, rows, n, closed, startRow, cam) {
  const P = line?.pts;
  if (!P?.length) return null;
  const lo = camDist - BEHIND_M, hi = camDist + AHEAD_M;
  // The samples inside the window, as an index range: sub-points need their SHAPE
  // neighbours, which for the first and last span sit outside the window itself.
  let i0 = 0;
  while (i0 < P.length && P[i0].dist < lo) i0++;
  let i1 = i0;
  while (i1 + 1 < P.length && P[i1 + 1].dist <= hi) i1++;
  if (i1 <= i0) return null;
  const at = (j) => P[j < 0 ? 0 : j >= P.length ? P.length - 1 : j];

  const out = [];
  let row = startRow;
  let wasAhead = false;
  // Drape onto the road, then apply the same doubling-back cut the road window
  // makes: on a tight complex the line 250 m ahead is beside the car, and a ribbon
  // painted there reads as the driver having swerved into the runoff. Returns false
  // once the line has come back behind us, which ends the walk.
  const emit = (x, z, src) => {
    let y = 0;
    // Interpolated, like the eye and the ghost: the ribbon is the surface the ghost's
    // shadow lands on, so if one snapped to rows and the other didn't they'd disagree
    // by up to a row's worth of gradient wherever the track climbs.
    if (rows) {
      row = walkTo(rows, n, closed, row, x, z);   // running cursor, kept for the next point
      y = elevAt(rows, closed, rowFracAt(rows, closed, row, x, z)) + RIBBON_LIFT;
    }
    if (cam) {
      const zc = depth(cam, x, y, z);
      if (zc > 2) wasAhead = true;
      else if (wasAhead) return false;
    }
    out.push({ x, z, y, throttle: src.throttle, brake: src.brake, dist: src.dist });
    return true;
  };

  if (emit(P[i0].x, P[i0].z, P[i0])) {
    outer:
    for (let i = i0; i < i1; i++) {
      const a = P[i], b = P[i + 1];
      const steps = Math.max(1, Math.min(SUB_MAX, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / SUB_M)));
      for (let s = 1; s <= steps; s++) {
        const t = s / steps;
        const q = s === steps ? b : catmullRom(at(i - 1), a, b, at(i + 2), t);
        // Every sub-point of this span carries the span's OWN pedal reading — the
        // painter colours each quad by its far end, so this keeps the gradient
        // quantised exactly where it was before, one bin at a time.
        if (!emit(q.x, q.z, { throttle: b.throttle, brake: b.brake, dist: a.dist + (b.dist - a.dist) * t })) break outer;
      }
    }
  }
  return out.length >= 2 ? out : null;
}

// Emit one ribbon quad into the current path. Returns false if it clipped away.
function ribbonQuad(ctx, cam, a, b, hw) {
  let tx = b.x - a.x, tz = b.z - a.z;
  const tl = Math.hypot(tx, tz);
  if (!(tl > 0)) return false;
  tx /= tl; tz /= tl;
  const nx = tz, nz = -tx;
  // One depth for the whole quad: segments are ~10 m and the floor only matters
  // far away, where 10 m of depth difference is a fraction of a pixel.
  const zc = Math.max(cam.near, (depth(cam, a.x, a.y, a.z) + depth(cam, b.x, b.y, b.z)) / 2);
  const e = widthFloor(cam, hw, zc);
  return pathPoly(ctx, cam, [
    a.x + nx * e, a.y, a.z + nz * e,
    b.x + nx * e, b.y, b.z + nz * e,
    b.x - nx * e, b.y, b.z - nz * e,
    a.x - nx * e, a.y, a.z - nz * e,
  ]);
}

// The driven line, coloured by the pedals. Bucketed into PEDAL_BUCKETS paths so the
// whole ribbon costs ~16 fills instead of one per segment — the same trick, and the
// same 16 buckets, the plan view's drivenGradientPaths uses.
function paintDrivenRibbon(ctx, cam, pts) {
  const buckets = new Map();
  for (let i = 1; i < pts.length; i++) {
    const t = pedalT(pts[i].throttle, pts[i].brake);
    const b = Math.round(t * (PEDAL_BUCKETS - 1));
    let arr = buckets.get(b); if (!arr) buckets.set(b, (arr = []));
    arr.push(i);
  }
  for (const [b, idxs] of buckets) {
    ctx.beginPath();
    let any = false;
    for (const i of idxs) if (ribbonQuad(ctx, cam, pts[i - 1], pts[i], DRIVEN_HW)) { ctx.closePath(); any = true; }
    if (any) { ctx.fillStyle = pedalColor(b / (PEDAL_BUCKETS - 1)); ctx.fill(); }
  }
}

// The reference line, dashed. The dash pattern is walked in WORLD metres, not
// ctx.setLineDash: screen-space dashes are the same length at every depth, which
// reads as a flat sticker over the frame. Walked in world space they compress
// toward the horizon exactly like real lane markings — the perspective cue is the
// whole reason to draw this view at all.
function paintRefRibbon(ctx, cam, pts) {
  const period = DASH_ON + DASH_OFF;
  let s = 0;
  ctx.beginPath();
  let any = false;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const segLen = Math.hypot(b.x - a.x, b.z - a.z);
    if (!(segLen > 0)) continue;
    // Sub-divide the 10 m sample gap at dash boundaries so a dash starts and ends
    // where the pattern says, not where the bins happen to fall.
    let walked = 0;
    while (walked < segLen) {
      const phase = (s + walked) % period;
      const on = phase < DASH_ON;
      const remain = on ? DASH_ON - phase : period - phase;
      const take = Math.min(remain, segLen - walked);
      if (on) {
        const t0 = walked / segLen, t1 = (walked + take) / segLen;
        const lerp = (t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t });
        if (ribbonQuad(ctx, cam, lerp(t0), lerp(t1), REF_HW)) { ctx.closePath(); any = true; }
      }
      walked += take;
    }
    s += segLen;
  }
  if (any) { ctx.fillStyle = REF_COLOR; ctx.globalAlpha = 0.85; ctx.fill(); ctx.globalAlpha = 1; }
}

// ─── The other car ────────────────────────────────────────────────────────────
// PLACEMENT IS RESOLVED SEPARATELY FROM PAINTING, because two consumers need the
// identical answer: tcamCarLayer renders a WebGL car from it before the 2D pass
// starts, and the blit further down has to agree about whether there is a car there
// at all. Resolve once, hand both the same placement, and they cannot disagree.
//
// CLOSE RANGE IS A FADE, NOT A CUTOFF. This used to return null the moment the ghost
// came within 8 m of the eye, and on a lap that's within a tenth of the reference the
// gap crosses that line over and over: the car vanished whole and came back whole a
// frame later, which reads as a rendering fault rather than as catching someone.
// Nothing about 8 m is a real boundary. Instead the placement carries an `alpha` that
// ramps off across the last several metres, and both painters honour it. It still
// ends at nothing — once the ghost's rear wing is at the lens there is no view of it
// that isn't a wall of bodywork across the frame, and holding it there would bury the
// road you're being shown — but it gets there over ~9 m of closing instead of in one
// frame. The other end of that ramp is also what keeps POS-SYNC honest: there both
// cars sit at the same track distance, so the ghost is alongside at ~zero depth and
// falls out at alpha 0 exactly as the old cutoff dropped it.
const FADE_FULL = 12;   // m of camera-axis depth — fully opaque at or beyond this
const FADE_GONE = 3;    // m — the car's rear wing is about at the eye here

// Sit the car on the ROAD, not at its own recorded ride height — the same reason
// the ribbons are draped: a car floating at suspension height beside a road drawn at
// surface height reads as a bug rather than as travel. Returns null when there's
// nothing to draw.
export function resolveOtherCar(model, rowIndex, cam, other) {
  if (!other || !cam) return null;
  const rows = model?.centerline || null;
  const n = rows?.length || 0;
  const closed = !!model?.closed;
  const y = rows ? roadYAt(rows, n, closed, rowIndex, other.x, other.z) : 0;
  const zc = depth(cam, other.x, y, other.z);
  const t = Math.max(0, Math.min(1, (zc - FADE_GONE) / (FADE_FULL - FADE_GONE)));
  const alpha = t * t * (3 - 2 * t);   // smoothstep: no kink at either end of the ramp
  if (alpha < 0.01) return null;
  return { x: other.x, y, z: other.z, yaw: other.yaw, color: other.color, alpha };
}

// The car's footprint on the tarmac. With no WebGL this IS the marker — everything
// else in the scene is already a polygon on the road surface, so a flat silhouette
// costs one more clipped quad and carries the meaning exactly: "the other car was
// HERE". Under a 3D car it becomes the contact shadow, which is what keeps a lit
// model from reading as pasted onto the road.
function carQuad(ctx, cam, p, grow = 0) {
  const fx = Math.cos(p.yaw), fz = Math.sin(p.yaw);
  const nx = fz, nz = -fx;
  const L = 2.6 + grow, W = 0.95 + grow;   // half-length / half-width, ≈ a 5.2 × 1.9 m car
  ctx.beginPath();
  return pathPoly(ctx, cam, [
    p.x + fx * L + nx * W, p.y, p.z + fz * L + nz * W,
    p.x + fx * L - nx * W, p.y, p.z + fz * L - nz * W,
    p.x - fx * L - nx * W, p.y, p.z - fz * L - nz * W,
    p.x - fx * L + nx * W, p.y, p.z - fz * L + nz * W,
  ]);
}

function paintOtherCar(ctx, cam, p) {
  const a = p.alpha ?? 1;
  if (carQuad(ctx, cam, p)) {
    ctx.closePath();
    ctx.fillStyle = p.color; ctx.globalAlpha = 0.35 * a; ctx.fill();
    ctx.globalAlpha = 0.9 * a; ctx.lineWidth = 1.4; ctx.strokeStyle = p.color; ctx.stroke();
    ctx.globalAlpha = 1;
  }
  // A vertical tick sells its position once it's far enough away that the decal is
  // only a few pixels.
  const base = project(cam, p.x, p.y, p.z);
  const top = project(cam, p.x, p.y + 1.4, p.z);
  ctx.beginPath();
  ctx.moveTo(base.sx, base.sy); ctx.lineTo(top.sx, top.sy);
  ctx.strokeStyle = p.color; ctx.globalAlpha = 0.75 * a; ctx.lineWidth = 1.6; ctx.stroke();
  ctx.globalAlpha = 1;
}

// The shadow fades with the car it belongs to — left at full strength it would
// outlive the ghost by several metres and leave a dark patch sliding up the road
// with nothing casting it.
function paintCarShadow(ctx, cam, p) {
  if (!carQuad(ctx, cam, p, 0.12)) return;
  ctx.closePath();
  ctx.fillStyle = "#000"; ctx.globalAlpha = 0.45 * (p.alpha ?? 1); ctx.fill();
  ctx.globalAlpha = 1;
}

// ─── Ego cockpit ──────────────────────────────────────────────────────────────
// Drawn last, in SCREEN space — and that's exact rather than a shortcut, because
// the camera is rigidly attached to the car, so this geometry genuinely doesn't
// move in frame. It's the cheapest way to make the view feel like an onboard: it
// gives the eye a fixed reference, so yaw reads as the car turning rather than the
// world swinging around for no reason.
// The overlay is a Blender bake of the real car from THIS camera
// (scripts/render-tcam-ego.py) — see public/tcam-ego.png. Compositing it needs one
// scalar, because the render and the pane are pinhole views of the same car from the
// same eye: the ratio of their focal lengths. The image supplies its own focal from
// its width, so re-rendering at a different resolution needs no change here.
//
// It carries no livery, so tint it the way the ghost car is tinted — the colour is
// what says whose seat this is in a two-pane Compare. Tinting is per-pixel over a
// 1600 px image, so the result is cached; in practice that's two entries.
const EGO_HALF_TAN = Math.tan(FOV_H * Math.PI / 360);
const egoTintCache = new Map();

// The overlay is a flat image, so on its own it has no idea which pixels are
// paintwork and which are rubber. public/tcam-ego-mask.png answers that: a second
// render over the identical camera whose ALPHA is "this pixel is bodywork". Cutting
// the accent to that alpha and MULTIPLYING it in lands the lap colour on the body's
// own shading and touches nothing else — where the mask is empty the source alpha is
// zero, which source-over leaves exactly as rendered, so tyres, wishbones and wings
// keep the black the model gave them.
//
// The obvious cheaper trick, tinting by luminosity with the "color" blend mode, does
// not work: it washes the accent over every pixel with any brightness at all, so
// rims and tyre highlights go blue too.
function tintedEgo(img, mask, color) {
  let c = egoTintCache.get(color);
  if (!c) {
    c = document.createElement("canvas");
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const g = c.getContext("2d");
    g.drawImage(img, 0, 0);
    if (mask?.naturalWidth) {
      const t = document.createElement("canvas");
      t.width = c.width;
      t.height = c.height;
      const tg = t.getContext("2d");
      tg.drawImage(mask, 0, 0);
      tg.globalCompositeOperation = "source-in";   // accent, cut to the body
      tg.fillStyle = color;
      tg.fillRect(0, 0, t.width, t.height);
      g.globalCompositeOperation = "multiply";
      g.drawImage(t, 0, 0);
      // Guarantee the silhouette still matches the render exactly, whatever the two
      // passes did at their antialiased edges.
      g.globalCompositeOperation = "destination-in";
      g.drawImage(img, 0, 0);
    }
    if (egoTintCache.size > 8) egoTintCache.clear();  // skins can mint new accents
    egoTintCache.set(color, c);
  }
  return c;
}

function paintEgo(ctx, cam, w, h, color, img, mask) {
  if (img?.naturalWidth) {
    const s = cam.focal / ((img.naturalWidth / 2) / EGO_HALF_TAN);
    const dw = img.naturalWidth * s, dh = img.naturalHeight * s;
    ctx.drawImage(tintedEgo(img, mask, color), w / 2 - dw / 2, h / 2 - dh / 2, dw, dh);
    return;
  }
  // Fallback for the frames before the image loads, and for anywhere it can't be
  // fetched at all: the drawn hoop this replaced.
  ctx.save();
  // Halo hoop + central strut. Kept low and shallow: it's a reference mark, and
  // anything bigger just eats the road you're trying to read.
  ctx.strokeStyle = "rgba(12,16,23,0.9)";
  ctx.lineWidth = Math.max(5, w * 0.009);
  ctx.beginPath();
  ctx.ellipse(w / 2, h * 1.14, w * 0.26, h * 0.22, 0, Math.PI, 2 * Math.PI);
  ctx.stroke();
  ctx.lineWidth = Math.max(2, w * 0.004);
  ctx.beginPath();
  ctx.moveTo(w / 2, h * 0.925); ctx.lineTo(w / 2, h * 0.885);
  ctx.stroke();
  // Front-wing endplate hints, tinted to whose car this is
  ctx.fillStyle = color; ctx.globalAlpha = 0.22;
  ctx.beginPath();
  ctx.moveTo(0, h); ctx.lineTo(w * 0.13, h); ctx.lineTo(0, h * 0.93); ctx.closePath();
  ctx.moveTo(w, h); ctx.lineTo(w * 0.87, h); ctx.lineTo(w, h * 0.93); ctx.closePath();
  ctx.fill();
  ctx.restore();
}

// Draw one complete onboard frame. `ctx` must already be DPR-scaled so all
// coordinates here are CSS pixels.
//
// Layer order is fixed rather than depth-sorted: everything sits on one surface, so
// there is no occlusion to resolve — what matters is that the reference reads OVER
// the driven line, matching the plan view's document order next door.
//
// `other` is a placement already resolved by resolveOtherCar, not a raw car. When
// `drawOther` is supplied it replaces the flat decal — that's the hook the WebGL
// car blits through, and it fires HERE, mid-scene, so the fog and the ego cockpit
// still layer over the car exactly as they layer over the decal.
export function drawTCamFrame(ctx, {
  cam, model, rowIndex, w, h, camDist, driven, reference, other, egoColor,
  egoImage, egoMask, egoLive, cornerMarks, brakeMarks, drawOther,
}) {
  const hy = paintBackdrop(ctx, cam, w, h);
  const win = model ? roadWindow(model, rowIndex, cam) : null;
  const rows = model?.centerline || null;
  const n = rows?.length || 0;
  const closed = !!model?.closed;
  if (win) {
    paintRoad(ctx, cam, win);
    paintKerbs(ctx, cam, win);
    paintEdgeLines(ctx, cam, win);
    paintStartFinish(ctx, cam, rows, n, closed, model.startIndex);
    paintBrakeGates(ctx, cam, brakeMarks, rows, n, closed, rowIndex);
  }

  if (driven) {
    const pts = lineWindow(driven, camDist, rows, n, closed, rowIndex, cam);
    if (pts) paintDrivenRibbon(ctx, cam, pts);
  }
  if (reference) {
    const pts = lineWindow(reference, camDist, rows, n, closed, rowIndex, cam);
    if (pts) paintRefRibbon(ctx, cam, pts);
  }
  // The ghost's contact shadow is 2D either way — it's a mark on the tarmac, not a
  // body. Then the blit, which carries BOTH cars and so has to fire whether or not
  // there's a ghost: the ego is always in it.
  if (other) {
    if (drawOther) paintCarShadow(ctx, cam, other);
    else paintOtherCar(ctx, cam, other);
  }
  if (drawOther) drawOther(ctx);
  // Fog sits ABOVE the road and the lines but BELOW the labels: it should bury the
  // far geometry in haze, not the text telling you what's out there.
  paintFog(ctx, hy, w, h);
  paintCornerPosts(ctx, cam, cornerMarks, rows, n, closed, rowIndex);
  // When the car layer is drawing the ego live it has already gone in above, with
  // real wheels and real depth against the ghost. The baked overlay is then the
  // fallback for exactly the cases the layer can't cover: no WebGL, a lost context,
  // or the model still loading.
  if (!egoLive) paintEgo(ctx, cam, w, h, egoColor || "#34c8ff", egoImage, egoMask);

  return { horizonY: hy, window: win };
}
