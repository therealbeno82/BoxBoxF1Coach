// ─── CAR MODEL ────────────────────────────────────────────────────────────────
// public/tcam-car.glb — the one car asset, and the only place it is loaded. Two
// views draw a car now (the T-cam's onboard pass and the orbit map), and each
// fetching, parsing and rigging its own copy of the same 450 kB of glTF would be
// pure duplication: the template is loaded ONCE per session and cloned per car.
//
// WHY AN ASSET AND NOT PROCEDURAL GEOMETRY. Cars are TINTED per lap — white for the
// reference, the panel's accent for the comparison — and a model with its livery
// baked into a texture can only ever be one car. This model has no textures at all:
// fourteen flat materials, of which `Body` is its own. So the bodywork takes the lap
// colour while tyres stay black and rims stay metal. See scripts/render-tcam-ego.py
// for how it's baked.
//
// FRAME. The app's world is already y-up with x/z on the ground, which is three's
// convention too, so world coordinates pass through untouched.
//
// OWNERSHIP. Clones share the template's GEOMETRY and clone only their materials, so
// an instance's dispose() frees materials and NEVER geometry — that belongs to the
// template, which outlives any one view. A renderer being torn down doesn't take the
// next view's car with it.
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

const MODEL_URL = "/tcam-car.glb";
const BODY_MATERIAL = "Body";     // the one material that carries the lap colour
const TYRE_MATERIAL = "Tyres";    // how the wheel nodes are found, below
const WHEEL_PIVOT = "wheelPivot";

export const WHEEL_RADIUS = 0.335;   // m — the model's tyre measures 0.67 m across

// The model is exported nose-along +Z — Blender's −Y, which the glTF exporter's
// Z-up→Y-up conversion maps to +Z. The world's heading ψ points along
// (cos ψ, sin ψ) in x/z, and a yaw of θ about +Y sends +Z to (sin θ, cos θ), so
// matching the two gives sin θ = cos ψ, cos θ = sin ψ — i.e. θ = π/2 − ψ.
export const modelYaw = (yaw) => Math.PI / 2 - yaw;

// ── Wheel rig ─────────────────────────────────────────────────────────────────
// The model carries its wheels as two nodes, each a Geometry-Nodes-generated PAIR
// spanning the full track width. That's convenient rather than awkward: both wheels
// of a pair share one axle line, so a single rotation about the axle's X axis spins
// the pair correctly.
//
// Their node origins are not on that axle though, so each gets wrapped in a pivot
// placed at the node's own bounding-box centre. Done once on the template, before
// any clone is taken, so every car inherits the rig.
const _box = new THREE.Box3();
const _c = new THREE.Vector3();
function rigWheels(root) {
  const nodes = new Set();
  root.traverse((o) => {
    if (o.isMesh && o.material?.name === TYRE_MATERIAL && o.parent) nodes.add(o.parent);
  });
  for (const node of nodes) {
    const parent = node.parent;
    if (!parent) continue;
    _box.setFromObject(node).getCenter(_c);
    const pivot = new THREE.Group();
    pivot.name = WHEEL_PIVOT;
    pivot.position.copy(_c);
    parent.add(pivot);
    pivot.add(node);
    node.position.sub(_c);
  }
}

// Resolves to the rigged template, or to NULL if the model can't be loaded — every
// caller has a no-model fallback (the T-cam's flat decal, the orbit view's marker),
// so this never rejects and never throws into a render loop. Cached: the second
// caller gets the same promise, so the file is fetched and parsed once.
let templatePromise = null;
export function loadCarTemplate() {
  if (!templatePromise) {
    templatePromise = new Promise((resolve) => {
      new GLTFLoader().load(
        MODEL_URL,
        (gltf) => { rigWheels(gltf.scene); resolve(gltf.scene); },
        undefined,
        () => resolve(null),
      );
    });
  }
  return templatePromise;
}

// ── One car ───────────────────────────────────────────────────────────────────
// A clone of the template with its own materials, so colour and opacity are per-car.
//
// `transparent` is part of three's PROGRAM state — flipping it mid-run costs a shader
// recompile — so it is decided once, here, from whether this car will ever need to
// blend. `opacity` is a plain uniform and can be rewritten every frame for free.
//
// `depthWrite` is the caller's call because the two views want opposite things from
// it. The T-cam's ghost keeps it ON: the model occludes its own far side and reads as
// a shell rather than an x-ray of its own suspension. The orbit view turns it OFF, on
// purpose — there the whole point is that two cars on the same piece of road stay
// visible through each other.
export function instanceCar(template, { color, opacity = 1, depthWrite = true } = {}) {
  const root = template.clone(true);
  const blends = opacity < 1 || !depthWrite;
  const mats = [];
  root.traverse((o) => {
    if (!o.isMesh || !o.material) return;
    const src = Array.isArray(o.material) ? o.material : [o.material];
    o.material = Array.isArray(o.material) ? src.map((m) => m.clone()) : src[0].clone();
    for (const m of (Array.isArray(o.material) ? o.material : [o.material])) {
      if (color && m.name === BODY_MATERIAL) m.color.set(color);
      if (blends) { m.transparent = true; m.opacity = opacity; m.depthWrite = depthWrite; }
      mats.push(m);
    }
  });
  const wheels = [];
  root.traverse((o) => { if (o.name === WHEEL_PIVOT) wheels.push(o); });

  return {
    root, mats,
    setOpacity(o) { for (const m of mats) m.opacity = o; },
    // `p` is { x, y, z, yaw } in world units, yaw in radians. `dist` is lap distance
    // in metres: the wheels roll off GROUND DISTANCE, never an integrated speed, so
    // scrubbing or pausing stays correct because nothing is accumulated.
    place(p, dist) {
      root.position.set(p.x, p.y, p.z);
      root.rotation.set(0, modelYaw(p.yaw), 0);
      if (typeof dist === "number") {
        const a = dist / WHEEL_RADIUS;
        for (const w of wheels) w.rotation.x = a;
      }
    },
    dispose() { for (const m of mats) m.dispose?.(); },  // geometry belongs to the template
  };
}
