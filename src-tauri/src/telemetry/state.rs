//! Shared telemetry state.
//!
//! Only the UDP thread writes `Latest`; it owns it exclusively (no lock). After
//! each relevant packet it publishes an immutable `Snapshot` into an `ArcSwap`,
//! which the FFB thread reads lock-free (real-time path) and a throttled emitter
//! serialises to the webview. The `AppStats` atomics carry the FFB safety/pause
//! signals that are cheaper to expose directly than to fold into the snapshot.

use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU8, AtomicU16, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Instant;

use arc_swap::ArcSwap;
use serde::{Deserialize, Serialize};

/// Freeze threshold (ms): no new physics frame this long → the game is paused /
/// in a menu. Mirrors the C++ `FFB_PAUSE_FREEZE_MS`.
pub const FFB_PAUSE_FREEZE_MS: i64 = 350;

/// Minimum interval between UI `Snapshot` builds. Packets arrive at up to
/// ~300-400/s across all types, but the emitter only samples the snapshot at
/// ~30 Hz — building it more often is pure waste (heap string + setup clone).
const UI_BUILD_MIN_MS: i64 = 33;

/// Deployable ERS energy per lap (J) → battery %. Mirrors the bridge's constant.
pub const MAX_ERS_JOULES: f32 = 4_000_000.0;

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

    // ── Car Status (fuel + ERS + tyres) ──
    /// Fuel currently in the tank (kg).
    pub fuel_in_tank: f32,
    /// The MFD's fuel figure: laps of fuel in hand *against what is left to run*
    /// — already a delta, negative when the car is short.
    pub fuel_remaining_laps: f32,
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
            fuel_in_tank: 0.0,
            fuel_remaining_laps: 0.0,
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
/// `Deserialize` so the demo session's recorded setup loads straight into it.
#[derive(Clone, Serialize, Deserialize)]
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
///
/// Deliberately NOT cfg'd out on mobile even though only the desktop FFB engine
/// reads it: it's 13 `f32`s, so publishing one `Arc` of it per packet is free, and
/// gating it would give Android a different `Snapshot`/`publish` shape than the
/// unit tests exercise. Identical code on both targets is worth ~50 bytes a packet.
#[cfg_attr(mobile, allow(dead_code))]
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

#[cfg_attr(mobile, allow(dead_code))]
#[derive(Clone, Copy, Default)]
pub struct FfbFrame {
    /// This frame's number in the Motion Ex sequence, stamped by
    /// `publish_ffb_frame`. The FFB thread accepts a frame when this differs from
    /// the last one it took — one load, nothing to race (see engine.rs).
    pub seq: u64,
    pub telem: FfbTelemetry,
    pub session_time: Option<f32>,
    pub frame_identifier: u32,
    pub arrival_s: f64,
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
    /// Fuel in the tank (kg) and the MFD's laps-in-hand delta (negative = short).
    /// The lap recorder diffs the tank across a lap to get what that lap burned.
    pub fuelInTank: f32,
    pub fuelRemainingLaps: f32,
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
            fuelInTank: l.fuel_in_tank,
            fuelRemainingLaps: l.fuel_remaining_laps,
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
        // Everything the FFB engine touches is sanitised HERE, at the one point
        // every frame enters the system. The game never sends NaN, but a
        // malformed/crafted datagram can put one in a Motion Ex float, and every
        // filter in the engine is an `x += a * (NaN - x)` recurrence — one bad
        // sample would latch every smoothed state for the rest of the stint.
        // wheel.rs already zeroes non-finite OUTPUT; this keeps the internal
        // state finite so the engine can recover instead of going silently limp.
        #[inline]
        fn fin(v: f32) -> f32 {
            if v.is_finite() { v } else { 0.0 }
        }
        FfbTelemetry {
            lateral_g: fin(l.lateral_g),
            front_slip_angle: fin(l.front_slip_angle),
            rear_slip_angle: fin(l.rear_slip_angle),
            front_lat_force: fin(l.front_lat_force),
            front_lon_force: fin(l.front_lon_force),
            front_vert_force: fin(l.front_vert_force),
            sideslip: fin(l.sideslip),
            front_slip_ratio: fin(l.front_slip_ratio),
            rear_slip_ratio: fin(l.rear_slip_ratio),
            speed_kmh: fin(l.speed_kmh),
            steer: fin(l.steer),
            throttle: fin(l.throttle),
            brake: fin(l.brake),
        }
    }
}

/// FFB safety / pause signals, plus the wake primitive the FFB engine blocks on.
/// Written by the UDP thread, read by the FFB thread — cheap atomics, no lock on
/// the hot path (mirrors the C++ `AppStats`).
///
/// The FFB-only fields stay on mobile for the same reason `FfbTelemetry` does:
/// the UDP thread writes them either way, and nothing reads them there.
#[cfg_attr(mobile, allow(dead_code))]
pub struct AppStats {
    pub udp_packets: AtomicU64,
    pub motion_frames: AtomicU64,
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

    /// Motion Ex frame counter; each published FfbFrame carries its value.
    pub motion_seq: AtomicU64,
    /// Parks the FFB thread between output ticks with no wheel open, and lets
    /// `stop` wake it promptly. Telemetry no longer signals it: the output loop
    /// free-runs on its own clock, so a per-frame notify only woke an idle thread
    /// sixty times a second for nothing.
    pub wake: (Mutex<()>, Condvar),
}

impl Default for AppStats {
    fn default() -> Self {
        AppStats {
            udp_packets: AtomicU64::new(0),
            motion_frames: AtomicU64::new(0),
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
            motion_seq: AtomicU64::new(0),
            wake: (Mutex::new(()), Condvar::new()),
        }
    }
}

/// Accessors for the atomics above. The getters exist for the FFB engine, so on
/// mobile they are written but never read — see the note on the struct.
#[cfg_attr(mobile, allow(dead_code))]
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
    /// Is the UDP core currently receiving packets (any in the last `within_ms`)?
    pub fn receiving(&self, now_ms: i64, within_ms: i64) -> bool {
        let last = self.last_udp_ms.load(Ordering::Relaxed);
        last != 0 && (now_ms - last) < within_ms
    }
}

/// The handle shared across threads: the latest snapshot (UI + FFB) and stats.
pub struct SharedTelemetry {
    pub ui: ArcSwap<Snapshot>,
    pub ffb_frame: ArcSwap<FfbFrame>,
    pub stats: AppStats,
    /// Whether any real packet has been seen (the UI keeps its own simulator
    /// until real telemetry starts flowing, mirroring the old bridge).
    pub got_packet: AtomicBool,
    /// UDP port the core is currently bound to (for the Settings readout).
    pub udp_port: AtomicU16,
    /// Why the listener has no socket right now (another program holding the
    /// port, usually), or None while bound. Surfaced in `core_status` — a bind
    /// failure used to reach only the log, so the UI just said "waiting".
    pub bind_error: Mutex<Option<String>>,
    /// The packet format of the last datagram dropped for being unsupported
    /// (e.g. 2024 when the game's UDP Format is set wrong), and when. 0 = none.
    pub unsupported_format: AtomicU16,
    pub unsupported_ms: AtomicI64,
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
            ffb_frame: ArcSwap::from_pointee(FfbFrame::default()),
            stats: AppStats::default(),
            got_packet: AtomicBool::new(false),
            udp_port: AtomicU16::new(port),
            bind_error: Mutex::new(None),
            unsupported_format: AtomicU16::new(0),
            unsupported_ms: AtomicI64::new(0),
            // Seeded a full interval in the past so the FIRST publish always
            // builds. `now_ms` is monotonic from process start, so 0 is a real
            // recent timestamp — seeding to 0 would throttle the first snapshot
            // away for the first UI_BUILD_MIN_MS of life (and `now_ms()` may
            // itself be 0 here, since this is often its first caller).
            last_ui_build_ms: AtomicI64::new(now_ms() - UI_BUILD_MIN_MS),
            ui_dirty: AtomicBool::new(false),
        })
    }

    /// Publish after a parsed packet. The UI snapshot is only rebuilt at
    /// ~30 Hz; in-between packets just mark it dirty. The FFB frame is NOT
    /// published here — it is a Motion Ex frame, published only by
    /// `publish_ffb_frame` so the real-time thread always reads one physics
    /// frame's channels together.
    pub fn publish(&self, l: &Latest) {
        self.got_packet.store(true, Ordering::Relaxed);
        let now = now_ms();
        if now - self.last_ui_build_ms.load(Ordering::Relaxed) >= UI_BUILD_MIN_MS {
            self.build_ui(l, now);
        } else {
            self.ui_dirty.store(true, Ordering::Relaxed);
        }
    }

    /// Publish one Motion Ex frame for the FFB thread, stamped with the next
    /// sequence number. The number travels INSIDE the frame, so the reader needs
    /// one load to know both what the frame is and whether it has seen it.
    /// Bumping a separate counter after the store left a window — two frames
    /// back to back over Wi-Fi — where the reader paired frame N+2 with N+1's
    /// number and then pushed N+2 again on its next tick: a duplicate knot, which
    /// is the slope kink the predictor exists to remove.
    #[cfg_attr(mobile, allow(dead_code))]
    pub fn publish_ffb_frame(
        &self,
        l: &Latest,
        session_time: Option<f32>,
        frame_identifier: u32,
        arrival_s: f64,
    ) {
        let seq = self.stats.motion_seq.fetch_add(1, Ordering::Relaxed) + 1;
        self.ffb_frame.store(Arc::new(FfbFrame {
            seq,
            telem: Snapshot::ffb(l),
            session_time,
            frame_identifier,
            arrival_s,
        }));
    }

    /// Forget everything the demo replay left behind. Entering demo starts from a
    /// clean `Latest`; leaving it used to keep the replay's Singapore track id,
    /// setup, lap data, fuel and wear in the snapshot until real packets happened
    /// to overwrite each field — the Session and Setup packets only come every
    /// ~500 ms, so the first live snapshots mixed the two. The FFB-facing stats go
    /// back to their defaults for the same reason. The last FFB frame is left in
    /// place: it stops advancing, which the engine already treats as frozen, and
    /// replacing it would hand the predictor a fresh all-zero knot.
    pub fn reset_after_demo(&self) {
        let fresh = Latest::default();
        self.got_packet.store(false, Ordering::Relaxed);
        let s = &self.stats;
        s.game_paused.store(false, Ordering::Relaxed);
        s.ai_in_control.store(false, Ordering::Relaxed);
        s.ai_run_up.store(false, Ordering::Relaxed);
        s.ai_controls_car.store(false, Ordering::Relaxed);
        s.session_type.store(0, Ordering::Relaxed);
        s.track_length_m.store(0, Ordering::Relaxed);
        s.driver_status.store(0xFF, Ordering::Relaxed);
        s.pit_status.store(0, Ordering::Relaxed);
        s.set_lap_distance(0.0);
        self.build_ui(&fresh, now_ms());
    }

    /// Record a datagram dropped for an unsupported packet format.
    pub fn note_unsupported(&self, format: u16) {
        self.unsupported_format.store(format, Ordering::Relaxed);
        self.unsupported_ms.store(now_ms(), Ordering::Relaxed);
    }

    pub fn set_bind_error(&self, err: Option<String>) {
        *self.bind_error.lock().unwrap_or_else(|e| e.into_inner()) = err;
    }

    /// What the UI's connection pill and Settings readout need. Compared by value
    /// in the emitter (it is only emitted when it changes) and returned as-is by
    /// the `get_core_status` command, so a page that subscribes AFTER the change
    /// can still ask.
    pub fn core_status(&self, now: i64) -> CoreStatus {
        let receiving = self.stats.receiving(now, 1500);
        let fmt = self.unsupported_format.load(Ordering::Relaxed);
        // Only report a wrong format while it is actually what's arriving: once
        // supported packets flow, the stale note means nothing.
        let wrong_format = (fmt != 0
            && !receiving
            && now - self.unsupported_ms.load(Ordering::Relaxed) < 3000)
            .then_some(fmt);
        CoreStatus {
            receiving,
            udp_port: self.udp_port.load(Ordering::Relaxed),
            bind_error: self.bind_error.lock().unwrap_or_else(|e| e.into_inner()).clone(),
            wrong_format,
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

/// The core's connection state, as the UI receives it (`core_status` event and
/// `get_core_status` command). camelCase is the wire contract.
#[derive(Clone, Serialize, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CoreStatus {
    pub receiving: bool,
    pub udp_port: u16,
    pub bind_error: Option<String>,
    pub wrong_format: Option<u16>,
}

/// Milliseconds on a monotonic clock anchored at first use. Deliberately NOT
/// wall time: every consumer subtracts two stamps (freeze/streak detection, the
/// UI throttle, TT holds, `receiving`), so only the deltas matter — and a
/// monotonic base keeps an NTP/clock step from turning a delta negative (a UI
/// throttle that stalls until the clock catches up) or huge (a false pause).
pub fn now_ms() -> i64 {
    mono_start().elapsed().as_millis() as i64
}

/// The same clock at sub-millisecond resolution, for the FFB frame stamps and
/// the predictor's render-time axis.
pub fn now_secs() -> f64 {
    mono_start().elapsed().as_secs_f64()
}

/// Convert an `Instant` on the monotonic clock into seconds since its anchor.
/// Only the FFB engine (desktop) reads it.
#[cfg_attr(mobile, allow(dead_code))]
pub fn mono_secs(t: Instant) -> f64 {
    t.saturating_duration_since(mono_start()).as_secs_f64()
}

fn mono_start() -> Instant {
    use std::sync::OnceLock;
    static START: OnceLock<Instant> = OnceLock::new();
    *START.get_or_init(Instant::now)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn core_status_names_a_wrong_packet_format_only_while_nothing_else_arrives() {
        let shared = SharedTelemetry::new(20777);
        let now = now_ms();
        assert_eq!(shared.core_status(now).wrong_format, None);

        shared.note_unsupported(2024);
        let st = shared.core_status(now_ms());
        assert!(!st.receiving);
        assert_eq!(st.wrong_format, Some(2024));

        // Supported packets flowing again → the stale note means nothing.
        shared.stats.last_udp_ms.store(now_ms().max(1), Ordering::Relaxed);
        assert_eq!(shared.core_status(now_ms()).wrong_format, None);
    }

    #[test]
    fn a_bind_error_is_reported_until_cleared() {
        let shared = SharedTelemetry::new(20777);
        shared.set_bind_error(Some("in use".into()));
        assert_eq!(shared.core_status(now_ms()).bind_error.as_deref(), Some("in use"));
        shared.set_bind_error(None);
        assert_eq!(shared.core_status(now_ms()).bind_error, None);
    }

    #[test]
    fn leaving_demo_clears_the_replayed_session() {
        let shared = SharedTelemetry::new(20777);
        let mut l = Latest::default();
        l.track_id = 12;
        l.track_length = 4940;
        l.lap_distance = 2000.0;
        shared.publish(&l);
        shared.stats.session_type.store(13, Ordering::Relaxed);
        assert_eq!(shared.ui.load().trackId, 12);

        shared.reset_after_demo();
        let snap = shared.ui.load();
        assert_eq!(snap.trackId, Latest::default().track_id as i32);
        assert_eq!(snap.lapDistance, 0.0);
        assert!(!shared.got_packet.load(Ordering::Relaxed));
        assert_eq!(shared.stats.session_type.load(Ordering::Relaxed), 0);
        assert_eq!(shared.stats.track_length_m.load(Ordering::Relaxed), 0);
    }
}
