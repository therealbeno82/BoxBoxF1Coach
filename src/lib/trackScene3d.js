// ─── 3D TRACK SCENE (Compare → Driving Lines tab) ─────────────────────────────
// A self-contained Three.js scene that renders two laps' captured racing lines on a
// real circuit model with two 3D cars driving along them, viewed by a chase camera
// you can orbit/zoom. Built imperatively (no react-three-fiber) so it owns its own
// render loop: React only pushes the playback fraction via setPlayback().
//
// The road comes from a track model (src/lib/trackGeometry.js): real centerline +
// per-point track widths aligned into the game's world frame, or a curvature
// heuristic road when no real data exists. The recorded lines are never modified —
// they are painted onto the road exactly where the car drove, so apexes, track
// limits and curb hops read honestly.
//
// createTrackScene(canvas, lines, opts) → controller
//   lines: [{ id, color(hex int|css), pts:[{x,y?,z}], distAt:[0..1], timeAt:[0..1], paceAt? }]
//   opts:  { camMode, track }  — track = model from trackGeometry.loadTrackModel()
//   controller: { setPlayback(frac, axis), zoomBy(f), setCamMode(m), frame(),
//                 updateLines(lines), resize(), dispose() }
// updateLines() refreshes the painted lines + car paths IN PLACE for the same set
// of line ids (a live lap growing new samples) — the road, renderer and camera
// survive, so a growing lap doesn't rebuild the whole scene every sample bin.
import * as THREE from "three";
import { makeF1Car } from "./carModel3d.js";
import { buildHeuristicTrack } from "./trackGeometry.js";

const UP = new THREE.Vector3(0, 1, 0);
const CAM_MODES = ["chase", "broadcast", "top"];

// Sample a car's world position + heading along a line at fraction `frac`. `axis` is
// "dist" (position-sync — raw track distance) or "time" (pace-sync — the line's pace
// curve, i.e. its progress in the shared anchor-distance clock). The anchor car stays in
// lock-step with the scrubber knob; the other car is offset along its own line by the pace
// curve, so the time gap shows. The path is a Catmull-Rom spline (line.curve) rather than
// the raw chords, so motion and heading stay smooth through corners.
function sampleLine(line, frac, axis) {
  // Pace-sync ("time") addresses the pace curve — the line's progress in the shared
  // anchor-distance clock — so every car sits at one wall-clock instant. Position-sync
  // ("dist") addresses raw track distance. Both are [0..1] arrays over the samples.
  const addr = axis === "time" ? (line.paceAt || line.distAt) : line.distAt;
  const P = line.vpts; // THREE.Vector3[]
  const n = P.length;
  const f = Math.max(0, Math.min(1, frac));
  let i = 1;
  while (i < n && addr[i] < f) i++;
  i = Math.min(i, n - 1);
  const lo = addr[i - 1], hi = addr[i];
  const t = hi > lo ? (f - lo) / (hi - lo) : 0;
  // Continuous parameter along the spline; segment boundaries land on the raw points, so
  // the car still passes through each captured sample at the same frac as the scrubber.
  const u = Math.max(0, Math.min(1, (i - 1 + t) / (n - 1)));
  if (!line.curve) { // safety fallback: linear between raw points
    const pos = P[i - 1].clone().lerp(P[i], t);
    const dir = P[i].clone().sub(P[i - 1]);
    return { pos, heading: Math.atan2(dir.x, dir.z) };
  }
  const pos = line.curve.getPoint(u);
  const tan = line.curve.getTangent(u); // smooth spline tangent → continuous heading
  const heading = Math.atan2(tan.x, tan.z); // car forward is +Z
  return { pos, heading };
}

// Indexed quad-strip between two rails of Vector3s (same length). `closed` adds the
// wrap-around quads. Optional `colors` = flat [r,g,b] per vertex (L then R per row).
function ribbonGeometry(Ls, Rs, closed, colors = null) {
  const N = Ls.length;
  const pos = new Float32Array(N * 2 * 3);
  for (let i = 0; i < N; i++) {
    pos.set([Ls[i].x, Ls[i].y, Ls[i].z], i * 6);
    pos.set([Rs[i].x, Rs[i].y, Rs[i].z], i * 6 + 3);
  }
  const idx = [];
  const segs = closed ? N : N - 1;
  for (let i = 0; i < segs; i++) {
    const j = (i + 1) % N;
    const a = i * 2, b = i * 2 + 1, c = j * 2, d = j * 2 + 1;
    idx.push(a, b, c, b, d, c);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  if (colors) geo.setAttribute("color", new THREE.BufferAttribute(Float32Array.from(colors), 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

// Sweep a constant half-width horizontal ribbon along a list of Vector3 points (open
// strip) — used for the painted racing lines.
function sweepRibbon(points, halfWidth) {
  const N = points.length;
  const Ls = new Array(N), Rs = new Array(N);
  const t = new THREE.Vector3(), n = new THREE.Vector3();
  for (let i = 0; i < N; i++) {
    const prev = points[Math.max(0, i - 1)];
    const next = points[Math.min(N - 1, i + 1)];
    t.copy(next).sub(prev); t.y = 0;
    if (t.lengthSq() < 1e-10) t.set(0, 0, 1); else t.normalize();
    n.crossVectors(UP, t);
    Ls[i] = points[i].clone().addScaledVector(n, halfWidth);
    Rs[i] = points[i].clone().addScaledVector(n, -halfWidth);
  }
  return ribbonGeometry(Ls, Rs, false);
}

// Deterministic per-index pseudo-noise in [0,1) for asphalt vertex shading.
const noise = (i) => {
  const x = Math.sin(i * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
};

export function createTrackScene(canvas, lines, opts = {}) {
  const CLEAR = 0x141a26;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setClearColor(CLEAR, 1);

  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(CLEAR, 150, 1100);

  const camera = new THREE.PerspectiveCamera(52, 1, 0.5, 20000);

  scene.add(new THREE.HemisphereLight(0xaecbff, 0x202028, 0.9));
  const sun = new THREE.DirectionalLight(0xffffff, 1.1);
  sun.position.set(120, 220, 80);
  scene.add(sun);
  scene.add(new THREE.AmbientLight(0xffffff, 0.25));

  // ── Center every line on the shared centroid so the scene sits near the origin ──
  const allPts = lines.flatMap(l => l.pts);
  const c = allPts.reduce((s, p) => { s.x += p.x; s.z += p.z; s.y += (p.y || 0); return s; },
    { x: 0, y: 0, z: 0 });
  c.x /= allPts.length; c.y /= allPts.length; c.z /= allPts.length;
  const hasY = allPts.some(p => typeof p.y === "number");
  // Center a raw line into the scene frame and fit its spline. Reused by
  // updateLines(), which keeps the ORIGINAL centroid so refreshed lines stay
  // aligned with the road that was built against it.
  const buildLine = (l) => {
    const bl = {
      ...l,
      vpts: l.pts.map(p => new THREE.Vector3(p.x - c.x, hasY ? (p.y || 0) - c.y : 0, p.z - c.z)),
    };
    // Smooth spline through the captured points; the car and the painted line both
    // follow it, so corners stay clean and the car never drifts off its own line.
    // Centripetal parameterization avoids overshoot/cusps on uneven sample spacing.
    bl.curve = new THREE.CatmullRomCurve3(bl.vpts, false, "centripetal");
    return bl;
  };
  // Build centered Vector3 lists (drop raw Y when absent → flat plane).
  const built = lines.map(buildLine);

  const disposables = [];
  const track = (obj) => { disposables.push(obj); return obj; };

  // ── Track model: real circuit (aligned) or heuristic road around the lines ────
  const model = opts.track || buildHeuristicTrack(lines);
  const closed = !!model?.closed;
  // Centered rows + per-row travel tangent/left-normal and edge rails.
  const rows = (model?.centerline || []).map(r => ({
    x: r.x - c.x, y: hasY ? r.y - c.y : 0, z: r.z - c.z, wl: r.wl, wr: r.wr, k: r.k || 0,
  }));
  const nR = rows.length;
  const rowN = new Array(nR);   // left-of-travel horizontal normal
  const atOffset = (i, off, lift = 0) => // point `off` meters left (+) / right (−) of row i
    new THREE.Vector3(rows[i].x + rowN[i].x * off, rows[i].y + lift, rows[i].z + rowN[i].z * off);
  for (let i = 0; i < nR; i++) {
    const a = rows[closed ? (i - 1 + nR) % nR : Math.max(0, i - 1)];
    const b = rows[closed ? (i + 1) % nR : Math.min(nR - 1, i + 1)];
    let tx = b.x - a.x, tz = b.z - a.z;
    const tl = Math.hypot(tx, tz) || 1;
    // n = cross(UP, t) → (tz, −tx): the left-hand side of the direction of travel.
    rowN[i] = { x: tz / tl, z: -tx / tl };
  }

  // Road-surface height at a centered x/z (elevAt works in world coords).
  const surfY = model?.elevAt
    ? (x, z) => model.elevAt(x + c.x, z + c.z) - (hasY ? c.y : 0)
    : () => 0;
  // Cars and painted lines ride ON the road, but keep any recorded height ABOVE it
  // (curb hops, bumps) — clamp only below-surface error from the drape smoothing.
  const onSurface = (x, rawY, z, lift) => {
    const road = surfY(x, z);
    return road + Math.min(Math.max(rawY - road, 0), 1.5) + lift;
  };

  if (nR > 2) {
    // ── Asphalt, with subtle per-vertex tone noise (no textures → CSP-safe) ──
    const Ls = [], Rs = [], roadCols = [];
    for (let i = 0; i < nR; i++) {
      Ls.push(atOffset(i, rows[i].wl));
      Rs.push(atOffset(i, -rows[i].wr));
    }
    for (let i = 0; i < nR; i++) {
      const a = 0.9 + 0.1 * noise(i * 2), b = 0.9 + 0.1 * noise(i * 2 + 1);
      roadCols.push(a, a, a, b, b, b);
    }
    const roadGeo = track(ribbonGeometry(Ls, Rs, closed, roadCols));
    const roadMat = track(new THREE.MeshStandardMaterial({
      color: 0x2d333f, roughness: 0.95, metalness: 0, vertexColors: true, side: THREE.DoubleSide,
    }));
    scene.add(new THREE.Mesh(roadGeo, roadMat));

    // ── Grass/runoff verges out from each edge ──
    const vergeMat = track(new THREE.MeshStandardMaterial({
      color: 0x15211b, roughness: 1, metalness: 0, side: THREE.DoubleSide,
    }));
    const LsV = rows.map((r, i) => atOffset(i, r.wl + 20, -0.04));
    const RsV = rows.map((r, i) => atOffset(i, -(r.wr + 20), -0.04));
    scene.add(new THREE.Mesh(track(ribbonGeometry(Ls.map(v => v.clone().setY(v.y - 0.04)), LsV, closed)), vergeMat));
    scene.add(new THREE.Mesh(track(ribbonGeometry(RsV, Rs.map(v => v.clone().setY(v.y - 0.04)), closed)), vergeMat));

    // ── White track-limit lines just inside each edge ──
    const edgeMat = track(new THREE.MeshBasicMaterial({
      color: 0xd8dde8, side: THREE.DoubleSide,
      polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
    }));
    const edgeRail = (side) => { // side +1 = left, −1 = right
      const A = rows.map((r, i) => atOffset(i, side * ((side > 0 ? r.wl : r.wr) - 0.2), 0.02));
      const B = rows.map((r, i) => atOffset(i, side * ((side > 0 ? r.wl : r.wr) - 0.45), 0.02));
      return track(ribbonGeometry(A, B, closed));
    };
    scene.add(new THREE.Mesh(edgeRail(1), edgeMat));
    scene.add(new THREE.Mesh(edgeRail(-1), edgeMat));

    // ── Curbs: red/white ribbons on corner edges (from centerline curvature) ──
    // A run of sustained curvature gets an apex curb on the inside edge for its whole
    // length and an exit curb on the outside edge over its second half. With the
    // n = cross(UP, t) convention, positive k puts the corner's inside on the RIGHT.
    const K_MIN = 1 / 120, MIN_RUN = 8, PAD = 4;
    const runs = [];
    let runStart = -1;
    for (let i = 0; i < nR + 1; i++) {
      const inCorner = i < nR && Math.abs(rows[i].k) > K_MIN;
      if (inCorner && runStart < 0) runStart = i;
      if (!inCorner && runStart >= 0) {
        if (i - runStart >= MIN_RUN) runs.push([runStart, i - 1]);
        runStart = -1;
      }
    }
    const curbPos = [], curbCol = [], curbIdx = [];
    const RED = [0.78, 0.16, 0.12], WHITE = [0.92, 0.92, 0.92];
    const addCurb = (i0, i1, side) => { // side +1 = left edge, −1 = right edge
      const start = curbPos.length / 3;
      let arc = 0, prev = null, stripe = 0;
      for (let i = i0; i <= i1; i++) {
        const j = closed ? (i + nR) % nR : Math.min(Math.max(i, 0), nR - 1);
        const w = side > 0 ? rows[j].wl : rows[j].wr;
        const inner = atOffset(j, side * (w - 0.1), 0.015);
        const outer = atOffset(j, side * (w + 1.5), 0.09); // raised outer lip
        if (prev) arc += Math.hypot(inner.x - prev.x, inner.z - prev.z);
        prev = inner;
        stripe = Math.floor(arc / 4) % 2; // alternate every ~4 m along the curb
        const col = stripe ? WHITE : RED;
        curbPos.push(inner.x, inner.y, inner.z, outer.x, outer.y, outer.z);
        curbCol.push(...col, ...col);
      }
      const rowsAdded = i1 - i0 + 1;
      for (let r = 0; r < rowsAdded - 1; r++) {
        const a = start + r * 2, b = a + 1, d = a + 2, e = a + 3;
        curbIdx.push(a, b, d, b, e, d);
      }
    };
    for (const [i0, i1] of runs) {
      const kMean = rows.slice(i0, i1 + 1).reduce((s, r) => s + r.k, 0) / (i1 - i0 + 1);
      const inside = kMean > 0 ? -1 : 1;
      addCurb(i0 - PAD, i1 + PAD, inside);                                  // apex curb
      addCurb(Math.round((i0 + i1) / 2), i1 + PAD * 2, -inside);            // exit curb
    }
    if (curbIdx.length) {
      const curbGeo = track(new THREE.BufferGeometry());
      curbGeo.setAttribute("position", new THREE.BufferAttribute(Float32Array.from(curbPos), 3));
      curbGeo.setAttribute("color", new THREE.BufferAttribute(Float32Array.from(curbCol), 3));
      curbGeo.setIndex(curbIdx);
      curbGeo.computeVertexNormals();
      const curbMat = track(new THREE.MeshStandardMaterial({
        vertexColors: true, roughness: 0.8, metalness: 0, side: THREE.DoubleSide,
        polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
      }));
      scene.add(new THREE.Mesh(curbGeo, curbMat));
    }

    // ── Start/finish: checkered strip across the road + a simple gantry ──
    const si = Math.min(Math.max(model.startIndex || 0, 0), nR - 1);
    const sj = closed ? (si + 2) % nR : Math.min(si + 2, nR - 1);
    const COLS = 10;
    const sfPos = [], sfCol = [], sfIdx = [];
    for (const [ri, i] of [[0, si], [1, sj]]) {
      for (let cIdx = 0; cIdx <= COLS; cIdx++) {
        const u = cIdx / COLS;
        const off = rows[i].wl - u * (rows[i].wl + rows[i].wr);
        const p = atOffset(i, off, 0.03);
        sfPos.push(p.x, p.y, p.z);
        const dark = (cIdx + ri) % 2 ? 0.08 : 0.95;
        sfCol.push(dark, dark, dark);
      }
    }
    for (let cIdx = 0; cIdx < COLS; cIdx++) {
      const a = cIdx, b = cIdx + 1, d = COLS + 1 + cIdx, e = COLS + 1 + cIdx + 1;
      sfIdx.push(a, b, d, b, e, d);
    }
    const sfGeo = track(new THREE.BufferGeometry());
    sfGeo.setAttribute("position", new THREE.BufferAttribute(Float32Array.from(sfPos), 3));
    sfGeo.setAttribute("color", new THREE.BufferAttribute(Float32Array.from(sfCol), 3));
    sfGeo.setIndex(sfIdx);
    sfGeo.computeVertexNormals();
    const sfMat = track(new THREE.MeshBasicMaterial({
      vertexColors: true, side: THREE.DoubleSide,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    }));
    scene.add(new THREE.Mesh(sfGeo, sfMat));
    // Gantry: two posts + beam over the line.
    const gantryMat = track(new THREE.MeshStandardMaterial({ color: 0x10141b, roughness: 0.7 }));
    const postGeo = track(new THREE.BoxGeometry(0.25, 5, 0.25));
    const pL = atOffset(si, rows[si].wl + 1.2), pR = atOffset(si, -(rows[si].wr + 1.2));
    for (const p of [pL, pR]) {
      const post = new THREE.Mesh(postGeo, gantryMat);
      post.position.set(p.x, p.y + 2.5, p.z);
      scene.add(post);
    }
    const beamLen = pL.distanceTo(pR);
    const beam = new THREE.Mesh(track(new THREE.BoxGeometry(0.35, 0.6, 0.35)), gantryMat);
    beam.scale.z = beamLen / 0.35;
    beam.position.set((pL.x + pR.x) / 2, (pL.y + pR.y) / 2 + 4.8, (pL.z + pR.z) / 2);
    beam.lookAt(pR.x, beam.position.y, pR.z);
    scene.add(beam);
  }

  // ── A large dark ground plane under the lowest point for depth ──
  const minY = Math.min(0, ...built.flatMap(l => l.vpts.map(v => v.y)), ...rows.map(r => r.y));
  const groundGeo = track(new THREE.PlaneGeometry(8000, 8000));
  const groundMat = track(new THREE.MeshStandardMaterial({ color: 0x0e131c, roughness: 1 }));
  const ground = new THREE.Mesh(groundGeo, groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = minY - 6;
  scene.add(ground);

  // ── Racing lines painted on the road surface + the cars ──
  // A thin ribbon hugging the road surface (curb hops included), swept along
  // densely-sampled spline points — reads as a painted line, not a 3D tube.
  const lineRibbon = (bl) => {
    const smooth = bl.curve.getPoints(Math.min(2000, Math.max(bl.vpts.length * 4, 64)));
    for (const p of smooth) p.y = onSurface(p.x, p.y, p.z, 0.05);
    return sweepRibbon(smooth, 0.12);
  };
  const cars = [];
  const lineMeshes = new Map(); // id → painted-ribbon mesh, for in-place refresh
  for (const l of built) {
    const lineMat = track(new THREE.MeshBasicMaterial({
      color: new THREE.Color(l.color), side: THREE.DoubleSide,
      polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3,
    }));
    // Geometry is NOT in `disposables`: updateLines() disposes replaced ribbons
    // itself, and dispose()'s scene traversal covers whichever one is current.
    const mesh = new THREE.Mesh(lineRibbon(l), lineMat);
    scene.add(mesh);
    lineMeshes.set(l.id, mesh);

    const car = makeF1Car(l.color);
    scene.add(car);
    cars.push({ line: l, car });
  }

  // ── Camera state ──
  let camMode = opts.camMode && CAM_MODES.includes(opts.camMode) ? opts.camMode : "chase";
  let zoom = 1;            // distance multiplier from +/- buttons & wheel
  let orbitYaw = 0;        // drag-added yaw offset (radians)
  let orbitPitch = 0;      // drag-added pitch offset
  const camPos = new THREE.Vector3();
  const camTarget = new THREE.Vector3();
  let camInit = false;

  // Latest playback pushed from React.
  let playFrac = 0, playAxis = "dist";

  function desiredCamera(targetCar) {
    const { pos, heading } = targetCar;
    // Base chase offset behind the car's heading.
    const baseDist = 24 * zoom;
    const baseHeight = 9 * zoom;
    let yaw = heading + Math.PI + orbitYaw; // behind the car
    let pitch = orbitPitch;
    let dist = baseDist, height = baseHeight;
    if (camMode === "broadcast") { yaw = heading + Math.PI * 0.5 + orbitYaw; height = 7 * zoom; dist = 30 * zoom; }
    else if (camMode === "top")  { height = 70 * zoom; dist = 1; pitch = -1.2; }
    const dir = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw));
    const want = pos.clone().addScaledVector(dir, dist);
    want.y = pos.y + height + pitch * 20;
    return { want, look: pos.clone() };
  }

  // Render one frame; returns false once the chase camera has eased to its target so the
  // scheduler can go idle (no perpetual rAF → page can settle, GPU rests when paused).
  function render() {
    let lead = null;
    for (const c2 of cars) {
      const s = sampleLine(c2.line, playFrac, playAxis);
      s.pos.y = onSurface(s.pos.x, s.pos.y, s.pos.z, 0);
      c2.car.position.copy(s.pos);
      c2.car.rotation.y = s.heading;
      if (c2.line.id === "comp" || !lead) lead = s; // chase the comparison car
    }
    let settled = true;
    if (lead) {
      const { want, look } = desiredCamera(lead);
      if (!camInit) { camPos.copy(want); camTarget.copy(look); camInit = true; }
      camPos.lerp(want, 0.12);
      camTarget.lerp(look, 0.18);
      camera.position.copy(camPos);
      camera.lookAt(camTarget);
      settled = camPos.distanceToSquared(want) < 1e-3 && camTarget.distanceToSquared(look) < 1e-3;
    }
    renderer.render(scene, camera);
    return settled;
  }

  // On-demand scheduler: render only while there's motion (playback, drag, camera ease,
  // resize). invalidate() asks for a frame; the frame re-requests itself until the
  // camera settles or a drag is active, then stops.
  let raf = 0, scheduled = false;
  function frame() {
    scheduled = false;
    const settled = render();
    if (!settled || dragging) requestFrame();
  }
  function requestFrame() {
    if (scheduled) return;
    scheduled = true;
    raf = requestAnimationFrame(frame);
  }

  // ── Pointer orbit + wheel zoom on the canvas ──
  let dragging = false, lastX = 0, lastY = 0;
  const onDown = (e) => { dragging = true; lastX = e.clientX; lastY = e.clientY; canvas.setPointerCapture?.(e.pointerId); requestFrame(); };
  const onMove = (e) => {
    if (!dragging) return;
    orbitYaw += (e.clientX - lastX) * 0.005;
    orbitPitch = Math.max(-1.2, Math.min(1.2, orbitPitch - (e.clientY - lastY) * 0.004));
    lastX = e.clientX; lastY = e.clientY;
    requestFrame();
  };
  const onUp = (e) => { dragging = false; canvas.releasePointerCapture?.(e.pointerId); requestFrame(); };
  const onWheel = (e) => { e.preventDefault(); zoom = Math.max(0.35, Math.min(4, zoom * (e.deltaY > 0 ? 1.1 : 0.9))); requestFrame(); };
  canvas.addEventListener("pointerdown", onDown);
  canvas.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  canvas.addEventListener("wheel", onWheel, { passive: false });

  function resize() {
    const w = canvas.clientWidth || 1, h = canvas.clientHeight || 1;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    requestFrame();
  }
  resize();
  requestFrame();

  return {
    setPlayback(frac, axis) { playFrac = frac; playAxis = axis === "time" ? "time" : "dist"; requestFrame(); },
    zoomBy(f) { zoom = Math.max(0.35, Math.min(4, zoom * f)); requestFrame(); },
    setCamMode(m) { if (CAM_MODES.includes(m)) camMode = m; requestFrame(); },
    cycleCamMode() { camMode = CAM_MODES[(CAM_MODES.indexOf(camMode) + 1) % CAM_MODES.length]; requestFrame(); return camMode; },
    // In-place refresh for a live lap growing new samples: same line ids, new
    // points. Swaps each painted ribbon's geometry and re-splines the car paths;
    // road, renderer and camera survive untouched. Returns false when the line
    // set itself changed — the caller must rebuild the scene instead.
    updateLines(newLines) {
      if (newLines.length !== lineMeshes.size ||
          newLines.some(l => !lineMeshes.has(l.id) || !l.pts?.length)) return false;
      for (const l of newLines) {
        const bl = buildLine(l);
        const mesh = lineMeshes.get(l.id);
        mesh.geometry.dispose();
        mesh.geometry = lineRibbon(bl);
        const rec = cars.find(c2 => c2.line.id === l.id);
        if (rec) rec.line = bl;
      }
      requestFrame();
      return true;
    },
    resetView() { orbitYaw = 0; orbitPitch = 0; zoom = 1; camInit = false; requestFrame(); },
    resize,
    dispose() {
      cancelAnimationFrame(raf);
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("wheel", onWheel);
      for (const d of disposables) d.dispose?.();
      scene.traverse(o => { o.geometry?.dispose?.(); if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => m.dispose?.()); });
      renderer.dispose();
    },
  };
}
