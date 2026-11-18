import { test } from "node:test";
import assert from "node:assert/strict";
import { lapClockAxis, timeAtDist, recordedTimeAxis } from "../src/lib/timeAxis.js";
import { demoLap } from "./helpers.mjs";

test("a recorded lap's clock axis is the game's own clock", () => {
  const lap = demoLap(3);
  const axis = lapClockAxis(lap);
  const last = lap.samples.length - 1;
  assert.ok(Math.abs(axis[last] - lap.samples[last].t) < 1e-9);
  assert.ok(Math.abs(axis[last] - lap.lapTime) < 0.5, `ends ${axis[last]} vs lap ${lap.lapTime}`);
  for (let i = 1; i < axis.length; i++) assert.ok(axis[i] >= axis[i - 1], "non-decreasing");
});

test("a lap without the clock is rescaled to end on its real lap time", () => {
  const lap = demoLap(3);
  lap.samples = lap.samples.map(({ t, ...rest }) => rest);   // an older recording
  assert.equal(recordedTimeAxis(lap.samples), null);
  const axis = lapClockAxis(lap);
  assert.ok(Math.abs(axis[axis.length - 1] - lap.lapTime) < 1e-6);
});

test("timeAtDist interpolates, and refuses ground the lap never covered", () => {
  const lap = demoLap(3);
  const axis = lapClockAxis(lap);
  const mid = lap.samples[100];
  assert.ok(Math.abs(timeAtDist(lap.samples, axis, mid.dist) - axis[100]) < 1e-9);
  const between = (lap.samples[100].dist + lap.samples[101].dist) / 2;
  const t = timeAtDist(lap.samples, axis, between);
  assert.ok(t > axis[100] && t < axis[101]);
  assert.equal(timeAtDist(lap.samples, axis, -500), null);
  assert.equal(timeAtDist(lap.samples, axis, 1e6), null);
});

test("the live delta of a lap against itself is zero all the way round", () => {
  const lap = demoLap(4);
  const axis = lapClockAxis(lap);
  for (let i = 0; i < lap.samples.length; i += 37) {
    const s = lap.samples[i];
    assert.ok(Math.abs(s.t - timeAtDist(lap.samples, axis, s.dist)) < 1e-9);
  }
});
