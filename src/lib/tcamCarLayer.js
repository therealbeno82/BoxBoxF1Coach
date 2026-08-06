// ─── T-CAM CAR LAYER ──────────────────────────────────────────────────────────
// The one part of the onboard view that is real 3D: the other car.
//
// WHY A SECOND RENDERER AT ALL. Everything else in the T-cam sits on a single
// surface, so tcamScene can paint it with a fixed layer order and no occlusion to
// resolve (see drawTCamFrame). A car is the exception — it has volume, it turns
// independently of the camera, and a flat decal on the tarmac can only ever say
// "here", never "at this angle, this far, this shape". So the car — and nothing
// else — gets a WebGL pass.
//
// WHY OFFSCREEN AND BLITTED, NOT STACKED. The obvious build is a transparent canvas
// over the 2D one, and it renders the car in the WRONG PLACE in the layer order:
// on top of the distance fog and the ego cockpit, so a car 200 m away punches
// through the haze and out through your own halo. This canvas is never in the DOM.
// TrackCamView blits it into the 2D context exactly where paintOtherCar used to
// draw — after the ribbons, before the fog — and the layering stays correct by
// construction.
//
// WHY AN ASSET AND NOT PROCEDURAL GEOMETRY. This used to build a car out of three.js
// primitives, because the ghost is TINTED per lap — white for the reference, the
// panel's accent for the comparison — and a model with its livery baked into a
// texture can only ever be one car. public/tcam-car.glb has no textures at all: it's
// fourteen flat materials, of which `Body` is its own. So the bodywork takes the lap
// colour while tyres stay black and rims stay metal, which is better separation than
// the procedural car ever had. See scripts/render-tcam-ego.py for how it's baked.
//
// FRAME. The app's world is already y-up with x/z on the ground, which is three's
// convention too, so world coordinates pass through untouched. All the mapping work
// is in the camera, below.
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

const MODEL_URL = "/tcam-car.glb";
const BODY_MATERIAL = "Body";   // the one material that carries the lap colour

// Depth range for the GL pass. NEAR has to be tiny because the EGO car surrounds the
// camera — its halo crown passes about 0.2 m in front of the eye — so anything like
// tcamProjection's own 1.0 m plane would slice the hoop off. FAR still clears
// AHEAD_M (250) for the ghost. That's a 13,000:1 range, which is what the
// logarithmic depth buffer below is for: without it the far car z-fights itself.
const NEAR = 0.03;
const FAR = 400;

const WHEEL_RADIUS = 0.335;   // m — the model's tyre measures 0.67 m across
const TYRE_MATERIAL = "Tyres";

// The ghost is never fully solid. It isn't a car that's there — it's where someone
// else's lap had got to — and at 0.86 the tarmac reads faintly through it without
// the model losing its shape or its lap colour. It's also what makes the proximity
// fade (resolveOtherCar's `alpha`, multiplied in below) look like more of the same
// thing rather than a separate effect switching on: the car is already translucent,
// so closing on it just makes it more so until it's gone.
const GHOST_ALPHA = 0.86;

// ─── Camera sync ──────────────────────────────────────────────────────────────
// Rebuild tcamProjection's pinhole as a three PerspectiveCamera. This is an exact
// re-expression of the same camera, not an approximation, and scripts/check-tcam-
// camera.mjs asserts that against project() to sub-pixel agreement.
//
// The basis falls straight out of the projection's own algebra. For an offset
// d = P − cam, that file computes:
//
//   lat = d·(−fz, 0,  fx)        → the driver's right   R
//   yc  = d·(fx·sp, cp, fz·sp)   → camera up            U
//   zc  = d·(fx·cp, −sp, fz·cp)  → view direction       F
//
// Those three are orthonormal (each is unit; every pairwise dot cancels), and
// R × U = −F, so (R, U, −F) is a proper right-handed basis — which is exactly
// three's camera convention, where local +X is right, +Y is up and +Z is BACKWARD
// because the camera looks down its own −Z.
//
// The projection matches on the same terms. tcamProjection maps
//   sx = w/2 + focal·lat/zc,  sy = h/2 − focal·yc/zc
// and a symmetric three frustum with aspect = w/h puts BOTH axes on the single
// focal (h/2)/tan(fov/2). So one inversion ties them together:
//
//   fov = 2·atan(h / (2·focal))
//
// Note it's the PANE's w/h, not the canvas's — each pane carries its own camera.
const _r = new THREE.Vector3();
const _u = new THREE.Vector3();
const _b = new THREE.Vector3();
const _m = new THREE.Matrix4();
const RAD2DEG = 180 / Math.PI;

export function syncThreeCamera(c3, cam) {
  c3.position.set(cam.x, cam.y, cam.z);
  _r.set(-cam.fz, 0, cam.fx);
  _u.set(cam.fx * cam.sp, cam.cp, cam.fz * cam.sp);
  _b.set(-cam.fx * cam.cp, cam.sp, -cam.fz * cam.cp);
  c3.quaternion.setFromRotationMatrix(_m.makeBasis(_r, _u, _b));
  c3.fov = 2 * Math.atan(cam.h / (2 * cam.focal)) * RAD2DEG;
  c3.aspect = cam.w / cam.h;
  c3.near = NEAR;
  c3.far = FAR;
  c3.updateProjectionMatrix();
  c3.updateMatrixWorld(true);
  return c3;
}

// The model is exported nose-along +Z — Blender's −Y, which the glTF exporter's
// Z-up→Y-up conversion maps to +Z. The world's heading ψ points along
// (cos ψ, sin ψ) in x/z, and a yaw of θ about +Y sends +Z to (sin θ, cos θ), so
// matching the two gives sin θ = cos ψ, cos θ = sin ψ — i.e. θ = π/2 − ψ.
export const modelYaw = (yaw) => Math.PI / 2 - yaw;

// ─── Layer ────────────────────────────────────────────────────────────────────
// Returns null when WebGL is unavailable — a machine with a blocked or exhausted
// GL context still gets the panel, just with tcamScene's flat decal. Nothing here
// is allowed to throw into the render loop.
//
// `onReady` fires once the model has loaded, so the caller can repaint: the loop is
// self-terminating and may well have settled by then. Until it fires, render()
// reports false and the decal stands in — which is also the permanent state if the
// model fails to load at all.
export function createCarLayer(onReady) {
  let canvas, renderer;
  try {
    canvas = document.createElement("canvas");
    renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: true,
      // The blit reads this canvas back with drawImage. That happens inside the
      // same rAF callback as the render, where the drawing buffer is still intact
      // either way — but a preserved buffer takes the question off the table, and
      // at one pane-sized canvas the cost is not measurable.
      preserveDrawingBuffer: true,
      // See NEAR/FAR: the ego car sits centimetres from the eye while the ghost can
      // be 250 m up the road, and a normal depth buffer cannot hold both.
      logarithmicDepthBuffer: true,
    });
  } catch {
    return null;
  }
  if (!renderer) return null;

  renderer.setClearColor(0x000000, 0);
  renderer.autoClear = false; // panes share one framebuffer; clear once, below

  const scene = new THREE.Scene();
  // Lighting carried over from the old track scene, which had to make the same dark
  // palette read: a cool sky/ground hemisphere for shape, one sun for a highlight
  // that separates the bodywork from the tarmac, and a little fill so the shadowed
  // side doesn't go to pure black against a near-black road.
  scene.add(new THREE.HemisphereLight(0xaecbff, 0x202028, 0.9));
  const sun = new THREE.DirectionalLight(0xffffff, 1.1);
  sun.position.set(0.4, 1, 0.25);
  scene.add(sun);
  scene.add(new THREE.AmbientLight(0xffffff, 0.25));

  const cam3 = new THREE.PerspectiveCamera(60, 1, NEAR, FAR);

  let alive = true;
  let disposed = false;
  let template = null;

  new GLTFLoader().load(
    MODEL_URL,
    (gltf) => {
      if (disposed) return;
      template = gltf.scene;
      rigWheels(template);
      onReady?.();
    },
    undefined,
    () => { /* no model — tcamScene's decal is the fallback, permanently */ },
  );

  // ── Wheel rig ───────────────────────────────────────────────────────────────
  // The model carries its wheels as two nodes, each a Geometry-Nodes-generated PAIR
  // spanning the full track width. That's convenient rather than awkward: both
  // wheels of a pair share one axle line, so a single rotation about the axle's X
  // axis spins the pair correctly.
  //
  // Their node origins are not on that axle though, so each gets wrapped in a pivot
  // placed at the node's own bounding-box centre. Done once on the template, before
  // any clone is taken, so every car inherits the rig.
  const _box = new THREE.Box3();
  const _c = new THREE.Vector3();
  const rigWheels = (root) => {
    const nodes = new Set();
    root.traverse((o) => {
      if (o.isMesh && o.material?.name === TYRE_MATERIAL && o.parent) nodes.add(o.parent);
    });
    for (const node of nodes) {
      const parent = node.parent;
      if (!parent) continue;
      _box.setFromObject(node).getCenter(_c);
      const pivot = new THREE.Group();
      pivot.name = "wheelPivot";
      pivot.position.copy(_c);
      parent.add(pivot);
      pivot.add(node);
      node.position.sub(_c);
    }
  };

  // One car per ROLE and colour. Role matters because the ego and the ghost are on
  // screen at the same time in different colours, and keying on colour alone would
  // hand both the same object.
  //
  // The ghost's materials are marked transparent HERE, once, rather than whenever its
  // opacity first drops below 1: `transparent` is part of three's program state and
  // flipping it mid-run costs a shader recompile, whereas `opacity` is a plain uniform
  // that can be rewritten every frame for free. They keep depthWrite on, so the model
  // still occludes its own far side and reads as a shell rather than an x-ray of its
  // own suspension. Being in the transparent queue also puts the ghost after the
  // opaque ego in one pass, which is exactly the order the blend needs.
  const cars = new Map();
  const carFor = (role, color) => {
    const key = `${role}:${color}`;
    let entry = cars.get(key);
    if (!entry) {
      const fades = role === "ghost";
      const root = template.clone(true);
      const mats = [];
      root.traverse((o) => {
        if (!o.isMesh || !o.material) return;
        const src = Array.isArray(o.material) ? o.material : [o.material];
        o.material = Array.isArray(o.material) ? src.map((m) => m.clone()) : src[0].clone();
        for (const m of (Array.isArray(o.material) ? o.material : [o.material])) {
          if (m.name === BODY_MATERIAL) m.color.set(color);
          if (fades) { m.transparent = true; m.opacity = GHOST_ALPHA; }
          mats.push(m);
        }
      });
      const wheels = [];
      root.traverse((o) => { if (o.name === "wheelPivot") wheels.push(o); });
      root.visible = false;
      scene.add(root);
      entry = { root, wheels, mats, fades };
      cars.set(key, entry);
    }
    return entry;
  };

  const place = (entry, p, dist) => {
    entry.root.visible = true;
    entry.root.position.set(p.x, p.y, p.z);
    entry.root.rotation.set(0, modelYaw(p.yaw), 0);
    if (entry.fades) {
      const o = GHOST_ALPHA * (p.alpha ?? 1);
      for (const m of entry.mats) m.opacity = o;
    }
    if (typeof dist === "number") {
      // Roll angle straight off ground distance — no speed channel needed, and it
      // stays correct through a scrub or a pause because it isn't integrated.
      const a = dist / WHEEL_RADIUS;
      for (const w of entry.wheels) w.rotation.x = a;
    }
  };

  let size = { w: 0, h: 0, dpr: 1 };
  const onLost = (e) => { e.preventDefault(); alive = false; };
  canvas.addEventListener("webglcontextlost", onLost);

  return {
    canvas,
    get alive() { return alive; },
    get ready() { return !!template; },

    resize(w, h, dpr) {
      if (!alive) return;
      if (size.w === w && size.h === h && size.dpr === dpr) return;
      size = { w, h, dpr };
      renderer.setPixelRatio(dpr);
      renderer.setSize(w, h, false); // false: this canvas has no CSS box to update
    },

    // `items` is one entry per pane: { cam, car, ego, dist, rect }. `car` is the
    // ghost's resolved placement { x, y, z, yaw, color, alpha } or null, where alpha
    // is resolveOtherCar's proximity fade; `ego` is the driver's own car in the same
    // shape, minus the fade — you are never far from yourself. `dist` is lap distance
    // in metres, which rolls the wheels. `rect` is the pane's box in CSS px from the TOP.
    //
    // Both cars go in ONE pass so the depth buffer sorts them: an ego wheel really
    // does occlude a ghost further up the road, and two passes would have to fake it.
    render(items) {
      if (!alive || !template || !size.w || !size.h) return false;
      try {
        renderer.setScissorTest(false);
        renderer.clear(true, true, false);
        for (const it of items) {
          if (!it?.cam || (!it.car && !it.ego)) continue;
          for (const c of cars.values()) c.root.visible = false;
          if (it.ego) place(carFor("ego", it.ego.color), it.ego, it.dist);
          if (it.car) place(carFor("ghost", it.car.color), it.car, it.dist);
          syncThreeCamera(cam3, it.cam);
          // GL's viewport origin is bottom-left while panes are laid out from the
          // top, so the y flips here — and only here.
          const gy = size.h - (it.rect.y + it.rect.h);
          renderer.setViewport(it.rect.x, gy, it.rect.w, it.rect.h);
          renderer.setScissor(it.rect.x, gy, it.rect.w, it.rect.h);
          renderer.setScissorTest(true);
          renderer.render(scene, cam3);
        }
        return true;
      } catch {
        // A GL fault must not take the panel down with it — drop to the 2D decal.
        alive = false;
        return false;
      }
    },

    dispose() {
      alive = false;
      disposed = true;
      canvas.removeEventListener("webglcontextlost", onLost);
      scene.traverse((o) => {
        o.geometry?.dispose?.();
        if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => m.dispose?.());
      });
      cars.clear();
      template = null;
      renderer.dispose();
    },
  };
}
