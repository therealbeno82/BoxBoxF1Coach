// ─── Measure circuit lengths from the committed geometry ──────────────────────
// Prints the TRACK_LENGTH_M table for src/lib/leaderboard/limits.js, summed from
// the centerline chords in public/tracks/<slug>.json. Run it after re-generating
// the track geometry (scripts/fetch-tracks.mjs):
//
//   node scripts/measure-track-lengths.mjs
//
// The chord sum sits within a fraction of a percent of the real circuit length
// (Monaco measures 3328 m against the calendar's 3337 m), which is why the
// validator's declared-length window is ±10% — far wider than that gap, and
// still tight enough to reject a fabricated short trace.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = fileURLToPath(new URL("../public/tracks/", import.meta.url));
const slugs = readdirSync(dir)
  .filter((f) => f.endsWith(".json") && f !== "index.json")
  .map((f) => f.slice(0, -5))
  .sort();

const lines = [];
for (const slug of slugs) {
  const track = JSON.parse(readFileSync(join(dir, `${slug}.json`), "utf8"));
  const pts = track.points || [];
  let m = 0;
  for (let i = 1; i < pts.length; i++) {
    m += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  }
  if (track.closed && pts.length > 1) {
    const a = pts[pts.length - 1], b = pts[0];
    m += Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  lines.push({ slug, m: Math.round(m) });
}

const pad = Math.max(...lines.map((l) => l.slug.length)) + 2;
for (const { slug, m } of lines) {
  console.log(`  ${`${slug}:`.padEnd(pad)} ${m},`);
}
