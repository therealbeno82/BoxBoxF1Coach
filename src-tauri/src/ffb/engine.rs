//! The FFB compute + real-time output loop. `Engine::compute` is a behavioural
//! port of the C++ `FFBEngine::compute` (`ffb_engine.cpp:93-468`); `ffb_thread`
//! ports the event-driven real-time loop (`ffb_engine.cpp:30-91`). All SDL usage
//! (via `WheelOutput`) stays on this one thread.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, SyncSender};
use std::sync::Arc;
use std::time::{Duration, Instant};

use arc_swap::ArcSwap;
use serde::Serialize;

use super::settings::{
    clampf, signf, FfbSettings, FfbSignals, FFB_KEEPALIVE_MS, FFB_MAX_HZ, FFB_MIN_HZ, FFB_REARM_MS,
};
use super::wheel::{DeviceInfo, WheelOutput};
use crate::telemetry::state::{now_ms, AppStats, FfbTelemetry, FFB_PAUSE_FREEZE_MS};
use crate::telemetry::SharedTelemetry;

// Session-type helpers (from C++ `types.h`).
fn session_has_ai_lap_start(t: u8) -> bool {
    t == 9 || t == 14 || t == 18 // One-Shot Q, One-Shot Shootout, Time Trial
}

const PI: f32 = std::f32::consts::PI;

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
    // Rates.
    pub udp_hz: f32,
    pub ffb_hz: f32,
}

/// Device/connection state for the tab (serialized to `ffb_status`).
#[derive(Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct FfbStatus {
    pub device_open: bool,
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
}

// ── The per-loop compute state (C++ `FFBEngine` members) ──
struct Engine {
    smooth_torque: f32,
    smooth_friction: f32,
    smooth_rumble: f32,
    rumble_hz: f32,
    soft_gain: f32,
    clip_ema: f32,
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
            smooth_friction: 0.0,
            smooth_rumble: 0.0,
            rumble_hz: 20.0,
            soft_gain: 0.0,
            clip_ema: 0.0,
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

    /// Zero everything and re-arm the ramps (the safety-release path).
    fn release(&mut self, stats: &AppStats, steer: f32) {
        self.smooth_torque = 0.0;
        self.smooth_friction = 0.0;
        self.smooth_rumble = 0.0;
        self.soft_gain = 0.0;
        self.clip_ema = 0.0;
        self.prev_steer = steer;
        self.steer_vel_lp = 0.0;
        self.lat_force_lp = 0.0;
        stats.set_clip_level(0.0);
    }

    fn compute(
        &mut self,
        s: &FfbTelemetry,
        c: &FfbSettings,
        stats: &AppStats,
        now: i64,
        dt: f32,
    ) -> FfbSignals {
        // Diagnostic: steady test force bypasses all physics.
        if c.test_force.abs() > 0.001 {
            let t = clampf(c.test_force, -1.0, 1.0);
            self.smooth_torque = t;
            self.smooth_friction = 0.0;
            self.smooth_rumble = 0.0;
            return FfbSignals { torque: t, friction: 0.0, rumble: 0.0, rumble_hz: self.rumble_hz };
        }
        if c.test_rumble > 0.001 {
            let r = clampf(c.test_rumble, 0.0, 1.0);
            self.smooth_torque = 0.0;
            self.smooth_friction = 0.0;
            self.smooth_rumble = r;
            return FfbSignals { torque: 0.0, friction: 0.0, rumble: r, rumble_hz: c.lockup_hz };
        }

        // ── SAFETY: release unless the car is actively being driven ──
        {
            let adv = stats.last_frame_advance_ms.load(Ordering::Relaxed);
            let streak = stats.frame_streak_start_ms.load(Ordering::Relaxed);
            let frozen = adv == 0 || (now - adv > FFB_PAUSE_FREEZE_MS);
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
            let a_f = clampf(dt / (0.10 + dt), 0.0, 1.0);
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
        let mut friction = clampf(0.08 + (front_norm + rear_norm) * 0.10, 0.0, 0.4);

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
        let brake_load = clampf(s.front_lon_force.abs() / 18000.0, 0.0, 1.0)
            * clampf(s.brake * 1.5, 0.0, 1.0);
        let brake_weight = c.braking_strength * brake_load;
        if brake_weight > 1e-4 {
            let raw_steer_vel = (s.steer - self.prev_steer) / if dt > 1e-4 { dt } else { 1e-4 };
            let a_steer = clampf(dt / (0.03 + dt), 0.0, 1.0);
            self.steer_vel_lp += a_steer * (raw_steer_vel - self.steer_vel_lp);
            let damper = -clampf(self.steer_vel_lp, -6.0, 6.0) * 0.06;
            let bw = clampf(damper * brake_weight, -0.30, 0.30);
            let dir = (if c.invert_force { -1.0 } else { 1.0 }) * (if c.braking_invert { -1.0 } else { 1.0 });
            torque += dir * bw;
        }
        self.prev_steer = s.steer;

        // ── 8. Overall scale + speed fade ──
        let scale = c.overall_strength * speed_factor;
        let torque_pre = torque * scale;
        torque = clampf(torque_pre, -1.0, 1.0);
        friction = clampf(friction * scale, 0.0, 1.0);
        rumble = clampf(rumble * scale, 0.0, 1.0);

        // Clipping EMA.
        let clipping = torque_pre.abs() > 0.999;
        self.clip_ema += 0.04 * ((if clipping { 1.0 } else { 0.0 }) - self.clip_ema);
        stats.set_clip_level(self.clip_ema);

        // ── 9. Time-based smoothing / interpolation ──
        let tau = c.smoothing * 0.08;
        let a = if tau > 1e-5 { clampf(dt / (tau + dt), 0.0, 1.0) } else { 1.0 };
        let a_r = if tau > 1e-5 { clampf(dt / (tau * 0.5 + dt), 0.0, 1.0) } else { 1.0 };
        self.smooth_torque += a * (torque - self.smooth_torque);
        self.smooth_friction += a * (friction - self.smooth_friction);
        self.smooth_rumble += a_r * (rumble - self.smooth_rumble);
        self.rumble_hz += a_r * (target_hz - self.rumble_hz);

        // ── 10. Min-force deadzone removal ──
        let mut out_torque = self.smooth_torque;
        let mf = clampf(c.min_force, 0.0, 0.9);
        if mf > 1e-4 {
            let mag = out_torque.abs();
            out_torque = if mag > 0.003 { signf(out_torque) * (mf + (1.0 - mf) * mag) } else { 0.0 };
        }

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
/// event-driven real-time output loop.
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
    let mut seen_seq = stats.motion_seq.load(Ordering::Relaxed);
    // Windows real-time state (TIME_CRITICAL priority + 1 ms timer resolution)
    // is global/expensive, so it's held only while a wheel is actually open —
    // not for the app's lifetime.
    let mut rt_active = false;
    // Gauges are consumed by the ~30 Hz emitter; publishing faster is wasted
    // allocation on the real-time thread.
    let mut last_gauge_pub: Option<Instant> = None;

    // Rate meters.
    let mut rate_anchor = Instant::now();
    let mut ffb_count: u64 = 0;
    let mut last_udp_count = stats.udp_packets.load(Ordering::Relaxed);

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
                    wheel.close_device();
                    push_status(&handle, &wheel, String::new());
                }
                FfbCommand::ResetPeak => stats.set_peak_lat_force(0.0),
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

        // 2) Compute + send.
        let hz = {
            let h = handle.settings.load().ffb_update_hz;
            if h < FFB_MIN_HZ { 90 } else { h.min(FFB_MAX_HZ) }
        };
        let interval = Duration::from_nanos((1_000_000_000i64 / hz as i64) as u64);
        let t0 = Instant::now();
        let mut dt = t0.duration_since(prev).as_secs_f32();
        prev = t0;
        if dt <= 0.0 || dt > 0.25 {
            dt = 1.0 / hz as f32;
        }

        let settings = handle.settings.load();
        let enabled = handle.enabled.load(Ordering::Relaxed);
        let telem: FfbTelemetry = **shared.ffb.load();

        let sig = if enabled && wheel.is_open() {
            engine.compute(&telem, &settings, stats, now_ms(), dt)
        } else {
            // Master off (or no device): release so the wheel goes limp.
            engine.release(stats, telem.steer);
            FfbSignals::default()
        };
        wheel.send(&sig);
        ffb_count += 1;
        stats.ffb_updates.fetch_add(1, Ordering::Relaxed);

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
                let adv = stats.last_frame_advance_ms.load(Ordering::Relaxed);
                let frozen = adv == 0 || (now - adv > FFB_PAUSE_FREEZE_MS);
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
                ffb_hz: prev.ffb_hz,
            };
            // Idle values repeat exactly — skip the store so the emitter's
            // pointer check sees "nothing new" and sends no IPC at all.
            if **prev != next {
                handle.gauges.store(Arc::new(next));
            }
        }

        // Refresh rate meters ~2×/s.
        if rate_anchor.elapsed() >= Duration::from_millis(500) {
            let secs = rate_anchor.elapsed().as_secs_f32();
            let udp_now = stats.udp_packets.load(Ordering::Relaxed);
            let udp_hz = (udp_now.saturating_sub(last_udp_count)) as f32 / secs;
            let ffb_hz = ffb_count as f32 / secs;
            let mut g = **handle.gauges.load();
            if g.udp_hz != udp_hz || g.ffb_hz != ffb_hz {
                g.udp_hz = udp_hz;
                g.ffb_hz = ffb_hz;
                handle.gauges.store(Arc::new(g));
            }
            last_udp_count = udp_now;
            ffb_count = 0;
            rate_anchor = Instant::now();
            // Surface a live SDL send error if one appeared.
            let err = wheel.last_error();
            if !err.is_empty() && handle.status.load().error != err {
                push_status(&handle, &wheel, err);
            }
        }

        if !handle.running.load(Ordering::Relaxed) {
            break;
        }

        // 3) Event-driven wait for the next telemetry frame (keepalive fallback).
        // With no wheel open there is nothing time-critical to keep alive, so the
        // fallback stretches to 250 ms — motion frames still wake the loop
        // instantly, keeping the FFB tab's monitor live while the game runs.
        {
            let deadline = Duration::from_millis(if wheel.is_open() {
                FFB_KEEPALIVE_MS as u64
            } else {
                250
            });
            let guard = stats.wake.0.lock().unwrap();
            let running = &handle.running;
            let _ = stats.wake.1.wait_timeout_while(guard, deadline, |_| {
                running.load(Ordering::Relaxed)
                    && stats.motion_seq.load(Ordering::Relaxed) == seen_seq
            });
            seen_seq = stats.motion_seq.load(Ordering::Relaxed);
        }
        if !handle.running.load(Ordering::Relaxed) {
            break;
        }

        // 4) Honour the output-rate ceiling: never send closer than `interval`.
        // The sub-millisecond spin only matters for jitter on a live wheel; with no
        // device open a plain sleep is fine and keeps the idle loop off the CPU.
        let earliest_next = t0 + interval;
        if wheel.is_open() {
            let sleep_until = earliest_next.checked_sub(Duration::from_micros(500));
            if let Some(su) = sleep_until {
                let n = Instant::now();
                if n < su {
                    std::thread::sleep(su - n);
                }
            }
            while Instant::now() < earliest_next { /* spin the last ~500µs */ }
        } else {
            let n = Instant::now();
            if n < earliest_next {
                std::thread::sleep(earliest_next - n);
            }
        }
    }

    wheel.close_device();
    if rt_active {
        realtime_end();
    }
}

fn push_status(handle: &Arc<FfbHandle>, wheel: &WheelOutput, error: String) {
    handle.status.store(Arc::new(FfbStatus {
        device_open: wheel.is_open(),
        device_name: wheel.device_name(),
        active_index: wheel.active_index(),
        enabled: handle.enabled.load(Ordering::Relaxed),
        error,
    }));
}
