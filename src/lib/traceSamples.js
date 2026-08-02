// ─── TRACE SAMPLES ────────────────────────────────────────────────────────────
// Telemetry has physical limits a hand-traced, hand-edited or older export can
// violate: a gear is always a whole number, throttle/brake are 0-100%, steer is
// ±100%. Clamp and round every channel so a stray 5.5 gear or -1 throttle never
// reaches the coaching logic or the readouts. (-1 gear = reverse and 0 = neutral
// stay legal, matching the live telemetry's gear range.)
//
// Lives in its own module because three callers need exactly this behaviour and
// must not drift: loading a trace file, receiving one off the leaderboard, and
// the server-side validator that checks a submission. The third is the reason it
// left BoxBoxApp — the Edge Function imports it directly, so what the server
// validates is the same shape the app will later read.

import { clamp } from "./format.js";

export function sanitizeTraceSamples(samples) {
  if (!Array.isArray(samples)) return samples;
  return samples.map((s) => {
    if (!s || typeof s !== "object") return s;
    const out = { ...s };
    if (typeof out.throttle === "number") out.throttle = clamp(out.throttle, 0, 100);
    if (typeof out.brake    === "number") out.brake    = clamp(out.brake, 0, 100);
    if (typeof out.steer    === "number") out.steer    = clamp(out.steer, -100, 100);
    if (typeof out.gear     === "number") out.gear     = clamp(Math.round(out.gear), -1, 8);
    return out;
  });
}
