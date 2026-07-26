// ─── MEASURE CORNER APEXES FROM THE SHIPPED CENTERLINES ────────────────────────
// One-time dev script (NOT wired into predev/prebuild — the output is committed).
// Reads public/tracks/<slug>.json, finds each circuit's apexes from the centerline's
// own curvature, and writes them back into the same file as `apexes`.
//
//   node scripts/fit-corners.mjs             # every covered circuit
//   node scripts/fit-corners.mjs singapore   # just one
//
// WHY THIS EXISTS: corner positions used to be hand-estimated lap fractions in
// src/lib/cornerData.js, and there was nothing to check them against — so they
// silently drifted. Singapore's put T1 805 m down a 550 m pit straight; Monaco's
// put the Grand Hotel hairpin ~340 m late. Measuring them off the geometry we
// already ship makes them reproducible and reviewable (see scripts/README note
// below on rendering a check image).
//
// FRAME: `apexes` are fractions of the centerline's own arc length from point 0,
// in FILE order. That is deliberately NOT a lap fraction:
//   • Point 0 is wherever the upstream GeoJSON way happened to start — the
//     start/finish line at Monza, but ~845 m past it at Monaco.
//   • File order is not always the racing direction — Singapore's way is traced
//     backwards (its polyline winds clockwise; Marina Bay races anti-clockwise).
// Both unknowns are already solved per-lap by src/lib/trackGeometry.js, which
// aligns this centerline to a recorded lap and knows `reverse` + `startIndex`.
// Corner NUMBERING is therefore applied at runtime, from the real start/finish —
// this file only says where the corners physically are.
//
// The corner COUNT comes from the official numbering curated in
// src/lib/cornerData.js, so a circuit whose apexes are ambiguous still gets
// exactly as many corners as the FIA numbers.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = resolve(root, "public/tracks");

const { CORNERS_BY_TRACK } = await import(
  pathToFileURL(resolve(root, "src/lib/cornerData.js")).href
);

const TURN_FLOOR = 0.005;   // rad/point of smoothed heading change — below this the road is straight
const MERGE_M    = 70;      // same-direction apexes closer than this are ONE corner, split by a brief straightening
const SMOOTH_HW  = 3;       // half-window (points) for heading smoothing; spacing is 2.5 m, so ~17 m
const FORCED_M   = 60;      // a forced apex suppresses detected candidates within this range
const EXCLUDE_M  = 25;      // ...exclusions name an exact apex, so they reach far less far:
                            // at 60 m Monaco's entry also swallowed Mirabeau, 53 m away

// ── Corners the geometry can't be asked to find ────────────────────────────────
// Official numbering and road curvature don't always agree, and no threshold
// reconciles them: Monza's Curva Grande is one numbered corner that reads as ~19
// separate 3-7 deg fragments (a long constant-radius sweep sitting on the
// detection floor), while Singapore's T18/T19 are TWO numbered corners that read
// as one continuous bend. Loosening the merge to catch the first breaks the
// second, so tracks where they genuinely disagree get an explicit entry here
// instead of a global threshold tuned until 25 circuits happen to line up.
//
// Values are apex positions in the same frame as `apexes` — fractions of the
// centerline's arc length from point 0, in FILE order. Forced apexes are always
// kept and suppress detected candidates within FORCED_M.
const FORCED_APEXES = {
  // T3 Curva Grande: ~98 deg spread over 648 m, so every fragment is too gentle
  // to survive the cut and the corner vanishes, shifting T3..T11 by one.
  italy: [0.1937],

  // Suzuka is the clearest case of both failure modes at once, and they cancelled
  // in pairs — the corner COUNT came out right while four labels sat wrong:
  //   T6  one 109 deg Esse split in two (its halves are 80 m apart, just over the
  //       merge threshold), which put T6 and T7 on the same corner
  //   T10 the right kink between Degner 2 and the hairpin: only 34 deg and cheaply
  //       outranked, so it went unlabelled
  //   T14 Spoon is one continuous 200 deg left that split into THREE apexes where
  //       Suzuka numbers two
  //   T15 130R is a long fast sweeper, dropped the same way Curva Grande was
  // Forcing an apex also suppresses detected ones within FORCED_M, so the two
  // Esse halves and the surplus Spoon apex are absorbed rather than excluded.
  //
  // NOTE on T7: the last Esse and Dunlop Curve are ONE continuous 160 deg left
  // here (0.252-0.330, never straightening), so there is no second apex to find in
  // it. Forcing one only put two labels on the same bend. T7 sits on it once and
  // Dunlop isn't separately numbered — which matches how the game labels it.
  japan: [0.2291, 0.4402, 0.6482, 0.8254],
};

// The mirror image: road features strong enough to win a slot that AREN'T numbered
// corners. One of these displaces a real corner and shifts every number after it.
const EXCLUDED_APEXES = {
  // A 19 deg blip between Mirabeau Haute and the Grand Hotel Hairpin. Nothing is
  // numbered there, and it pushed the 190 deg hairpin from T6 to T7.
  monaco: [0.090],
};

// Arc length along the closed centerline.
function arcLengths(P) {
  const n = P.length;
  const cum = [0];
  for (let i = 1; i < n; i++) cum.push(cum[i - 1] + Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]));
  const total = cum[n - 1] + Math.hypot(P[0][0] - P[n - 1][0], P[0][1] - P[n - 1][1]);
  return { cum, total };
}

// Smoothed per-point heading change (rad). Positive = left in the data's
// x=east / y=north frame; only the SIGN's consistency matters here.
function heading(P) {
  const n = P.length;
  const raw = new Array(n);
  for (let i = 0; i < n; i++) {
    const a = P[(i - 1 + n) % n], b = P[i], c = P[(i + 1) % n];
    let v = Math.atan2(c[1] - b[1], c[0] - b[0]) - Math.atan2(b[1] - a[1], b[0] - a[0]);
    while (v > Math.PI) v -= 2 * Math.PI;
    while (v < -Math.PI) v += 2 * Math.PI;
    raw[i] = v;
  }
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let j = -SMOOTH_HW; j <= SMOOTH_HW; j++) s += raw[(i + j + n) % n];
    out[i] = s / (SMOOTH_HW * 2 + 1);
  }
  return out;
}

// Contiguous same-sign runs of turning → one candidate corner each, scored by
// total angle turned. Apex = the run's curvature-weighted centre.
function candidates(P, s, cum, total) {
  const n = P.length;
  const turning = s.map((v) => Math.abs(v) > TURN_FLOOR);
  // Start scanning from the straightest point so no run wraps the array end.
  let q = 0;
  for (let k = 0; k < n; k++) if (Math.abs(s[k]) < Math.abs(s[q])) q = k;
  const at = (k) => (k + q) % n;

  const out = [];
  let i = 0;
  while (i < n) {
    if (!turning[at(i)]) { i++; continue; }
    const sign = Math.sign(s[at(i)]);
    let j = i, sum = 0, weighted = 0;
    while (j < n && turning[at(j)] && Math.sign(s[at(j)]) === sign) {
      const w = Math.abs(s[at(j)]);
      sum += w; weighted += w * j; j++;
    }
    const idx = at(Math.round(weighted / sum));
    out.push({
      f: cum[idx] / total, deg: (sum * 180) / Math.PI, dir: sign,
      // Where the turning STARTS and ENDS, so merging can inspect the road in
      // between rather than guess from how far apart the apexes are (mergeSplit).
      fromIdx: at(i), toIdx: at(j - 1),
    });
    i = j;
  }
  return out.sort((a, b) => a.f - b.f);
}

// One corner routinely registers as several runs: a long constant-radius sweeper
// sits near the turning floor, so surface noise dips it below again and again.
// Monza's Curva Grande fragments into 19 runs of 3-7 deg over 648 m, and losing it
// drops a real corner and lets a kink take its place — which shifts every later
// corner NUMBER.
//
// Deliberately conservative — it only rejoins fragments whose APEXES are within
// MERGE_M. Widening it to also catch long sweepers merges genuinely separate
// corners elsewhere (Singapore's T18/T19), so sweepers are handled by
// FORCED_APEXES instead.
function mergeSplit(cands, total) {
  const out = [];
  for (const c of cands) {
    const prev = out[out.length - 1];
    if (prev && prev.dir === c.dir && (c.f - prev.f) * total < MERGE_M) {
      const deg = prev.deg + c.deg;
      prev.f = (prev.f * prev.deg + c.f * c.deg) / deg;   // angle-weighted apex
      prev.deg = deg;
    } else out.push({ ...c });
  }
  return out;
}

const only = process.argv[2] || null;
const slugs = Object.keys(CORNERS_BY_TRACK).filter((s) => !only || s === only);
if (only && !slugs.length) {
  console.error(`[fit-corners] unknown track "${only}"`);
  process.exit(1);
}

let written = 0;
for (const slug of slugs) {
  const file = resolve(outDir, `${slug}.json`);
  let data;
  try { data = JSON.parse(readFileSync(file, "utf8")); }
  catch { console.warn(`[fit-corners] ${slug}: no geometry — skipped`); continue; }

  const want = CORNERS_BY_TRACK[slug].length;
  const { cum, total } = arcLengths(data.points);
  const s = heading(data.points);
  let cs = mergeSplit(candidates(data.points, s, cum, total), total);

  const apart = (a, b) => Math.min(Math.abs(a - b), 1 - Math.abs(a - b)) * total;

  // Drop road features that aren't numbered corners before anything competes for a slot.
  const excluded = EXCLUDED_APEXES[slug] || [];
  if (excluded.length) cs = cs.filter((c) => excluded.every((x) => apart(c.f, x) > EXCLUDE_M));

  // Corners the detector can't see get pinned and claim their slots; any candidate
  // that's really the same corner is dropped so it can't take a second.
  const forced = (FORCED_APEXES[slug] || []).map((f) => ({ f, deg: Infinity, forced: true }));
  if (forced.length) {
    cs = cs.filter((c) => forced.every((k) => apart(c.f, k.f) > FORCED_M)).concat(forced);
  }

  // Keep the `want` most significant corners, then restore file order. A circuit
  // with fewer detectable apexes than official corners is reported, not padded —
  // numbering would drift, so it needs a look before being trusted.
  const found = cs.length;
  if (found > want) cs = cs.sort((a, b) => b.deg - a.deg).slice(0, want);
  cs.sort((a, b) => a.f - b.f);

  data.apexes = cs.map((c) => +c.f.toFixed(4));
  writeFileSync(file, JSON.stringify(data));
  written++;

  const flag = cs.length === want ? "" : `  ** ${cs.length}/${want} — CHECK`;
  console.log(
    `[fit-corners] ${slug.padEnd(12)} ${String(cs.length).padStart(2)} apexes ` +
    `(official ${String(want).padStart(2)}, ${found} candidates, ${Math.round(total)} m)${flag}`
  );
}
console.log(`[fit-corners] wrote apexes for ${written} circuit(s)`);
