//! The single UDP listener — binds the game port, parses each datagram, updates
//! the shared telemetry snapshot, maintains the FFB safety/pause signals, and
//! wakes the FFB engine on every fresh Motion Ex frame. Ported in spirit from the
//! C++ `UdpReceiver::loop`, minus the repeater (this is the sole receiver).

use std::net::UdpSocket;
use std::sync::atomic::{AtomicBool, AtomicU16, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::Duration;

use super::demo::Replay;
use super::header::{Header, HEADER_LEN};
use super::packets;
use super::state::{now_ms, Latest, SharedTelemetry, FFB_PAUSE_FREEZE_MS};

// Packet ids (F1 2025/2026).
const PKT_MOTION: u8 = 0;
const PKT_SESSION: u8 = 1;
const PKT_LAP_DATA: u8 = 2;
const PKT_PARTICIPANTS: u8 = 4;
const PKT_CAR_SETUPS: u8 = 5;
const PKT_CAR_TELEM: u8 = 6;
const PKT_CAR_STATUS: u8 = 7;
const PKT_CAR_DAMAGE: u8 = 10;
const PKT_MOTION_EX: u8 = 13;
const PKT_CAR_TELEM2: u8 = 16;

/// Any qualifying-type session (Q1..One-Shot Shootout = 5..=14) — the modes that
/// offer the AI flying-lap run-up. Mirrors the C++ `sessionIsQualifying`.
fn session_is_qualifying(t: u8) -> bool {
    (5..=14).contains(&t)
}

/// How often the demo replay publishes a frame (ms) — ~60 Hz, matching the rate
/// the game's physics packets land at.
const DEMO_TICK_MS: u64 = 16;

/// Runtime knobs shared with the app: stop, retarget the port, toggle demo mode.
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

    /// Is the core synthesising telemetry right now? The UI seeds its Demo Mode
    /// toggle from this, so launching with `F1_FAKE=1` shows the toggle already
    /// on instead of the two disagreeing.
    pub fn is_fake(&self) -> bool {
        self.control.fake.load(Ordering::Relaxed)
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
    let mut replay = Replay::default();
    let mut last_demo_tick = std::time::Instant::now();
    let mut was_fake = false;

    while control.running.load(Ordering::Relaxed) {
        // Demo mode: no socket; replay the recorded session at ~60 Hz.
        if control.fake.load(Ordering::Relaxed) {
            socket = None;
            bound_port = 0;
            if !was_fake {
                // Entering demo → start the recorded race from its first lap.
                was_fake = true;
                latest = Latest::default();
                replay.reset();
                last_demo_tick = std::time::Instant::now();
            }
            // Wall-clock dt so the replay runs in real time; capped so a stalled
            // thread (sleeping laptop, breakpoint) resumes instead of skipping
            // half the race.
            let dt = last_demo_tick.elapsed().as_secs_f32().min(0.25);
            last_demo_tick = std::time::Instant::now();
            replay.tick(&mut latest, &shared, dt);
            std::thread::sleep(Duration::from_millis(DEMO_TICK_MS));
            continue;
        }
        if was_fake {
            // Leaving demo mode: the latched "got a packet" no longer holds — the
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
        PKT_CAR_DAMAGE => {
            if packets::parse_car_damage(payload, &hdr, latest).is_some() {
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

// Demo mode's frame source is `super::demo::Replay` — a replay of a real recorded
// session. It replaced the sine-wave lap generator that used to live here, so the
// no-game path exercises the pipeline with data the game actually produced.
