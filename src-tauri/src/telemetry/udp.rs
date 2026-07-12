//! The single UDP listener — binds the game port, parses each datagram, updates
//! the shared telemetry snapshot, maintains the FFB safety/pause signals, and
//! wakes the FFB engine on every fresh Motion Ex frame. Ported in spirit from the
//! C++ `UdpReceiver::loop`, minus the repeater (this is the sole receiver).

use std::net::UdpSocket;
use std::sync::atomic::{AtomicBool, AtomicU16, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::Duration;

use super::header::{Header, HEADER_LEN};
use super::packets;
use super::state::{now_ms, CarSetup, Latest, SharedTelemetry, FFB_PAUSE_FREEZE_MS};

// Packet ids (F1 2025/2026).
const PKT_MOTION: u8 = 0;
const PKT_SESSION: u8 = 1;
const PKT_LAP_DATA: u8 = 2;
const PKT_PARTICIPANTS: u8 = 4;
const PKT_CAR_SETUPS: u8 = 5;
const PKT_CAR_TELEM: u8 = 6;
const PKT_CAR_STATUS: u8 = 7;
const PKT_MOTION_EX: u8 = 13;
const PKT_CAR_TELEM2: u8 = 16;

/// Any qualifying-type session (Q1..One-Shot Shootout = 5..=14) — the modes that
/// offer the AI flying-lap run-up. Mirrors the C++ `sessionIsQualifying`.
fn session_is_qualifying(t: u8) -> bool {
    (5..=14).contains(&t)
}

/// Runtime knobs shared with the app: stop, retarget the port, toggle fake mode.
pub struct CoreControl {
    pub running: AtomicBool,
    pub desired_port: AtomicU16,
    pub fake: AtomicBool,
}

pub struct TelemetryCore {
    pub shared: Arc<SharedTelemetry>,
    pub control: Arc<CoreControl>,
    handle: Option<JoinHandle<()>>,
}

impl TelemetryCore {
    /// Start the core on `port`. Set `fake` to synthesise a lap with no game.
    pub fn start(port: u16, fake: bool) -> TelemetryCore {
        let shared = SharedTelemetry::new(port);
        let control = Arc::new(CoreControl {
            running: AtomicBool::new(true),
            desired_port: AtomicU16::new(port),
            fake: AtomicBool::new(fake),
        });
        let handle = {
            let shared = shared.clone();
            let control = control.clone();
            std::thread::spawn(move || run_loop(shared, control))
        };
        TelemetryCore {
            shared,
            control,
            handle: Some(handle),
        }
    }

    pub fn set_port(&self, port: u16) {
        self.control.desired_port.store(port, Ordering::Relaxed);
    }

    pub fn set_fake(&self, fake: bool) {
        self.control.fake.store(fake, Ordering::Relaxed);
    }

    pub fn stop(&mut self) {
        self.control.running.store(false, Ordering::Relaxed);
        if let Some(h) = self.handle.take() {
            let _ = h.join();
        }
    }
}

impl Drop for TelemetryCore {
    fn drop(&mut self) {
        self.stop();
    }
}

/// Per-connection parse state that lives across packets (not in the snapshot).
#[derive(Default)]
struct LoopState {
    last_session_uid: u64,
    last_frame: u32,
    streak_start_ms: i64,
    drove_pit_lane: bool,
}

fn run_loop(shared: Arc<SharedTelemetry>, control: Arc<CoreControl>) {
    let mut latest = Latest::default();
    let mut ls = LoopState::default();
    let mut socket: Option<UdpSocket> = None;
    let mut bound_port: u16 = 0;
    let mut buf = [0u8; 4096];
    let started = std::time::Instant::now();
    let mut was_fake = false;

    while control.running.load(Ordering::Relaxed) {
        // Fake mode: no socket; synthesise a lap and publish at ~60 Hz.
        if control.fake.load(Ordering::Relaxed) {
            socket = None;
            bound_port = 0;
            was_fake = true;
            fake_tick(&mut latest, &shared, started.elapsed().as_secs_f32());
            std::thread::sleep(Duration::from_millis(16));
            continue;
        }
        if was_fake {
            // Leaving fake mode: the latched "got a packet" no longer holds — the
            // UI should idle until real telemetry actually arrives.
            was_fake = false;
            shared.got_packet.store(false, Ordering::Relaxed);
        }

        // (Re)bind if the desired port changed or we don't have a socket.
        let want = control.desired_port.load(Ordering::Relaxed);
        if socket.is_none() || want != bound_port {
            match bind(want) {
                Ok(s) => {
                    socket = Some(s);
                    bound_port = want;
                    shared.udp_port.store(want, Ordering::Relaxed);
                    log::info!("[core] listening for F1 telemetry on UDP {want}");
                }
                Err(e) => {
                    log::warn!("[core] could not bind UDP {want}: {e}");
                    std::thread::sleep(Duration::from_millis(500));
                    continue;
                }
            }
        }

        let sock = socket.as_ref().unwrap();
        let len = match sock.recv(&mut buf) {
            Ok(n) => n,
            Err(_) => {
                // Timeout (so we can re-check running/port) or transient error.
                // The stream went quiet — push any packets the ~30 Hz snapshot
                // throttle skipped so the UI sees the burst's final state.
                shared.flush_ui(&latest);
                continue;
            }
        };
        if len < HEADER_LEN {
            continue;
        }
        handle_datagram(&buf[..len], &mut latest, &mut ls, &shared);
    }
}

fn bind(port: u16) -> std::io::Result<UdpSocket> {
    let sock = UdpSocket::bind(("0.0.0.0", port))?;
    // Short read timeout so the loop can re-check the running flag / port change.
    sock.set_read_timeout(Some(Duration::from_millis(200)))?;
    Ok(sock)
}

fn handle_datagram(buf: &[u8], latest: &mut Latest, ls: &mut LoopState, shared: &Arc<SharedTelemetry>) {
    let hdr = match Header::parse(buf) {
        Some(h) if h.is_supported() => h,
        _ => return,
    };
    let stats = &shared.stats;
    let now = now_ms();
    stats.udp_packets.fetch_add(1, Ordering::Relaxed);
    stats.last_udp_ms.store(now, Ordering::Relaxed);

    // New session → the recorded peak lateral force no longer applies.
    if hdr.session_uid != ls.last_session_uid {
        ls.last_session_uid = hdr.session_uid;
        stats.set_peak_lat_force(0.0);
    }
    latest.session_uid = hdr.session_uid;

    // Pause detection via the *overall* frame identifier (continuous across the
    // whole session, unlike frameIdentifier which resets at phase changes).
    if hdr.overall_frame_identifier != ls.last_frame {
        let prev_change = stats.last_frame_advance_ms.load(Ordering::Relaxed);
        if now - prev_change > FFB_PAUSE_FREEZE_MS {
            ls.streak_start_ms = now; // resuming after a freeze
        }
        ls.last_frame = hdr.overall_frame_identifier;
        stats.last_frame_advance_ms.store(now, Ordering::Relaxed);
        stats
            .frame_streak_start_ms
            .store(ls.streak_start_ms, Ordering::Relaxed);
    }

    let payload = &buf[HEADER_LEN..];

    match hdr.packet_id {
        PKT_SESSION => {
            if let Some(paused) = packets::parse_session(payload, latest) {
                stats.game_paused.store(paused, Ordering::Relaxed);
                stats.session_type.store(latest.session_type, Ordering::Relaxed);
                stats.track_length_m.store(latest.track_length, Ordering::Relaxed);
                shared.publish(latest);
            }
        }
        PKT_LAP_DATA => {
            if let Some(result_status) = packets::parse_lap_data(payload, &hdr, latest) {
                update_ai_from_lap(result_status, latest, ls, shared);
                shared.publish(latest);
            }
        }
        PKT_PARTICIPANTS => {
            if let Some(ai_car) = packets::parse_participants_ai(payload, &hdr) {
                stats.ai_controls_car.store(ai_car, Ordering::Relaxed);
            }
        }
        PKT_MOTION => {
            if packets::parse_motion(payload, &hdr, latest).is_some() {
                shared.publish(latest);
            }
        }
        PKT_MOTION_EX => {
            if packets::parse_motion_ex(payload, latest).is_some() {
                shared.publish(latest);
                // Motion Ex carries the core FFB inputs and lands once per physics
                // frame → use it as the event-driven wake for the FFB engine.
                stats.notify_frame();
            }
        }
        PKT_CAR_TELEM => {
            if packets::parse_car_telemetry(payload, &hdr, latest).is_some() {
                shared.publish(latest);
            }
        }
        PKT_CAR_STATUS => {
            if packets::parse_car_status(payload, &hdr, latest).is_some() {
                shared.publish(latest);
            }
        }
        PKT_CAR_TELEM2 => {
            if packets::parse_car_telemetry2(payload, &hdr, latest).is_some() {
                shared.publish(latest);
            }
        }
        PKT_CAR_SETUPS => {
            if packets::parse_car_setups(payload, &hdr, latest).is_some() {
                shared.publish(latest);
            }
        }
        _ => {}
    }
}

/// AI-in-control + flying-lap run-up detection (from Lap Data). Mirrors the C++
/// gate: pit-lane or session-finished means the AI has the car; a qualifying
/// out-lap the car was *placed* into (never drove the pit lane) is the run-up.
fn update_ai_from_lap(result_status: u8, l: &Latest, ls: &mut LoopState, shared: &Arc<SharedTelemetry>) {
    let stats = &shared.stats;
    let in_pit = l.pit_status != 0;
    let finished = result_status >= 3;
    stats.ai_in_control.store(in_pit || finished, Ordering::Relaxed);
    stats.pit_status.store(l.pit_status, Ordering::Relaxed);
    stats.driver_status.store(l.driver_status, Ordering::Relaxed);
    stats.set_lap_distance(l.lap_distance);

    if l.driver_status == 0 {
        ls.drove_pit_lane = false; // fresh run (in garage)
    }
    if l.pit_status != 0 && l.speed_kmh > 20.0 {
        ls.drove_pit_lane = true;
    }
    let ai_run_up = session_is_qualifying(stats.session_type.load(Ordering::Relaxed))
        && l.pit_status == 0
        && l.driver_status == 3 // out lap
        && !ls.drove_pit_lane;
    stats.ai_run_up.store(ai_run_up, Ordering::Relaxed);
}

// ── Fake mode: a synthetic lap so the pipeline (incl. FFB) is testable with no
// game. Ported from the old bridge's fake generator (f1-bridge.cjs:405-479),
// plus plausible physics fields so the FFB engine has something to react to. ──
fn fake_tick(l: &mut Latest, shared: &Arc<SharedTelemetry>, t: f32) {
    let lap = 90.0f32;
    let pct = (t % lap) / lap;
    let lap_index = (t / lap) as u32;
    let braking = (pct * std::f32::consts::PI * 8.0).sin() < -0.5;
    let clamp = |v: f32, lo: f32, hi: f32| v.max(lo).min(hi);

    l.track_length = 5278;
    l.track_id = 0;
    l.session_uid = 1; // synthetic but non-zero so the UI's session keying works
    l.session_type = if lap_index % 2 == 0 { 18 } else { 7 };
    l.lap_distance = pct * l.track_length as f32;
    l.speed_kmh = if braking { 90.0 } else { 260.0 };
    l.throttle = if braking { 0.05 } else { 0.95 };
    l.brake = if braking { 0.7 } else { 0.0 };
    l.steer = clamp((pct * std::f32::consts::PI * 12.0).sin() * 0.85, -1.0, 1.0);
    l.gear = clamp(l.speed_kmh / 42.0, 1.0, 8.0) as i8;
    l.rpm = 9000 + ((t * 3.0).sin().abs() * 3000.0) as u16;
    l.ers_mode = if braking { 1 } else { 3 };
    l.ers_store_energy = 2_000_000.0;
    l.ers_deployed_this_lap = pct * 4_000_000.0;
    l.ers_harvest_limit = 4_000_000.0;
    l.regs2026 = 1;
    l.lap_time = t % lap;
    l.lap_number = (lap_index % 200) as u8 + 1;
    l.last_lap_time = if t >= lap { lap } else { 0.0 };
    l.tyre_visual = 16;
    l.tyre_actual = 16;
    l.tyre_age = (lap_index % 200) as u8;
    // Tyre temps: surface spikes under braking + wanders; carcass is smoother —
    // two visibly distinct worms for the Telemetry tab's tyre panel.
    let surf = 92.0 + if braking { 14.0 } else { 0.0 } + (t * 0.7).sin() * 5.0;
    let carc = 95.0 + (t * 0.25).sin() * 3.0;
    for i in 0..4 {
        l.tyre_surface_temps[i] = (surf + i as f32 * 1.5) as u8;
        l.tyre_inner_temps[i] = (carc + i as f32) as u8;
    }
    l.driver_status = 1;
    l.pit_status = 0;
    l.lap_invalid = 0;
    // A plausible static garage setup so the Setup popup is testable with no game
    // (ported from the old bridge's fake generator, plus the engine-braking and
    // ballast bytes it omitted — both are real fields in 2025/2026, see
    // packets::parse_car_setups).
    if l.setup.is_none() {
        l.setup = Some(CarSetup {
            m_frontWing: 6,
            m_rearWing: 8,
            m_onThrottle: 65,
            m_offThrottle: 55,
            m_frontCamber: -3.0,
            m_rearCamber: -1.7,
            m_frontToe: 0.07,
            m_rearToe: 0.34,
            m_frontSuspension: 5,
            m_rearSuspension: 6,
            m_frontAntiRollBar: 7,
            m_rearAntiRollBar: 4,
            m_frontSuspensionHeight: 3,
            m_rearSuspensionHeight: 6,
            m_brakePressure: 95,
            m_brakeBias: 54,
            m_engineBraking: 60,
            m_rearLeftTyrePressure: 21.5,
            m_rearRightTyrePressure: 21.5,
            m_frontLeftTyrePressure: 23.5,
            m_frontRightTyrePressure: 23.5,
            m_ballast: 6,
            m_fuelLoad: 10.0,
        });
    }
    l.current_sector = if pct < 1.0 / 3.0 { 0 } else if pct < 2.0 / 3.0 { 1 } else { 2 };
    l.sector1_time = if pct >= 1.0 / 3.0 { lap / 3.0 } else { 0.0 };
    l.sector2_time = if pct >= 2.0 / 3.0 { lap / 3.0 } else { 0.0 };
    let ang = pct * 2.0 * std::f32::consts::PI;
    l.world_x = Some(600.0 * ang.cos() + 160.0 * (3.0 * ang).cos());
    l.world_z = Some(420.0 * ang.sin() + 130.0 * (2.0 * ang).sin());
    l.world_y = Some(18.0 * (ang * 3.0).sin() + 9.0 * (ang * 5.0).cos());

    // Synthetic physics so the FFB engine reacts: lateral force follows steering,
    // slip/lockup/spin around the braking/accel phases.
    l.lateral_g = l.steer * 3.5;
    l.front_lat_force = l.steer * 9000.0;
    l.front_lon_force = if braking { -14000.0 } else { 4000.0 };
    l.front_vert_force = 8000.0;
    l.front_slip_angle = (l.steer.abs() * 0.12).min(0.2);
    l.rear_slip_angle = (l.steer.abs() * 0.10).min(0.18);
    l.front_slip_ratio = if braking { -0.15 } else { 0.0 };
    l.rear_slip_ratio = if !braking && l.throttle > 0.9 { 0.2 } else { 0.0 };
    l.sideslip = l.steer * 0.08;

    let stats = &shared.stats;
    let now = now_ms();
    stats.udp_packets.fetch_add(1, Ordering::Relaxed);
    stats.last_udp_ms.store(now, Ordering::Relaxed);
    stats.last_frame_advance_ms.store(now, Ordering::Relaxed);
    stats.frame_streak_start_ms.store(now - 1000, Ordering::Relaxed);
    stats.session_type.store(l.session_type, Ordering::Relaxed);
    stats.track_length_m.store(l.track_length, Ordering::Relaxed);
    stats.driver_status.store(1, Ordering::Relaxed);
    stats.set_lap_distance(l.lap_distance);
    shared.publish(l);
    stats.notify_frame();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fake_tick_supplies_a_car_setup() {
        // Fake mode must populate a synthetic garage setup so the Car Setup modal
        // is testable with no game (parity with the old bridge's fake generator).
        let shared = SharedTelemetry::new(20777);
        let mut l = Latest::default();
        fake_tick(&mut l, &shared, 1.0);
        let setup = l.setup.as_ref().expect("fake mode populates a setup");
        assert_eq!(setup.m_frontWing, 6);
        assert!(setup.m_fuelLoad > 0.0);
        // …and it reaches the UI snapshot the emitter serialises.
        assert!(shared.ui.load().setup.is_some());
    }
}
