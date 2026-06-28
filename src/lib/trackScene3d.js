// ─── 3D TRACK SCENE (Compare → Driving Lines tab) ─────────────────────────────
// A self-contained Three.js scene that renders two laps' captured racing lines as a
// road ribbon with two 3D cars driving along them, viewed by a chase camera you can
// orbit/zoom. Built imperatively (no react-three-fiber) so it owns its own render loop
// and stays decoupled from React's 60 fps state churn: React only pushes the current
// playback fraction via setPlayback(); this module's rAF does the drawing.
//
// createTrackScene(canvas, lines, opts) → controller
//   lines: [{ id, color(hex int|css), pts:[{x,y?,z}], distAt:[0..1], timeAt:[0..1] }]
//   controller: { setPlayback(frac, axis), zoomBy(f), setCamMode(m), frame(),
//                 resize(), dispose() }
import * as THREE from "three";

const UP = new THREE.Vector3(0, 1, 0);
const CAM_MODES = ["chase", "broadcast", "top"];

// Sample a car's world position + heading along a line at fraction `frac`, using the same
// dist/time addressing curves the 2D timeline uses so the 3D cars stay in lock-step with
// the scrubber. `axis` is "dist" (position-sync) or "time" (pace-sync). The path itself is
// a Catmull-Rom spline (line.curve) rather than the raw chords, so motion and heading stay
// smooth through corners instead of snapping segment-to-segment.
function sampleLine(line, frac, axis) {
  const addr = axis === "time" ? line.timeAt : line.distAt;
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

// World position of a built line (vpts + distAt) at lap-distance fraction `f`. Used to
// average the drawn lines into a neutral road spine so neither car sits glued to the
// road centreline. Mirrors sampleLine's distAt addressing but only needs a position.
function linePosAtFrac(line, f) {
  const addr = line.distAt, P = line.vpts, n = P.length;
  let i = 1;
  while (i < n && addr[i] < f) i++;
  i = Math.min(i, n - 1);
  const lo = addr[i - 1], hi = addr[i];
  const t = Math.max(0, Math.min(1, hi > lo ? (f - lo) / (hi - lo) : 0));
  return P[i - 1].clone().lerp(P[i], t);
}

// An open-wheel F1-style car from primitives, facing +Z (front is +Z). ~5.0 m long.
function makeCar(color) {
  const g = new THREE.Group();
  const paint = new THREE.MeshStandardMaterial({ color, metalness: 0.35, roughness: 0.4 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x0c0f13, metalness: 0.2, roughness: 0.6 });
  const helmetMat = new THREE.MeshStandardMaterial({ color: 0xe8edf5, metalness: 0.1, roughness: 0.35 });

  // Slim central monocoque tub
  const tub = new THREE.Mesh(new THREE.BoxGeometry(0.78, 0.42, 3.4), paint);
  tub.position.y = 0.5;
  g.add(tub);

  // Tapered nose reaching forward to the front wing
  const nose = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.1, 1.5, 4), paint);
  nose.rotation.x = Math.PI / 2;   // lay the pyramid along Z
  nose.rotation.y = Math.PI / 4;   // square it up
  nose.position.set(0, 0.42, 2.2);
  g.add(nose);

  // Engine cover / airbox tapering behind the cockpit
  const airbox = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.4, 1.7, 4), paint);
  airbox.rotation.x = -Math.PI / 2;
  airbox.rotation.y = Math.PI / 4;
  airbox.position.set(0, 0.78, -1.0);
  g.add(airbox);

  // Open cockpit: driver helmet poking up, plus a thin halo hoop
  const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.27, 16, 12), helmetMat);
  helmet.position.set(0, 0.95, 0.15);
  g.add(helmet);
  const halo = new THREE.Mesh(new THREE.TorusGeometry(0.34, 0.04, 8, 16, Math.PI), dark);
  halo.rotation.x = Math.PI / 2;
  halo.position.set(0, 0.92, 0.35);
  g.add(halo);

  // Front wing: wide, low, near the nose tip
  const frontWing = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.06, 0.55), dark);
  frontWing.position.set(0, 0.16, 2.55);
  g.add(frontWing);

  // Rear wing: tall plane on a pylon at the back
  const rearWing = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.4, 0.1), dark);
  rearWing.position.set(0, 0.95, -2.0);
  g.add(rearWing);
  const pylon = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.5, 0.3), dark);
  pylon.position.set(0, 0.7, -1.9);
  g.add(pylon);

  // Exposed wheels sitting outside the narrow body
  const wheelGeo = new THREE.CylinderGeometry(0.38, 0.38, 0.42, 16);
  for (const [wx, wz] of [[-0.95, 1.5], [0.95, 1.5], [-0.95, -1.5], [0.95, -1.5]]) {
    const w = new THREE.Mesh(wheelGeo, dark);
    w.rotation.z = Math.PI / 2; // roll about X (axle along X)
    w.position.set(wx, 0.38, wz);
    g.add(w);
  }
  return g;
}

// Build a road ribbon (BufferGeometry) by sweeping a constant half-width along a spine
// of Vector3 points, with a horizontal normal so the surface follows elevation.
function buildRoadGeometry(spine, halfWidth) {
  const N = spine.length;
  const pos = new Float32Array(N * 2 * 3);
  const n = new THREE.Vector3();
  const t = new THREE.Vector3();
  for (let i = 0; i < N; i++) {
    const prev = spine[Math.max(0, i - 1)];
    const next = spine[Math.min(N - 1, i + 1)];
    t.copy(next).sub(prev); t.y = 0; t.normalize();
    n.crossVectors(UP, t).normalize(); // horizontal perpendicular
    const p = spine[i];
    const L = p.clone().addScaledVector(n, halfWidth);
    const R = p.clone().addScaledVector(n, -halfWidth);
    pos.set([L.x, L.y, L.z], i * 6);
    pos.set([R.x, R.y, R.z], i * 6 + 3);
  }
  const idx = [];
  for (let i = 0; i < N - 1; i++) {
    const a = i * 2, b = i * 2 + 1, c = i * 2 + 2, d = i * 2 + 3;
    idx.push(a, b, c, b, d, c);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

export function createTrackScene(canvas, lines, opts = {}) {
  const CLEAR = 0x141a26;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setClearColor(CLEAR, 1);

  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(CLEAR, 120, 900);

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
  // Build centered Vector3 lists (drop raw Y when absent → flat plane).
  const built = lines.map(l => ({
    ...l,
    vpts: l.pts.map(p => new THREE.Vector3(p.x - c.x, hasY ? (p.y || 0) - c.y : 0, p.z - c.z)),
  }));

  const disposables = [];
  const track = (obj) => { disposables.push(obj); return obj; };

  // ── Road surface from a NEUTRAL spine ──────────────────────────────────────
  // With one line, the road IS that line. With two, building the road from either
  // racing line would pin that line's car to the road centreline (it looked like
  // the car "stayed in the middle" and ignored track data) — and which line won was
  // just whichever had more samples. Instead sweep the per-fraction MIDLINE of all
  // drawn lines, so every car visibly weaves off-centre on its own line.
  const spineVpts = built.length < 2
    ? built[0].vpts
    : (() => {
        const M = 240;
        const out = [];
        for (let k = 0; k <= M; k++) {
          const f = k / M;
          const v = new THREE.Vector3();
          for (const l of built) v.add(linePosAtFrac(l, f));
          out.push(v.multiplyScalar(1 / built.length));
        }
        return out;
      })();
  const roadGeo = track(buildRoadGeometry(spineVpts, 8));
  const roadMat = track(new THREE.MeshStandardMaterial({
    color: 0x2b313d, roughness: 0.95, metalness: 0.0, side: THREE.DoubleSide,
  }));
  const road = new THREE.Mesh(roadGeo, roadMat);
  road.position.y = -0.05;
  scene.add(road);

  // ── A large dark ground plane under the lowest point for depth ──
  const minY = Math.min(...built.flatMap(l => l.vpts.map(v => v.y)));
  const groundGeo = track(new THREE.PlaneGeometry(6000, 6000));
  const groundMat = track(new THREE.MeshStandardMaterial({ color: 0x0e131c, roughness: 1 }));
  const ground = new THREE.Mesh(groundGeo, groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = minY - 6;
  scene.add(ground);

  // ── Flat 2D racing lines (thin ribbons painted on the track) + cars ──
  const cars = [];
  for (const l of built) {
    const col = new THREE.Color(l.color);
    // Smooth spline through the captured points; the car and the painted line both follow
    // it, so corners stay clean and the car never drifts off its own line. Centripetal
    // parameterization avoids overshoot/cusps when sample spacing is uneven.
    l.curve = new THREE.CatmullRomCurve3(l.vpts, false, "centripetal");
    // A thin horizontal ribbon hugging the surface, swept along densely-sampled spline
    // points — reads as a flat painted line, not a 3D tube. Half-width 0.1 → ~0.2 m wide.
    const smooth = l.curve.getPoints(Math.min(2000, Math.max(l.vpts.length * 4, 64)));
    const lineGeo = track(buildRoadGeometry(smooth, 0.1));
    const lineMat = track(new THREE.MeshBasicMaterial({
      color: col, side: THREE.DoubleSide,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    }));
    const lineMesh = new THREE.Mesh(lineGeo, lineMat);
    lineMesh.position.y = 0.03; // lift just above the road to avoid z-fighting
    scene.add(lineMesh);

    const car = makeCar(l.color);
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
