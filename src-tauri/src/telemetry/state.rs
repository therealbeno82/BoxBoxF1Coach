//! Shared telemetry state.
//!
//! Only the UDP thread writes `Latest`; it owns it exclusively (no lock). After
//! each relevant packet it publishes an immutable `Snapshot` into an `ArcSwap`,
//! which the FFB thread reads lock-free (real-time path) and a throttled emitter
//! serialises to the webview. The `AppStats` atomics carry the FFB safety/pause
//! signals that are cheaper to expose directly than to fold into the snapshot.

use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU8, AtomicU16, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};

use arc_swap::ArcSwap;
use serde::Serialize;

/// Freeze threshold (ms): no new physics frame this long → the game is paused /
/// in a menu. Mirrors the C++ `FFB_PAUSE_FREEZE_MS`.
pub const FFB_PAUSE_FREEZE_MS: i64 = 350;

/// Minimum interval between UI `Snapshot` builds. Packets arrive at up to
/// ~300-400/s across all types, but the emitter only samples the snapshot at
/// ~30 Hz — building it more often is pure waste (heap string + setup clone).
const UI_BUILD_MIN_MS: i64 = 33;

/// Deployable ERS energy per lap (J) → battery %. Mirrors the bridge's constant.
const MAX_ERS_JOULES: f32 = 4_000_000.0;

/// Everything the UDP thread accumulates from the various packet types. The
/// physics fields (forces/slips) mirror the C++ `TelemetryState`; the rest feed
/// the UI snapshot the Coach tabs consume.
#[derive(Clone)]
pub struct Latest {
    // ── Physics (Motion Ex + Motion) — the FFB inputs ──
    pub lateral_g: f32,
    pub front_slip_angle: f32,
    pub rear_slip_angle: f32,
    pub front_lat_force: f32,
    pub front_lon_force: f32,
    pub front_vert_force: f32,
    pub sideslip: f32,
    pub front_slip_ratio: f32,
    pub rear_slip_ratio: f32,

    // ── Car Telemetry ──
    pub speed_kmh: f32,
    pub steer: f32,    // -1..1
    pub throttle: f32, // 0..1
    pub brake: f32,    // 0..1
    pub gear: i8,
    pub rpm: u16,
    /// Per-wheel tyre temps (°C), wheel order RL RR FL FR (the game's array order).
    pub tyre_surface_temps: [u8; 4],
    pub tyre_inner_temps: [u8; 4],

    // ── Car Status (ERS + tyres) ──
    pub ers_mode: u8,
    pub ers_store_energy: f32,
    pub ers_deployed_this_lap: f32,
    pub ers_harvest_limit: f32,
    pub tyre_visual: i8,
    pub tyre_actual: i8,
    pub tyre_age: u8,

    // ── Car Damage ──
    /// Per-wheel tyre wear (%), wheel order RL RR FL FR.
    pub tyre_wear: [f32; 4],

    // ── Car Telemetry 2 (2026 boost + active aero) ──
    pub overtake_available: u8,
    pub overtake_active: u8,
    pub overtake_activation_distance: u16,
    pub active_aero_mode: u8,
    pub active_aero_available: u8,
    pub active_aero_activation_distance: u16,
    pub regs2026: u8,

    // ── Lap Data ──
    pub lap_distance: f32,
    pub lap_time: f32,
    pub last_lap_time: f32,
    pub lap_number: u8,
    pub driver_status: u8,
    pub pit_status: u8,
    pub lap_invalid: u8,
    pub sector1_time: f32,
    pub sector2_time: f32,
    pub current_sector: u8,

    // ── Session ──
    pub track_id: i8,
    pub session_type: u8,
    pub track_length: u16,
    /// Session weather (0 clear … 5 storm) + track/air temperature (°C).
    pub weather: u8,
    pub track_temp: i8,
    pub air_temp: i8,
    pub sector2_start: f32,
    pub sector3_start: f32,
    /// The game's per-session UID (from every packet header) — the UI keys its
    /// drive "session" on this so a pause/resume never resets the session.
    pub session_uid: u64,
    /// The online `m_gamePaused` flag from the Session packet. Sticky until the
    /// next Session packet updates it; forwarded to the UI so the coach can mute
    /// track cues while the game is paused (a pause otherwise replays cues).
    pub game_paused: bool,

    // ── Motion (world position) ──
    pub world_x: Option<f32>,
    pub world_y: Option<f32>,
    pub world_z: Option<f32>,

    // ── Car Setups (raw player struct, forwarded verbatim to the UI) ──
    pub setup: Option<CarSetup>,
}

impl Default for Latest {
    fn default() -> Self {
        Latest {
            lateral_g: 0.0,
            front_slip_angle: 0.0,
            rear_slip_angle: 0.0,
            front_lat_force: 0.0,
            front_lon_force: 0.0,
            front_vert_force: 0.0,
            sideslip: 0.0,
            front_slip_ratio: 0.0,
            rear_slip_ratio: 0.0,
            speed_kmh: 0.0,
            steer: 0.0,
            throttle: 0.0,
            brake: 0.0,
            gear: 0,
            rpm: 0,
            tyre_surface_temps: [0; 4],
            tyre_inner_temps: [0; 4],
            ers_mode: 0,
            ers_store_energy: MAX_ERS_JOULES * 0.5,
            ers_deployed_this_lap: 0.0,
            ers_harvest_limit: 0.0,
            tyre_visual: -1,
            tyre_actual: -1,
            tyre_age: 0,
            tyre_wear: [0.0; 4],
            overtake_available: 0,
            overtake_active: 0,
            overtake_activation_distance: 0,
            active_aero_mode: 0,
            active_aero_available: 0,
            active_aero_activation_distance: 0,
            regs2026: 0,
            lap_distance: 0.0,
            lap_time: 0.0,
            last_lap_time: 0.0,
            lap_number: 0,
            driver_status: 4,
            pit_status: 0,
            lap_invalid: 0,
            sector1_time: 0.0,
            sector2_time: 0.0,
            current_sector: 0,
            track_id: -1,
            session_type: 0,
            track_length: 0,
            weather: 0,
            track_temp: 0,
            air_temp: 0,
            sector2_start: 0.0,
            sector3_start: 0.0,
            session_uid: 0,
            game_paused: false,
            world_x: None,
            world_y: None,
            world_z: None,
            setup: None,
        }
    }
}

/// Raw player car setup — field names mirror the F1 UDP spec (and the old
/// bridge's forwarded object) so the existing CarSetupModal keeps working.
#[derive(Clone, Serialize)]
#[allow(non_snake_case)]
pub struct CarSetup {
    pub m_frontWing: u8,
    pub m_rearWing: u8,
    pub m_onThrottle: u8,
    pub m_offThrottle: u8,
    pub m_frontCamber: f32,
    pub m_rearCamber: f32,
    pub m_frontToe: f32,
    pub m_rearToe: f32,
    pub m_frontSuspension: u8,
    pub m_rearSuspension: u8,
    pub m_frontAntiRollBar: u8,
    pub m_rearAntiRollBar: u8,
    pub m_frontSuspensionHeight: u8,
    pub m_rearSuspensionHeight: u8,
    pub m_brakePressure: u8,
    pub m_brakeBias: u8,
    pub m_engineBraking: u8,
    pub m_rearLeftTyrePressure: f32,
    pub m_rearRightTyrePressure: f32,
    pub m_frontLeftTyrePressure: f32,
    pub m_frontRightTyrePressure: f32,
    pub m_ballast: u8,
    pub m_fuelLoad: f32,
}

/// The FFB-facing physics snapshot (read lock-free by the FFB thread).
#[derive(Clone, Copy, Default)]
pub struct FfbTelemetry {
    pub lateral_g: f32,
    pub front_slip_angle: f32,
    pub rear_slip_angle: f32,
    pub front_lat_force: f32,
    pub front_lon_force: f32,
    pub front_vert_force: f32,
    pub sideslip: f32,
    pub front_slip_ratio: f32,
    pub rear_slip_ratio: f32,
    pub speed_kmh: f32,
    pub steer: f32,
    pub throttle: f32,
    pub brake: f32,
}

/// The JSON telemetry snapshot the webview consumes. Field-for-field identical
/// to the old bridge `snapshot()` so every downstream Coach consumer is unchanged.
/// camelCase field names are deliberate — they are the serialized wire contract.
#[derive(Clone, Serialize)]
#[allow(non_snake_case)]
pub struct Snapshot {
    pub trackId: i32,
    pub sessionType: u8,
    pub lapPct: f32,
    pub lapDistance: f32,
    pub throttle: i32,
    pub brake: i32,
    pub steer: i32,
    pub speed: i32,
    pub gear: i8,
    pub rpm: i32,
    pub ersMode: u8,
    pub ersDeploy: i32,
    pub ersBattery: i32,
    pub ersHarvestLimit: i32,
    pub overtakeAvailable: u8,
    pub overtakeActive: u8,
    pub overtakeActivationDistance: u16,
    pub activeAeroMode: u8,
    pub activeAeroAvailable: u8,
    pub activeAeroActivationDistance: u16,
    pub regs2026: u8,
    pub lapTime: f32,
    pub lapNumber: u8,
    pub lastLapTime: f32,
    pub tyreVisual: i8,
    pub tyreActual: i8,
    pub tyreAge: u8,
    /// Per-wheel tyre temps (°C), wheel order RL RR FL FR.
    pub tyreSurfaceTemps: [u8; 4],
    pub tyreInnerTemps: [u8; 4],
    /// Per-wheel tyre wear (%), wheel order RL RR FL FR.
    pub tyreWear: [f32; 4],
    /// Session conditions: weather code (0 clear … 5 storm) + temps (°C).
    pub weather: u8,
    pub trackTemp: i8,
    pub airTemp: i8,
    pub driverStatus: u8,
    pub pitStatus: u8,
    pub lapInvalid: u8,
    pub sector1Time: f32,
    pub sector2Time: f32,
    pub currentSector: u8,
    pub sector2Pct: f32,
    pub sector3Pct: f32,
    /// Stringified u64 — a raw u64 can exceed JS Number.MAX_SAFE_INTEGER.
    pub sessionUid: String,
    /// True while the game is paused (Session packet `m_gamePaused`) — the UI
    /// mutes real-time track cues so a pause doesn't replay them.
    pub gamePaused: bool,
    pub worldX: Option<f32>,
    pub worldY: Option<f32>,
    pub worldZ: Option<f32>,
    pub setup: Option<CarSetup>,
}

#[allow(non_snake_case)]
impl Snapshot {
    /// Build the UI snapshot from the accumulated `Latest`, applying the same
    /// unit conversions the old bridge did (throttle→%, joules→battery %, …).
    pub fn from_latest(l: &Latest) -> Snapshot {
        let clamp = |v: f32, lo: f32, hi: f32| v.max(lo).min(hi);
        let track_len = l.track_length as f32;
        let lap_pct = if track_len > 0.0 {
            clamp(l.lap_distance / track_len, 0.0, 1.0)
        } else {
            0.0
        };
        Snapshot {
            trackId: l.track_id as i32,
            sessionType: l.session_type,
            lapPct: lap_pct,
            lapDistance: l.lap_distance.max(0.0).round(),
            throttle: (clamp(l.throttle, 0.0, 1.0) * 100.0).round() as i32,
            brake: (clamp(l.brake, 0.0, 1.0) * 100.0).round() as i32,
            steer: (clamp(l.steer, -1.0, 1.0) * 100.0).round() as i32,
            speed: l.speed_kmh.round() as i32,
            gear: l.gear,
            rpm: l.rpm as i32,
            ersMode: l.ers_mode,
            ersDeploy: (l.ers_deployed_this_lap / 1000.0).round() as i32,
            ersBattery: clamp((l.ers_store_energy / MAX_ERS_JOULES) * 100.0, 0.0, 100.0).round()
                as i32,
            ersHarvestLimit: (l.ers_harvest_limit / 1000.0).round() as i32,
            overtakeAvailable: l.overtake_available,
            overtakeActive: l.overtake_active,
            overtakeActivationDistance: l.overtake_activation_distance,
            activeAeroMode: l.active_aero_mode,
            activeAeroAvailable: l.active_aero_available,
            activeAeroActivationDistance: l.active_aero_activation_distance,
            regs2026: l.regs2026,
            lapTime: l.lap_time,
            lapNumber: l.lap_number,
            lastLapTime: l.last_lap_time,
            tyreVisual: l.tyre_visual,
            tyreActual: l.tyre_actual,
            tyreAge: l.tyre_age,
            tyreSurfaceTemps: l.tyre_surface_temps,
            tyreInnerTemps: l.tyre_inner_temps,
            tyreWear: l.tyre_wear,
            weather: l.weather,
            trackTemp: l.track_temp,
            airTemp: l.air_temp,
            driverStatus: l.driver_status,
            pitStatus: l.pit_status,
            lapInvalid: l.lap_invalid,
            sector1Time: l.sector1_time,
            sector2Time: l.sector2_time,
            currentSector: l.current_sector,
            sector2Pct: if track_len > 0.0 && l.sector2_start > 0.0 {
                clamp(l.sector2_start / track_len, 0.0, 1.0)
            } else {
                1.0 / 3.0
            },
            sector3Pct: if track_len > 0.0 && l.sector3_start > 0.0 {
                clamp(l.sector3_start / track_len, 0.0, 1.0)
            } else {
                2.0 / 3.0
            },
            sessionUid: l.session_uid.to_string(),
            gamePaused: l.game_paused,
            worldX: l.world_x,
            worldY: l.world_y,
            worldZ: l.world_z,
            setup: l.setup.clone(),
        }
    }

    pub fn ffb(l: &Latest) -> FfbTelemetry {
        FfbTelemetry {
            lateral_g: l.lateral_g,
            front_slip_angle: l.front_slip_angle,
            rear_slip_angle: l.rear_slip_angle,
            front_lat_force: l.front_lat_force,
            front_lon_force: l.front_lon_force,
            front_vert_force: l.front_vert_force,
            sideslip: l.sideslip,
            front_slip_ratio: l.front_slip_ratio,
            rear_slip_ratio: l.rear_slip_ratio,
            speed_kmh: l.speed_kmh,
            steer: l.steer,
            throttle: l.throttle,
            brake: l.brake,
        }
    }
}

/// FFB safety / pause signals, plus the wake primitive the FFB engine blocks on.
/// Written by the UDP thread, read by the FFB thread — cheap atomics, no lock on
/// the hot path (mirrors the C++ `AppStats`).
pub struct AppStats {
    pub udp_packets: AtomicU64,
    pub last_udp_ms: AtomicI64,
    pub last_frame_advance_ms: AtomicI64,
    pub frame_streak_start_ms: AtomicI64,
    pub game_paused: AtomicBool,
    pub ai_in_control: AtomicBool,
    pub ai_controls_car: AtomicBool,
    pub ai_run_up: AtomicBool,
    pub ai_run_up_held: AtomicBool,
    pub tt_holding: AtomicBool,
    pub session_type: AtomicU8,
    pub track_length_m: AtomicU16,
    pub driver_status: AtomicU8,
    pub pit_status: AtomicU8,
    pub lap_distance: AtomicU32, // f32 bits
    pub peak_lat_force_n: AtomicU32, // f32 bits
    pub clip_level: AtomicU32,   // f32 bits
    pub ffb_updates: AtomicU64,

    /// Event-driven FFB wake: bumped once per Motion Ex frame; the FFB thread
    /// waits on the condvar so it computes on fresh data with minimal latency.
    pub motion_seq: AtomicU64,
    pub wake: (Mutex<()>, Condvar),
}

impl Default for AppStats {
    fn default() -> Self {
        AppStats {
            udp_packets: AtomicU64::new(0),
            last_udp_ms: AtomicI64::new(0),
            last_frame_advance_ms: AtomicI64::new(0),
            frame_streak_start_ms: AtomicI64::new(0),
            game_paused: AtomicBool::new(false),
            ai_in_control: AtomicBool::new(false),
            ai_controls_car: AtomicBool::new(false),
            ai_run_up: AtomicBool::new(false),
            ai_run_up_held: AtomicBool::new(false),
            tt_holding: AtomicBool::new(false),
            session_type: AtomicU8::new(0),
            track_length_m: AtomicU16::new(0),
            driver_status: AtomicU8::new(0xFF),
            pit_status: AtomicU8::new(0),
            lap_distance: AtomicU32::new(0),
            peak_lat_force_n: AtomicU32::new(0),
            clip_level: AtomicU32::new(0),
            ffb_updates: AtomicU64::new(0),
            motion_seq: AtomicU64::new(0),
            wake: (Mutex::new(()), Condvar::new()),
        }
    }
}

impl AppStats {
    pub fn set_lap_distance(&self, v: f32) {
        self.lap_distance.store(v.to_bits(), Ordering::Relaxed);
    }
    pub fn get_lap_distance(&self) -> f32 {
        f32::from_bits(self.lap_distance.load(Ordering::Relaxed))
    }
    pub fn set_peak_lat_force(&self, v: f32) {
        self.peak_lat_force_n.store(v.to_bits(), Ordering::Relaxed);
    }
    pub fn get_peak_lat_force(&self) -> f32 {
        f32::from_bits(self.peak_lat_force_n.load(Ordering::Relaxed))
    }
    pub fn set_clip_level(&self, v: f32) {
        self.clip_level.store(v.to_bits(), Ordering::Relaxed);
    }
    pub fn get_clip_level(&self) -> f32 {
        f32::from_bits(self.clip_level.load(Ordering::Relaxed))
    }
    /// Bump the motion sequence and wake the FFB engine (one fresh frame arrived).
    pub fn notify_frame(&self) {
        let _g = self.wake.0.lock().unwrap_or_else(|e| e.into_inner());
        self.motion_seq.fetch_add(1, Ordering::Relaxed);
        self.wake.1.notify_one();
    }
    /// Is the UDP core currently receiving packets (any in the last `within_ms`)?
    pub fn receiving(&self, now_ms: i64, within_ms: i64) -> bool {
        let last = self.last_udp_ms.load(Ordering::Relaxed);
        last != 0 && (now_ms - last) < within_ms
    }
}

/// The handle shared across threads: the latest snapshot (UI + FFB) and stats.
pub struct SharedTelemetry {
    pub ui: ArcSwap<Snapshot>,
    pub ffb: ArcSwap<FfbTelemetry>,
    pub stats: AppStats,
    /// Whether any real packet has been seen (the UI keeps its own simulator
    /// until real telemetry starts flowing, mirroring the old bridge).
    pub got_packet: AtomicBool,
    /// UDP port the core is currently bound to (for the Settings readout).
    pub udp_port: AtomicU16,
    /// When the UI snapshot was last built, and whether packets have landed
    /// since — publish() throttles builds to ~30 Hz and flush_ui() catches the
    /// trailing update when the stream goes quiet.
    last_ui_build_ms: AtomicI64,
    ui_dirty: AtomicBool,
}

impl SharedTelemetry {
    pub fn new(port: u16) -> Arc<SharedTelemetry> {
        let seed = Latest::default();
        Arc::new(SharedTelemetry {
            ui: ArcSwap::from_pointee(Snapshot::from_latest(&seed)),
            ffb: ArcSwap::from_pointee(Snapshot::ffb(&seed)),
            stats: AppStats::default(),
            got_packet: AtomicBool::new(false),
            udp_port: AtomicU16::new(port),
            last_ui_build_ms: AtomicI64::new(0),
            ui_dirty: AtomicBool::new(false),
        })
    }

    /// Publish after a parsed packet. The FFB snapshot (small, Copy) is always
    /// refreshed — it feeds the real-time thread. The UI snapshot is only
    /// rebuilt at ~30 Hz; in-between packets just mark it dirty.
    pub fn publish(&self, l: &Latest) {
        self.ffb.store(Arc::new(Snapshot::ffb(l)));
        self.got_packet.store(true, Ordering::Relaxed);
        let now = now_ms();
        if now - self.last_ui_build_ms.load(Ordering::Relaxed) >= UI_BUILD_MIN_MS {
            self.build_ui(l, now);
        } else {
            self.ui_dirty.store(true, Ordering::Relaxed);
        }
    }

    /// Build the UI snapshot from any packets the throttle skipped — called when
    /// the receive loop goes idle, so the final state of a burst (e.g. the
    /// lap-complete packet right before a pause) always reaches the UI.
    pub fn flush_ui(&self, l: &Latest) {
        if self.ui_dirty.load(Ordering::Relaxed) {
            self.build_ui(l, now_ms());
        }
    }

    fn build_ui(&self, l: &Latest, now: i64) {
        self.last_ui_build_ms.store(now, Ordering::Relaxed);
        self.ui_dirty.store(false, Ordering::Relaxed);
        self.ui.store(Arc::new(Snapshot::from_latest(l)));
    }
}

/// Milliseconds since the UNIX epoch (steady enough for the freeze/streak math).
pub fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
