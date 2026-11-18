import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveZonesFromTrace, classifySample } from "../src/lib/coach/zones.js";
import { demoLap } from "./helpers.mjs";

// ── A5: nothing derivable → no zones (it used to invent nine and speak them) ──
test("a reference with nothing usable yields no zones at all", () => {
  assert.deepEqual(deriveZonesFromTrace(null), []);
  assert.deepEqual(deriveZonesFromTrace({ samples: [] }), []);
  assert.deepEqual(deriveZonesFromTrace({ samples: [{ dist: 0, throttle: 100 }] }), []);
  // Flat out all lap: nothing to call.
  const flat = Array.from({ length: 200 }, (_, i) => ({ dist: i * 10, throttle: 100, brake: 0, ersMode: 0 }));
  assert.deepEqual(deriveZonesFromTrace({ samples: flat }), []);
});

test("a synthetic braking zone is found where the pedal goes down", () => {
  const samples = Array.from({ length: 300 }, (_, i) => {
    const d = i * 10;
    const braking = d >= 1500 && d < 1620;
    return { dist: d, throttle: braking ? 0 : 100, brake: braking ? 90 : 0, ersMode: 0 };
  });
  const zones = deriveZonesFromTrace({ samples });
  const brake = zones.filter((z) => z.type === "brake");
  assert.equal(brake.length, 1);
  const startM = brake[0].start * 2990;
  assert.ok(Math.abs(startM - 1500) <= 10, `brake zone opens at ${startM.toFixed(0)} m`);
  assert.equal(brake[0].name, "Brake 1");
});

test("the recorded demo lap yields named, track-ordered zones", () => {
  const zones = deriveZonesFromTrace(demoLap(3));
  assert.ok(zones.length > 10, `${zones.length} zones`);
  for (let i = 1; i < zones.length; i++) assert.ok(zones[i].start >= zones[i - 1].start);
  assert.ok(zones.some((z) => z.type === "brake"));
});

test("classifySample priority: brake > coast > ERS > lift", () => {
  assert.equal(classifySample({ throttle: 0, brake: 50, ersMode: 3 }).type, "brake");
  assert.equal(classifySample({ throttle: 0, brake: 0 }).type, "lico");
  assert.equal(classifySample({ throttle: 100, brake: 0, ersMode: 2 }).type, "ers");
  assert.equal(classifySample({ throttle: 60, brake: 0, ersMode: 0 }).type, "lift");
  assert.equal(classifySample({ throttle: 0 }, false).type, "brake", "no brake channel → coast reads as braking");
});
