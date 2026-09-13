// Offline analysis of an FFB output trace exported from the app's Force Feedback
// tab (Wheel Torque panel → Export trace). Each trace is the output the wheel
// actually received while driving: the reconstructed input force, steer, and the
// final torque at the engine's output rate.
//
// The point is to make "grain" measurable. A slope kink at every 60 Hz frame
// boundary shows up as excess energy above ~25 Hz for the same driving; comparing
// a Linear trace against a Cubic one, or one smoothing setting against another,
// shows which frequencies the change actually moved.
//
//   node scripts/analyze-ffb-trace.mjs trace-linear.json trace-cubic.json
import { readFileSync } from "node:fs";

const files = process.argv.slice(2).filter((a) => !a.startsWith("-"));
if (files.length === 0) {
  console.log("Usage: node scripts/analyze-ffb-trace.mjs <trace.json> [trace2.json ...]");
  process.exit(1);
}

const WINDOW_MAX = 2048;

function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wRe = Math.cos(ang);
    const wIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let curRe = 1;
      let curIm = 0;
      for (let j = 0; j < len / 2; j++) {
        const a = i + j;
        const b = a + len / 2;
        const vRe = re[b] * curRe - im[b] * curIm;
        const vIm = re[b] * curIm + im[b] * curRe;
        re[b] = re[a] - vRe;
        im[b] = im[a] - vIm;
        re[a] += vRe;
        im[a] += vIm;
        const nextRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nextRe;
      }
    }
  }
}

// Welch PSD over Hann-windowed blocks. Returns { freqs, psd } with psd in
// torque^2 per Hz (window-length normalised, so absolute levels are comparable
// between traces at the same rate).
function psd(samples, hz) {
  const n = samples.length;
  let win = 2 ** Math.floor(Math.log2(Math.min(WINDOW_MAX, n)));
  if (win < 64) return { freqs: [], psd: [] };
  const hop = win >> 1;
  const bins = win / 2 + 1;
  const acc = new Float64Array(bins);
  let blocks = 0;
  const w = new Float64Array(win);
  let wsum = 0;
  for (let i = 0; i < win; i++) {
    w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (win - 1));
    wsum += w[i] * w[i];
  }
  for (let start = 0; start + win <= n; start += hop) {
    const re = new Float64Array(win);
    const im = new Float64Array(win);
    let mean = 0;
    for (let i = 0; i < win; i++) mean += samples[start + i];
    mean /= win;
    for (let i = 0; i < win; i++) re[i] = (samples[start + i] - mean) * w[i];
    fft(re, im);
    for (let k = 0; k < bins; k++) acc[k] += (re[k] * re[k] + im[k] * im[k]) / (hz * wsum);
    blocks++;
  }
  const freqs = Array.from({ length: bins }, (_, k) => (k * hz) / win);
  const out = Array.from(acc, (v) => v / Math.max(1, blocks));
  return { freqs, psd: out };
}

const BANDS = [
  ["0-10 Hz", 0, 10],
  ["10-25 Hz", 10, 25],
  ["25-45 Hz", 25, 45],
  ["45-90 Hz", 45, 90],
  ["90+ Hz", 90, Infinity],
];

function bandPowers({ freqs, psd }, nyq) {
  const out = BANDS.map(() => 0);
  for (let k = 0; k < freqs.length; k++) {
    for (let b = 0; b < BANDS.length; b++) {
      if (freqs[k] >= BANDS[b][1] && freqs[k] < BANDS[b][2]) {
        out[b] += psd[k];
        break;
      }
    }
  }
  const total = out.reduce((a, b) => a + b, 0) || 1;
  const db = out.map((v, b) => {
    const width = Math.max(1, Math.min(BANDS[b][2], nyq) - BANDS[b][1]);
    return 10 * Math.log10(v / width + 1e-30);
  });
  return { abs: out, pct: out.map((v) => (100 * v) / total), db };
}

function roughness(x) {
  let s = 0;
  for (let i = 1; i < x.length - 1; i++) {
    const d = x[i + 1] - 2 * x[i] + x[i - 1];
    s += d * d;
  }
  return Math.sqrt(s / Math.max(1, x.length - 2));
}

function stats(x) {
  let mean = 0;
  for (const v of x) mean += v;
  mean /= x.length;
  let varr = 0;
  let maxAbs = 0;
  for (const v of x) {
    varr += (v - mean) * (v - mean);
    maxAbs = Math.max(maxAbs, Math.abs(v));
  }
  return { mean, std: Math.sqrt(varr / x.length), maxAbs };
}

const results = [];
for (const file of files) {
  const raw = JSON.parse(readFileSync(file, "utf8"));
  const samples = Array.isArray(raw.samples) ? raw.samples : [];
  if (samples.length < 128) {
    console.log(`${file}: not enough samples (${samples.length}) — drive with a wheel open first.`);
    continue;
  }
  const t = samples.map((s) => s.t);
  const torque = samples.map((s) => s.torque);
  const lat = samples.map((s) => s.lat);
  const duration = t[t.length - 1] - t[0];
  const hz = (t.length - 1) / duration;
  const gain = stats(torque);
  const bands = bandPowers(psd(torque, hz), hz / 2);
  results.push({ file, raw, samples, duration, hz, gain, bands });
}

const F = (v, d = 2) => v.toFixed(d).padStart(8);

console.log("\nFFB trace analysis  (torque = what the wheel received)\n");
for (const r of results) {
  console.log(`${r.file}`);
  console.log(`  duration ${r.duration.toFixed(1)} s · ${r.samples.length} samples · measured ${r.hz.toFixed(1)} Hz (nominal ${r.raw.hz})`);
  console.log(`  torque mean ${F(r.gain.mean, 3)} · std ${F(r.gain.std, 3)} · peak |t| ${F(r.gain.maxAbs, 3)}`);
  console.log(`  roughness (RMS 2nd difference) ${F(roughness(r.samples.map((s) => s.torque)), 5)}`);
  console.log(`  input |lat force| mean ${F(r.samples.reduce((a, s) => a + Math.abs(s.lat), 0) / r.samples.length, 1)} N`);
  console.log("  band            " + BANDS.map(([n]) => n.padStart(9)).join(" "));
  console.log("  power %         " + r.bands.pct.map((v) => F(v, 1)).join(" "));
  console.log("  mean PSD dB     " + r.bands.db.map((v) => F(v, 1)).join(" "));
  console.log("");
}

if (results.length === 2) {
  const [a, b] = results;
  console.log("Cubic vs Linear style comparison (B relative to A):");
  for (let i = 0; i < BANDS.length; i++) {
    const pa = a.bands.pct[i];
    const pb = b.bands.pct[i];
    const d = b.bands.db[i] - a.bands.db[i];
    console.log(
      `  ${BANDS[i][0].padEnd(9)} A ${F(pa, 1)}%  B ${F(pb, 1)}%  ${d >= 0 ? "+" : ""}${d.toFixed(1)} dB`,
    );
  }
  console.log("  (a cubic/linear switch should move the >25 Hz bands down, not the <10 Hz weight)");
}
