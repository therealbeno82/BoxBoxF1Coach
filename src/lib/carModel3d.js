// ─── PROCEDURAL F1 CAR (Driving Lines 3D scene) ────────────────────────────────
// A modern-generation open-wheel car built entirely from three.js primitives — no
// asset files (the packaged app's CSP forbids external fetches, and a bundled glTF
// would need tint surgery per lap colour anyway). Smoothness comes from a beveled
// plan-view extrusion for the chassis, capsules for sidepods/engine cover, and
// 24-segment wheels — replacing the old box-and-pyramid look.
//
//   makeF1Car(color) → THREE.Group   (+Z forward, ~5.1 m long, ~1.9 m wide)
//
// Everything is created per car (no module-level sharing): the scene's dispose()
// traverses and disposes every geometry/material it finds, so shared caches would
// be destroyed by the first scene teardown and poison later rebuilds.
import * as THREE from "three";

function makeMats() {
  return {
    carbon: new THREE.MeshStandardMaterial({ color: 0x14171c, metalness: 0.3, roughness: 0.55 }),
    tyre:   new THREE.MeshStandardMaterial({ color: 0x131313, metalness: 0.05, roughness: 0.9 }),
    rim:    new THREE.MeshStandardMaterial({ color: 0x9aa1ad, metalness: 0.85, roughness: 0.35 }),
    helmet: new THREE.MeshStandardMaterial({ color: 0xe8edf5, metalness: 0.15, roughness: 0.3 }),
    visor:  new THREE.MeshStandardMaterial({ color: 0x1a2330, metalness: 0.6, roughness: 0.2 }),
  };
}

// Thin structural rod between two points (suspension arms, wing pylons).
function rod(from, to, r, mat) {
  const dir = new THREE.Vector3().subVectors(to, from);
  const len = dir.length();
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, 6), mat);
  m.position.copy(from).addScaledVector(dir, 0.5);
  m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
  return m;
}

// ── chassis plan-view outline, extruded + beveled → one smooth painted body ─────
// Drawn in shape space: x = car width, y = car length with NOSE at −y (after the
// −90° X rotation, shape −y maps to world +Z = forward). Quadratic curves keep the
// silhouette flowing: slim nose → cockpit shoulders → coke-bottle waist → gearbox.
function bodyGeometry() {
  const s = new THREE.Shape();
  s.moveTo(0, -2.55);                                   // nose tip
  s.quadraticCurveTo(0.14, -2.45, 0.17, -1.95);         // slender nose cone
  s.quadraticCurveTo(0.22, -1.35, 0.44, -0.85);         // widening to the tub
  s.quadraticCurveTo(0.50, -0.35, 0.48, 0.15);          // cockpit shoulders
  s.quadraticCurveTo(0.46, 0.75, 0.33, 1.15);           // coke-bottle waist
  s.quadraticCurveTo(0.28, 1.5, 0.30, 1.75);            // gearbox / crash structure
  s.lineTo(0, 1.8);
  // mirror (x < 0), traced back to the nose
  s.lineTo(-0.30, 1.75);
  s.quadraticCurveTo(-0.28, 1.5, -0.33, 1.15);
  s.quadraticCurveTo(-0.46, 0.75, -0.48, 0.15);
  s.quadraticCurveTo(-0.50, -0.35, -0.44, -0.85);
  s.quadraticCurveTo(-0.22, -1.35, -0.17, -1.95);
  s.quadraticCurveTo(-0.14, -2.45, 0, -2.55);
  return new THREE.ExtrudeGeometry(s, {
    depth: 0.24, bevelEnabled: true, bevelThickness: 0.09, bevelSize: 0.055,
    bevelSegments: 3, curveSegments: 10,
  });
}

export function makeF1Car(color) {
  const g = new THREE.Group();
  const MAT = makeMats();
  const paint = new THREE.MeshStandardMaterial({ color, metalness: 0.5, roughness: 0.32 });
  const paintDark = new THREE.MeshStandardMaterial({
    color: new THREE.Color(color).multiplyScalar(0.55), metalness: 0.45, roughness: 0.4,
  });

  // Chassis: plan-view extrusion lying flat; shape −y → world +Z (nose forward).
  const body = new THREE.Mesh(bodyGeometry(), paint);
  body.rotation.x = -Math.PI / 2;
  body.position.y = 0.26; // extrusion (0..0.24 + bevels) sits above the floor
  g.add(body);

  // Floor + rear diffuser kick — gives the car its full width between the wheels.
  const floor = new THREE.Mesh(new THREE.BoxGeometry(1.38, 0.045, 3.1), MAT.carbon);
  floor.position.set(0, 0.11, -0.05);
  g.add(floor);
  const diffuser = new THREE.Mesh(new THREE.BoxGeometry(1.05, 0.045, 0.6), MAT.carbon);
  diffuser.position.set(0, 0.2, -1.85);
  diffuser.rotation.x = 0.28;
  g.add(diffuser);

  // Sidepods: squashed capsules hugging the tub, slightly undercut.
  for (const sx of [-1, 1]) {
    const pod = new THREE.Mesh(new THREE.CapsuleGeometry(0.3, 1.05, 6, 12), paintDark);
    pod.scale.set(1, 0.6, 1);
    pod.rotation.x = Math.PI / 2;
    pod.rotation.z = sx * 0.06; // subtle inward lean
    pod.position.set(sx * 0.55, 0.4, -0.25);
    g.add(pod);
  }

  // Engine cover: slim capsule ridge from the cockpit back, plus a shark fin.
  const cover = new THREE.Mesh(new THREE.CapsuleGeometry(0.21, 1.5, 6, 12), paint);
  cover.scale.set(0.72, 1, 1);
  cover.rotation.x = Math.PI / 2;
  cover.position.set(0, 0.68, -0.75);
  g.add(cover);
  const fin = new THREE.Mesh(new THREE.BoxGeometry(0.024, 0.3, 0.85), paint);
  fin.position.set(0, 0.88, -1.35);
  fin.rotation.x = -0.1;
  g.add(fin);
  const tcam = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.09, 0.22), MAT.carbon);
  tcam.position.set(0, 0.97, 0.02);
  g.add(tcam);

  // Cockpit: helmet + visor behind the halo.
  const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.24, 18, 14), MAT.helmet);
  helmet.position.set(0, 0.72, 0.28);
  g.add(helmet);
  const visor = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.09, 0.05), MAT.visor);
  visor.position.set(0, 0.74, 0.5);
  g.add(visor);
  // Halo: half-torus hoop + the forward centre pylon.
  const halo = new THREE.Mesh(new THREE.TorusGeometry(0.36, 0.038, 8, 20, Math.PI), MAT.carbon);
  halo.rotation.x = Math.PI / 2;
  halo.position.set(0, 0.82, 0.42);
  g.add(halo);
  g.add(rod(new THREE.Vector3(0, 0.5, 0.82), new THREE.Vector3(0, 0.82, 0.48), 0.032, MAT.carbon));

  // Mirrors.
  for (const sx of [-1, 1]) {
    const mir = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.07, 0.04), MAT.carbon);
    mir.position.set(sx * 0.52, 0.66, 0.62);
    g.add(mir);
  }

  // Front wing: two stacked elements with a rotated flap + swept endplates, hung
  // below the nose on a short pylon.
  const wingMain = new THREE.Mesh(new THREE.BoxGeometry(1.86, 0.035, 0.44), MAT.carbon);
  wingMain.position.set(0, 0.11, 2.42);
  wingMain.rotation.x = 0.06;
  g.add(wingMain);
  const wingFlap = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.03, 0.3), paint);
  wingFlap.position.set(0, 0.2, 2.28);
  wingFlap.rotation.x = -0.3;
  g.add(wingFlap);
  for (const sx of [-1, 1]) {
    const ep = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.24, 0.62), paintDark);
    ep.position.set(sx * 0.95, 0.18, 2.38);
    ep.rotation.y = sx * -0.12;
    g.add(ep);
  }
  const nosePylon = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.16, 0.5), paint);
  nosePylon.position.set(0, 0.2, 2.35);
  g.add(nosePylon);

  // Rear wing: main plane + upper flap between endplates on twin swan-neck pylons,
  // plus a low beam wing over the diffuser.
  const rwMain = new THREE.Mesh(new THREE.BoxGeometry(1.02, 0.045, 0.36), MAT.carbon);
  rwMain.position.set(0, 0.92, -2.05);
  rwMain.rotation.x = 0.42;
  g.add(rwMain);
  const rwFlap = new THREE.Mesh(new THREE.BoxGeometry(1.02, 0.035, 0.26), paint);
  rwFlap.position.set(0, 1.06, -2.18);
  rwFlap.rotation.x = 0.62;
  g.add(rwFlap);
  for (const sx of [-1, 1]) {
    const ep = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.42, 0.58), paintDark);
    ep.position.set(sx * 0.53, 0.92, -2.1);
    g.add(ep);
  }
  g.add(rod(new THREE.Vector3(0.16, 0.62, -1.72), new THREE.Vector3(0.16, 1.02, -2.1), 0.026, MAT.carbon));
  g.add(rod(new THREE.Vector3(-0.16, 0.62, -1.72), new THREE.Vector3(-0.16, 1.02, -2.1), 0.026, MAT.carbon));
  const beam = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.03, 0.18), MAT.carbon);
  beam.position.set(0, 0.52, -2.12);
  beam.rotation.x = 0.5;
  g.add(beam);

  // Wheels: 24-segment tyres with metallic hub discs; fronts narrower than rears
  // (current regs), each corner tied to the tub with wishbone rods.
  const mkWheel = (r, w) => {
    const wheel = new THREE.Group();
    const tyre = new THREE.Mesh(new THREE.CylinderGeometry(r, r, w, 24), MAT.tyre);
    tyre.rotation.z = Math.PI / 2;
    wheel.add(tyre);
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.55, r * 0.55, w + 0.02, 18), MAT.rim);
    hub.rotation.z = Math.PI / 2;
    wheel.add(hub);
    return wheel;
  };
  for (const [sx, z, front] of [[-1, 1.62, true], [1, 1.62, true], [-1, -1.5, false], [1, -1.5, false]]) {
    const r = front ? 0.33 : 0.345, w = front ? 0.3 : 0.39;
    const wheel = mkWheel(r, w);
    wheel.position.set(sx * 0.83, r, z);
    g.add(wheel);
    // Upper + lower wishbones from tub to hub.
    const hubP = new THREE.Vector3(sx * 0.68, r, z);
    g.add(rod(new THREE.Vector3(sx * 0.3, r + 0.12, z - (front ? -0.25 : 0.25)), hubP, 0.016, MAT.carbon));
    g.add(rod(new THREE.Vector3(sx * 0.3, r - 0.14, z), new THREE.Vector3(sx * 0.68, r - 0.05, z), 0.016, MAT.carbon));
  }

  return g;
}
