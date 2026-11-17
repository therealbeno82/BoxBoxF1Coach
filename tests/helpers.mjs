// Shared fixtures for the tests. The demo replay (src-tauri/demo/session.json) is
// a real recorded race at Singapore, so it doubles as honest lap data: every lap in
// it was actually driven, with the game's own lap time, sectors and 10 m bins.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const repo = path.resolve(here, "..");

let demo = null;
export function demoSession() {
  if (!demo) demo = JSON.parse(fs.readFileSync(path.join(repo, "src-tauri/demo/session.json"), "utf8"));
  return demo;
}

// One demo lap in the recorder's own stored-lap shape.
export function demoLap(i = 3) {
  const s = demoSession();
  const l = s.laps[i];
  return {
    id: `demo-${i}`,
    lapNumber: l.lapNumber,
    lapTime: l.lapTime,
    invalid: !!l.invalid,
    sectorTimes: l.sectorTimes,
    tyre: l.tyre,
    meta: {
      driver: "Tester", track: s.track, trackId: s.trackId, trackLengthM: s.trackLength,
      sessionType: "Race", weather: l.weather, trackTemp: l.trackTemp, airTemp: l.airTemp,
    },
    samples: l.samples.map((p) => ({
      dist: p.d, t: p.t, throttle: p.th, brake: p.br, steer: p.st, speed: p.sp, gear: p.g,
      ersMode: p.em, ersSpent: p.ek, x: p.x, y: p.y, z: p.z,
    })),
  };
}
