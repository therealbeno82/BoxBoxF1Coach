// Asserts that tcamCarLayer's three.js camera is the SAME camera as
// tcamProjection's pinhole — not a lookalike. The T-cam composites a WebGL car into
// a 2D-painted road, so any disagreement between the two shows up directly as a car
// sitting off its own racing line, which is very hard to eyeball and trivial to
// measure. Pure math: three needs no WebGL for Vector3/Matrix4/PerspectiveCamera,
// so this runs in plain node.
//
//   node scripts/check-tcam-camera.mjs
import * as THREE from "three";
import { makeCamera, project } from "../src/lib/tcamProjection.js";
import { syncThreeCamera, modelYaw } from "../src/lib/tcamCarLayer.js";

const DEG = Math.PI / 180;
let checked = 0, worst = 0, worstAt = null;

// Deterministic sampler so a failure is reproducible.
let seed = 12345;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

const c3 = new THREE.PerspectiveCamera();
const v = new THREE.Vector3();

// Pane shapes that actually occur: a full-width T-Cam pane and a squat Compare pane.
for (const [w, h] of [[900, 520], [900, 260], [420, 300], [1600, 900]]) {
  for (const yawDeg of [0, 37, 90, 143, 180, -95, -179.4]) {
    for (const pitchDeg of [0, 8, 18]) {
      const cam = makeCamera({
        x: 120.5, y: 3.25, z: -48.75, yaw: yawDeg * DEG, w, h, pitchDeg,
      });
      syncThreeCamera(c3, cam);
      for (let k = 0; k < 400; k++) {
        // Sample around the camera in a box big enough to cover the drawn window.
        const p = [
          cam.x + (rnd() - 0.5) * 500,
          cam.y + (rnd() - 0.5) * 40,
          cam.z + (rnd() - 0.5) * 500,
        ];
        const a = project(cam, p[0], p[1], p[2]);
        if (!(a.zc >= 1)) continue; // in front of the near plane only
        v.set(p[0], p[1], p[2]).project(c3);
        const bx = (0.5 + v.x * 0.5) * w;
        const by = (0.5 - v.y * 0.5) * h;
        const err = Math.hypot(a.sx - bx, a.sy - by);
        checked++;
        if (err > worst) { worst = err; worstAt = { w, h, yawDeg, pitchDeg, p, a, b: { bx, by } }; }
      }
    }
  }
}

// ── the model's own yaw mapping: +Z forward must end up along (cos ψ, sin ψ) ──
let yawWorst = 0;
for (let d = -180; d <= 180; d += 7.5) {
  const psi = d * DEG;
  const q = new THREE.Object3D();
  q.rotation.set(0, modelYaw(psi), 0);
  q.updateMatrixWorld(true);
  const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(q.quaternion);
  yawWorst = Math.max(yawWorst, Math.hypot(fwd.x - Math.cos(psi), fwd.z - Math.sin(psi), fwd.y));
}

console.log(`projection : ${checked} points, worst disagreement ${worst.toExponential(3)} px`);
console.log(`model yaw  : worst forward-vector error ${yawWorst.toExponential(3)}`);
if (worst > 1e-3 || yawWorst > 1e-9) {
  console.error("\nFAIL — the three camera is not the projection's camera.");
  if (worstAt) console.error(JSON.stringify(worstAt, null, 2));
  process.exit(1);
}
console.log("\nOK — three camera matches tcamProjection to sub-pixel, model yaw exact.");
