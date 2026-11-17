import { test } from "node:test";
import assert from "node:assert/strict";
import { formatLapTime, speakable } from "../src/lib/format.js";
import { compareVersions } from "../src/lib/updateCheck.js";

test("formatLapTime rounds before splitting (119.98 s is 2:00.0, not 1:60.0)", () => {
  assert.equal(formatLapTime(119.98), "2:00.0");
  assert.equal(formatLapTime(59.9996, 3), "1:00.000");
  assert.equal(formatLapTime(93.371, 3), "1:33.371");
  assert.equal(formatLapTime(5.2, 3), "0:05.200");
});

test("formatLapTime keeps the sign on a negative time and never prints -0", () => {
  assert.equal(formatLapTime(-1.5, 1), "-0:01.5");
  assert.equal(formatLapTime(-0.004, 2), "0:00.00");
  assert.equal(formatLapTime(null), "—");
  assert.equal(formatLapTime(NaN), "—");
});

test("speakable expands glued and spaced units for TTS", () => {
  assert.equal(speakable("280km/h at the apex"), "280 kilometres per hour at the apex");
  assert.equal(speakable("brake 150m earlier"), "brake 150 metres earlier");
  assert.equal(speakable("90°C fronts, 12% wear"), "90 degrees fronts, 12 percent wear");
  assert.equal(speakable("you vs the ref"), "you versus the ref");
});

test("compareVersions orders dotted versions and ignores a leading v", () => {
  assert.equal(compareVersions("4.1.0", "4.0.9"), 1);
  assert.equal(compareVersions("v4.1", "4.1.0"), 0);
  assert.equal(compareVersions("4.1.0", "4.10.0"), -1);
});
