// ─── TRACK GEOMETRY (Driving Lines tab) ────────────────────────────────────────
// Turns a recorded racing line into a drivable *track model* for the 3D scene:
//
//   loadTrackModel(slug, lines3D) → Promise<model | null>
//     Fetches the bundled real-circuit centerline + widths (public/tracks/<slug>.json,
//     from the TUMFTM racetrack-database) and rigidly aligns it into the game's world
//     frame so the recorded lines sit on the real road — apexes, curbs and all. The
//     recorded lines are NEVER modified; only the track is transformed. Falls back to
//     buildHeuristicTrack() when the circuit isn't covered, the fetch fails, or the
//     fit is poor (e.g. the game's layout differs from the dataset's vintage).
//
//   buildHeuristicTrack(lines3D) → model
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
//   elevAt: (x, z) => y,                   // road-surface height lookup
// }
//
// Pure math — no three.js import, so the scene chunk stays the only heavy one.

const FIT_N = 512;          // resample count for the alignment solve
const RMSE_ACCEPT = 12;     // meters — reject fits worse than this (line legitimately
                            // sits up to ~half a track-width off the centerline)
const HEUR_HALF_W = 6.5;    // heuristic road half-width (m)
const KAPPA_SAT = 1 / 50;   // curvature (1/m) treated as a "full" corner
const EDGE_MARGIN = 1.0;    // meters added to each real-track edge: the driven line is the
                            // car CENTER and the ~1.9 m car straddles it; TUMFTM widths stop
                            // at the white line, but kerbs are drivable. Keeps cars on-track
                            // at the edge instead of hanging into the grass on corner exits.

// ── small vector helpers on {x, z} ──────────────────────────────────────────────
const hyp = (ax, az, bx, bz) => Math.hypot(bx - ax, bz - az);

// Uniform spatial grid over {x, z} points → a nearest-index query, replacing the O(n·m)
// brute-force scans in the alignment + elevation passes with ~O(n). Returns the exact same
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
function anchorLine(lines3D) {
  let best = null;
  for (const l of lines3D || []) if (l?.pts?.length >= 20 && (!best || l.pts.length > best.pts.length)) best = l;
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

// Drape recorded elevation onto centerline rows: nearest-row accumulation of every
// sample's y, cyclic gap fill, then smoothing. Mutates rows[i].y. No y → stays flat.
function drapeElevation(rows, lines3D, closed) {
  const samples = [];
  for (const l of lines3D || []) {
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
  const smoothed = boxBlur(y, 5, 3, closed);
  for (let i = 0; i < n; i++) rows[i].y = smoothed[i];
}

// Attach a coarse spatial-hash elevation sampler to the model.
function makeElevAt(rows) {
  const CELL = 25;
  const grid = new Map();
  const key = (ix, iz) => ix + ":" + iz;
  rows.forEach((r, i) => {
    const k = key(Math.floor(r.x / CELL), Math.floor(r.z / CELL));
    let arr = grid.get(k);
    if (!arr) grid.set(k, (arr = []));
    arr.push(i);
  });
  return (x, z) => {
    const ix = Math.floor(x / CELL), iz = Math.floor(z / CELL);
    let bi = -1, bd = Infinity;
    for (let r = 1; r <= 3 && bi < 0; r++) { // expand the search ring until something hits
      for (let dx = -r; dx <= r; dx++) {
        for (let dz = -r; dz <= r; dz++) {
          const arr = grid.get(key(ix + dx, iz + dz));
          if (!arr) continue;
          for (const i of arr) {
            const ddx = rows[i].x - x, ddz = rows[i].z - z;
            const d = ddx * ddx + ddz * ddz;
            if (d < bd) { bd = d; bi = i; }
          }
        }
      }
    }
    return bi >= 0 ? rows[bi].y : 0;
  };
}

function finishModel(rows, { status, closed, rmse = null, attribution = null }, lines3D) {
  drapeElevation(rows, lines3D, closed);
  const kStep = Math.max(2, Math.round(6 / Math.max(1, arcSpacing(rows, closed))));
  const kappa = boxBlur(signedCurvature(rows, kStep, closed), Math.round(kStep * 2.5), 2, closed);
  rows.forEach((r, i) => { r.k = kappa[i]; });

  // Start/finish = the row nearest the anchor lap's first point (lap distance ≈ 0).
  const anchor = anchorLine(lines3D);
  let startIndex = 0;
  if (anchor) {
    const p0 = anchor.pts[0];
    let bd = Infinity;
    rows.forEach((r, i) => {
      const d = (r.x - p0.x) ** 2 + (r.z - p0.z) ** 2;
      if (d < bd) { bd = d; startIndex = i; }
    });
  }
  return { status, centerline: rows, closed, startIndex, rmse, attribution, elevAt: makeElevAt(rows) };
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
export function buildHeuristicTrack(lines3D) {
  const drawable = (lines3D || []).filter((l) => l?.pts?.length >= 20);
  if (!drawable.length) return null;

  // Spine: the single line, or the per-fraction average of both (matches the old
  // midline behaviour so neither car is pinned to the road centre).
  let spinePts;
  if (drawable.length === 1) {
    spinePts = drawable[0].pts.map((p) => ({ x: p.x, z: p.z, y: p.y }));
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
        y: (P[i - 1].y != null && P[i].y != null) ? P[i - 1].y + (P[i].y - P[i - 1].y) * t : undefined,
      };
    };
    spinePts = [];
    for (let k = 0; k < M; k++) {
      const f = k / M;
      let x = 0, z = 0, y = 0, ys = 0;
      for (const l of drawable) {
        const p = at(l, f);
        x += p.x; z += p.z;
        if (p.y != null) { y += p.y; ys++; }
      }
      spinePts.push({ x: x / drawable.length, z: z / drawable.length, y: ys ? y / ys : undefined });
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
    rows[i] = { x: spine[i].x + nx * off, z: spine[i].z + nz * off, y: 0, wl: HEUR_HALF_W, wr: HEUR_HALF_W };
  }
  return finishModel(rows, { status: "fallback", closed }, lines3D);
}

// ── Real circuit loader ─────────────────────────────────────────────────────────
const modelCache = new Map();

export async function loadTrackModel(slug, lines3D) {
  const anchor = anchorLine(lines3D);
  if (!anchor) return null;
  const cacheKey = (slug || "none") + "::" + (lines3D || []).map((l) => l.id + ":" + (l.pts?.length || 0)).join(",");
  if (modelCache.has(cacheKey)) return modelCache.get(cacheKey);

  let model = null;
  if (slug) {
    try {
      const res = await fetch(`/tracks/${slug}.json`);
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data.points) && data.points.length > 100) {
          model = fitRealTrack(data, anchor, lines3D);
        }
      }
    } catch (e) {
      console.warn(`[trackGeometry] ${slug}: load failed (${e.message}) — using heuristic road`);
    }
  }
  if (!model) model = buildHeuristicTrack(lines3D);
  modelCache.set(cacheKey, model);
  return model;
}

function fitRealTrack(data, anchor, lines3D) {
  const t0 = performance.now();
  const fit = solveAlignment(data.points, anchor.pts);
  const ms = Math.round(performance.now() - t0);
  console.info(`[trackGeometry] ${data.slug}: fit RMSE ${fit.rmse.toFixed(1)} m` +
    ` (mirror=${fit.mirror}, reverse=${fit.reverse}, ${ms} ms)`);
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
    return { x: w.x, z: w.z, y: 0, wl: fit.swapSides ? wr : wl, wr: fit.swapSides ? wl : wr };
  });
  return finishModel(rows, {
    status: "real", closed: true, rmse: fit.rmse, attribution: data.attribution || null,
  }, lines3D);
}
