//! Demo mode — replay of a REAL recorded session.
//!
//! With no game running the core used to synthesise a lap from sine waves, which
//! exercised the pipeline but looked nothing like driving. Instead it now replays
//! a real session recorded by the app's own lap log (`demo/session.json`, built
//! by `scripts/make-demo-session.mjs` and compiled in — the demo has to work from
//! a fresh install with no files alongside the exe).
//!
//! The file is distance-binned every 10 m with a precomputed time axis, so a tick
//! is: advance the lap clock, walk the cursor forward, lerp between two samples.
//! Everything downstream — UI snapshot, lap recorder, coach, FFB — sees exactly
//! what it would see from the game.
//!
//! Two families of channel are NOT in a recorded lap and are modelled here from
//! the real ones, because the FFB engine and the tyre/ERS panels need them:
//!   • forces + slips — from the recorded lateral/longitudinal g (which the build
//!     script measured off the world path and the speed trace), so the wheel
//!     loads up in the real corners at the real moments;
//!   • ERS state of charge, rpm, tyre wear — plausible models around the real
//!     deployment, gear/speed and stint age.

use std::sync::atomic::Ordering;
use std::sync::{Arc, OnceLock};

use serde::Deserialize;

use super::state::{now_ms, CarSetup, Latest, SharedTelemetry, MAX_ERS_JOULES};

/// The replay session, compiled into the exe (~2 MB) so Demo Mode never depends
/// on files next to the binary. Regenerate with `scripts/make-demo-session.mjs`.
const SESSION_JSON: &str = include_str!("../../demo/session.json");

/// Peak MGU-K recovery under braking (W) — 2026 regulations.
const HARVEST_WATTS: f32 = 350_000.0;

#[derive(Deserialize)]
pub struct DemoSession {
    pub driver: String,
    pub track: Option<String>,
    #[serde(rename = "trackId")]
    pub track_id: i8,
    #[serde(rename = "trackLength")]
    pub track_length: u16,
    #[serde(rename = "sessionType")]
    pub session_type: u8,
    pub laps: Vec<DemoLap>,
}

#[derive(Deserialize)]
pub struct DemoLap {
    #[serde(rename = "lapNumber")]
    pub lap_number: u8,
    #[serde(rename = "lapTime")]
    pub lap_time: f32,
    pub invalid: bool,
    #[serde(rename = "sectorTimes")]
    pub sector_times: Vec<f32>,
    #[serde(rename = "sector2Start")]
    pub sector2_start: f32,
    #[serde(rename = "sector3Start")]
    pub sector3_start: f32,
    pub weather: u8,
    #[serde(rename = "trackTemp")]
    pub track_temp: i8,
    #[serde(rename = "airTemp")]
    pub air_temp: i8,
    pub tyre: DemoTyre,
    pub setup: Option<CarSetup>,
    pub samples: Vec<DemoSample>,
}

#[derive(Deserialize)]
pub struct DemoTyre {
    pub visual: i8,
    pub actual: i8,
    pub age: u8,
}

/// One 10 m bin. Short field names — 12k of these ship inside the exe.
#[derive(Deserialize)]
pub struct DemoSample {
    /// Seconds since the lap started.
    pub t: f32,
    /// Lap distance (m).
    pub d: f32,
    pub th: f32, // throttle %
    pub br: f32, // brake %
    pub st: f32, // steer, -100..100
    pub sp: f32, // speed km/h
    pub g: i8,   // gear
    pub em: u8,  // ERS mode
    pub ek: f32, // ERS deployed this lap (kJ)
    pub bo: u8,  // boost (overtake) active
    pub ae: u8,  // active-aero mode
    pub ts: u8,  // tyre surface temp (°C, 4-wheel average)
    pub tc: u8,  // tyre carcass temp (°C, 4-wheel average)
    pub x: f32,
    pub y: f32,
    pub z: f32,
    pub lg: f32, // lateral g (signed, + = turning right)
    pub ag: f32, // longitudinal g (+ = accelerating)
}

/// Parsed once, on the first demo tick — a ~2 MB parse we don't want in startup
/// for the (usual) case of someone who has the game running.
fn session() -> Option<&'static DemoSession> {
    static PARSED: OnceLock<Option<DemoSession>> = OnceLock::new();
    PARSED
        .get_or_init(|| match serde_json::from_str::<DemoSession>(SESSION_JSON) {
            Ok(s) if !s.laps.is_empty() => {
                log::info!(
                    "[core] demo session: {} at {} — {} laps",
                    s.driver,
                    s.track.as_deref().unwrap_or("unknown"),
                    s.laps.len()
                );
                Some(s)
            }
            Ok(_) => {
                log::error!("[core] demo session has no laps — demo mode will idle");
                None
            }
            Err(e) => {
                log::error!("[core] demo session failed to parse: {e} — demo mode will idle");
                None
            }
        })
        .as_ref()
}

/// Playback cursor. One per core; `reset()` on every entry into demo mode so the
/// toggle always starts the race from lap 1.
pub struct Replay {
    lap: usize,
    /// Seconds into the current lap.
    t: f32,
    /// Index of the sample at or before `t` (monotonic within a lap).
    cursor: usize,
    /// Bumped each time the replay wraps, so the UI files each run through the
    /// session as its own drive rather than appending 25 more laps to the last.
    session_uid: u64,
    last_lap_time: f32,
    /// Integrated ERS store (J) — see `tick`.
    ers_store: f32,
}

impl Default for Replay {
    fn default() -> Self {
        Replay {
            lap: 0,
            t: 0.0,
            cursor: 0,
            session_uid: 1, // non-zero: the UI keys its drive session on this
            last_lap_time: 0.0,
            ers_store: MAX_ERS_JOULES,
        }
    }
}

fn lerp(a: f32, b: f32, u: f32) -> f32 {
    a + (b - a) * u
}

impl Replay {
    /// Restart from the first lap (entering demo mode).
    pub fn reset(&mut self) {
        let uid = self.session_uid + 1;
        *self = Replay {
            session_uid: uid,
            ..Replay::default()
        };
    }

    /// Advance the replay by `dt` seconds and publish the resulting snapshot.
    /// Returns false when there is no session to play (a broken data file).
    pub fn tick(&mut self, l: &mut Latest, shared: &Arc<SharedTelemetry>, dt: f32) -> bool {
        let Some(s) = session() else { return false };

        // ── Advance the lap clock (a `while`, so a long stall skips whole laps
        // rather than falling behind forever).
        self.t += dt;
        while self.t >= s.laps[self.lap].lap_time {
            self.t -= s.laps[self.lap].lap_time;
            self.last_lap_time = s.laps[self.lap].lap_time;
            self.cursor = 0;
            self.lap += 1;
            if self.lap >= s.laps.len() {
                self.lap = 0;
                self.session_uid += 1; // replay wrapped → a fresh drive session
            }
        }
        let lap = &s.laps[self.lap];

        // ── Interpolate between the two bins straddling `t`.
        while self.cursor + 2 < lap.samples.len() && lap.samples[self.cursor + 1].t <= self.t {
            self.cursor += 1;
        }
        let a = &lap.samples[self.cursor];
        let b = lap.samples.get(self.cursor + 1).unwrap_or(a);
        let span = b.t - a.t;
        let u = if span > 1e-4 {
            ((self.t - a.t) / span).clamp(0.0, 1.0)
        } else {
            0.0
        };
        // Fraction of the lap completed — drives the modelled wear/charge curves.
        let lap_frac = (self.t / lap.lap_time).clamp(0.0, 1.0);

        // ── Session / lap identity ──
        l.session_uid = self.session_uid;
        l.track_id = s.track_id;
        l.track_length = s.track_length;
        l.session_type = s.session_type;
        l.weather = lap.weather;
        l.track_temp = lap.track_temp;
        l.air_temp = lap.air_temp;
        l.regs2026 = 1;
        l.game_paused = false;
        l.driver_status = 1; // flying lap
        l.pit_status = 0;
        l.lap_number = lap.lap_number;
        l.lap_time = self.t;
        l.last_lap_time = self.last_lap_time;
        l.lap_invalid = lap.invalid as u8;
        if lap.setup.is_some() {
            l.setup = lap.setup.clone();
        }

        // ── Recorded channels ──
        l.lap_distance = lerp(a.d, b.d, u);
        l.speed_kmh = lerp(a.sp, b.sp, u);
        l.throttle = lerp(a.th, b.th, u) / 100.0;
        l.brake = lerp(a.br, b.br, u) / 100.0;
        l.steer = (lerp(a.st, b.st, u) / 100.0).clamp(-1.0, 1.0);
        l.gear = a.g; // discrete: hold the bin's value, never lerp through a shift
        l.ers_mode = a.em;
        l.ers_deployed_this_lap = lerp(a.ek, b.ek, u) * 1000.0; // kJ → J
        l.ers_harvest_limit = MAX_ERS_JOULES;
        l.overtake_active = a.bo;
        l.overtake_available = 1 - a.bo;
        l.overtake_activation_distance = 0;
        l.active_aero_mode = a.ae;
        l.active_aero_available = 1;
        l.active_aero_activation_distance = 0;
        l.tyre_visual = lap.tyre.visual;
        l.tyre_actual = lap.tyre.actual;
        l.tyre_age = lap.tyre.age;
        l.world_x = Some(lerp(a.x, b.x, u));
        l.world_y = Some(lerp(a.y, b.y, u));
        l.world_z = Some(lerp(a.z, b.z, u));

        // ── Sectors: the recorded splits, released as the lap clock passes them.
        let s1 = lap.sector_times.first().copied().unwrap_or(0.0);
        let s2 = lap.sector_times.get(1).copied().unwrap_or(0.0);
        l.sector1_time = if self.t >= s1 { s1 } else { 0.0 };
        l.sector2_time = if self.t >= s1 + s2 { s2 } else { 0.0 };
        l.current_sector = if self.t < s1 {
            0
        } else if self.t < s1 + s2 {
            1
        } else {
            2
        };
        l.sector2_start = lap.sector2_start;
        l.sector3_start = lap.sector3_start;

        // ── Tyre temps: the lap carries the 4-wheel average, so spread the wheels
        // around it (fronts run hotter than rears at a street circuit).
        let surf = lerp(a.ts as f32, b.ts as f32, u);
        let carc = lerp(a.tc as f32, b.tc as f32, u);
        const WHEEL_BIAS: [f32; 4] = [-3.0, -2.0, 2.0, 3.0]; // RL RR FL FR
        for i in 0..4 {
            l.tyre_surface_temps[i] = (surf + WHEEL_BIAS[i]).clamp(0.0, 255.0) as u8;
            l.tyre_inner_temps[i] = (carc + WHEEL_BIAS[i] * 0.5).clamp(0.0, 255.0) as u8;
        }

        // ── Tyre wear: not recorded. Model a stint at ~1%/lap off the set's real
        // age, so the lap log's wear column moves and resets with each new set.
        let laps_on_set = lap.tyre.age as f32 + lap_frac;
        for i in 0..4 {
            l.tyre_wear[i] = laps_on_set * 1.0 + i as f32 * 0.4;
        }

        // ── ERS state of charge: not recorded either, but deployment is — so
        // integrate it, and harvest under braking. Wanders like the real thing
        // instead of sitting at a constant.
        let deploy_w = if span > 1e-4 {
            ((b.ek - a.ek) * 1000.0 / span).max(0.0)
        } else {
            0.0
        };
        self.ers_store += (l.brake * HARVEST_WATTS - deploy_w) * dt;
        self.ers_store = self.ers_store.clamp(0.0, MAX_ERS_JOULES);
        l.ers_store_energy = self.ers_store;

        // ── rpm: not recorded. Approximate the gear's speed band so the shift
        // lights sweep and reset with each upshift.
        let band = 45.0 * l.gear.max(1) as f32 + 25.0;
        let load = (l.speed_kmh / band).clamp(0.35, 1.0);
        l.rpm = (4000.0 + load * 11000.0) as u16;

        // ── FFB physics from the measured g's. Magnitudes are chosen to land in
        // the same range as the game's own (front axle ≈ 10 kN at the limit,
        // ~18 kN of longitudinal load under maximum braking) so a wheel tuned on
        // real telemetry feels the same in demo.
        let lat_g = lerp(a.lg, b.lg, u);
        let lon_g = lerp(a.ag, b.ag, u);
        let v_ms = l.speed_kmh / 3.6;
        l.lateral_g = lat_g;
        l.front_lat_force = lat_g * 2000.0;
        l.front_lon_force = lon_g * 3500.0;
        l.front_vert_force = 6000.0 + (v_ms / 80.0).powi(2) * 8000.0; // static + downforce
        // Slip angles rise with cornering load; trail braking loads the front,
        // power-down loads the rear — the asymmetry is what the understeer /
        // oversteer cues read.
        let grip = (lat_g.abs() / 4.0).min(1.0);
        l.front_slip_angle = grip * 0.11 + l.brake * grip * 0.03;
        l.rear_slip_angle = grip * 0.10 + l.throttle * grip * 0.03;
        l.sideslip = lat_g * 0.015; // rad — ~3.5° at the limit
        // Lockups only at the very top of the pedal; wheelspin only on a slow exit.
        l.front_slip_ratio = -0.10 * ((l.brake - 0.9) / 0.1).clamp(0.0, 1.0);
        l.rear_slip_ratio = 0.18
            * ((l.throttle - 0.9) / 0.1).clamp(0.0, 1.0)
            * ((120.0 - l.speed_kmh) / 60.0).clamp(0.0, 1.0);

        // ── Publish (mirrors what handle_datagram does for real packets).
        let stats = &shared.stats;
        let now = now_ms();
        stats.udp_packets.fetch_add(1, Ordering::Relaxed);
        stats.last_udp_ms.store(now, Ordering::Relaxed);
        stats.last_frame_advance_ms.store(now, Ordering::Relaxed);
        stats.frame_streak_start_ms.store(now - 1000, Ordering::Relaxed);
        stats.game_paused.store(false, Ordering::Relaxed);
        stats.ai_in_control.store(false, Ordering::Relaxed);
        stats.ai_run_up.store(false, Ordering::Relaxed);
        stats.session_type.store(l.session_type, Ordering::Relaxed);
        stats.track_length_m.store(l.track_length, Ordering::Relaxed);
        stats.driver_status.store(l.driver_status, Ordering::Relaxed);
        stats.pit_status.store(l.pit_status, Ordering::Relaxed);
        stats.set_lap_distance(l.lap_distance);
        shared.publish(l);
        stats.notify_frame();
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::telemetry::state::Snapshot;

    #[test]
    fn the_shipped_session_parses() {
        let s = session().expect("demo/session.json parses");
        assert!(!s.laps.is_empty());
        for lap in &s.laps {
            // A zero-length lap would spin `tick`'s advance loop forever.
            assert!(lap.lap_time > 1.0, "lap {} has no time", lap.lap_number);
            assert!(lap.samples.len() >= 10);
            // The time axis must be sorted and end on the lap time — the cursor
            // walk and the lap-advance both rely on it.
            assert!(lap.samples.windows(2).all(|w| w[1].t > w[0].t));
            let end = lap.samples.last().unwrap().t;
            assert!((end - lap.lap_time).abs() < 0.05, "lap {} ends at {end}", lap.lap_number);
        }
    }

    #[test]
    fn replay_walks_real_laps_in_order() {
        let shared = SharedTelemetry::new(20777);
        let mut r = Replay::default();
        let mut l = Latest::default();
        let s = session().unwrap();

        // Half a second in: still on lap 1, moving, with the real circuit tagged.
        for _ in 0..30 {
            assert!(r.tick(&mut l, &shared, 1.0 / 60.0));
        }
        assert_eq!(l.lap_number, s.laps[0].lap_number);
        assert_eq!(l.track_id, s.track_id);
        assert!(l.speed_kmh > 0.0);
        assert!(l.setup.is_some(), "the recorded garage setup reaches the UI");
        assert!(shared.ui.load().setup.is_some());

        // Skip past the first lap → the second lap of the recording, with the
        // first one's real time reported as the last lap.
        r.tick(&mut l, &shared, s.laps[0].lap_time);
        assert_eq!(l.lap_number, s.laps[1].lap_number);
        assert_eq!(l.last_lap_time, s.laps[0].lap_time);
    }

    /// Play the whole session at 60 Hz and check what the UI would actually see:
    /// every recorded lap, in order, each taking the time it was really set, with
    /// the distance resetting once per lap and the speed trace staying inside the
    /// recorded envelope. This is the end-to-end guard on the time axis — a bad
    /// one drifts silently rather than failing a spot check.
    #[test]
    fn full_session_replays_every_lap_at_its_real_time() {
        let shared = SharedTelemetry::new(20777);
        let mut r = Replay::default();
        let mut l = Latest::default();
        let s = session().unwrap();
        let dt = 1.0 / 60.0;

        let mut seen: Vec<(u8, f64)> = Vec::new(); // (lap number, observed duration)
        let mut lap_start = 0.0f64;
        // Ticks, not an accumulated f32 — 150k additions of 1/60 lose ~0.3 s of
        // precision over a 42-minute race, which would swamp what's measured here.
        let mut ticks = 0u32;
        let mut prev_lap = 0u8;
        let mut prev_dist = 0.0f32;
        let mut resets = 0;
        let total: f64 = s.laps.iter().map(|x| x.lap_time as f64).sum();

        while (ticks as f64) / 60.0 < total - 1.0 {
            r.tick(&mut l, &shared, dt);
            ticks += 1;
            let clock = (ticks as f64) / 60.0;
            if l.lap_number != prev_lap {
                if prev_lap != 0 {
                    seen.push((prev_lap, clock - lap_start));
                }
                prev_lap = l.lap_number;
                lap_start = clock;
            }
            if l.lap_distance < prev_dist {
                resets += 1;
            }
            prev_dist = l.lap_distance;
            assert!(l.speed_kmh > 0.0 && l.speed_kmh < 400.0, "speed {}", l.speed_kmh);
            assert!(l.gear >= 0 && l.gear <= 8, "gear {}", l.gear);
            assert!((0.0..=1.0).contains(&l.throttle) && (0.0..=1.0).contains(&l.brake));
            assert!(l.lap_distance <= s.track_length as f32);

            // …and the same frame as the webview receives it (the wire contract
            // every screen, the lap recorder and the coach read).
            let snap = Snapshot::from_latest(&l);
            assert!((0.0..=1.0).contains(&snap.lapPct));
            assert!((0..=100).contains(&snap.ersBattery), "battery {}", snap.ersBattery);
            assert!(snap.sector2Pct > 0.0 && snap.sector2Pct < snap.sector3Pct && snap.sector3Pct < 1.0);
            assert!(snap.worldX.is_some() && snap.worldZ.is_some(), "the track map needs world position");
            assert!(matches!(snap.tyreVisual, 7 | 8 | 16 | 17 | 18), "compound {}", snap.tyreVisual);
        }

        assert_eq!(seen.len(), s.laps.len() - 1, "every lap but the last one ended");
        for ((num, observed), lap) in seen.iter().zip(s.laps.iter()) {
            assert_eq!(*num, lap.lap_number);
            assert!(
                (observed - lap.lap_time as f64).abs() < 0.05,
                "lap {num} replayed in {observed:.3}s, was set in {:.3}s",
                lap.lap_time
            );
        }
        assert_eq!(resets, s.laps.len() - 1, "distance resets once per lap");
    }

    #[test]
    fn replay_wraps_into_a_new_session() {
        let shared = SharedTelemetry::new(20777);
        let mut r = Replay::default();
        let mut l = Latest::default();
        let total: f32 = session().unwrap().laps.iter().map(|x| x.lap_time).sum();
        r.tick(&mut l, &shared, 1.0 / 60.0);
        let first_uid = l.session_uid;
        r.tick(&mut l, &shared, total);
        assert_eq!(l.lap_number, session().unwrap().laps[0].lap_number);
        assert!(l.session_uid > first_uid, "a wrap starts a fresh drive session");
    }
}
