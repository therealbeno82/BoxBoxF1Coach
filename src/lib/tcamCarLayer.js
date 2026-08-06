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
// primitives, because the ghost is TINTED per lap. The model, its rig and the tinting
// rules now live in lib/carModel.js, shared with the orbit map — all the mapping work
// left here is in the camera, below.
import * as THREE from "three";
import { loadCarTemplate, instanceCar } from "./carModel.js";

// Depth range for the GL pass. NEAR has to be tiny because the EGO car surrounds the
// camera — its halo crown passes about 0.2 m in front of the eye — so anything like
// tcamProjection's own 1.0 m plane would slice the hoop off. FAR still clears
// AHEAD_M (250) for the ghost. That's a 13,000:1 range, which is what the
// logarithmic depth buffer below is for: without it the far car z-fights itself.
const NEAR = 0.03;
const FAR = 400;

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

  loadCarTemplate().then((t) => {
    // A null template means the model wouldn't load — tcamScene's decal is then the
    // fallback, permanently.
    if (disposed || !t) return;
    template = t;
    onReady?.();
  });

  // One car per ROLE and colour. Role matters because the ego and the ghost are on
  // screen at the same time in different colours, and keying on colour alone would
  // hand both the same object.
  //
  // The ghost blends and the ego doesn't. The ghost keeps depthWrite ON, so the model
  // still occludes its own far side and reads as a shell rather than an x-ray of its
  // own suspension; being in the transparent queue also puts it after the opaque ego
  // in one pass, which is exactly the order the blend needs.
  const cars = new Map();
  const carFor = (role, color) => {
    const key = `${role}:${color}`;
    let entry = cars.get(key);
    if (!entry) {
      const fades = role === "ghost";
      const car = instanceCar(template, { color, opacity: fades ? GHOST_ALPHA : 1 });
      car.root.visible = false;
      scene.add(car.root);
      entry = { car, fades };
      cars.set(key, entry);
    }
    return entry;
  };

  const place = (entry, p, dist) => {
    entry.car.root.visible = true;
    entry.car.place(p, dist);
    if (entry.fades) entry.car.setOpacity(GHOST_ALPHA * (p.alpha ?? 1));
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
          for (const c of cars.values()) c.car.root.visible = false;
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

    // Materials are this layer's, geometry is the shared template's — see carModel.
    // Disposing the geometry here would pull it out from under the orbit map's cars.
    dispose() {
      alive = false;
      disposed = true;
      canvas.removeEventListener("webglcontextlost", onLost);
      for (const c of cars.values()) c.car.dispose();
      cars.clear();
      template = null;
      renderer.dispose();
    },
  };
}
