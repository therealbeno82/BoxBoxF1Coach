// ─── TRACK GEOMETRY (Driving Lines tab) ────────────────────────────────────────
// Turns a recorded racing line into a drivable *track model* for the driving-lines view:
//
//   loadTrackModel(slug, lines) → Promise<model | null>
//     Fetches the bundled real-circuit centerline + widths (public/tracks/<slug>.json,
//     built by scripts/fetch-tracks.mjs) and rigidly aligns it into the game's world
//     frame so the recorded lines sit on the real road — apexes, curbs and all. The
//     recorded lines are NEVER modified; only the track is transformed. Falls back to
//     buildHeuristicTrack() when the circuit isn't covered, the fetch fails, or the
//     fit is poor (e.g. the game's layout differs from the dataset's vintage).
//
//   buildHeuristicTrack(lines) → model
//     No real data: estimate a road around the driven line using racing-line geometry —
//     offset the road centre toward the corner OUTSIDE by smoothed signed curvature, so
//     the line touches the inside edge at apexes instead of floating mid-road.
//
// model = {
//   status: "real" | "fallback",
//   centerline: [{ x, y, z, wl, wr, k }],  // world frame; wl/wr = width (m) left/right
//                                          // of travel; k = signed curvature (1/m)
//   closed: boolean,                       // does the loop wrap?
//   startIndex: number,                    // row nearest the lap's start/finish point
//   rmse: number|null,                     // fit quality (real only)
//   attribution: string|null,              // dataset credit (real only)
//   seated: number,                        // m — peak lateral correction applied to
//                                          // seat the road under the car (real only)
// }
//
// Row height (`y`) is DRAPED FROM THE LAPS, not read from public/tracks/*.json —
// the shipped geometry is 2D. The top-down plan view ignores it; the T-cam rides
// it. Laps recorded before the recorder captured height drape flat (y = 0), which
// is harmless in both views. Use elevAtRowFrac() to sample between rows.
//
// Pure math — no rendering dependency, so this stays cheap to import.
// (The one exception is the corner-anchor cache: a real fit is the only place the
// start/finish line and traversal direction are recoverable, so loadTrackModel
// records them for src/lib/cornerAnchors.js.)
import { setAnchor } from "./cornerAnchors.js";

const FIT_N = 512;          // resample count for the alignment solve
const RMSE_ACCEPT = 12;     // meters — reject fits worse than this (line legitimately
                            // sits up to ~half a track-width off the centerline)
const HEUR_HALF_W = 6.5;    // heuristic road half-width (m)
const KAPPA_SAT = 1 / 50;   // curvature (1/m) treated as a "full" corner
const EDGE_MARGIN = 1.0;    // meters added to each real-track edge: the driven line is the
                            // car CENTER and the ~1.9 m car straddles it; the shipped widths
                            // stop at the white line, but kerbs are drivable. Keeps cars on-track
                            // at the edge instead of hanging into the grass on corner exits.

// ── small vector helpers on {x, z} ──────────────────────────────────────────────
const hyp = (ax, az, bx, bz) => Math.hypot(bx - ax, bz - az);

// Uniform spatial grid over {x, z} points → a nearest-index query, replacing the O(n·m)
// brute-force scans in the alignment pass with ~O(n). Returns the exact same
// nearest point a linear scan would (an expanding-ring search with a distance prune), just
// far faster. `cell` should be a few × the mean point spacing.
function buildGrid(pts, cell) {
  const c = cell > 0 ? cell : 1;
  const grid = new Map();
  const key = (ix, iz) => ix + ":" + iz;
  for (let i = 0; i < pts.length; i++) {
    const k = key(Math.floor(pts[i].x / c), Math.floor(pts[i].z / c));
    let arr = grid.get(k); if (!arr) grid.set(k, (arr = [])); arr.push(i);
  }
  return (x, z) => {
    const ix = Math.floor(x / c), iz = Math.floor(z / c);
    let bi = -1, bd = Infinity;
    for (let r = 0; r <= 48; r++) {
      // A point in a Chebyshev-ring-r cell is ≥ (r−1)·cell from the query, so once that
      // exceeds the best distance found, no farther ring can improve it.
      if (bi >= 0 && (r - 1) * c > Math.sqrt(bd)) break;
      for (let dx = -r; dx <= r; dx++) {
        for (let dz = -r; dz <= r; dz++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue; // ring shell only
          const arr = grid.get(key(ix + dx, iz + dz));
          if (!arr) continue;
          for (const i of arr) {
            const ddx = pts[i].x - x, ddz = pts[i].z - z;
            const d = ddx * ddx + ddz * ddz;
            if (d < bd) { bd = d; bi = i; }
          }
        }
      }
    }
    if (bi < 0) for (let i = 0; i < pts.length; i++) { // pathologically sparse → exact scan
      const ddx = pts[i].x - x, ddz = pts[i].z - z;
      const d = ddx * ddx + ddz * ddz;
      if (d < bd) { bd = d; bi = i; }
    }
    return bi;
  };
}

// Longest drawn line = the fit/spine anchor (usually the driven lap).
function anchorLine(lines) {
  let best = null;
  for (const l of lines || []) if (l?.pts?.length >= 20 && (!best || l.pts.length > best.pts.length)) best = l;
  return best;
}

// Resample a point loop to `n` points uniform in fraction-of-total-arc-length.
// `closed` bridges the end→start gap as a real segment. Returns [{x, z}].
function resampleLoop(pts, n, closed) {
  const m = pts.length;
  const segs = closed ? m : m - 1;
  const cum = [0];
  for (let i = 1; i <= segs; i++) {
    const a = pts[i - 1], b = pts[i % m];
    cum[i] = cum[i - 1] + hyp(a.x, a.z, b.x, b.z);
  }
  const total = cum[segs] || 1;
  const out = [];
  let seg = 1;
  for (let k = 0; k < n; k++) {
    const s = (k / n) * total;
    while (seg <= segs && cum[seg] < s) seg++;
    const i = Math.min(seg, segs);
    const a = pts[i - 1], b = pts[i % m];
    const span = cum[i] - cum[i - 1];
    const t = span > 0 ? (s - cum[i - 1]) / span : 0;
    out.push({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t });
  }
  return out;
}

function centroidOf(pts) {
  let x = 0, z = 0;
  for (const p of pts) { x += p.x; z += p.z; }
  return { x: x / pts.length, z: z / pts.length };
}

// Closed-form 2D Kabsch rotation for centered, index-matched point sets.
function kabschTheta(A, B) {
  let cross = 0, dot = 0;
  for (let i = 0; i < A.length; i++) {
    dot += A[i].x * B[i].x + A[i].z * B[i].z;
    cross += A[i].x * B[i].z - A[i].z * B[i].x;
  }
  return Math.atan2(cross, dot);
}

// RMSE between R·A[i] and B[i] (both centered) for rotation theta.
function pairRmse(A, B, theta) {
  const c = Math.cos(theta), s = Math.sin(theta);
  let sum = 0;
  for (let i = 0; i < A.length; i++) {
    const rx = c * A[i].x - s * A[i].z;
    const rz = s * A[i].x + c * A[i].z;
    const dx = rx - B[i].x, dz = rz - B[i].z;
    sum += dx * dx + dz * dz;
  }
  return Math.sqrt(sum / A.length);
}

// Rigid-align dataset centerline (2D, meters) to the recorded line (world x/z, meters).
// Solves mirror ∈ {no, yes}, traversal reversal ∈ {no, yes}, cyclic start offset k,
// rotation θ and translation t — scale is fixed at 1 (both frames are meters).
// Returns { apply(x, z) → {x, z}, swapSides, reverse, rmse }.
function solveAlignment(trackPts2, linePts) {
  const line = resampleLoop(linePts, FIT_N, true);
  const lc = centroidOf(line);
  const B = line.map((p) => ({ x: p.x - lc.x, z: p.z - lc.z }));

  let best = null;
  for (const mirror of [false, true]) {
    for (const reverse of [false, true]) {
      // Build the candidate track loop in this orientation, centered.
      const raw = trackPts2.map((p) => ({ x: p[0], z: mirror ? -p[1] : p[1] }));
      if (reverse) raw.reverse();
      const tr = resampleLoop(raw.map((p) => ({ x: p.x, z: p.z })), FIT_N, true);
      const tc = centroidOf(tr);
      const A0 = tr.map((p) => ({ x: p.x - tc.x, z: p.z - tc.z }));

      // Coarse cyclic-offset sweep, then refine around the best offset.
      const tryOffset = (k) => {
        const A = new Array(FIT_N);
        for (let i = 0; i < FIT_N; i++) A[i] = A0[(i + k) % FIT_N];
        const theta = kabschTheta(A, B);
        return { rmse: pairRmse(A, B, theta), theta, k };
      };
      let localBest = null;
      for (let k = 0; k < FIT_N; k += 4) {
        const r = tryOffset(k);
        if (!localBest || r.rmse < localBest.rmse) localBest = r;
      }
      for (let dk = -3; dk <= 3; dk++) {
        if (dk === 0) continue;
        const r = tryOffset((localBest.k + dk + FIT_N) % FIT_N);
        if (r.rmse < localBest.rmse) localBest = r;
      }
      if (!best || localBest.rmse < best.rmse) {
        best = { ...localBest, mirror, reverse, tc, lc };
      }
    }
  }

  // ── ICP refinement: index correspondence biases the fit because a racing line
  // runs long arcs off-centre; re-match each line point to its NEAREST track point
  // and re-solve. 2–3 passes settle it.
  const raw = trackPts2.map((p) => ({ x: p[0], z: best.mirror ? -p[1] : p[1] }));
  if (best.reverse) raw.reverse();
  const tr = resampleLoop(raw, FIT_N, true);
  let theta = best.theta;
  // Current translation: rotate-about-track-centroid then move to line centroid.
  let tc = best.tc, lc2 = best.lc;
  let rmse = best.rmse;
  for (let pass = 0; pass < 3; pass++) {
    const c = Math.cos(theta), s = Math.sin(theta);
    const world = tr.map((p) => ({
      x: c * (p.x - tc.x) - s * (p.z - tc.z) + lc2.x,
      z: s * (p.x - tc.x) + c * (p.z - tc.z) + lc2.z,
    }));
    // Match every resampled line point to its nearest transformed track point (grid-accelerated).
    const worldSpacing = hyp(world[0].x, world[0].z, world[1].x, world[1].z);
    const nearestWorld = buildGrid(world, Math.max(10, worldSpacing * 4));
    const pairsA = [], pairsB = [];
    let sum = 0;
    for (const q of line) {
      const bi = nearestWorld(q.x, q.z);
      const dx = world[bi].x - q.x, dz = world[bi].z - q.z;
      sum += dx * dx + dz * dz;
      pairsA.push(tr[bi]);
      pairsB.push(q);
    }
    rmse = Math.sqrt(sum / line.length);
    // Re-solve rotation + translation from the matched pairs.
    const ca = centroidOf(pairsA), cb = centroidOf(pairsB);
    const A = pairsA.map((p) => ({ x: p.x - ca.x, z: p.z - ca.z }));
    const Bp = pairsB.map((p) => ({ x: p.x - cb.x, z: p.z - cb.z }));
    theta = kabschTheta(A, Bp);
    tc = ca; lc2 = cb;
  }

  const c = Math.cos(theta), s = Math.sin(theta);
  return {
    rmse,
    reverse: best.reverse,
    mirror: best.mirror,
    // Both mirroring and reversing flip which side of travel is "left"; together they cancel.
    swapSides: best.reverse !== best.mirror,
    apply: (x, zRaw) => {
      const z = best.mirror ? -zRaw : zRaw;
      return {
        x: c * (x - tc.x) - s * (z - tc.z) + lc2.x,
        z: s * (x - tc.x) + c * (z - tc.z) + lc2.z,
      };
    },
  };
}

// Signed curvature (1/m) at each row of a loop of {x, z}, from neighbours ± `step`
// rows. Positive = counter-clockwise in the x/z plane. NaN-safe on degenerate spans.
function signedCurvature(rows, step, closed) {
  const n = rows.length;
  const out = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    let ia = i - step, ic = i + step;
    if (closed) { ia = (ia + n) % n; ic = ic % n; }
    else { ia = Math.max(0, ia); ic = Math.min(n - 1, ic); }
    const a = rows[ia], b = rows[i], cc = rows[ic];
    const abx = b.x - a.x, abz = b.z - a.z;
    const bcx = cc.x - b.x, bcz = cc.z - b.z;
    const acx = cc.x - a.x, acz = cc.z - a.z;
    const lab = Math.hypot(abx, abz), lbc = Math.hypot(bcx, bcz), lac = Math.hypot(acx, acz);
    if (lab * lbc * lac < 1e-6) continue;
    out[i] = (2 * (abx * bcz - abz * bcx)) / (lab * lbc * lac);
  }
  return out;
}

// Cyclic (or clamped) box blur, run `passes` times with half-window `hw`.
function boxBlur(vals, hw, passes, closed) {
  let v = vals.slice();
  const n = v.length;
  for (let p = 0; p < passes; p++) {
    const next = new Array(n);
    for (let i = 0; i < n; i++) {
      let sum = 0, cnt = 0;
      for (let d = -hw; d <= hw; d++) {
        let j = i + d;
        if (closed) j = (j + n) % n;
        else if (j < 0 || j >= n) continue;
        sum += v[j]; cnt++;
      }
      next[i] = sum / cnt;
    }
    v = next;
  }
  return v;
}

// ── De-facet the centerline ────────────────────────────────────────────────────
// The shipped rows are 2.5 m apart, but their SHAPE is much coarser than that. The
// upstream GeoJSON ways carry a vertex every 5-10 m through a corner and
// fetch-tracks resamples between them LINEARLY, so the extra points land on the
// chords: measured across all 25 circuits, 600+ rows per lap turn by under 0.05°
// while the odd one turns as much as 56° in a single 2.5 m step. In the plan view
// that's invisible. From the T-cam it's a corner built out of flat panels, which is
// exactly the artefact this removes.
//
// SAVITZKY-GOLAY, not a box blur, and the difference matters. A box blur pulls a
// constant-radius corner INWARD — it's averaging points off an arc, so the average
// sits inside it — and the tighter the corner the worse it gets. A local quadratic
// least-squares fit reproduces a parabola exactly, so a real corner passes through
// essentially untouched and only the kinks (which are curvature the source never
// had) get rounded. Measured across the 25 shipped circuits at this window: the
// worst single-step turn drops 55.9° → 6.1°, no row moves more than 0.97 m, and the
// worst lap shortens by 0.18%. The equivalent box blur costs 1.9 m and 0.69%.
//
// Row COUNT and ORDER are untouched, which is what keeps this free elsewhere:
// startIndex, sfFrac and the shipped `apexes` are all index fractions of this array,
// so corner numbering and placement are unaffected.
const SMOOTH_HALF_M = 10;   // m — half-window of the fit
const SMOOTH_PASSES = 2;

// Savitzky-Golay smoothing coefficients, degree 2, half-window m (closed form).
function sgKernel(m) {
  const norm = (2 * m + 1) * (4 * m * m + 4 * m - 3);
  const c = new Array(2 * m + 1);
  for (let j = -m; j <= m; j++) c[j + m] = (3 * (3 * m * m + 3 * m - 1 - 5 * j * j)) / norm;
  return c;
}

function deFacet(rows, closed) {
  const n = rows.length;
  const m = Math.max(2, Math.min(12, Math.round(SMOOTH_HALF_M / Math.max(1, arcSpacing(rows, closed)))));
  if (n < 4 * m + 1) return;                 // too short for the window to mean anything
  const c = sgKernel(m);
  // An open road clamps at its ends rather than renormalising a truncated kernel —
  // SG's negative wings go unstable when you cut them off.
  const wrap = closed
    ? (i) => ((i % n) + n) % n
    : (i) => (i < 0 ? 0 : i >= n ? n - 1 : i);
  let x = rows.map((r) => r.x), z = rows.map((r) => r.z);
  for (let p = 0; p < SMOOTH_PASSES; p++) {
    const nx = new Array(n), nz = new Array(n);
    for (let i = 0; i < n; i++) {
      let sx = 0, sz = 0;
      for (let j = -m; j <= m; j++) { const k = wrap(i + j); sx += c[j + m] * x[k]; sz += c[j + m] * z[k]; }
      nx[i] = sx; nz[i] = sz;
    }
    x = nx; z = nz;
  }
  for (let i = 0; i < n; i++) { rows[i].x = x[i]; rows[i].z = z[i]; }
}

// Drape recorded elevation onto centerline rows: nearest-row accumulation of every
// sample's y, cyclic gap fill, then smoothing. Mutates rows[i].y — every path here
// writes it, so callers need no `y: 0` seed. No y anywhere → the model stays flat,
// which is exactly what a lap recorded before the recorder captured height gets.
//
// Note the source is the LAPS, not the shipped track file: public/tracks/*.json is
// 2D. So one lap with height lifts the whole scene for every comparison on that
// circuit, including for a lap that has none of its own.
function drapeElevation(rows, lines, closed) {
  const samples = [];
  for (const l of lines || []) {
    for (const p of l?.pts || []) {
      if (typeof p.y === "number" && isFinite(p.y) && typeof p.x === "number" && typeof p.z === "number") {
        samples.push(p);
      }
    }
  }
  if (!samples.length) { for (const r of rows) r.y = 0; return; }

  const n = rows.length;
  const sum = new Array(n).fill(0), cnt = new Array(n).fill(0);
  const nearestRow = buildGrid(rows, Math.max(8, arcSpacing(rows, closed) * 4));
  for (const p of samples) {
    const bi = nearestRow(p.x, p.z);
    if (bi >= 0) { sum[bi] += p.y; cnt[bi]++; }
  }
  // Seed hit rows, then fill gaps by linear interpolation between hit rows.
  const y = new Array(n).fill(null);
  for (let i = 0; i < n; i++) if (cnt[i]) y[i] = sum[i] / cnt[i];
  const hits = [];
  for (let i = 0; i < n; i++) if (y[i] != null) hits.push(i);
  if (!hits.length) { for (const r of rows) r.y = 0; return; }
  for (let h = 0; h < hits.length; h++) {
    const i0 = hits[h];
    const i1 = hits[(h + 1) % hits.length];
    const gap = (i1 - i0 + n) % n || n;
    for (let d = 1; d < gap; d++) {
      const i = (i0 + d) % n;
      if (!closed && i < i0) break; // open loop: don't wrap the fill
      y[i] = y[i0] + ((y[i1] - y[i0]) * d) / gap;
    }
  }
  for (let i = 0; i < n; i++) if (y[i] == null) y[i] = y[hits[0]];
  // ~27 m smoothing window at 2.5 m spacing kills curb strikes and bin noise
  // while keeping real gradients (Eau Rouge climbs ~40 m over 500 m — survives).
  // This is why the T-cam reads height from the ROAD and never from a lap's own
  // y: raw y carries ride height and suspension travel, which would bob the camera.
  const smoothed = boxBlur(y, 5, 3, closed);
  for (let i = 0; i < n; i++) rows[i].y = smoothed[i];
}

// Road height at a FRACTIONAL row index, linearly interpolated.
//
// Deliberately not a spatial (x, z) lookup: the old makeElevAt() hashed position to
// the nearest row, which is piecewise-constant, so a camera crossing 2.5 m rows at
// racing speed popped vertically ~14×/s. Every caller that wants height is already
// walking rows by index, so interpolating between two of them is both cheaper and
// smooth.
export function elevAtRowFrac(rows, fi, closed = true) {
  const n = rows?.length || 0;
  if (!n) return 0;
  const i0 = Math.floor(fi);
  const t = fi - i0;
  const wrap = (i) => (closed ? ((i % n) + n) % n : Math.max(0, Math.min(n - 1, i)));
  const a = rows[wrap(i0)].y || 0, b = rows[wrap(i0 + 1)].y || 0;
  return a + (b - a) * t;
}

// ── Seat the road under the car ────────────────────────────────────────────────
// solveAlignment is RIGID — one rotation and one translation for the whole
// circuit. The shipped centerlines are OpenStreetMap traces whose local accuracy
// varies along a lap, so no rigid transform can sit under the car everywhere, and
// RMSE_ACCEPT tolerates up to 12 m of that.
//
// Measured on the demo session (Singapore, 25 laps) the residual is unmistakably
// the GEOMETRY and not the driving: at a fixed point on the circuit the lap-to-lap
// spread is 0.5-2.6 m while the offset common to all 25 laps swings −11.8 to
// +11.1 m against a 7 m half-width. Twenty-five independent laps are not all
// eleven metres off-road at the same corner.
//
// In the top-down plan view that's a few pixels. From the T-cam it puts the car in
// the gravel, so this nudges each row sideways to take it back up.
//
// Minimal intervention, deliberately: it only ever corrects the amount by which a
// line would sit OUTSIDE the road, so a circuit whose fit is already good gets a
// correction of zero and keeps its surveyed geometry untouched. The shift is then
// heavily smoothed, so the road bends rather than kinking, and the racing line's own
// apexing — the high-frequency part, which is real driving — is preserved.
const SNAP_MARGIN = 0.5;   // m — how far inside the edge to bring a line that's out
const SNAP_MAX    = 15;    // m — cap, so a catastrophic fit can't warp the road absurdly
const SNAP_WINDOW = 22;    // m — smoothing half-window for the correction
const SNAP_PASSES = 4;     // see the iteration note below

// Pair each line point with the row it's REALLY beside, by walking both in order.
//
// A Euclidean nearest-row lookup is wrong here and dangerously so. Street circuits
// run alongside themselves — Singapore has several — so a grid lookup happily
// matches a point to the road on the far side of a barrier, twenty metres of
// concrete away. Feeding that into a lateral correction shoves the row across the
// gap: the first version of this produced a 126°-per-row fold in the centerline.
// Walking a monotone cursor forward along the lap cannot make that mistake, because
// the correspondence is constrained by arc length, not by proximity.
// Rows either side of the cursor. Consecutive lap samples are 10 m apart — about
// four rows — so ±16 (40 m) is a wide margin on the step the cursor actually has to
// make, while staying far short of the distance across to a parallel section. This
// window is the inner loop of the whole seating pass, and a live lap re-fits every
// 64 samples on the UI thread, so it's worth not making it bigger than it needs.
const SNAP_SEARCH = 16;

function pairLineToRows(rows, n, closed, pts) {
  const sum = new Array(n).fill(0), cnt = new Array(n).fill(0);
  const d2 = (i, p) => (rows[i].x - p.x) ** 2 + (rows[i].z - p.z) ** 2;
  const wrap = (i) => (closed ? ((i % n) + n) % n : Math.max(0, Math.min(n - 1, i)));
  // Seed on the first point with a full scan; after that the cursor carries.
  let cur = 0, bd = Infinity;
  for (let i = 0; i < n; i++) { const d = d2(i, pts[0]); if (d < bd) { bd = d; cur = i; } }

  for (const p of pts) {
    let best = cur, bestD = d2(cur, p);
    for (let k = -SNAP_SEARCH; k <= SNAP_SEARCH; k++) {
      const i = wrap(cur + k);
      const d = d2(i, p);
      if (d < bestD) { bestD = d; best = i; }
    }
    cur = best;
    // Signed lateral offset along this row's left normal (nx, nz) = (tz, −tx).
    const prev = rows[wrap(best - 1)], next = rows[wrap(best + 1)];
    let tx = next.x - prev.x, tz = next.z - prev.z;
    const tl = hyp(0, 0, tx, tz) || 1; tx /= tl; tz /= tl;
    sum[best] += (p.x - rows[best].x) * tz + (p.z - rows[best].z) * -tx;
    cnt[best] += 1;
  }
  return { sum, cnt };
}

function seatRoadUnderLines(rows, lines, closed) {
  const pts = [];
  for (const l of lines || []) {
    const own = (l?.pts || []).filter((p) => isFinite(p?.x) && isFinite(p?.z));
    if (own.length >= 20) pts.push(own);
  }
  if (!pts.length) return 0;
  const n = rows.length;
  const hw = Math.max(2, Math.round(SNAP_WINDOW / Math.max(1, arcSpacing(rows, closed))));
  const nx = new Array(n), nz = new Array(n), excess = new Array(n);
  const applied = new Array(n).fill(0);

  // ITERATE. One pass under-corrects badly: smoothing is what stops the road
  // kinking, but blurring a localised excess also flattens its peak, so a single
  // pass removed only about a third of the error. Re-measuring after each pass
  // converges it, and it plateaus after a handful — no point running more.
  for (let pass = 0; pass < SNAP_PASSES; pass++) {
    for (let i = 0; i < n; i++) {
      const prev = rows[closed ? (i - 1 + n) % n : Math.max(0, i - 1)];
      const next = rows[closed ? (i + 1) % n : Math.min(n - 1, i + 1)];
      let tx = next.x - prev.x, tz = next.z - prev.z;
      const tl = hyp(0, 0, tx, tz) || 1; tx /= tl; tz /= tl;
      nx[i] = tz; nz[i] = -tx;                 // left normal, the codebase convention
      excess[i] = 0;
    }
    // Worst overhang per row across every line, so the road ends up wide enough
    // for both cars rather than seated under whichever was processed last.
    let worst = 0;
    for (const own of pts) {
      const { sum, cnt } = pairLineToRows(rows, n, closed, own);
      for (let i = 0; i < n; i++) {
        if (!cnt[i]) continue;
        const d = sum[i] / cnt[i];
        const halfW = Math.max(1, (d > 0 ? rows[i].wl : rows[i].wr) - SNAP_MARGIN);
        const over = Math.abs(d) - halfW;
        if (over <= 0) continue;
        const want = Math.sign(d) * Math.min(over, SNAP_MAX);
        if (Math.abs(want) > Math.abs(excess[i])) excess[i] = want;
        worst = Math.max(worst, over);
      }
    }
    if (worst < 0.25) break;                   // already seated
    const shift = boxBlur(excess, hw, 3, closed);
    for (let i = 0; i < n; i++) {
      rows[i].x += nx[i] * shift[i];
      rows[i].z += nz[i] * shift[i];
      applied[i] += shift[i];
    }
  }
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(applied[i]));
  return peak;
}

function finishModel(rows, { status, closed, rmse = null, attribution = null, reverse = false, apexes = null }, lines) {
  // Order matters: de-facet FIRST so the seating pass measures the shape that gets
  // drawn rather than the polyline, then seat the road so the elevation drape and
  // the curvature channel are both computed on the geometry that actually gets drawn.
  deFacet(rows, closed);
  const seated = status === "real" ? seatRoadUnderLines(rows, lines, closed) : 0;
  drapeElevation(rows, lines, closed);
  const kStep = Math.max(2, Math.round(6 / Math.max(1, arcSpacing(rows, closed))));
  const kappa = boxBlur(signedCurvature(rows, kStep, closed), Math.round(kStep * 2.5), 2, closed);
  rows.forEach((r, i) => { r.k = kappa[i]; });

  // Start/finish = the row nearest the anchor lap's first point (lap distance ≈ 0).
  const anchor = anchorLine(lines);
  let startIndex = 0;
  if (anchor) {
    const p0 = anchor.pts[0];
    let bd = Infinity;
    rows.forEach((r, i) => {
      const d = (r.x - p0.x) ** 2 + (r.z - p0.z) ** 2;
      if (d < bd) { bd = d; startIndex = i; }
    });
    // p0 is the lap's FIRST SAMPLE, which is only the start/finish line when the
    // recorder happened to catch the lap from the line. A lap taken from session
    // history often opens some way down the road; trusting it there puts S/F that
    // far past the line, which rotates every corner NUMBER while leaving each
    // marker sitting on a real corner. The lap's own distance channel says how far
    // past the line it opened, so walk that much back up the road (rows are already
    // ordered in the driving direction).
    const lead = p0.dist;
    if (closed && typeof lead === "number" && isFinite(lead) && lead > 0) {
      let back = 0;
      while (back < lead) {
        const prev = (startIndex - 1 + rows.length) % rows.length;
        back += hyp(rows[prev].x, rows[prev].z, rows[startIndex].x, rows[startIndex].z);
        startIndex = prev;
      }
    }
  }
  // Start/finish expressed back in the DATA's own frame: a fraction of the shipped
  // centerline's arc length, in file order. That's the frame public/tracks/<slug>.json
  // `apexes` live in, so this is the one number needed to number the corners from
  // the real start/finish — see src/lib/cornerAnchors.js. Only meaningful for a
  // real fit; the heuristic road has no file to refer back to.
  const n = rows.length;
  const sfFrac = status === "real" && n
    ? (reverse ? n - 1 - startIndex : startIndex) / n
    : null;

  return {
    status, centerline: rows, closed, startIndex, rmse, attribution,
    reverse, sfFrac, apexes,
    // How far the road had to move to get under the car. 0 on a circuit whose
    // rigid fit was already good; the T-cam surfaces it when it's large, because
    // that's the honest signal that the shipped geometry is approximate there.
    seated,
  };
}

function arcSpacing(rows, closed) {
  let total = 0;
  const segs = closed ? rows.length : rows.length - 1;
  for (let i = 1; i <= segs; i++) {
    const a = rows[i - 1], b = rows[i % rows.length];
    total += hyp(a.x, a.z, b.x, b.z);
  }
  return total / Math.max(1, segs);
}

// ── Heuristic road (no real data) ───────────────────────────────────────────────
// Sweep a constant-width road along the drawn line(s), but offset its centre toward
// the corner OUTSIDE by smoothed, saturated curvature — so at a full corner the line
// sits ~1 m from the inside edge (apex/curb) instead of dead centre.
export function buildHeuristicTrack(lines) {
  const drawable = (lines || []).filter((l) => l?.pts?.length >= 20);
  if (!drawable.length) return null;

  // Spine: the single line, or the per-fraction average of both (matches the old
  // midline behaviour so neither car is pinned to the road centre).
  let spinePts;
  if (drawable.length === 1) {
    spinePts = drawable[0].pts.map((p) => ({ x: p.x, z: p.z }));
  } else {
    const M = 480;
    const at = (l, f) => {
      const addr = l.distAt, P = l.pts, n = P.length;
      let i = 1;
      while (i < n && addr[i] < f) i++;
      i = Math.min(i, n - 1);
      const lo = addr[i - 1], hi = addr[i];
      const t = Math.max(0, Math.min(1, hi > lo ? (f - lo) / (hi - lo) : 0));
      return {
        x: P[i - 1].x + (P[i].x - P[i - 1].x) * t,
        z: P[i - 1].z + (P[i].z - P[i - 1].z) * t,
      };
    };
    spinePts = [];
    for (let k = 0; k < M; k++) {
      const f = k / M;
      let x = 0, z = 0;
      for (const l of drawable) {
        const p = at(l, f);
        x += p.x; z += p.z;
      }
      spinePts.push({ x: x / drawable.length, z: z / drawable.length });
    }
  }

  const first = spinePts[0], last = spinePts[spinePts.length - 1];
  const closed = hyp(first.x, first.z, last.x, last.z) < 60;

  // Resample to ~3 m and compute the outward offset from smoothed curvature.
  const spine = resampleLoop(spinePts, Math.max(64, Math.round(spinePts.length * (10 / 3))), closed);
  const kappa = boxBlur(signedCurvature(spine, 2, closed), 5, 2, closed);
  const n = spine.length;
  const rows = new Array(n);
  for (let i = 0; i < n; i++) {
    const prev = spine[closed ? (i - 1 + n) % n : Math.max(0, i - 1)];
    const next = spine[closed ? (i + 1) % n : Math.min(n - 1, i + 1)];
    let tx = next.x - prev.x, tz = next.z - prev.z;
    const tl = Math.hypot(tx, tz) || 1;
    tx /= tl; tz /= tl;
    const nx = tz, nz = -tx; // horizontal normal (matches cross(UP, t) in the scene)
    const sat = Math.max(-1, Math.min(1, kappa[i] / KAPPA_SAT));
    const off = sat * (HEUR_HALF_W - 1.0); // toward the outside of the corner
    rows[i] = { x: spine[i].x + nx * off, z: spine[i].z + nz * off, wl: HEUR_HALF_W, wr: HEUR_HALF_W };
  }
  return finishModel(rows, { status: "fallback", closed }, lines);
}

// ── Real circuit loader ─────────────────────────────────────────────────────────
const modelCache = new Map();
const MODEL_CACHE_MAX = 24;   // a growing live lap re-keys every refit; don't accumulate forever

// A cheap 32-bit signature of what a line actually LOOKS like. Sample count alone
// isn't enough to identify a lap: two different laps on the same circuit with the
// same number of samples would share a cache key, and the second would be handed
// the first one's model — corner markers placed off the road (they're read from
// model.centerline), and a wrong start/finish taught to the corner-anchor cache.
// Sampling fixed fractions keeps this O(1) however long the lap is; coordinates are
// rounded to the metre so sub-metre jitter doesn't needlessly invalidate a fit.
function lineSignature(line) {
  const pts = line?.pts;
  if (!pts?.length) return "0";
  const SAMPLES = 12;
  let h = 0x811c9dc5;
  for (let s = 0; s < SAMPLES; s++) {
    const p = pts[Math.round((s / (SAMPLES - 1)) * (pts.length - 1))];
    h = Math.imul(h ^ Math.round(p?.x || 0), 0x01000193) >>> 0;
    h = Math.imul(h ^ Math.round(p?.z || 0), 0x01000193) >>> 0;
  }
  return pts.length.toString(36) + "." + h.toString(36);
}

export async function loadTrackModel(slug, lines) {
  const anchor = anchorLine(lines);
  if (!anchor) return null;
  const cacheKey = (slug || "none") + "::" + (lines || []).map((l) => l.id + ":" + lineSignature(l)).join(",");
  if (modelCache.has(cacheKey)) return modelCache.get(cacheKey);

  let model = null;
  if (slug) {
    try {
      const res = await fetch(`/tracks/${slug}.json`);
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data.points) && data.points.length > 100) {
          model = fitRealTrack(data, anchor, lines);
        }
      }
    } catch (e) {
      console.warn(`[trackGeometry] ${slug}: load failed (${e.message}) — using heuristic road`);
    }
  }
  if (!model) model = buildHeuristicTrack(lines);
  // A real fit is the only place the start/finish line and the traversal direction
  // are actually known, so teach the anchor cache here — that's what lets corner
  // numbering work on this circuit before a lap has been fitted next session.
  if (model.status === "real" && model.sfFrac != null) {
    setAnchor(slug, { sfFrac: model.sfFrac, reverse: model.reverse });
  }
  if (modelCache.size >= MODEL_CACHE_MAX) modelCache.clear();
  modelCache.set(cacheKey, model);
  return model;
}

function fitRealTrack(data, anchor, lines) {
  const t0 = performance.now();
  const fit = solveAlignment(data.points, anchor.pts);
  const ms = Math.round(performance.now() - t0);
  // Dev-only fit diagnostic — useful when tuning the alignment solver, but noise
  // in the packaged app. The rejection warning below is NOT gated: that one
  // reports a circuit whose geometry didn't fit, which is a real problem.
  if (import.meta.env.DEV) {
    console.info(`[trackGeometry] ${data.slug}: fit RMSE ${fit.rmse.toFixed(1)} m` +
      ` (mirror=${fit.mirror}, reverse=${fit.reverse}, ${ms} ms)`);
  }
  if (!(fit.rmse < RMSE_ACCEPT)) {
    console.warn(`[trackGeometry] ${data.slug}: fit rejected (RMSE ${fit.rmse.toFixed(1)} m ≥ ${RMSE_ACCEPT}) — using heuristic road`);
    return null;
  }
  // Transform every full-resolution row into the world frame, ordered in the driving
  // direction; swap side widths when the traversal sense flipped an odd number of times.
  let pts = data.points;
  if (fit.reverse) pts = [...pts].reverse();
  const rows = pts.map((p) => {
    const w = fit.apply(p[0], p[1]); // apply() folds the mirror in itself
    const wr = p[2] + EDGE_MARGIN, wl = p[3] + EDGE_MARGIN;
    return { x: w.x, z: w.z, wl: fit.swapSides ? wr : wl, wr: fit.swapSides ? wl : wr };
  });
  return finishModel(rows, {
    status: "real", closed: true, rmse: fit.rmse, attribution: data.attribution || null,
    reverse: fit.reverse, apexes: Array.isArray(data.apexes) ? data.apexes : null,
  }, lines);
}
