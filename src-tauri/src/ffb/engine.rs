//! The FFB compute + real-time output loop. `Engine::compute` is a behavioural
//! port of the C++ `FFBEngine::compute` (`ffb_engine.cpp:93-468`). All SDL usage
//! (via `WheelOutput`) stays on this one thread.
//!
//! **The output loop free-runs on a fixed clock, deliberately decoupled from the
//! telemetry rate.** The game sends UDP at ~60 Hz, and pinning output to those
//! packets held each force value for a whole frame — a staircase on a
//! direct-drive wheel. `compute` reloads the latest snapshot every tick, so the
//! data is always current while the OUTPUT cadence (and every filter inside
//! `compute`) runs at `ffb_update_hz`.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, SyncSender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use arc_swap::ArcSwap;
use serde::Serialize;

use super::settings::{
    clampf, signf, FfbSettings, FfbSignals, InterpMode, FFB_MAX_HZ, FFB_MIN_HZ, FFB_REARM_MS,
};
use super::wheel::{DeviceInfo, WheelOutput};
use crate::telemetry::state::{mono_secs, now_ms, AppStats, FfbFrame, FfbTelemetry, FFB_PAUSE_FREEZE_MS};
use crate::telemetry::SharedTelemetry;

// Session-type helpers (from C++ `types.h`).
fn session_has_ai_lap_start(t: u8) -> bool {
    t == 9 || t == 14 || t == 18 // One-Shot Q, One-Shot Shootout, Time Trial
}

const PI: f32 = std::f32::consts::PI;

/// How recent a UDP packet has to be for the game to count as "sending".
const TELE_LIVE_MS: i64 = 2_000;
/// How long telemetry must have been quiet before it resuming counts as the
/// game starting up rather than a lull between sessions.
const TELE_COLD_MS: i64 = 30_000;

/// The last slice of each output tick is a CPU spin rather than a sleep: no
/// Windows wait primitive returns exactly on a sub-millisecond deadline, and
/// the residual jitter is amplitude noise on a direct-drive wheel. The guard
/// bounds the cost (~5% of a core at 200 Hz, ~9% at 360 Hz).
const WAIT_SPIN_GUARD: Duration = Duration::from_micros(250);

/// Normalised slip + grip cues, shared by the force computation and the UI
/// gauges so the arc gauges always display exactly what the wheel feels.
/// Returns (front_norm, rear_norm, understeer, oversteer).
fn grip_cues(t: &FfbTelemetry) -> (f32, f32, f32, f32) {
    let slip_scale = 8.0 * (PI / 180.0);
    let front_norm = clampf(t.front_slip_angle / slip_scale, 0.0, 1.0);
    let rear_norm = clampf(t.rear_slip_angle / slip_scale, 0.0, 1.0);
    let understeer = clampf(front_norm - rear_norm * 0.5, 0.0, 1.0);
    let oversteer = clampf(rear_norm - front_norm * 0.3, 0.0, 1.0);
    (front_norm, rear_norm, understeer, oversteer)
}

/// Has the game's physics frame gone stale (paused, or no frames arriving)?
/// Shared by the safety release in `compute` and the run-state gauge so the two
/// can never drift apart on what counts as frozen.
#[inline]
fn frames_frozen(stats: &AppStats, now: i64) -> bool {
    let adv = stats.last_frame_advance_ms.load(Ordering::Relaxed);
    adv == 0 || (now - adv > FFB_PAUSE_FREEZE_MS)
}

/// First-order EMA coefficient for a step `dt` at time constant `tau`. This is
/// the exact zero-order-hold discretisation (`1 - e^(-dt/tau)`), so a filter
/// stepped at 60 Hz and one stepped at 360 Hz have the SAME effective time
/// constant and land in the same place after the same wall time. The cheaper
/// `dt/(tau+dt)` is only first-order accurate — its time constant drifts with
/// the tick rate, which is exactly what free-running the output loop exposes.
#[inline]
fn ema_alpha(dt: f32, tau: f32) -> f32 {
    if tau > 1e-5 {
        clampf(1.0 - (-dt / tau).exp(), 0.0, 1.0)
    } else {
        1.0
    }
}

/// Cap on forward projection past the newest sample, as a fraction of a frame,
/// so a noisy sample can never be extrapolated into a larger spike.
const INTERP_EXTRAP_MAX_FRAC: f32 = 0.5;
/// After this many frames with no new physics frame the game has paused or
/// stopped sending: hold the last value instead of projecting.
const INTERP_STALE_FRAMES: f32 = 4.0;
/// Physics frames the reconstructor retains. Four gives the cubic a neighbour
/// on both sides of every knot the render time can reach.
const PREDICTOR_FRAMES: usize = 4;
/// Game-clock intervals outside this multiple of the local estimate are treated
/// as a clock reset (lap/session boundary) or a dropped frame; that interval
/// falls back to arrival timing.
const CLOCK_MIN_FRAC: f32 = 0.25;
const CLOCK_MAX_FRAC: f32 = 2.5;
const NOMINAL_FRAME_S: f32 = 1.0 / 60.0;
/// Channels in `FfbTelemetry` — the reconstructor works on a flat array so one
/// cubic routine serves every channel.
const CHANNELS: usize = 13;

fn channels(t: &FfbTelemetry) -> [f32; CHANNELS] {
    [
        t.lateral_g,
        t.front_slip_angle,
        t.rear_slip_angle,
        t.front_lat_force,
        t.front_lon_force,
        t.front_vert_force,
        t.sideslip,
        t.front_slip_ratio,
        t.rear_slip_ratio,
        t.speed_kmh,
        t.steer,
        t.throttle,
        t.brake,
    ]
}

fn from_channels(v: [f32; CHANNELS]) -> FfbTelemetry {
    FfbTelemetry {
        lateral_g: v[0],
        front_slip_angle: v[1],
        rear_slip_angle: v[2],
        front_lat_force: v[3],
        front_lon_force: v[4],
        front_vert_force: v[5],
        sideslip: v[6],
        front_slip_ratio: v[7],
        rear_slip_ratio: v[8],
        speed_kmh: v[9],
        steer: v[10],
        throttle: v[11],
        brake: v[12],
    }
}

/// `a + (b - a) * f` between the two knots surrounding `t`; past the newest
/// knot the last secant continues (the original projection behaviour).
fn linear_at(ts: &[f32], ys: &[f32], t: f32) -> f32 {
    let n = ts.len();
    if n == 0 || t <= ts[0] {
        return ys.first().copied().unwrap_or(0.0);
    }
    if n == 1 {
        return ys[0];
    }
    let mut k = 0usize;
    while k + 1 < n - 1 && ts[k + 1] < t {
        k += 1;
    }
    let h = ts[k + 1] - ts[k];
    let u = if h.abs() > 1e-9 { (t - ts[k]) / h } else { 0.0 };
    ys[k] + (ys[k + 1] - ys[k]) * u
}

/// Monotone cubic Hermite (Fritsch–Carlson/PCHIP): exact at every knot, C1
/// across them, and no overshoot between. That is what removes the per-frame
/// slope kink a linear blend leaves behind — jerk the two-pole smoother only
/// partly buries.
/// The half of a PCHIP evaluation that depends only on the KNOT TIMES and the
/// query point — not on any channel's values.
///
/// Every one of the CHANNELS is evaluated at the same `ts` and the same `t`, so
/// without this the knot-segment search, the knot spacings, the interior tangent
/// weights and the four Hermite basis coefficients were all recomputed 13 times
/// per output tick, at up to 360 Hz. Build it once, then call
/// `pchip_at_with` per channel.
struct PchipBasis {
    n: usize,
    k: usize,
    /// Spacing of each span: `hs[i] == ts[i + 1] - ts[i]`.
    hs: [f32; PREDICTOR_FRAMES],
    /// Fritsch-Carlson weights for each interior knot.
    w1: [f32; PREDICTOR_FRAMES],
    w2: [f32; PREDICTOR_FRAMES],
    u: f32,
    /// Hermite basis coefficients for ys[k], m[k], ys[k+1], m[k+1].
    b_y0: f32,
    b_m0: f32,
    b_y1: f32,
    b_m1: f32,
}

impl PchipBasis {
    /// `None` when there is nothing to interpolate (no knots, one knot, or a
    /// query at/before the first knot) — the caller answers those directly from
    /// `ys`, exactly as the original single-shot function did.
    fn build(ts: &[f32], t: f32) -> Option<Self> {
        let n = ts.len();
        if n == 0 || n == 1 || t <= ts[0] {
            return None;
        }
        let mut hs = [0.0f32; PREDICTOR_FRAMES];
        for i in 0..n - 1 {
            hs[i] = ts[i + 1] - ts[i];
        }
        let mut w1 = [0.0f32; PREDICTOR_FRAMES];
        let mut w2 = [0.0f32; PREDICTOR_FRAMES];
        for i in 1..n - 1 {
            let h0 = hs[i - 1];
            let h1 = hs[i];
            w1[i] = 2.0 * h1 + h0;
            w2[i] = h1 + 2.0 * h0;
        }
        let mut k = 0usize;
        while k + 1 < n - 1 && ts[k + 1] < t {
            k += 1;
        }
        let h = hs[k];
        let u = if h.abs() > 1e-9 { (t - ts[k]) / h } else { 0.0 };
        let u2 = u * u;
        let u3 = u2 * u;
        Some(Self {
            n,
            k,
            hs,
            w1,
            w2,
            u,
            b_y0: 2.0 * u3 - 3.0 * u2 + 1.0,
            b_m0: (u3 - 2.0 * u2 + u) * h,
            b_y1: -2.0 * u3 + 3.0 * u2,
            b_m1: (u3 - u2) * h,
        })
    }
}

/// Evaluate one channel against a prebuilt basis. The secants, the tangents and
/// the monotonicity limiter are the only parts that genuinely depend on `ys`.
fn pchip_at_with(b: &PchipBasis, ys: &[f32]) -> f32 {
    let n = b.n;
    let mut secant = [0.0f32; PREDICTOR_FRAMES];
    for i in 0..n - 1 {
        let h = b.hs[i];
        secant[i] = if h.abs() > 1e-9 { (ys[i + 1] - ys[i]) / h } else { 0.0 };
    }
    let mut m = [0.0f32; PREDICTOR_FRAMES];
    for i in 1..n - 1 {
        let (s0, s1) = (secant[i - 1], secant[i]);
        if s0 * s1 <= 0.0 {
            m[i] = 0.0;
        } else {
            let (w1, w2) = (b.w1[i], b.w2[i]);
            m[i] = (w1 + w2) / (w1 / s0 + w2 / s1);
        }
    }
    m[0] = secant[0];
    m[n - 1] = secant[n - 2];
    for i in 0..n - 1 {
        let s = secant[i];
        if s.abs() < 1e-12 {
            m[i] = 0.0;
            m[i + 1] = 0.0;
            continue;
        }
        let a = m[i] / s;
        let bb = m[i + 1] / s;
        let q = a * a + bb * bb;
        if q > 9.0 {
            let tau = 3.0 / q.sqrt();
            m[i] = tau * a * s;
            m[i + 1] = tau * bb * s;
        }
    }
    let k = b.k;
    let y = b.b_y0 * ys[k] + b.b_m0 * m[k] + b.b_y1 * ys[k + 1] + b.b_m1 * m[k + 1];
    if b.u > 1.0 {
        let lo = ys[n - 2].min(ys[n - 1]);
        let hi = ys[n - 2].max(ys[n - 1]);
        let d = hi - lo;
        return y.clamp(lo - 0.5 * d, hi + 0.5 * d);
    }
    y.clamp(ys[k].min(ys[k + 1]), ys[k].max(ys[k + 1]))
}

/// Single-shot convenience wrapper: build the basis and evaluate one channel.
///
/// The hot path uses `PchipBasis::build` once and `pchip_at_with` per channel
/// instead, so nothing in the engine calls this — but it composes exactly those
/// two pieces, which is what lets the unit tests exercise the real reconstruction
/// without reproducing the per-tick plumbing.
#[allow(dead_code)]
fn pchip_at(ts: &[f32], ys: &[f32], t: f32) -> f32 {
    match PchipBasis::build(ts, t) {
        None => {
            if ts.is_empty() {
                0.0
            } else {
                ys[0]
            }
        }
        Some(b) => pchip_at_with(&b, ys),
    }
}

#[derive(Clone, Copy, Default)]
struct PredictorSample {
    ch: [f32; CHANNELS],
    session_time: Option<f32>,
    arrival_s: f64,
    span: f32,
}

/// Turns the game's ~60 Hz physics frames into a continuous input for the
/// fixed-rate output loop.
///
/// The loop already runs faster than the game (see `ffb_thread`), but without
/// this every input it read was a value that changed once per packet and was
/// then held. A low-pass turns those steps into a curve, but leaves a KINK in
/// its slope at every packet boundary — jerk, which a direct-drive base reads as
/// grain, worst at centre where the useful force is smallest. A C1, overshoot-
/// free cubic through the four most recent frames removes the kink outright,
/// and the game's own session clock spaces the knots exactly instead of
/// trusting when each packet happened to land on this machine.
struct TelemetryPredictor {
    ring: [PredictorSample; PREDICTOR_FRAMES],
    head: usize,
    count: usize,
    /// Arrival-time interval estimate, used when the game clock is absent
    /// (demo) or unusable (a lap/session boundary, dropped frame).
    span_lp: f32,
    /// Did the newest interval come from the game clock?
    game_clock: bool,
}

impl TelemetryPredictor {
    fn new() -> TelemetryPredictor {
        TelemetryPredictor {
            ring: [PredictorSample::default(); PREDICTOR_FRAMES],
            head: PREDICTOR_FRAMES - 1,
            count: 0,
            span_lp: 0.0,
            game_clock: false,
        }
    }

    /// Record a freshly parsed physics frame.
    fn push(&mut self, frame: &FfbFrame) {
        let mut span = 0.0f32;
        let mut game = false;
        if self.count > 0 {
            let newest = &self.ring[self.head];
            let arrival = (frame.arrival_s - newest.arrival_s) as f32;
            if arrival > 1e-4 && arrival < 0.5 {
                self.span_lp = if self.span_lp <= 1e-4 {
                    arrival
                } else {
                    self.span_lp * 0.8 + arrival * 0.2
                };
            }
            let nominal = if self.span_lp > 1e-4 { self.span_lp } else { NOMINAL_FRAME_S };
            if let (Some(t_new), Some(t_old)) = (frame.session_time, newest.session_time) {
                let dt = t_new - t_old;
                if dt > CLOCK_MIN_FRAC * nominal && dt < CLOCK_MAX_FRAC * nominal {
                    span = dt;
                    game = true;
                }
            }
            if !game {
                span = self.span_lp;
            }
        }
        self.game_clock = game;
        self.head = (self.head + 1) % PREDICTOR_FRAMES;
        self.ring[self.head] = PredictorSample {
            ch: channels(&frame.telem),
            session_time: frame.session_time,
            arrival_s: frame.arrival_s,
            span,
        };
        self.count = (self.count + 1).min(PREDICTOR_FRAMES);
    }

    /// The input to drive the wheel with at monotonic time `now_s`.
    fn at(&self, now_s: f64, mode: InterpMode, delay_frac: f32) -> FfbTelemetry {
        if self.count == 0 {
            return FfbTelemetry::default();
        }
        let newest = &self.ring[self.head];
        if self.count == 1 {
            return from_channels(newest.ch);
        }
        let span = if newest.span > 1e-4 { newest.span } else { self.span_lp };
        if span <= 1e-4 {
            return from_channels(newest.ch);
        }
        let age = ((now_s - newest.arrival_s) as f32).max(0.0);
        if age > span * INTERP_STALE_FRAMES {
            return from_channels(newest.ch);
        }

        let delay = span * clampf(delay_frac, 0.0, 1.0);
        let mut t_rel = age - delay;
        let lead_cap = span * INTERP_EXTRAP_MAX_FRAC;
        if t_rel > lead_cap {
            t_rel = lead_cap;
        }

        let n = self.count;
        let mut chs = [[0.0f32; CHANNELS]; PREDICTOR_FRAMES];
        for i in 0..n {
            let j = n - 1 - i;
            chs[i] = self.ring[(self.head + PREDICTOR_FRAMES - j) % PREDICTOR_FRAMES].ch;
        }
        let mut ts = [0.0f32; PREDICTOR_FRAMES];
        for i in (0..n - 1).rev() {
            let j = n - 2 - i;
            let newer = &self.ring[(self.head + PREDICTOR_FRAMES - j) % PREDICTOR_FRAMES];
            ts[i] = ts[i + 1] - newer.span.max(1e-4);
        }
        if t_rel < ts[0] {
            t_rel = ts[0];
        }

        // Built ONCE for all channels — they share `ts` and `t_rel`, and this is
        // the knot search plus the Hermite basis, i.e. most of the per-call work.
        let basis = if mode == InterpMode::Linear {
            None
        } else {
            PchipBasis::build(&ts[..n], t_rel)
        };
        let mut out = [0.0f32; CHANNELS];
        for c in 0..CHANNELS {
            let mut ys = [0.0f32; PREDICTOR_FRAMES];
            for i in 0..n {
                ys[i] = chs[i][c];
            }
            out[c] = if mode == InterpMode::Linear {
                linear_at(&ts[..n], &ys[..n], t_rel)
            } else if let Some(b) = &basis {
                pchip_at_with(b, &ys[..n])
            } else {
                // Degenerate (no knots / one knot / query at or before the first):
                // the same answer pchip_at gives, without rebuilding the basis.
                ys[0]
            };
        }
        from_channels(out)
    }
}

/// Live meters for the tab's monitor column (serialized to `ffb_gauges`). Mirrors
/// the data the original app's left column showed: output signals, grip cues, the
/// telemetry grid and driver inputs — so the FFB tab is self-contained.
#[derive(Clone, Copy, PartialEq, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct FfbGauges {
    // Output signals.
    pub torque: f32,
    pub friction: f32,
    pub rumble: f32,
    pub rumble_hz: f32,
    pub clip: f32,
    // Grip cues (arc gauges).
    pub understeer: f32,
    pub oversteer: f32,
    pub front_slip: f32,
    pub rear_slip: f32,
    // Telemetry grid.
    pub speed: f32,
    pub lateral_g: f32,
    pub front_force: f32,
    pub vert_load: f32,
    pub sideslip_deg: f32,
    pub front_slip_ratio: f32,
    pub rear_slip_ratio: f32,
    pub peak_force: f32,
    // Driver inputs.
    pub throttle: f32,
    pub brake: f32,
    pub steer: f32,
    // Status.
    pub udp_packets: u64,
    pub session_type: u8,
    pub driver_status: u8,
    pub pit_status: u8,
    pub ai_control: bool,
    // 0 waiting · 1 driving · 2 paused/menu · 3 AI driving · 4 AI start hold.
    pub run_state: u8,
    // Rates and timing diagnostics.
    pub udp_hz: f32,
    pub motion_hz: f32,
    pub ffb_hz: f32,
    pub tick_late_us: f32,
    pub tick_max_late_us: f32,
    pub frame_identifier: u32,
    /// True while the reconstructor is spacing knots by the game's own session
    /// clock; false means it fell back to packet arrival times.
    pub game_clock: bool,
}

/// Ring capacity: ~45 s of output at 360 Hz, ~80 s at 200 Hz.
const TRACE_CAP: usize = 16_384;

/// One tick of the output the wheel actually received, for offline spectral
/// analysis (`scripts/analyze-ffb-trace.mjs`). Deliberately small and `Copy`.
#[derive(Clone, Copy, Default, Serialize)]
pub struct TraceSample {
    /// Seconds since the first recorded sample.
    pub t: f32,
    pub lat: f32,
    pub steer: f32,
    pub torque: f32,
}

#[derive(Serialize)]
pub struct TraceDump {
    pub hz: f32,
    /// Oldest first, so a consumer can treat it as a plain time series.
    pub samples: Vec<TraceSample>,
}

/// Bounded history of the FFB output. The real-time thread only ever
/// `try_lock`s it, so a reader copying a trace can never stall a tick.
pub struct FfbTrace {
    samples: Vec<TraceSample>,
    head: usize,
    origin_s: f64,
}

impl Default for FfbTrace {
    /// Allocate the whole ring UP FRONT, once, off the real-time thread.
    ///
    /// `Vec::new()` meant the first TRACE_CAP samples grew by doubling — ~15
    /// reallocations, the last a 256 KiB malloc + memcpy — on the thread running
    /// at THREAD_PRIORITY_TIME_CRITICAL, inside a 2.8 ms tick, while holding the
    /// trace mutex. That covered the first 45-80 s after a wheel opened, which is
    /// exactly when someone would be capturing an A/B trace.
    fn default() -> Self {
        Self {
            samples: Vec::with_capacity(TRACE_CAP),
            head: 0,
            origin_s: 0.0,
        }
    }
}

impl FfbTrace {
    pub fn record(&mut self, now_s: f64, telem: &FfbTelemetry, torque: f32) {
        if self.origin_s <= 0.0 {
            self.origin_s = now_s;
        }
        let s = TraceSample {
            t: (now_s - self.origin_s) as f32,
            lat: telem.front_lat_force,
            steer: telem.steer,
            torque,
        };
        if self.samples.len() < TRACE_CAP {
            self.samples.push(s);
        } else {
            self.samples[self.head] = s;
            self.head = (self.head + 1) % TRACE_CAP;
        }
    }

    /// `fallback_hz` is only used when the trace is too short to measure.
    ///
    /// The rate is DERIVED from the samples' own timestamps rather than taken
    /// from the setting, because the setting can have changed since they were
    /// recorded — and A/B-ing one output rate against another is the whole
    /// reason this export exists, so trusting the live value mislabelled exactly
    /// the comparison being made and shifted every band in the PSD that
    /// `scripts/analyze-ffb-trace.mjs` prints.
    pub fn snapshot(&self, fallback_hz: f32) -> TraceDump {
        let mut samples = Vec::with_capacity(self.samples.len());
        if self.samples.len() < TRACE_CAP {
            samples.extend_from_slice(&self.samples);
        } else {
            samples.extend_from_slice(&self.samples[self.head..]);
            samples.extend_from_slice(&self.samples[..self.head]);
        }
        let span = match (samples.first(), samples.last()) {
            (Some(a), Some(b)) => b.t - a.t,
            _ => 0.0,
        };
        let hz = if samples.len() > 1 && span > 1e-3 {
            (samples.len() - 1) as f32 / span
        } else {
            fallback_hz
        };
        TraceDump { hz, samples }
    }
}

/// Device/connection state for the tab (serialized to `ffb_status`).
#[derive(Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct FfbStatus {
    pub device_open: bool,
    /// Open AND actually producing force. `device_open` alone can't say: another
    /// app acquiring the wheel stops our effects behind a still-valid handle,
    /// so a green light keyed on `device_open` lies until the driver notices
    /// there is no FFB. See `WheelOutput::poll_health`.
    pub healthy: bool,
    pub device_name: Option<String>,
    pub active_index: i32,
    pub enabled: bool,
    pub error: String,
}

/// Commands the tab issues that must run on the SDL/FFB thread. Each device op
/// carries a reply channel so the Tauri command can return the result.
pub enum FfbCommand {
    Enumerate(SyncSender<Vec<DeviceInfo>>),
    Open(i32, SyncSender<Result<String, String>>),
    Close,
    ResetPeak,
}

/// Shared handle the app holds: push settings, read gauges/status, send commands.
pub struct FfbHandle {
    pub settings: ArcSwap<FfbSettings>,
    pub gauges: ArcSwap<FfbGauges>,
    pub status: ArcSwap<FfbStatus>,
    pub enabled: AtomicBool,
    pub cmd_tx: SyncSender<FfbCommand>,
    pub running: Arc<AtomicBool>,
    pub trace: Mutex<FfbTrace>,
}

// ── The per-loop compute state (C++ `FFBEngine` members) ──
struct Engine {
    smooth_torque: f32,
    /// Second pole of the torque smoother (see `compute`). One pole is not
    /// enough to bury the game's ~60 Hz force grain without adding lag; a
    /// critically-damped two-pole cascade has the same low-frequency group delay
    /// as a single pole but rolls off twice as fast.
    smooth_torque2: f32,
    smooth_friction: f32,
    smooth_rumble: f32,
    rumble_hz: f32,
    soft_gain: f32,
    clip_ema: f32,
    /// Previous emitted torque, for the optional slew-rate limit (10b).
    last_out_torque: f32,
    prev_steer: f32,
    steer_vel_lp: f32,
    lat_force_lp: f32,
    prev_session_type: u8,
    prev_lap_dist: f32,
    prev_streak: i64,
    last_drop_ms: i64,
    tt_hold_until_ms: i64,
    tt_check_ms: i64,
    tt_pending: bool,
}

impl Engine {
    fn new() -> Engine {
        Engine {
            smooth_torque: 0.0,
            smooth_torque2: 0.0,
            smooth_friction: 0.0,
            smooth_rumble: 0.0,
            rumble_hz: 20.0,
            soft_gain: 0.0,
            clip_ema: 0.0,
            last_out_torque: 0.0,
            prev_steer: 0.0,
            steer_vel_lp: 0.0,
            lat_force_lp: 0.0,
            prev_session_type: 0,
            prev_lap_dist: 0.0,
            prev_streak: 0,
            last_drop_ms: 0,
            tt_hold_until_ms: 0,
            tt_check_ms: 0,
            tt_pending: false,
        }
    }

    /// Reset the Auto-Max-Force peak tracker. Clearing the lateral-force LP
    /// alongside the atomic matters: compute() re-publishes any peak above the
    /// stored one, so a stale LP value would instantly undo the reset.
    fn reset_peak(&mut self, stats: &AppStats) {
        self.lat_force_lp = 0.0;
        stats.set_peak_lat_force(0.0);
    }

    /// Zero everything and re-arm the ramps (the safety-release path).
    fn release(&mut self, stats: &AppStats, steer: f32) {
        self.smooth_torque = 0.0;
        self.smooth_torque2 = 0.0;
        self.smooth_friction = 0.0;
        self.smooth_rumble = 0.0;
        self.soft_gain = 0.0;
        self.clip_ema = 0.0;
        self.last_out_torque = 0.0;
        self.prev_steer = steer;
        self.steer_vel_lp = 0.0;
        self.lat_force_lp = 0.0;
        stats.set_clip_level(0.0);
        // The run-state flags are only ever SET inside compute(), which doesn't
        // run on this path — so without clearing them here they latch. Closing
        // the device (or flipping the master off) during an out-lap the car had
        // been placed into pinned the FFB tab's lamp to "AI driving" for the
        // rest of the process, hiding every real state afterwards.
        stats.ai_run_up_held.store(false, Ordering::Relaxed);
        stats.tt_holding.store(false, Ordering::Relaxed);
    }

    fn compute(
        &mut self,
        s: &FfbTelemetry,
        c: &FfbSettings,
        stats: &AppStats,
        now: i64,
        dt: f32,
    ) -> FfbSignals {
        // Diagnostic: steady test force bypasses all physics. The steering
        // state is still advanced so the first real tick after the test doesn't
        // see a minutes-old rate and spike the braking damper; `last_out_torque`
        // follows the emitted value so the slew limiter resumes from where the
        // test left the wheel.
        // The max-output safety cap applies to a test force too. Bypassing the
        // PHYSICS is the point of the diagnostic; bypassing the number the
        // driver set to protect themselves is not — on a strong base, "Max
        // Output 10%" has to mean 10% even here.
        let test_cap = clampf(c.max_output, 0.0, 1.0);
        // Both test paths return before the safety block that maintains these,
        // so clear them here or they latch exactly as they do on release().
        // Neither "AI driving" nor "holding at the line" is true of a bench test.
        if c.test_force.abs() > 0.001 || c.test_rumble > 0.001 {
            stats.ai_run_up_held.store(false, Ordering::Relaxed);
            stats.tt_holding.store(false, Ordering::Relaxed);
        }
        if c.test_force.abs() > 0.001 {
            let t = clampf(c.test_force, -test_cap, test_cap);
            self.smooth_torque = t;
            // smooth_torque2 is the pole the OUTPUT reads (step 10), so it has to
            // be seeded too. Leaving it stale meant the first real tick after the
            // test button was released stepped from the test value toward
            // whatever was loaded when the test began — from a held -0.8 to a
            // +0.25 test force, that lands at -0.21 in ONE tick: a 0.46
            // full-scale reversal with soft_gain already at 1.0 and no slew
            // limit by default.
            self.smooth_torque2 = t;
            self.smooth_friction = 0.0;
            self.smooth_rumble = 0.0;
            self.prev_steer = s.steer;
            self.last_out_torque = t;
            return FfbSignals { torque: t, friction: 0.0, rumble: 0.0, rumble_hz: self.rumble_hz };
        }
        if c.test_rumble > 0.001 {
            let r = clampf(c.test_rumble, 0.0, test_cap);
            self.smooth_torque = 0.0;
            self.smooth_torque2 = 0.0;
            self.smooth_friction = 0.0;
            self.smooth_rumble = r;
            self.prev_steer = s.steer;
            self.last_out_torque = 0.0;
            return FfbSignals { torque: 0.0, friction: 0.0, rumble: r, rumble_hz: c.lockup_hz };
        }

        // ── SAFETY: release unless the car is actively being driven ──
        {
            let streak = stats.frame_streak_start_ms.load(Ordering::Relaxed);
            let frozen = frames_frozen(stats, now);
            let rearming = now - streak < FFB_REARM_MS;
            let paused = stats.game_paused.load(Ordering::Relaxed);

            // Flying-lap run-up: hold, then release approaching the S/F line.
            let ai_run_up_raw = stats.ai_run_up.load(Ordering::Relaxed);
            let mut ai_run_up_held = ai_run_up_raw;
            if ai_run_up_raw {
                let ld = stats.get_lap_distance();
                let tl = stats.track_length_m.load(Ordering::Relaxed) as f32;
                let dist_to_line = if ld < 0.0 {
                    -ld
                } else if tl > 1.0 {
                    tl - ld
                } else {
                    1e9
                };
                ai_run_up_held = dist_to_line > c.run_up_release_m;
            }
            stats.ai_run_up_held.store(ai_run_up_held, Ordering::Relaxed);

            let ai_driving = stats.ai_in_control.load(Ordering::Relaxed)
                || ai_run_up_held
                || stats.ai_controls_car.load(Ordering::Relaxed);

            // AI start hold (Time Trial / one-shot & hot-lap qualifying).
            let sess = stats.session_type.load(Ordering::Relaxed);
            let ai_start_mode = session_has_ai_lap_start(sess);
            let entered_mode = ai_start_mode && !session_has_ai_lap_start(self.prev_session_type);
            self.prev_session_type = sess;

            let lap_dist = stats.get_lap_distance();
            let dropped = lap_dist < self.prev_lap_dist - 100.0;
            self.prev_lap_dist = lap_dist;
            let rearmed = streak != self.prev_streak;
            self.prev_streak = streak;
            if dropped {
                self.last_drop_ms = now;
            }

            let mut tt_hold = false;
            if ai_start_mode && c.tt_start_hold_sec > 0.01 {
                if rearmed || entered_mode {
                    self.tt_hold_until_ms = now + (c.tt_start_hold_sec * 1000.0) as i64;
                    self.tt_check_ms = now + 2500;
                    self.tt_pending = true;
                }
                if self.tt_pending && now >= self.tt_check_ms {
                    self.tt_pending = false;
                    let recent_reset = (now - self.last_drop_ms) < 2700;
                    if !recent_reset && lap_dist > 250.0 {
                        self.tt_hold_until_ms = 0;
                    }
                }
                tt_hold = now < self.tt_hold_until_ms;
            }
            stats.tt_holding.store(tt_hold, Ordering::Relaxed);

            if frozen || rearming || paused || ai_driving || tt_hold {
                self.release(stats, s.steer);
                return FfbSignals { torque: 0.0, friction: 0.0, rumble: 0.0, rumble_hz: self.rumble_hz };
            }
        }

        // ── Auto Max Force: peak sustained front lateral force (~100 ms LP) ──
        {
            // Same exact EMA form as every other filter here: the old
            // `dt / (tau + dt)` was first-order only, so the 100 ms attack —
            // and with it the peak the panel reports — moved with the output
            // rate the loop free-runs at.
            let a_f = ema_alpha(dt, 0.10);
            self.lat_force_lp += a_f * (s.front_lat_force.abs() - self.lat_force_lp);
            if self.lat_force_lp > stats.get_peak_lat_force() {
                stats.set_peak_lat_force(self.lat_force_lp);
            }
        }

        let speed = s.speed_kmh;
        let speed_factor = clampf((speed - c.min_speed_kmh) / 20.0, 0.0, 1.0);

        // ── 1. Base torque: front tyre lateral force ──
        let max_force_n = if c.max_force_n > 1.0 { c.max_force_n } else { 1.0 };
        let mut base_torque = clampf(s.front_lat_force / max_force_n, -1.0, 1.0);
        if c.invert_force {
            base_torque = -base_torque;
        }

        // ── 1b. Load-sensitive steering weight (optional) ──
        if c.load_sensitivity > 1e-4 && c.load_ref_n > 1.0 {
            const LOAD_FLOOR: f32 = 0.4;
            let load_norm = clampf(s.front_vert_force / c.load_ref_n, 0.0, 1.0);
            let load_mul = LOAD_FLOOR + (1.0 - LOAD_FLOOR) * load_norm;
            base_torque *= 1.0 + c.load_sensitivity * (load_mul - 1.0);
        }

        // ── 2. Slip angles → grip-loss signals ──
        let (front_norm, rear_norm, understeer, oversteer) = grip_cues(s);

        let mut torque = base_torque;

        // ── 2b. Peak load-up emphasis (optional) ──
        if c.peak_emphasis > 1e-4 {
            let bump = clampf(1.0 - (front_norm - 0.75).abs() / 0.55, 0.0, 1.0);
            torque *= 1.0 + c.peak_emphasis * 0.30 * bump;
        }

        // ── 3. Extra understeer lightening ──
        const US_DEADZONE: f32 = 0.65;
        const US_AUTHORITY: f32 = 0.6;
        let us_past = clampf((understeer - US_DEADZONE) / (1.0 - US_DEADZONE), 0.0, 1.0);
        let us_reduction = us_past * us_past * c.understeer_strength * c.grip_loss_strength * US_AUTHORITY;
        torque *= clampf(1.0 - us_reduction, 0.0, 1.0);

        // ── 4. Oversteer counter-steer cue from sideslip ──
        let sideslip_scale = 12.0 * (PI / 180.0);
        let mut slip_cue = clampf(s.sideslip / sideslip_scale, -1.0, 1.0);
        if c.invert_force {
            slip_cue = -slip_cue;
        }
        torque += slip_cue * oversteer * c.oversteer_strength * 0.5;

        // ── 5. Friction / damping ──
        // The DirectInput damper is rendered by the device from its own velocity
        // estimate; `damping` lets the driver scale it out if their base makes it
        // grainy at low speed.
        let mut friction = clampf(0.08 + (front_norm + rear_norm) * 0.10, 0.0, 0.4);
        friction *= clampf(c.damping, 0.0, 3.0);

        // ── 6/7. Rumble: lockup + wheelspin + front-scrub ──
        let mut rumble = 0.0f32;
        const LOCKUP_DEADZONE: f32 = 0.06;
        const LOCKUP_RANGE: f32 = 0.30;
        let lockup = clampf((-s.front_slip_ratio - LOCKUP_DEADZONE) / LOCKUP_RANGE, 0.0, 1.0)
            * clampf(s.brake * 2.0, 0.0, 1.0);
        const SPIN_DEADZONE: f32 = 0.10;
        const SPIN_RANGE: f32 = 0.50;
        let spin = clampf((s.rear_slip_ratio - SPIN_DEADZONE) / SPIN_RANGE, 0.0, 1.0)
            * clampf(s.throttle * 2.0, 0.0, 1.0);
        const SCRUB_DEADZONE: f32 = 0.65;
        let scrub = clampf((front_norm - SCRUB_DEADZONE) / (1.0 - SCRUB_DEADZONE), 0.0, 1.0)
            * clampf((speed - 40.0) / 30.0, 0.0, 1.0)
            * clampf((s.lateral_g.abs() - 0.6) / 0.9, 0.0, 1.0);

        let lockup_amt = lockup * c.lockup_strength;
        let spin_amt = spin * c.wheelspin_strength;
        let scrub_amt = scrub * c.scrub_strength;
        rumble = clampf(rumble + lockup_amt + spin_amt + scrub_amt, 0.0, 1.0);

        const SEVERITY_RAMP: f32 = 0.30;
        let mut target_hz = self.rumble_hz;
        if lockup_amt + spin_amt + scrub_amt > 1e-4 {
            let lockup_hz = c.lockup_hz * (1.0 + SEVERITY_RAMP * lockup);
            let spin_hz = c.wheelspin_hz * (1.0 + SEVERITY_RAMP * spin);
            let scrub_hz = c.scrub_hz * (1.0 + SEVERITY_RAMP * scrub);
            target_hz = (lockup_amt * lockup_hz + spin_amt * spin_hz + scrub_amt * scrub_hz)
                / (lockup_amt + spin_amt + scrub_amt);
        }

        // ── 7b. Braking weight (software damper on the constant-force channel) ──
        // The steering-rate low-pass advances EVERY tick, not only while
        // braking. Held across the gap between braking zones (often a minute or
        // more) it kept its last pre-corner value, so the first braking tick
        // injected a one-tick torque step from a stale rate before the filter
        // re-converged. `prev_steer` is tracked unconditionally for the same
        // reason. The damper itself still only applies under braking.
        let raw_steer_vel = (s.steer - self.prev_steer) / if dt > 1e-4 { dt } else { 1e-4 };
        self.steer_vel_lp += ema_alpha(dt, 0.03) * (raw_steer_vel - self.steer_vel_lp);
        self.prev_steer = s.steer;
        let brake_load = clampf(s.front_lon_force.abs() / 18000.0, 0.0, 1.0)
            * clampf(s.brake * 1.5, 0.0, 1.0);
        let brake_weight = c.braking_strength * brake_load;
        if brake_weight > 1e-4 {
            let damper = -clampf(self.steer_vel_lp, -6.0, 6.0) * 0.06;
            let bw = clampf(damper * brake_weight, -0.30, 0.30);
            let dir = (if c.invert_force { -1.0 } else { 1.0 }) * (if c.braking_invert { -1.0 } else { 1.0 });
            torque += dir * bw;
        }

        // ── 8. Overall scale + speed fade ──
        let scale = c.overall_strength * speed_factor;
        let torque_pre = torque * scale;
        torque = clampf(torque_pre, -1.0, 1.0);
        friction = clampf(friction * scale, 0.0, 1.0);
        rumble = clampf(rumble * scale, 0.0, 1.0);

        // Clipping EMA (~0.4 s time constant). Time-based, not a fixed per-call
        // step: the loop free-runs at `ffb_update_hz`, so a constant per-call add
        // would make the meter react faster the higher the output rate.
        let clipping = torque_pre.abs() > 0.999;
        self.clip_ema +=
            ema_alpha(dt, 0.40) * ((if clipping { 1.0 } else { 0.0 }) - self.clip_ema);
        stats.set_clip_level(self.clip_ema);

        // ── 9. Time-based smoothing / interpolation ──
        // Torque gets TWO cascaded poles of tau/2 each: critically damped (no
        // overshoot) with the same low-frequency group delay as a single tau pole,
        // but a second-order rolloff — the game's high-frequency force grain is
        // buried far better for the same perceived lag. Friction and rumble keep
        // ONE pole each: friction at the full tau (a slower, heavier channel),
        // rumble at tau/2 so tyre vibration stays crisp.
        let tau = c.smoothing * 0.08;
        let a_half = ema_alpha(dt, tau * 0.5);
        let a = ema_alpha(dt, tau);
        self.smooth_torque += a_half * (torque - self.smooth_torque);
        self.smooth_torque2 += a_half * (self.smooth_torque - self.smooth_torque2);
        self.smooth_friction += a * (friction - self.smooth_friction);
        self.smooth_rumble += a_half * (rumble - self.smooth_rumble);
        self.rumble_hz += a_half * (target_hz - self.rumble_hz);

        // ── 10. Min-force deadzone removal ──
        let mut out_torque = self.smooth_torque2;
        let mf = clampf(c.min_force, 0.0, 0.9);
        if mf > 1e-4 {
            let mag = out_torque.abs();
            out_torque = if mag > 0.003 { signf(out_torque) * (mf + (1.0 - mf) * mag) } else { 0.0 };
        }

        // ── 10b. Optional slew-rate limit (anti-grain) ──
        if c.slew_limit > 1e-4 {
            let max_step = c.slew_limit * dt;
            out_torque = self.last_out_torque
                + clampf(out_torque - self.last_out_torque, -max_step, max_step);
        }
        self.last_out_torque = out_torque;

        // ── 11. Soft-start ramp ──
        let ramp = if c.soft_start_sec > 1e-3 { dt / c.soft_start_sec } else { 1.0 };
        self.soft_gain = clampf(self.soft_gain + ramp, 0.0, 1.0);

        // ── 12. Max-output safety cap ──
        let cap = clampf(c.max_output, 0.0, 1.0);
        let g = self.soft_gain;
        FfbSignals {
            torque: clampf(out_torque * g, -cap, cap),
            friction: clampf(self.smooth_friction * g, 0.0, cap),
            rumble: clampf(self.smooth_rumble * g, 0.0, cap),
            rumble_hz: self.rumble_hz,
        }
    }
}

// ── Windows real-time knobs (thread priority + 1 ms timer) via direct FFI, so we
// don't pull in the heavy `windows` crate. ──
#[cfg(windows)]
mod winrt {
    #[link(name = "winmm")]
    extern "system" {
        pub fn timeBeginPeriod(u: u32) -> u32;
        pub fn timeEndPeriod(u: u32) -> u32;
    }
    extern "system" {
        pub fn GetCurrentThread() -> isize;
        pub fn SetThreadPriority(h: isize, p: i32) -> i32;
    }
    pub const THREAD_PRIORITY_TIME_CRITICAL: i32 = 15;
    pub const THREAD_PRIORITY_NORMAL: i32 = 0;
}

/// High-resolution waitable timer (Windows 10 1803+), direct FFI for the same
/// reason as `winrt`. `Condvar::wait_timeout` is rounded to the system timer
/// (~1 ms with `timeBeginPeriod`), which is a third of an output tick at
/// 360 Hz; this wakes an order of magnitude closer to the deadline. The caller
/// still spins the last `WAIT_SPIN_GUARD` because even a high-resolution wake
/// carries scheduler latency.
#[cfg(windows)]
mod hrtimer {
    use std::ffi::c_void;
    use std::time::Duration;

    #[link(name = "kernel32")]
    extern "system" {
        fn CreateWaitableTimerExW(
            attrs: *mut c_void,
            name: *const u16,
            flags: u32,
            access: u32,
        ) -> isize;
        fn SetWaitableTimer(
            timer: isize,
            due: *const i64,
            period_ms: i32,
            routine: *mut c_void,
            routine_arg: *mut c_void,
            resume: i32,
        ) -> i32;
        fn WaitForSingleObject(handle: isize, ms: u32) -> u32;
        fn CloseHandle(handle: isize) -> i32;
    }

    const CREATE_WAITABLE_TIMER_HIGH_RESOLUTION: u32 = 0x0000_0002;
    const TIMER_ALL_ACCESS: u32 = 0x001F_0003;
    const INFINITE: u32 = 0xFFFF_FFFF;

    pub struct HiResTimer(isize);

    impl HiResTimer {
        pub fn create() -> Option<HiResTimer> {
            let h = unsafe {
                CreateWaitableTimerExW(
                    std::ptr::null_mut(),
                    std::ptr::null(),
                    CREATE_WAITABLE_TIMER_HIGH_RESOLUTION,
                    TIMER_ALL_ACCESS,
                )
            };
            if h == 0 {
                None
            } else {
                Some(HiResTimer(h))
            }
        }

        /// Block for `d`. False when the timer call failed, so the caller can
        /// fall back to the condvar rather than losing the deadline entirely.
        pub fn wait(&self, d: Duration) -> bool {
            let micros = d.as_micros().min((i64::MAX / 10) as u128) as i64;
            let due = -micros * 10; // 100 ns units; negative = relative
            unsafe {
                if SetWaitableTimer(self.0, &due, 0, std::ptr::null_mut(), std::ptr::null_mut(), 0) == 0 {
                    return false;
                }
                WaitForSingleObject(self.0, INFINITE) == 0
            }
        }
    }

    impl Drop for HiResTimer {
        fn drop(&mut self) {
            unsafe { CloseHandle(self.0) };
        }
    }
}

#[cfg(not(windows))]
mod hrtimer {
    use std::time::Duration;

    pub struct HiResTimer;

    impl HiResTimer {
        pub fn create() -> Option<HiResTimer> {
            None
        }
        pub fn wait(&self, _d: Duration) -> bool {
            false
        }
    }
}

fn realtime_begin() {
    #[cfg(windows)]
    unsafe {
        winrt::SetThreadPriority(winrt::GetCurrentThread(), winrt::THREAD_PRIORITY_TIME_CRITICAL);
        winrt::timeBeginPeriod(1);
    }
}
fn realtime_end() {
    #[cfg(windows)]
    unsafe {
        winrt::SetThreadPriority(winrt::GetCurrentThread(), winrt::THREAD_PRIORITY_NORMAL);
        winrt::timeEndPeriod(1);
    }
}

/// The FFB thread. Owns the wheel + SDL, processes device commands, and runs the
/// fixed-rate real-time output loop.
pub fn ffb_thread(
    handle: Arc<FfbHandle>,
    shared: Arc<SharedTelemetry>,
    cmd_rx: Receiver<FfbCommand>,
) {
    let mut wheel = WheelOutput::new();
    if !wheel.init() {
        push_status(&handle, &wheel, format!("SDL init failed: {}", wheel.last_error()));
    } else {
        push_status(&handle, &wheel, String::new());
    }

    let mut engine = Engine::new();
    let stats = &shared.stats;
    let mut prev = Instant::now();
    // Records the game's ~60 Hz physics frames so the fixed-rate loop can render
    // continuously between them (see `TelemetryPredictor`).
    let mut predictor = TelemetryPredictor::new();
    let mut seen_seq = stats.motion_seq.load(Ordering::Relaxed);
    // `None` on anything that cannot provide a high-resolution timer; the wait
    // below then keeps the original condvar behaviour.
    let timer = hrtimer::HiResTimer::create();
    // Windows real-time state (TIME_CRITICAL priority + 1 ms timer resolution)
    // is global/expensive, so it's held only while a wheel is actually open —
    // not for the app's lifetime.
    let mut rt_active = false;
    // Gauges are consumed by the ~30 Hz emitter; publishing faster is wasted
    // allocation on the real-time thread.
    let mut last_gauge_pub: Option<Instant> = None;

    // Telemetry-liveness edge: the ms at which the game last looked like it was
    // sending. Frozen while it is quiet, so a resume after a long silence is
    // recognisable as the game coming up.
    let mut tele_alive_ms: i64 = 0;
    let mut last_diag: Option<(i32, i32, bool, i32)> = None;

    // Rate meters.
    let mut rate_anchor = Instant::now();
    let mut ffb_count: u64 = 0;
    let mut last_udp_count = stats.udp_packets.load(Ordering::Relaxed);
    let mut last_motion_count = stats.motion_frames.load(Ordering::Relaxed);
    // Output-tick lateness (µs), windowed to the same ~2 Hz refresh.
    let mut late_sum_us: u64 = 0;
    let mut late_max_us: u32 = 0;
    let mut late_count: u64 = 0;

    while handle.running.load(Ordering::Relaxed) {
        // 1) Drain pending device commands (they must run on this SDL thread).
        while let Ok(cmd) = cmd_rx.try_recv() {
            match cmd {
                FfbCommand::Enumerate(reply) => {
                    wheel.enumerate();
                    let _ = reply.send(wheel.devices());
                }
                FfbCommand::Open(idx, reply) => {
                    let r = wheel.open_device(idx);
                    push_status(&handle, &wheel, wheel.last_error());
                    let _ = reply.send(r);
                }
                FfbCommand::Close => {
                    wheel.release_device();
                    push_status(&handle, &wheel, String::new());
                }
                FfbCommand::ResetPeak => engine.reset_peak(stats),
            }
        }

        // Track the device-open lifetime with the real-time knobs.
        if wheel.is_open() != rt_active {
            rt_active = wheel.is_open();
            if rt_active {
                realtime_begin();
            } else {
                realtime_end();
            }
        }

        // 2) Compute + send. `load_full` rather than a `load()` guard: the
        // guard would be held across the rest of this iteration — including the
        // 250 ms idle wait with no wheel open — occupying a fast debt slot and
        // pushing every concurrent settings write onto arc-swap's slower path.
        let settings = handle.settings.load_full();
        let hz = {
            let h = settings.ffb_update_hz;
            if h < FFB_MIN_HZ { FfbSettings::default().ffb_update_hz } else { h.min(FFB_MAX_HZ) }
        };
        let interval = Duration::from_nanos((1_000_000_000i64 / hz as i64) as u64);
        let t0 = Instant::now();
        let mut dt = t0.duration_since(prev).as_secs_f32();
        prev = t0;
        if dt <= 0.0 || dt > 0.25 {
            dt = 1.0 / hz as f32;
        }

        let enabled = handle.enabled.load(Ordering::Relaxed);
        // A new Motion Ex frame means a fresh physics sample: record it, then
        // drive the wheel with the interpolated input rather than the held one.
        // Load the FRAME first, then re-read the sequence, and only accept the
        // pair when the sequence hasn't moved underneath us. publish_ffb_frame
        // stores the frame before bumping the sequence, so reading seq first let
        // a frame published between the two loads be pushed while `seen_seq`
        // still recorded the older number — the next tick then pushed the SAME
        // frame again. A duplicate knot has a zero clock delta and a zero
        // arrival delta, so both spacing guards fall through to the smoothed
        // span and it lands a full frame after itself: one frame rendered flat,
        // the next at double slope, which is exactly the slope discontinuity the
        // predictor exists to remove.
        let seq = stats.motion_seq.load(Ordering::Relaxed);
        if seq != seen_seq {
            let frame = shared.ffb_frame.load();
            if stats.motion_seq.load(Ordering::Relaxed) == seq {
                seen_seq = seq;
                predictor.push(&frame);
            }
            // Sequence moved mid-read: leave seen_seq alone and take the pair on
            // the next tick, at most one tick later.
        }
        let now_s = mono_secs(t0);
        let telem: FfbTelemetry =
            predictor.at(now_s, settings.interpolation, settings.interp_delay_frac);

        let sig = if enabled && wheel.is_open() {
            engine.compute(&telem, &settings, stats, now_ms(), dt)
        } else {
            // Master off (or no device): release so the wheel goes limp.
            engine.release(stats, telem.steer);
            FfbSignals::default()
        };
        wheel.send(&sig);
        if wheel.is_open() {
            if let Ok(mut trace) = handle.trace.try_lock() {
                trace.record(now_s, &telem, sig.torque);
            }
        }
        ffb_count += 1;

        // Publish gauges at ~30 Hz (the emitter's sample rate — anything faster
        // is dropped unread). Output signals come from `sig` (zero when off / no
        // wheel — correct); the grip cues and the telemetry grid are computed
        // from live telemetry so the monitor stays live regardless of FFB state.
        if last_gauge_pub.map_or(true, |t| t.elapsed() >= Duration::from_millis(33)) {
            last_gauge_pub = Some(Instant::now());
            let (front_norm, rear_norm, understeer, oversteer) = grip_cues(&telem);
            let ai_control = stats.ai_in_control.load(Ordering::Relaxed)
                || stats.ai_run_up_held.load(Ordering::Relaxed)
                || stats.ai_controls_car.load(Ordering::Relaxed);
            let run_state: u8 = {
                let now = now_ms();
                let last_pkt = stats.last_udp_ms.load(Ordering::Relaxed);
                let frozen = frames_frozen(stats, now);
                if last_pkt == 0 {
                    0
                } else if stats.game_paused.load(Ordering::Relaxed) {
                    2
                } else if ai_control {
                    3
                } else if stats.tt_holding.load(Ordering::Relaxed) {
                    4
                } else if frozen {
                    2
                } else {
                    1
                }
            };
            let prev = handle.gauges.load();
            let next = FfbGauges {
                torque: sig.torque,
                friction: sig.friction,
                rumble: sig.rumble,
                rumble_hz: sig.rumble_hz,
                clip: stats.get_clip_level(),
                understeer,
                oversteer,
                front_slip: front_norm,
                rear_slip: rear_norm,
                speed: telem.speed_kmh,
                lateral_g: telem.lateral_g,
                front_force: telem.front_lat_force.abs(),
                vert_load: telem.front_vert_force,
                sideslip_deg: telem.sideslip * 57.2958,
                front_slip_ratio: telem.front_slip_ratio,
                rear_slip_ratio: telem.rear_slip_ratio,
                peak_force: stats.get_peak_lat_force(),
                throttle: telem.throttle,
                brake: telem.brake,
                steer: telem.steer,
                udp_packets: stats.udp_packets.load(Ordering::Relaxed),
                session_type: stats.session_type.load(Ordering::Relaxed),
                driver_status: stats.driver_status.load(Ordering::Relaxed),
                pit_status: stats.pit_status.load(Ordering::Relaxed),
                ai_control,
                run_state,
                udp_hz: prev.udp_hz,
                motion_hz: prev.motion_hz,
                ffb_hz: prev.ffb_hz,
                tick_late_us: prev.tick_late_us,
                tick_max_late_us: prev.tick_max_late_us,
                frame_identifier: shared.ffb_frame.load().frame_identifier,
                game_clock: predictor.game_clock,
            };
            // Idle values repeat exactly — skip the store so the emitter's
            // pointer check sees "nothing new" and sends no IPC at all.
            if **prev != next {
                handle.gauges.store(Arc::new(next));
            }
        }

        // Refresh rate meters ~2×/s. One `elapsed()` read for both the gate and
        // the window, so the rate divides by exactly the interval it measured.
        let rate_elapsed = rate_anchor.elapsed();
        if rate_elapsed >= Duration::from_millis(500) {
            let secs = rate_elapsed.as_secs_f32();
            let udp_now = stats.udp_packets.load(Ordering::Relaxed);
            let udp_hz = (udp_now.saturating_sub(last_udp_count)) as f32 / secs;
            let motion_now = stats.motion_frames.load(Ordering::Relaxed);
            let motion_hz = (motion_now.saturating_sub(last_motion_count)) as f32 / secs;
            let ffb_hz = ffb_count as f32 / secs;
            let tick_late_us =
                if late_count > 0 { late_sum_us as f32 / late_count as f32 } else { 0.0 };
            let tick_max_late_us = late_max_us as f32;
            let mut g = **handle.gauges.load();
            if g.udp_hz != udp_hz
                || g.motion_hz != motion_hz
                || g.ffb_hz != ffb_hz
                || g.tick_late_us != tick_late_us
                || g.tick_max_late_us != tick_max_late_us
            {
                g.udp_hz = udp_hz;
                g.motion_hz = motion_hz;
                g.ffb_hz = ffb_hz;
                g.tick_late_us = tick_late_us;
                g.tick_max_late_us = tick_max_late_us;
                handle.gauges.store(Arc::new(g));
            }
            last_udp_count = udp_now;
            last_motion_count = motion_now;
            ffb_count = 0;
            late_sum_us = 0;
            late_max_us = 0;
            late_count = 0;
            rate_anchor = Instant::now();
            // ── The game waking up is our most reliable "the wheel has just
            // been taken" signal. ──
            // No DirectInput query reports the theft dependably (some bases keep
            // reporting the effect as playing while producing nothing), but the
            // cure the driver found by hand — a full deselect/reselect — always
            // works. Telemetry arriving after a long silence is the game coming
            // up, i.e. just after the steal, so do that deselect/reselect for
            // them. The long-gap requirement is what keeps it from firing on the
            // short pauses between sessions, and `reacquire`'s own backoff stops
            // it treading on a device the driver has only just chosen.
            if wheel.is_open() {
                let now = now_ms();
                let last_pkt = stats.last_udp_ms.load(Ordering::Relaxed);
                if last_pkt != 0 && now - last_pkt < TELE_LIVE_MS {
                    if tele_alive_ms == 0 || now - tele_alive_ms > TELE_COLD_MS {
                        wheel.reacquire("the game started sending telemetry");
                    }
                    tele_alive_ms = now;
                }
            }

            // Liveness probe + self-repair. It has to run AFTER the frame's
            // `send`, because that update is what drives SDL's re-acquire and so
            // decides whether the probe's `Start` can land. 2 Hz is plenty: what
            // it catches happens while the game is booting, not on track.
            let health_changed = wheel.poll_health();

            // What the DEVICE says, logged only when it changes: the belief and
            // the driver's answer diverging is the whole bug, so print the
            // answer rather than the belief.
            if wheel.is_open() {
                let d = wheel.diag();
                if last_diag != Some(d) {
                    last_diag = Some(d);
                    log::info!(
                        "[ffb] device says: constant={} sine={} trusted={} sendRc={} \
                         (we think open={} healthy={})",
                        d.0, d.1, d.2, d.3, wheel.is_open(), wheel.is_healthy(),
                    );
                }
            } else {
                last_diag = None;
            }
            // Surface a live SDL error if one appeared — or clear a stale one
            // once a recovery has taken.
            let err = wheel.last_error();
            if health_changed || handle.status.load().error != err {
                push_status(&handle, &wheel, err);
            }
        }

        if !handle.running.load(Ordering::Relaxed) {
            break;
        }

        // 3) Fixed-rate output tick. The wheel is deliberately NOT woken by
        // telemetry frames: pinning output to the game's ~60 Hz packet rate is
        // what held each force value for a whole frame — a staircase on a
        // direct-drive wheel. `compute` above reloads the latest snapshot every
        // pass, so the data is always current; this only sets the OUTPUT cadence,
        // and the filters inside `compute` now run at this rate too. With a
        // wheel open the deadline is kept by a high-resolution waitable timer
        // (falling back to the condvar) and the last `WAIT_SPIN_GUARD` is spun,
        // because no wait primitive returns exactly on a sub-millisecond
        // deadline. With no wheel open there is nothing to keep lively, so the
        // idle tick stretches to 250 ms on the condvar — which is also how
        // `stop` gets its prompt wake.
        {
            let deadline = if wheel.is_open() {
                interval
            } else {
                Duration::from_millis(250)
            };
            let next = t0 + deadline;
            if wheel.is_open() {
                let sleep_until = next.checked_sub(WAIT_SPIN_GUARD).unwrap_or(next);
                match timer.as_ref() {
                    Some(t) => {
                        while handle.running.load(Ordering::Relaxed) {
                            let now = Instant::now();
                            if now >= sleep_until {
                                break;
                            }
                            let remaining = sleep_until - now;
                            if !t.wait(remaining) {
                                std::thread::sleep(remaining);
                            }
                        }
                    }
                    None => {
                        let mut guard =
                            stats.wake.0.lock().unwrap_or_else(|e| e.into_inner());
                        while handle.running.load(Ordering::Relaxed) {
                            let now = Instant::now();
                            if now >= sleep_until {
                                break;
                            }
                            let (g, _) = stats
                                .wake
                                .1
                                .wait_timeout(guard, sleep_until - now)
                                .unwrap_or_else(|e| e.into_inner());
                            guard = g;
                        }
                    }
                }
                while handle.running.load(Ordering::Relaxed) && Instant::now() < next {
                    std::hint::spin_loop();
                }
                let late = Instant::now().saturating_duration_since(next).as_micros() as u32;
                late_sum_us += u64::from(late);
                late_max_us = late_max_us.max(late);
                late_count += 1;
            } else {
                let mut guard = stats.wake.0.lock().unwrap_or_else(|e| e.into_inner());
                while handle.running.load(Ordering::Relaxed) {
                    let now = Instant::now();
                    if now >= next {
                        break;
                    }
                    let (g, _) = stats
                        .wake
                        .1
                        .wait_timeout(guard, next - now)
                        .unwrap_or_else(|e| e.into_inner());
                    guard = g;
                }
            }
        }
    }

    wheel.release_device();
    if rt_active {
        realtime_end();
    }
}

fn push_status(handle: &Arc<FfbHandle>, wheel: &WheelOutput, error: String) {
    handle.status.store(Arc::new(FfbStatus {
        device_open: wheel.is_open(),
        healthy: wheel.is_healthy(),
        device_name: wheel.device_name(),
        active_index: wheel.active_index(),
        enabled: handle.enabled.load(Ordering::Relaxed),
        error,
    }));
}

#[cfg(test)]
mod tests {
    use super::{channels, ema_alpha, from_channels, pchip_at, FfbFrame, InterpMode, TelemetryPredictor};
    use crate::telemetry::state::FfbTelemetry;

    fn telem(lat: f32) -> FfbTelemetry {
        FfbTelemetry { front_lat_force: lat, ..Default::default() }
    }

    fn frame(arrival_s: f64, lat: f32) -> FfbFrame {
        FfbFrame { telem: telem(lat), session_time: None, frame_identifier: 0, arrival_s }
    }

    fn frame_at(session_time: f32, arrival_s: f64, lat: f32) -> FfbFrame {
        FfbFrame {
            telem: telem(lat),
            session_time: Some(session_time),
            frame_identifier: 0,
            arrival_s,
        }
    }

    /// The output loop free-runs at whatever `ffb_update_hz` the driver picks, so
    /// every smoother has to close the same fraction of its gap over the same
    /// wall time regardless of tick rate — otherwise raising the rate silently
    /// retunes the CLIP meter (and the torque smoothing) instead of just making
    /// them finer. This is the property the fixed-rate reclock depends on.
    #[test]
    fn ema_is_rate_independent_over_the_same_wall_time() {
        let tau = 0.40;
        let run = |hz: f32| {
            let dt = 1.0 / hz;
            let steps = (0.5 * hz) as usize; // exactly 0.5 s of wall time
            let mut v = 0.0_f32;
            for _ in 0..steps {
                v += ema_alpha(dt, tau) * (1.0 - v);
            }
            v
        };
        let exact = 1.0 - (-0.5_f32 / tau).exp();
        let slow = run(60.0);
        let fast = run(360.0);
        assert!((slow - exact).abs() < 1e-3, "60 Hz: {slow} vs {exact}");
        assert!((fast - exact).abs() < 1e-3, "360 Hz: {fast} vs {exact}");
        assert!((fast - slow).abs() < 1e-3, "60 Hz {slow} != 360 Hz {fast}");
    }

    #[test]
    fn ema_with_no_time_constant_is_a_passthrough() {
        assert_eq!(ema_alpha(1.0 / 360.0, 0.0), 1.0);
    }

    /// Torque now runs through two identical poles (see `compute`): critically
    /// damped, so a step approaches the target monotonically with no overshoot —
    /// overshoot in a wheel force is a kick that wasn't in the data.
    #[test]
    fn two_pole_torque_smoothing_has_no_overshoot() {
        let tau = 0.02;
        let dt = 1.0 / 200.0;
        let a = ema_alpha(dt, tau * 0.5);
        let (mut s1, mut s2, mut prev) = (0.0_f32, 0.0_f32, 0.0_f32);
        for _ in 0..300 {
            s1 += a * (1.0 - s1);
            s2 += a * (s1 - s2);
            assert!(s2 >= prev - 1e-6, "overshoot: {s2} after {prev}");
            prev = s2;
        }
        assert!((s2 - 1.0).abs() < 0.02, "did not converge: {s2}");
    }

    #[test]
    fn predictor_holds_until_a_second_frame_arrives() {
        let p = TelemetryPredictor::new();
        assert_eq!(p.at(0.0, InterpMode::Cubic, 0.5).front_lat_force, 0.0);

        let mut p = TelemetryPredictor::new();
        p.push(&frame(0.000, 7.0));
        // One frame is not enough to know a velocity — the value is held as-is.
        assert_eq!(p.at(0.008, InterpMode::Cubic, 0.5).front_lat_force, 7.0);
    }

    /// The whole point of the predictor: between two frames the wheel is driven
    /// by an interpolated (and, past the newest frame, projected) value, not by
    /// the held sample. With only two frames the monotone cubic degenerates to
    /// the same line the old blend drew, so the original expectations stand.
    #[test]
    fn predictor_interpolates_and_projects_between_frames() {
        let mut p = TelemetryPredictor::new();
        p.push(&frame(0.000, 0.0));
        p.push(&frame(0.016, 10.0));

        // Half a frame of delay renders the midpoint of the two frames.
        let mid = p.at(0.016, InterpMode::Cubic, 0.5);
        assert!((mid.front_lat_force - 5.0).abs() < 1e-3, "mid was {}", mid.front_lat_force);
        // A full frame on renders the newest sample.
        let at_last = p.at(0.024, InterpMode::Cubic, 0.5);
        assert!((at_last.front_lat_force - 10.0).abs() < 1e-3, "at_last was {}", at_last.front_lat_force);
        // Another half frame projects half a step past it (capped there).
        let projected = p.at(0.032, InterpMode::Cubic, 0.5);
        assert!((projected.front_lat_force - 15.0).abs() < 1e-3, "projected was {}", projected.front_lat_force);
        // ...and no further however long we wait within the stale window.
        let capped = p.at(0.048, InterpMode::Cubic, 0.5);
        assert!((capped.front_lat_force - 15.0).abs() < 1e-3, "capped was {}", capped.front_lat_force);
    }

    #[test]
    fn predictor_holds_when_the_stream_goes_stale() {
        let mut p = TelemetryPredictor::new();
        p.push(&frame(0.000, 0.0));
        p.push(&frame(0.016, 10.0));
        let held = p.at(0.096, InterpMode::Cubic, 0.5);
        assert!((held.front_lat_force - 10.0).abs() < 1e-3, "held was {}", held.front_lat_force);
    }

    /// The braking-weight damper differences `steer` every tick. If `steer` were
    /// held between packets that difference was a 60 Hz spike train (the full
    /// frame's movement divided by one tick) — felt as grain under braking. The
    /// predictor makes `steer` a ramp, so the difference is a real velocity.
    #[test]
    fn predictor_ramps_steer_so_its_velocity_is_real() {
        let mut a = FfbTelemetry::default();
        a.steer = 0.0;
        let mut b = FfbTelemetry::default();
        b.steer = 0.1;
        let mut p = TelemetryPredictor::new();
        p.push(&FfbFrame { telem: a, session_time: None, frame_identifier: 0, arrival_s: 0.000 });
        p.push(&FfbFrame { telem: b, session_time: None, frame_identifier: 0, arrival_s: 0.016 });
        let s1 = p.at(0.016, InterpMode::Cubic, 0.5).steer;
        let s2 = p.at(0.024, InterpMode::Cubic, 0.5).steer;
        assert!(s2 > s1, "steer must ramp between frames, got {s1} then {s2}");
        assert!((s2 - s1) > 1e-3, "ramp was flat: {s1} -> {s2}");
    }

    /// Arrival jitter must not move the knots: the game's session clock gives
    /// the exact spacing, so the rendered midpoint is the same as if the
    /// packets had landed evenly.
    #[test]
    fn predictor_spaces_knots_by_the_game_clock_not_arrival_jitter() {
        let mut p = TelemetryPredictor::new();
        p.push(&frame_at(0.0000, 0.000, 0.0));
        p.push(&frame_at(0.0167, 0.020, 16.7));
        p.push(&frame_at(0.0333, 0.040, 33.3));
        assert!(p.game_clock, "the game clock should have been trusted");
        let mid = p.at(0.040, InterpMode::Cubic, 0.5).front_lat_force;
        assert!((mid - 25.0).abs() < 0.2, "expected the game-clock midpoint, got {mid}");
    }

    /// A lap/session boundary makes the session clock jump; that interval must
    /// fall back to arrival time rather than treating the jump as one frame.
    #[test]
    fn predictor_falls_back_to_arrival_when_the_session_clock_resets() {
        let mut p = TelemetryPredictor::new();
        p.push(&frame_at(10.0000, 0.000, 0.0));
        p.push(&frame_at(10.0160, 0.016, 10.0));
        p.push(&frame_at(0.0000, 0.032, 20.0));
        assert!(!p.game_clock, "a reset clock must not be trusted");
        let mid = p.at(0.032, InterpMode::Cubic, 0.5).front_lat_force;
        assert!((mid - 15.0).abs() < 1e-3, "expected the arrival midpoint, got {mid}");
    }

    /// The reason for the cubic: on a 60 Hz-sampled signal the reconstruction
    /// error at 5 Hz is measurably smaller than a linear blend's, which is the
    /// grain the smoothing filter was having to bury. PCHIP trades some raw
    /// accuracy for its no-overshoot guarantee, so the margin is ~2.6× rather
    /// than an ideal-spline's much larger one.
    #[test]
    fn cubic_reconstruction_beats_linear_on_a_sampled_sine() {
        let mut p = TelemetryPredictor::new();
        let hz = 60.0f64;
        let freq = 5.0f64;
        let frames = 30usize;
        for i in 0..frames {
            let t = i as f64 / hz;
            let v = (2.0 * std::f64::consts::PI * freq * t).sin() as f32;
            p.push(&frame_at(t as f32, t, v));
        }
        let newest_t = (frames - 1) as f64 / hz;
        let (mut lin_err, mut cub_err) = (0.0f64, 0.0f64);
        for i in 0..20 {
            let age = i as f64 * (0.5 / hz) / 20.0;
            let t_rel = age - 0.5 / hz;
            let truth = (2.0 * std::f64::consts::PI * freq * (newest_t + t_rel)).sin();
            let lin = (p.at(newest_t + age, InterpMode::Linear, 0.5).front_lat_force as f64 - truth).abs();
            let cub = (p.at(newest_t + age, InterpMode::Cubic, 0.5).front_lat_force as f64 - truth).abs();
            lin_err = lin_err.max(lin);
            cub_err = cub_err.max(cub);
        }
        assert!(cub_err * 2.0 < lin_err, "cubic {cub_err} vs linear {lin_err}");
    }

    #[test]
    fn pchip_reproduces_a_line_exactly() {
        let ts = [0.0f32, 0.016, 0.032, 0.048];
        let ys = [0.0f32, 1.6, 3.2, 4.8];
        for i in 0..=48 {
            let t = i as f32 * 0.001;
            let y = pchip_at(&ts, &ys, t);
            assert!((y - 100.0 * t).abs() < 1e-3, "t={t} y={y}");
        }
    }

    #[test]
    fn pchip_never_overshoots_between_knots() {
        let ts = [0.0f32, 0.016, 0.032, 0.048];
        let ys = [0.0f32, 0.0, 1.0, 1.0];
        let mut t = 0.0f32;
        while t <= 0.048 {
            let y = pchip_at(&ts, &ys, t);
            assert!((0.0..=1.0).contains(&y), "overshoot at {t}: {y}");
            t += 0.0005;
        }
    }

    /// A linear blend had a slope jump at every knot (here 50/s against 10/s);
    /// the cubic is C1, which is the whole point.
    #[test]
    fn pchip_slope_is_continuous_at_a_knot() {
        let ts = [0.0f32, 0.02, 0.04, 0.06];
        let ys = [0.0f32, 1.0, 1.2, 3.0];
        let e = 1e-5f32;
        let left = (pchip_at(&ts, &ys, 0.04) - pchip_at(&ts, &ys, 0.04 - e)) / e;
        let right = (pchip_at(&ts, &ys, 0.04 + e) - pchip_at(&ts, &ys, 0.04)) / e;
        assert!((left - right).abs() < 0.5, "slope jumps: {left} vs {right}");
    }

    /// The high-resolution timer is direct FFI, so a wrong signature would only
    /// show up as a silent fallback on the wheel. Skipped where the OS does not
    /// offer it (the engine falls back to the condvar there anyway).
    #[cfg(windows)]
    #[test]
    fn high_resolution_timer_waits_without_error() {
        use std::time::{Duration, Instant};
        if let Some(t) = super::hrtimer::HiResTimer::create() {
            let start = Instant::now();
            assert!(t.wait(Duration::from_millis(2)));
            assert!(start.elapsed() >= Duration::from_millis(1));
        }
    }

    #[test]
    fn channel_mapping_round_trips() {
        let mut t = FfbTelemetry::default();
        t.lateral_g = 1.0;
        t.front_slip_angle = 2.0;
        t.rear_slip_angle = 3.0;
        t.front_lat_force = 4.0;
        t.front_lon_force = 5.0;
        t.front_vert_force = 6.0;
        t.sideslip = 7.0;
        t.front_slip_ratio = 8.0;
        t.rear_slip_ratio = 9.0;
        t.speed_kmh = 10.0;
        t.steer = 11.0;
        t.throttle = 12.0;
        t.brake = 13.0;
        let c = channels(&t);
        assert_eq!(channels(&from_channels(c)), c);
    }
}
