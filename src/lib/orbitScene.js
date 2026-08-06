// ─── ORBIT SCENE (Analytics ▸ Driving Lines ▸ 3D) ─────────────────────────────
// The plan view's content — road, both racing lines, both cars, corner markers —
// built as real geometry and looked at from an arbitrary angle.
//
// WHY A THIRD RENDERER RATHER THAN A MODE OF ONE OF THE OTHER TWO. The plan view is
// SVG because its geometry is fixed and only the viewBox moves. The T-cam is a 2D
// painter because everything it draws sits on one surface in a fixed layer order,
// with no occlusion to resolve. Neither survives a free camera: the moment you can
// look along the road from 30° up, a car IS in front of a kerb, a ribbon DOES pass
// under a car, and the far side of a hairpin is behind the near side. That is a
// depth buffer's job, so this view is ordinary three.js with an orbit camera and
// nothing painterly about it.
//
// WHAT IT'S FOR. Seeing how someone else takes a corner — where they put the car
// relative to you through the whole phase of it — which is exactly the thing a
// top-down map flattens away and the onboard view can only show from one seat.
//
// FRAME. World x/z on the ground, y up, matching three's convention and the rest of
// the app's geometry, so nothing is remapped anywhere in this file.
import * as THREE from "three";
import { loadCarTemplate, instanceCar } from "./carModel.js";
import { pedalT, pedalColor } from "./racingLine.js";
import { FONT } from "./ui/tokens.js";

// Depth range. The camera pulls back to ~600 m and the far side of a circuit can be
// 3 km beyond that, while the near plane has to clear a car sitting a few metres from
// the lens at full zoom. A logarithmic depth buffer covers that span without the road
// and the markings a centimetre above it z-fighting at distance — and those
// millimetres are load-bearing now that the cars depth-test against them.
const NEAR = 0.4;
const FAR = 20000;

const ROAD_COLOR = 0x1d2433;   // asphalt — lighter than the plan view's fill, because
                               // seen at a grazing angle a flat dark surface loses its
                               // edges into the backdrop entirely
const EDGE_COLOR = 0x3a445c;   // same track edge as the plan view
const SF_COLOR   = 0xd8dee9;   // start/finish band

// Draw order for the transparent pass. Everything on the road surface is within
// centimetres of everything else, so left to the depth sort a brake dot would get to
// decide it was in front of the car parked on it. The opaque road is not in this
// list — opaque always draws first.
//
// THE CARS GO FIRST, ahead of every marking, and that ordering is the whole mechanism
// behind markings being hidden behind them. A car is translucent, so anything already
// in the colour buffer underneath it shows through; drawing the road markings AFTER
// means the ones a car covers are rejected by its depth instead of blended through
// it. The markings are unchanged — they still test depth and still don't write it —
// so the only thing that moved is who is in the buffer first.
const ORDER = { car: 0, kerb: 1, edge: 2, sf: 2, brake: 3, line: 4, label: 10 };

// Ribbons ride just above the road so they never z-fight it, and the reference sits
// a hair above the driven one so a crossing reads unambiguously rather than as
// stitching.
//
// MILLIMETRES, not the tens of centimetres this started at. Now that a marking is
// depth-tested against the car rather than painted under it, its height is the height
// at which it can poke through the car's own bodywork: at a grazing camera angle a
// line floating 10 cm up passes IN FRONT of a front wing sitting at 5 cm. Real paint
// is on the road, and with the logarithmic depth buffer these separations are still
// thousands of times the precision available at any distance the camera can reach.
const LINE_LIFT_DRIVEN = 0.018;
const LINE_LIFT_REF    = 0.026;
// Half-widths, so the ribbons come out ~0.55 m and ~0.42 m wide. Deliberately thin
// relative to the road: at the width that first felt right up close they measured
// nearly a car across, and a racing line as wide as the car driving it stops reading
// as a line and starts reading as a lane.
const LINE_HALF_DRIVEN = 0.275;
const LINE_HALF_REF    = 0.21;

// The reference line is DASHED, like it is in the other two views. Measured in world
// METRES rather than screen pixels, which is the same choice the T-cam makes and for
// the same reason: screen-space dashes are the same length at every depth and read as
// a sticker laid over the frame, while world-space ones compress toward the horizon
// exactly like real lane markings.
//
// Longer than the T-cam's 3/4 m, because this camera can sit 300 m back where that
// one is only ever a few metres ahead: at 3 m the dashes aliased into a shimmer at
// the far end of the zoom. The duty cycle is kept where the other two views put it,
// so the gap still reads the same.
const REF_DASH_ON = 4.5, REF_DASH_OFF = 5.5;

// The cars are TRANSLUCENT AND WRITE DEPTH. Two cars comparing a corner spend most of
// it on top of each other from some angle, and the one behind has to stay visible —
// that is the whole reason for the alpha. Depth-writing looks like it should defeat
// that, and it doesn't: three sorts the transparent queue back to front, so the FAR
// car is drawn first and the near one blends over it. Both are there, and the far one
// reads through at 1 − CAR_ALPHA.
//
// What writing depth buys is everything else being correctly occluded — a car really
// does hide the racing line it is standing on (see ORDER), its own far side doesn't
// x-ray through its near side, and a car across the circuit doesn't float through the
// road in front of it. Only two cars almost exactly coincident sort unstably, and at
// that point they are one shape anyway.
const CAR_ALPHA = 0.7;

const CORNER_POST_H = 5.5;   // m — label height above the road
const LABEL_H = 3.2;         // m — world height of the label plate

// ─── Row lookup ───────────────────────────────────────────────────────────────
// Nearest centerline row to a world point. With `from` supplied this is a BOUNDED
// walk around that row, which is O(1) for the sequential points of a ribbon; without
// it, a full scan, which is what a car gets every frame — a few thousand squared
// distances, cheap enough that it stays correct through a scrub instead of tracking
// a cursor that a jump would strand.
function nearestRow(rows, closed, x, z, from = null, span = 90) {
  const n = rows.length;
  let best = 0, bd = Infinity;
  const test = (i) => {
    const r = rows[i];
    const d = (r.x - x) ** 2 + (r.z - z) ** 2;
    if (d < bd) { bd = d; best = i; }
  };
  if (from == null) {
    for (let i = 0; i < n; i++) test(i);
    return best;
  }
  for (let k = -span; k <= span; k++) {
    let i = from + k;
    if (closed) i = ((i % n) + n) % n;
    else if (i < 0 || i >= n) continue;
    test(i);
  }
  return best;
}

// ─── Geometry builders ────────────────────────────────────────────────────────

// Every builder below sweeps the same centerline, so they all want the same per-row
// normal. Computed once, because a normal that differed between two of them would
// show as a kerb sliding off the edge it is supposed to sit on.
function rowNormals(rows, closed) {
  const m = rows.length;
  const nx = new Float32Array(m), nz = new Float32Array(m);
  for (let i = 0; i < m; i++) {
    const prev = rows[closed ? (i - 1 + m) % m : Math.max(0, i - 1)];
    const next = rows[closed ? (i + 1) % m : Math.min(m - 1, i + 1)];
    const tx = next.x - prev.x, tz = next.z - prev.z;
    const tl = Math.hypot(tx, tz) || 1;
    nx[i] = tz / tl; nz[i] = -tx / tl;
  }
  return { nx, nz };
}

// The road surface: one quad per centerline row pair, swept out to each row's own
// measured width. Same sweep the plan view does in SVG, with the drape's `y` added.
function roadMesh(model) {
  const rows = model?.centerline;
  if (!rows?.length) return null;
  const closed = !!model.closed;
  const m = rows.length;
  const { nx, nz } = rowNormals(rows, closed);
  const pos = new Float32Array(m * 6);
  for (let i = 0; i < m; i++) {
    const r = rows[i], y = r.y || 0;
    pos[i * 6 + 0] = r.x + nx[i] * (r.wl || 6); pos[i * 6 + 1] = y; pos[i * 6 + 2] = r.z + nz[i] * (r.wl || 6);
    pos[i * 6 + 3] = r.x - nx[i] * (r.wr || 6); pos[i * 6 + 4] = y; pos[i * 6 + 5] = r.z - nz[i] * (r.wr || 6);
  }
  const idx = [];
  const segs = closed ? m : m - 1;
  for (let i = 0; i < segs; i++) {
    const a = i * 2, b = ((i + 1) % m) * 2;
    idx.push(a, a + 1, b, a + 1, b + 1, b);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  const mesh = new THREE.Mesh(g, new THREE.MeshStandardMaterial({
    color: ROAD_COLOR, roughness: 0.96, metalness: 0, side: THREE.DoubleSide,
  }));
  mesh.renderOrder = 0;
  return mesh;
}

// Both track edges as lines, lifted clear of the surface they bound. Drawn OVER the
// kerbs (see ORDER), which is the layering the T-cam's painter has: a kerb's outer
// boundary is the track edge, so the edge line has to be on top or the kerb eats it.
function roadEdges(model) {
  const rows = model?.centerline;
  if (!rows?.length) return [];
  const closed = !!model.closed;
  const m = rows.length;
  const { nx, nz } = rowNormals(rows, closed);
  const L = [], R = [];
  for (let i = 0; i < m; i++) {
    const r = rows[i], y = (r.y || 0) + 0.014;
    L.push(new THREE.Vector3(r.x + nx[i] * (r.wl || 6), y, r.z + nz[i] * (r.wl || 6)));
    R.push(new THREE.Vector3(r.x - nx[i] * (r.wr || 6), y, r.z - nz[i] * (r.wr || 6)));
  }
  const mat = new THREE.LineBasicMaterial({
    color: EDGE_COLOR, transparent: true, opacity: 0.95, depthWrite: false,
  });
  const make = (pts) => {
    const g = new THREE.BufferGeometry().setFromPoints(pts);
    const line = closed ? new THREE.LineLoop(g, mat) : new THREE.Line(g, mat);
    line.renderOrder = ORDER.edge;
    return line;
  };
  return [make(L), make(R)];
}

// ─── Kerbs ────────────────────────────────────────────────────────────────────
// Built the same way the T-cam builds them (tcamScene's paintKerbs), off the same
// constants: no kerb data is shipped, but the centerline's smoothed signed curvature
// `k` says where the corners are, and `trackGeometry` already pads each shipped edge
// by EDGE_MARGIN = 1 m precisely because "kerbs are drivable" — so the outer metre of
// the road on the INSIDE of a corner already is the kerb. Mirror those numbers rather
// than inventing a second set that would drift from them.
//
// The one thing that has to differ is the alpha ramp. The T-cam fades the whole
// visible run by the curvature nearest the camera, which it can do because it only
// ever draws a few hundred metres of road. Here the entire circuit sits in one static
// mesh, so the ramp is PER VERTEX instead — a four-component colour attribute, which
// three reads as vertex alpha on its own.
const KERB_W      = 1.0;        // = trackGeometry's EDGE_MARGIN
const KERB_K_ON   = 1 / 120;    // curvature where a kerb starts to appear (R 120 m)
const KERB_K_FULL = 1 / 60;     // ...and where it's fully opaque
const KERB_STRIPE = 2.0;        // m per red/white block
const KERB_LIFT   = 0.010;      // m — clear of the road quad, under every other marking
const KERB_RED    = new THREE.Color(0xd43b3b);
const KERB_WHITE  = new THREE.Color(0xe8edf5);

function kerbMesh(model) {
  const rows = model?.centerline;
  if (!rows?.length) return null;
  const closed = !!model.closed;
  const m = rows.length;
  const { nx, nz } = rowNormals(rows, closed);
  const pos = [], col = [], idx = [];
  const segs = closed ? m : m - 1;
  let s = 0;   // running arc length, so the stripe stays 2 m however the rows fall

  for (let i = 0; i < segs; i++) {
    const ia = i, ib = (i + 1) % m;
    const a = rows[ia], b = rows[ib];
    const s0 = s;
    s += Math.hypot(b.x - a.x, b.z - a.z);
    const k = ((a.k || 0) + (b.k || 0)) / 2;
    if (Math.abs(k) < KERB_K_ON) continue;
    // k > 0 curves toward +z and the left normal points toward −z, so a positive k
    // turns AWAY from the left normal: the inside of the corner is the wr side.
    const sgn = k > 0 ? -1 : 1;
    const wA = (k > 0 ? a.wr : a.wl) || 6;
    const wB = (k > 0 ? b.wr : b.wl) || 6;
    if (Math.min(wA, wB) <= KERB_W) continue;   // no room for a kerb inside the line

    const c = Math.floor(s0 / KERB_STRIPE) % 2 ? KERB_RED : KERB_WHITE;
    const t = Math.max(0, Math.min(1, (Math.abs(k) - KERB_K_ON) / (KERB_K_FULL - KERB_K_ON)));
    const alpha = 0.35 + 0.5 * t;
    const base = pos.length / 3;
    const corner = (row, ni, w) => {
      pos.push(row.x + nx[ni] * sgn * w, (row.y || 0) + KERB_LIFT, row.z + nz[ni] * sgn * w);
      col.push(c.r, c.g, c.b, alpha);
    };
    corner(a, ia, wA); corner(a, ia, wA - KERB_W);
    corner(b, ib, wB); corner(b, ib, wB - KERB_W);
    idx.push(base, base + 1, base + 2, base + 1, base + 3, base + 2);
  }
  if (!idx.length) return null;   // a circuit with no corner tight enough to kerb

  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("color", new THREE.Float32BufferAttribute(col, 4));  // 4 → vertex alpha
  g.setIndex(idx);
  const mesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial({
    vertexColors: true, transparent: true, side: THREE.DoubleSide, depthWrite: false,
  }));
  mesh.renderOrder = ORDER.kerb;
  return mesh;
}

// The start/finish band, straight across the road at the fitted S/F row.
function startLine(model) {
  const rows = model?.centerline;
  if (!rows?.length || typeof model.startIndex !== "number") return null;
  const m = rows.length, closed = !!model.closed;
  const at = (i) => rows[closed ? ((i % m) + m) % m : Math.max(0, Math.min(m - 1, i))];
  const pos = [];
  for (const i of [model.startIndex, model.startIndex + 2]) {
    const r = at(i), prev = at(i - 1), next = at(i + 1);
    let tx = next.x - prev.x, tz = next.z - prev.z;
    const tl = Math.hypot(tx, tz) || 1; tx /= tl; tz /= tl;
    const nx = tz, nz = -tx, y = (r.y || 0) + 0.006;
    pos.push(r.x + nx * (r.wl || 6), y, r.z + nz * (r.wl || 6));
    pos.push(r.x - nx * (r.wr || 6), y, r.z - nz * (r.wr || 6));
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex([0, 1, 2, 1, 3, 2]);
  const mesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial({
    color: SF_COLOR, transparent: true, opacity: 0.5, side: THREE.DoubleSide, depthWrite: false,
  }));
  mesh.renderOrder = ORDER.sf;
  return mesh;
}

// The mesh both ribbon builders end at. Unlit on purpose: these are annotations drawn
// on the world, not surfaces in it, and the pedal ramp's saturation is the
// information. Shading it would read as the driver having lifted wherever the sun
// didn't reach.
function ribbonMesh(pos, idx, col, { color, opacity }) {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  if (col) g.setAttribute("color", new THREE.BufferAttribute(col, 3));
  g.setIndex(idx);
  const mesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial({
    vertexColors: !!col, color: col ? 0xffffff : color,
    transparent: opacity < 1, opacity, side: THREE.DoubleSide, depthWrite: false,
  }));
  mesh.renderOrder = ORDER.line;
  return mesh;
}

// The driven line: one continuous ribbon draped on the road, coloured per sample by
// `colorAt` off the SAME pedal ramp the plan view and the T-cam use — one definition
// of what full throttle looks like, three views reading it.
function lineRibbon(line, { halfWidth, lift, colorAt, color, opacity }, yAt) {
  const pts = line?.pts;
  if (!pts || pts.length < 2) return null;
  const n = pts.length;
  const pos = new Float32Array(n * 6);
  const col = colorAt ? new Float32Array(n * 6) : null;
  const c = new THREE.Color();
  const idx = [];
  let row = null;
  for (let i = 0; i < n; i++) {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)];
    let tx = b.x - a.x, tz = b.z - a.z;
    const tl = Math.hypot(tx, tz) || 1; tx /= tl; tz /= tl;
    const nx = tz, nz = -tx;
    const p = pts[i];
    const seat = yAt(p.x, p.z, row);
    row = seat.row;
    const y = seat.y + lift;
    pos[i * 6 + 0] = p.x + nx * halfWidth; pos[i * 6 + 1] = y; pos[i * 6 + 2] = p.z + nz * halfWidth;
    pos[i * 6 + 3] = p.x - nx * halfWidth; pos[i * 6 + 4] = y; pos[i * 6 + 5] = p.z - nz * halfWidth;
    if (col) {
      c.set(colorAt(p));
      col[i * 6 + 0] = c.r; col[i * 6 + 1] = c.g; col[i * 6 + 2] = c.b;
      col[i * 6 + 3] = c.r; col[i * 6 + 4] = c.g; col[i * 6 + 5] = c.b;
    }
    if (i) { const k = (i - 1) * 2; idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2); }
  }
  return ribbonMesh(pos, idx, col, { color, opacity });
}

// The reference line: the same ribbon cut into dashes, one detached quad each.
//
// The pattern is walked in world METRES along the line's own arc length, which means
// the 10 m sample gaps have to be SUBDIVIDED at dash boundaries — a dash starts and
// ends where the pattern says, not where the recorder's bins happen to fall. Same
// walk the T-cam's paintRefRibbon does, and it has to be: a dash pattern that drifted
// against the bins would put dashes in different places in the two views.
function dashedRibbon(line, { halfWidth, lift, color, opacity, on, off }, yAt) {
  const pts = line?.pts;
  if (!pts || pts.length < 2) return null;
  const period = on + off;
  const pos = [], idx = [];
  let row = null;

  // One dash. Its normal comes from its OWN endpoints rather than the sample's, so a
  // dash that lands mid-corner sits square across the line it is drawn on.
  const quad = (ax, az, bx, bz) => {
    let tx = bx - ax, tz = bz - az;
    const tl = Math.hypot(tx, tz);
    if (!(tl > 0)) return;
    tx /= tl; tz /= tl;
    const nx = tz, nz = -tx;
    const sa = yAt(ax, az, row); row = sa.row;
    const sb = yAt(bx, bz, row); row = sb.row;
    const ay = sa.y + lift, by = sb.y + lift;
    const base = pos.length / 3;
    pos.push(ax + nx * halfWidth, ay, az + nz * halfWidth,
             ax - nx * halfWidth, ay, az - nz * halfWidth,
             bx + nx * halfWidth, by, bz + nz * halfWidth,
             bx - nx * halfWidth, by, bz - nz * halfWidth);
    idx.push(base, base + 1, base + 2, base + 1, base + 3, base + 2);
  };

  let s = 0;   // arc length walked, so the phase carries across sample boundaries
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const segLen = Math.hypot(b.x - a.x, b.z - a.z);
    if (!(segLen > 0)) continue;
    let walked = 0;
    while (walked < segLen) {
      const phase = (s + walked) % period;
      const lit = phase < on;
      const take = Math.min(lit ? on - phase : period - phase, segLen - walked);
      if (lit) {
        const t0 = walked / segLen, t1 = (walked + take) / segLen;
        quad(a.x + (b.x - a.x) * t0, a.z + (b.z - a.z) * t0,
             a.x + (b.x - a.x) * t1, a.z + (b.z - a.z) * t1);
      }
      walked += take;
    }
    s += segLen;
  }
  if (!idx.length) return null;
  return ribbonMesh(new Float32Array(pos), idx, null, { color, opacity });
}

// ─── Corner labels ────────────────────────────────────────────────────────────
// A billboarded plate on a post, same idea as the T-cam's corner posts: text alone
// floating over tarmac reads as an overlay, a plate on a stick reads as being AT the
// corner. Drawn with depth test off so a label is never half-buried in the car or
// the road it is annotating.
function labelSprite(text) {
  const canvas = document.createElement("canvas");
  const fs = 40, pad = 12;
  const ctx = canvas.getContext("2d");
  const font = `700 ${fs}px ${FONT.mono}`;
  ctx.font = font;
  canvas.width = Math.ceil(ctx.measureText(text).width) + pad * 2;
  canvas.height = fs + pad * 2;
  // Sizing the canvas RESETS its context state, so everything is re-set after it.
  ctx.font = font;
  ctx.textBaseline = "middle";
  ctx.fillStyle = "rgba(8,11,18,0.86)";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = "rgba(91,107,140,0.9)";
  ctx.lineWidth = 3;
  ctx.strokeRect(1.5, 1.5, canvas.width - 3, canvas.height - 3);
  ctx.fillStyle = "#aeb8cc";
  ctx.fillText(text, pad, canvas.height / 2 + 1);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const spr = new THREE.Sprite(new THREE.SpriteMaterial({
    map: tex, transparent: true, depthTest: false, depthWrite: false,
  }));
  spr.scale.set((LABEL_H * canvas.width) / canvas.height, LABEL_H, 1);
  spr.renderOrder = ORDER.label;
  return spr;
}

// ─── Scene ────────────────────────────────────────────────────────────────────
// Returns null when WebGL is unavailable, exactly like the T-cam's car layer —
// the caller shows a note and the other two camera modes still work. Nothing in
// here is allowed to throw into a render loop.
export function createOrbitScene(canvas, onReady) {
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, logarithmicDepthBuffer: true });
  } catch {
    return null;
  }
  if (!renderer) return null;
  renderer.setClearColor(0x000000, 0);

  const scene = new THREE.Scene();
  // Same three lights the T-cam's car pass uses, and for the same reason: this is a
  // near-black palette, so it takes a cool hemisphere for shape, one sun for a
  // highlight that separates bodywork from tarmac, and a little fill so the shadowed
  // side doesn't go to pure black.
  scene.add(new THREE.HemisphereLight(0xaecbff, 0x202028, 0.9));
  const sun = new THREE.DirectionalLight(0xffffff, 1.1);
  sun.position.set(0.4, 1, 0.25);
  scene.add(sun);
  scene.add(new THREE.AmbientLight(0xffffff, 0.25));

  const cam = new THREE.PerspectiveCamera(46, 1, NEAR, FAR);
  const target = new THREE.Vector3();

  // Static geometry, rebuilt as a unit whenever the track or the laps change.
  const world = new THREE.Group();
  scene.add(world);

  let template = null;
  let rows = null, closed = false;
  let alive = true, disposed = false;
  const cars = new Map();   // colour → car instance

  loadCarTemplate().then((t) => {
    if (disposed || !t) return;   // no model — the wedge markers stand in, permanently
    template = t;
    // Any car built while the load was in flight is a wedge; drop them so carFor
    // rebuilds from the model. Cars are cheap and this happens once.
    for (const c of cars.values()) { scene.remove(c.root); c.dispose(); }
    cars.clear();
    onReady?.();
  });

  // Fallback car: a plain wedge, used only when the GLB didn't load. It says where
  // and which way round, which is the irreducible part of the job.
  const markerCar = (color) => {
    const g = new THREE.BufferGeometry();
    const w = 0.9, l = 2.4, h = 0.5;
    g.setAttribute("position", new THREE.Float32BufferAttribute([
      0, 0, l, -w, 0, -l, w, 0, -l,
      0, h, -l * 0.2, -w, 0, -l, 0, 0, l,
      0, h, -l * 0.2, 0, 0, l, w, 0, -l,
      0, h, -l * 0.2, w, 0, -l, -w, 0, -l,
    ], 3));
    g.computeVertexNormals();
    const root = new THREE.Mesh(g, new THREE.MeshStandardMaterial({
      color, transparent: true, opacity: CAR_ALPHA, side: THREE.DoubleSide,
    }));
    return {
      root,
      place(p) { root.position.set(p.x, p.y + 0.1, p.z); root.rotation.set(0, Math.PI / 2 - p.yaw, 0); },
      dispose() { g.dispose(); root.material.dispose(); },
    };
  };

  const carFor = (color) => {
    let car = cars.get(color);
    if (!car) {
      car = template
        ? instanceCar(template, { color, opacity: CAR_ALPHA })
        : markerCar(color);
      car.root.visible = false;
      // renderOrder has to go on the MESHES — it's per-object, and a Group is never
      // drawn, so setting it on the root does nothing. Without this the cars sort
      // among the road markings by their own order-0 default and a brake dot lying on
      // the tarmac paints straight over the car standing on it. Everything in `world`
      // stays below 5; the cars are the only things that aren't part of the road.
      car.root.traverse((o) => { if (o.isMesh) o.renderOrder = ORDER.car; });
      scene.add(car.root);
      cars.set(color, car);
    }
    return car;
  };

  const clearWorld = () => {
    world.traverse((o) => {
      if (o === world) return;
      o.geometry?.dispose?.();
      if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => {
        m.map?.dispose?.(); m.dispose?.();
      });
    });
    world.clear();
  };

  // Road height at a world point, plus the row it came from so a caller walking a
  // polyline can hand it back and get an O(1) lookup next time. Flat when there's no
  // model at all — a lap with no fitted circuit still draws its lines and its cars.
  const seatAt = (x, z, from = null) => {
    if (!rows?.length) return { y: 0, row: null };
    const row = nearestRow(rows, closed, x, z, from);
    return { y: rows[row].y || 0, row };
  };

  return {
    get alive() { return alive; },
    get ready() { return !!template; },

    // Rebuilds the static half of the scene. Callers pass the same objects every
    // frame and this is not cheap, so the caller decides when it changed — see
    // TrackOrbitView, which keys it on the model and line identities.
    setTrack({ model, driven, reference, cornerMarks, brakeMarks }) {
      clearWorld();
      rows = model?.centerline || null;
      closed = !!model?.closed;
      const road = roadMesh(model);
      if (road) {
        world.add(road);
        const kerbs = kerbMesh(model);
        if (kerbs) world.add(kerbs);
        for (const e of roadEdges(model)) world.add(e);
        const sf = startLine(model);
        if (sf) world.add(sf);
      }
      const ref = dashedRibbon(reference, {
        halfWidth: LINE_HALF_REF, lift: LINE_LIFT_REF, color: 0xffffff, opacity: 0.85,
        on: REF_DASH_ON, off: REF_DASH_OFF,
      }, seatAt);
      if (ref) world.add(ref);
      const drv = lineRibbon(driven, {
        halfWidth: LINE_HALF_DRIVEN, lift: LINE_LIFT_DRIVEN, opacity: 1,
        colorAt: (p) => pedalColor(pedalT(p.throttle, p.brake)),
      }, seatAt);
      if (drv) world.add(drv);

      // The reference driver's brake points, as discs lying on the road — the plan
      // view's dot, given a surface. (The T-cam draws these as a gate across the
      // whole road instead, because from the seat a dot means nothing; from a free
      // camera the point on the LINE is exactly what you want to see.)
      if (brakeMarks?.length) {
        const disc = new THREE.CircleGeometry(1.0, 20).rotateX(-Math.PI / 2);
        const mat = new THREE.MeshBasicMaterial({
          color: 0xff2d2d, transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthWrite: false,
        });
        for (const mark of brakeMarks) {
          const mesh = new THREE.Mesh(disc, mat);
          mesh.position.set(mark.x, seatAt(mark.x, mark.z).y + LINE_LIFT_REF + 0.008, mark.z);
          mesh.renderOrder = ORDER.brake;
          world.add(mesh);
        }
      }

      for (const mark of cornerMarks || []) {
        const { y } = seatAt(mark.x, mark.z);
        const post = new THREE.Line(
          new THREE.BufferGeometry().setFromPoints([
            new THREE.Vector3(mark.x, y + 0.1, mark.z),
            new THREE.Vector3(mark.x, y + CORNER_POST_H, mark.z),
          ]),
          new THREE.LineBasicMaterial({ color: 0x5b6b8c, transparent: true, opacity: 0.75 }),
        );
        world.add(post);
        const spr = labelSprite(mark.name);
        spr.position.set(mark.x, y + CORNER_POST_H + LABEL_H * 0.55, mark.z);
        world.add(spr);
      }
    },

    // `list` is [{ x, z, yaw, color, dist }] — world x/z, heading in radians, the lap
    // colour, and lap distance in metres for the wheel roll. Cars are seated on the
    // ROAD rather than at their own recorded ride height, the same drape the T-cam
    // and the ribbons use: one road surface, one answer for what height is.
    setCars(list) {
      for (const c of cars.values()) c.root.visible = false;
      for (const it of list || []) {
        if (!it) continue;
        const car = carFor(it.color);
        car.root.visible = true;
        car.place({ x: it.x, y: seatAt(it.x, it.z).y, z: it.z, yaw: it.yaw }, it.dist);
      }
    },

    // Height of the road under a point, for the caller's camera target.
    roadY(x, z) { return seatAt(x, z).y; },

    // Orbit pose: where to look, from what bearing, how high up, how far back.
    // Azimuth is WORLD-fixed, not car-relative — the corner has to hold still while
    // the cars drive through it, which is the whole point of the view.
    setCamera(tx, ty, tz, az, el, dist) {
      target.set(tx, ty, tz);
      const ce = Math.cos(el);
      cam.position.set(tx + dist * ce * Math.cos(az), ty + dist * Math.sin(el), tz + dist * ce * Math.sin(az));
      cam.up.set(0, 1, 0);
      cam.lookAt(target);
    },

    resize(w, h, dpr) {
      renderer.setPixelRatio(dpr);
      renderer.setSize(w, h, false);   // false: the canvas' CSS box is the caller's
      cam.aspect = w / Math.max(1, h);
      cam.updateProjectionMatrix();
    },

    render() {
      if (!alive) return false;
      try {
        renderer.render(scene, cam);
        return true;
      } catch {
        alive = false;   // a GL fault drops the view, it never takes the panel down
        return false;
      }
    },

    dispose() {
      alive = false;
      disposed = true;
      clearWorld();
      for (const c of cars.values()) c.dispose();
      cars.clear();
      template = null;
      renderer.dispose();
    },
  };
}
