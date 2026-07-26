//! Per-packet extraction of the *player car's* fields, by fixed offset within a
//! format-aware per-car stride. This mirrors the C++ `udp_receiver.cpp` (which
//! reads the player slice by offset) and the field layouts in
//! `bridge/f1-2026-parser.cjs`. Reading only the player slice — rather than
//! parsing full per-car arrays — is both faster and immune to array slot-count
//! questions, since the player index alone locates the slice.
//!
//! `payload` is the datagram *after* the 29-byte header.

use super::header::Header;
use super::raw::{f32_at, i16_at, i8_at, u16_at, u8_at};
use super::state::{CarSetup, Latest};

// ── Per-car strides (bytes), format 2026 primary / 2025 fallback ──
const MOTION_STRIDE_2026: usize = 54;
const MOTION_STRIDE_2025: usize = 60;
const CAR_TELEM_STRIDE_2026: usize = 59;
const CAR_TELEM_STRIDE_2025: usize = 60;
const CAR_STATUS_STRIDE_2026: usize = 59;
const CAR_STATUS_STRIDE_2025: usize = 55;
const LAP_DATA_STRIDE: usize = 57;
const CAR_SETUP_STRIDE: usize = 50;
const CAR_TELEM2_STRIDE: usize = 10;

#[inline]
fn is26(h: &Header) -> bool {
    h.packet_format == 2026
}


// ── Motion (id 0): world position + lateral G ──
pub fn parse_motion(payload: &[u8], h: &Header, l: &mut Latest) -> Option<()> {
    let stride = if is26(h) { MOTION_STRIDE_2026 } else { MOTION_STRIDE_2025 };
    let base = h.player_car_index as usize * stride;
    l.world_x = Some(f32_at(payload, base)?);
    l.world_y = Some(f32_at(payload, base + 4)?);
    l.world_z = Some(f32_at(payload, base + 8)?);
    // gForceLateral @36: int16/1000 in 2026, float in 2025.
    l.lateral_g = if is26(h) {
        i16_at(payload, base + 36)? as f32 / 1000.0
    } else {
        f32_at(payload, base + 36)?
    };
    Some(())
}

// ── Motion Ex (id 13, player car only): tyre forces + slip → the FFB inputs ──
// Layout ported from the C++ `PacketMotionExData`. Wheel order: RL=0 RR=1 FL=2 FR=3.
// Each leading array is 4×f32 (16 bytes): susPos@0 susVel@16 susAcc@32 wheelSpeed@48
// slipRatio@64 slipAngle@80 latForce@96 lonForce@112; then scalars — localVelX@132,
// localVelZ@140; and wheelVertForce@172.
pub fn parse_motion_ex(payload: &[u8], l: &mut Latest) -> Option<()> {
    let f = |o: usize| f32_at(payload, o);
    let slip_angle = |w: usize| f(80 + w * 4);
    let slip_ratio = |w: usize| f(64 + w * 4);
    let lat_force = |w: usize| f(96 + w * 4);
    let lon_force = |w: usize| f(112 + w * 4);
    let vert_force = |w: usize| f(172 + w * 4);

    l.front_slip_angle = (slip_angle(2)?.abs() + slip_angle(3)?.abs()) * 0.5;
    l.rear_slip_angle = (slip_angle(0)?.abs() + slip_angle(1)?.abs()) * 0.5;
    l.front_lat_force = lat_force(2)? + lat_force(3)?;
    l.front_lon_force = lon_force(2)? + lon_force(3)?;
    l.front_vert_force = vert_force(2)? + vert_force(3)?;
    l.front_slip_ratio = (slip_ratio(2)? + slip_ratio(3)?) * 0.5;
    l.rear_slip_ratio = (slip_ratio(0)? + slip_ratio(1)?) * 0.5;

    // Vehicle sideslip from local velocity: atan2(lateral, |forward|); gated at
    // low speed where the ratio is numerically meaningless.
    let vx = f(132)?;
    let vz = f(140)?;
    l.sideslip = if vz.abs() > 1.0 { vx.atan2(vz.abs()) } else { 0.0 };
    Some(())
}

// ── Car Telemetry (id 6): speed/throttle/steer/brake/gear/rpm + tyre temps ──
// All the fields we read — including the tyre temp arrays at +30/+34 — sit before
// the 2026 engine-temperature type change, so only the stride (which locates the
// player slice) is format-dependent.
pub fn parse_car_telemetry(payload: &[u8], h: &Header, l: &mut Latest) -> Option<()> {
    let stride = if is26(h) { CAR_TELEM_STRIDE_2026 } else { CAR_TELEM_STRIDE_2025 };
    let base = h.player_car_index as usize * stride;
    l.speed_kmh = u16_at(payload, base)? as f32;
    l.throttle = f32_at(payload, base + 2)?;
    l.steer = f32_at(payload, base + 6)?;
    l.brake = f32_at(payload, base + 10)?;
    l.gear = i8_at(payload, base + 15)?;
    l.rpm = u16_at(payload, base + 16)?;
    // tyresSurfaceTemperature[4] @30, tyresInnerTemperature[4] @34 — u8 °C,
    // wheel order RL RR FL FR.
    for i in 0..4 {
        l.tyre_surface_temps[i] = u8_at(payload, base + 30 + i)?;
        l.tyre_inner_temps[i] = u8_at(payload, base + 34 + i)?;
    }
    Some(())
}

// ── Car Status (id 7): ERS + tyre compound/age ──
pub fn parse_car_status(payload: &[u8], h: &Header, l: &mut Latest) -> Option<()> {
    let stride = if is26(h) { CAR_STATUS_STRIDE_2026 } else { CAR_STATUS_STRIDE_2025 };
    let base = h.player_car_index as usize * stride;
    l.tyre_actual = u8_at(payload, base + 25)? as i8;
    l.tyre_visual = u8_at(payload, base + 26)? as i8;
    l.tyre_age = u8_at(payload, base + 27)?;
    l.ers_store_energy = f32_at(payload, base + 37)?;
    l.ers_mode = u8_at(payload, base + 41)?;
    // 2026 inserted m_ersHarvestLimitPerLap before m_ersDeployedThisLap.
    if is26(h) {
        l.ers_harvest_limit = f32_at(payload, base + 50)?;
        l.ers_deployed_this_lap = f32_at(payload, base + 54)?;
    } else {
        l.ers_harvest_limit = 0.0;
        l.ers_deployed_this_lap = f32_at(payload, base + 50)?;
    }
    Some(())
}

// ── Car Telemetry 2 (id 16, 2026): boost / active aero ──
pub fn parse_car_telemetry2(payload: &[u8], h: &Header, l: &mut Latest) -> Option<()> {
    let base = h.player_car_index as usize * CAR_TELEM2_STRIDE;
    l.active_aero_mode = u8_at(payload, base)?;
    l.active_aero_available = u8_at(payload, base + 1)?;
    l.active_aero_activation_distance = u16_at(payload, base + 2)?;
    l.overtake_available = u8_at(payload, base + 4)?;
    l.overtake_active = u8_at(payload, base + 5)?;
    l.overtake_activation_distance = u16_at(payload, base + 6)?;
    l.regs2026 = u8_at(payload, base + 8)?;
    Some(())
}

// ── Lap Data (id 2): timing, sectors, validity + AI signals ──
// Everything lands in `Latest`; the return value is m_resultStatus, the one
// AI-detection input the snapshot doesn't carry.
pub fn parse_lap_data(payload: &[u8], h: &Header, l: &mut Latest) -> Option<u8> {
    let base = h.player_car_index as usize * LAP_DATA_STRIDE;
    let sector_seconds = |ms_off: usize, min_off: usize| -> Option<f32> {
        let ms = u16_at(payload, base + ms_off)? as f32;
        let min = u8_at(payload, base + min_off)? as f32;
        Some((min * 60000.0 + ms) / 1000.0)
    };
    l.last_lap_time = super::raw::u32_at(payload, base)? as f32 / 1000.0;
    l.lap_time = super::raw::u32_at(payload, base + 4)? as f32 / 1000.0;
    l.sector1_time = sector_seconds(8, 10)?;
    l.sector2_time = sector_seconds(11, 13)?;
    // NB: keep the raw (possibly negative) value — F1 reports m_lapDistance as
    // negative before the S/F line on an out-lap, which the FFB flying-lap release
    // (engine.rs) needs. The UI re-clamps independently in Snapshot::from_latest.
    l.lap_distance = f32_at(payload, base + 20)?;
    l.lap_number = u8_at(payload, base + 33)?;
    l.pit_status = u8_at(payload, base + 34)?;
    l.current_sector = u8_at(payload, base + 36)?;
    l.lap_invalid = u8_at(payload, base + 37)?;
    l.driver_status = u8_at(payload, base + 44)?;
    u8_at(payload, base + 45) // m_resultStatus
}

// ── Participants (id 4): m_aiControlled for the player car ──
pub fn parse_participants_ai(payload: &[u8], h: &Header) -> Option<bool> {
    // Payload = 1 byte m_numActiveCars, then m_participants[CARS]; the AI flag is
    // the first byte of each participant. Derive the stride from the payload so
    // it self-adjusts to the (2025/2026) struct size. The grid is 22 cars in both
    // formats; also tolerate a 24-slot padded array so a game build that ships one
    // degrades to a correct parse instead of disabling AI detection entirely.
    const HEADER_BYTE: usize = 1;
    let body = payload.len().checked_sub(HEADER_BYTE).filter(|&b| b > 0)?;
    let cars = [h.max_cars(), 24].into_iter().find(|&c| body % c == 0)?;
    let stride = body / cars;
    let base = HEADER_BYTE + h.player_car_index as usize * stride;
    Some(u8_at(payload, base)? != 0)
}

// ── Session (id 1): track/session + sector boundaries + game-paused ──
// Returns the online `m_gamePaused` flag; updates track/session fields on `l`.
// Leading fixed fields (stable across 2025/2026): m_weather@0, trackTemp@1,
// airTemp@2, totalLaps@3, trackLength@4 (u16), sessionType@6, trackId@7,
// formula@8, sessionTimeLeft@9, sessionDuration@11, pitSpeedLimit@13, gamePaused@14.
pub fn parse_session(payload: &[u8], l: &mut Latest) -> Option<bool> {
    // Weather + temps: the Live screen stamps them on each session block of the
    // lap log, so a race review shows the conditions each stint was driven in.
    l.weather = u8_at(payload, 0)?;
    l.track_temp = i8_at(payload, 1)?;
    l.air_temp = i8_at(payload, 2)?;
    l.track_length = u16_at(payload, 4)?;
    l.session_type = u8_at(payload, 6)?;
    l.track_id = i8_at(payload, 7)?;
    let game_paused = u8_at(payload, 14)? != 0;
    l.game_paused = game_paused;
    // The sector-2/3 lap-distance starts sit at the very tail of the packet, after
    // the marshal-zone and weather-forecast arrays. Read them relative to the end
    // so we don't have to walk the whole variable-length body — then sanity-check
    // them (ordered, on-track) so a future format revision that appends trailing
    // fields degrades to the UI's 1/3–2/3 fallback instead of silently misplacing
    // the mini-sector boundaries for the whole session.
    if payload.len() >= 8 {
        let s3 = f32_at(payload, payload.len() - 4)?;
        let s2 = f32_at(payload, payload.len() - 8)?;
        let track_len = l.track_length as f32;
        if s2 > 0.0 && s2 < s3 && s3 < track_len {
            l.sector2_start = s2;
            l.sector3_start = s3;
        } else {
            // Implausible → clear rather than keep: stale boundaries from a
            // previous circuit are worse than the neutral thirds fallback.
            l.sector2_start = 0.0;
            l.sector3_start = 0.0;
        }
    }
    Some(game_paused)
}

// ── Car Damage (id 10): per-wheel tyre wear % for the player car ──
// `m_tyresWear[4]` (f32 %, wheel order RL RR FL FR) opens each CarDamageData
// struct, so only the stride — which locates the player's slice — matters. Derive
// it from the payload (as parse_participants_ai does) so a struct-size change in a
// future format revision degrades to "no wear" instead of a misaligned read.
pub fn parse_car_damage(payload: &[u8], h: &Header, l: &mut Latest) -> Option<()> {
    let cars = [h.max_cars(), 24]
        .into_iter()
        .find(|&c| payload.len() % c == 0 && payload.len() / c >= 16)?;
    let base = h.player_car_index as usize * (payload.len() / cars);
    let mut wear = [0.0f32; 4];
    for (i, w) in wear.iter_mut().enumerate() {
        *w = f32_at(payload, base + i * 4)?;
    }
    l.tyre_wear = wear;
    Some(())
}

// ── Car Setups (id 5): raw player setup, forwarded verbatim to the UI ──
// NB: this layout is byte-identical in formats 2025 and 2026 (verified against
// F1Game.UDP v26's CarSetupData: 50 bytes, m_engineBraking and m_ballast both
// present) — the old bridge's diagnostic claiming 2026 dropped the engine-braking
// byte was wrong, so no format branch is needed here.
pub fn parse_car_setups(payload: &[u8], h: &Header, l: &mut Latest) -> Option<()> {
    let base = h.player_car_index as usize * CAR_SETUP_STRIDE;
    // Bounds-check the last field up front so every read below is safe.
    let _ = f32_at(payload, base + 46)?;
    l.setup = Some(CarSetup {
        m_frontWing: u8_at(payload, base)?,
        m_rearWing: u8_at(payload, base + 1)?,
        m_onThrottle: u8_at(payload, base + 2)?,
        m_offThrottle: u8_at(payload, base + 3)?,
        m_frontCamber: f32_at(payload, base + 4)?,
        m_rearCamber: f32_at(payload, base + 8)?,
        m_frontToe: f32_at(payload, base + 12)?,
        m_rearToe: f32_at(payload, base + 16)?,
        m_frontSuspension: u8_at(payload, base + 20)?,
        m_rearSuspension: u8_at(payload, base + 21)?,
        m_frontAntiRollBar: u8_at(payload, base + 22)?,
        m_rearAntiRollBar: u8_at(payload, base + 23)?,
        m_frontSuspensionHeight: u8_at(payload, base + 24)?,
        m_rearSuspensionHeight: u8_at(payload, base + 25)?,
        m_brakePressure: u8_at(payload, base + 26)?,
        m_brakeBias: u8_at(payload, base + 27)?,
        m_engineBraking: u8_at(payload, base + 28)?,
        m_rearLeftTyrePressure: f32_at(payload, base + 29)?,
        m_rearRightTyrePressure: f32_at(payload, base + 33)?,
        m_frontLeftTyrePressure: f32_at(payload, base + 37)?,
        m_frontRightTyrePressure: f32_at(payload, base + 41)?,
        m_ballast: u8_at(payload, base + 45)?,
        m_fuelLoad: f32_at(payload, base + 46)?,
    });
    Some(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::telemetry::header::HEADER_LEN;

    fn put_u16(b: &mut [u8], o: usize, v: u16) {
        b[o..o + 2].copy_from_slice(&v.to_le_bytes());
    }
    fn put_u32(b: &mut [u8], o: usize, v: u32) {
        b[o..o + 4].copy_from_slice(&v.to_le_bytes());
    }
    fn put_f32(b: &mut [u8], o: usize, v: f32) {
        b[o..o + 4].copy_from_slice(&v.to_le_bytes());
    }

    fn hdr(packet_id: u8, player: u8) -> Header {
        Header {
            packet_format: 2026,
            packet_id,
            session_uid: 0,
            overall_frame_identifier: 0,
            player_car_index: player,
        }
    }

    #[test]
    fn header_parse() {
        let mut b = vec![0u8; HEADER_LEN];
        put_u16(&mut b, 0, 2026);
        b[6] = 6; // packet id
        put_u32(&mut b, 23, 4242); // overall frame id
        b[27] = 3; // player car index
        let h = Header::parse(&b).unwrap();
        assert!(h.is_supported());
        assert_eq!(h.packet_id, 6);
        assert_eq!(h.overall_frame_identifier, 4242);
        assert_eq!(h.player_car_index, 3);
        assert_eq!(h.max_cars(), 22);
    }

    #[test]
    fn participants_ai_22_car_array() {
        // 1 count byte + 22 participants × 5-byte stride; player index 3 is AI.
        let mut p = vec![0u8; 1 + 22 * 5];
        p[0] = 20; // m_numActiveCars (irrelevant to the slot count)
        p[1 + 3 * 5] = 1;
        assert_eq!(parse_participants_ai(&p, &hdr(4, 3)), Some(true));
        p[1 + 3 * 5] = 0;
        assert_eq!(parse_participants_ai(&p, &hdr(4, 3)), Some(false));
    }

    #[test]
    fn participants_ai_tolerates_24_slot_padding() {
        // 24 × 7-byte stride (168 is not divisible by 22, so the fallback fires).
        let mut p = vec![0u8; 1 + 24 * 7];
        p[1 + 3 * 7] = 1;
        assert_eq!(parse_participants_ai(&p, &hdr(4, 3)), Some(true));
    }

    #[test]
    fn participants_ai_rejects_bad_length() {
        // 100 body bytes divides by neither 22 nor 24 → refuse rather than guess.
        let p = vec![0u8; 1 + 100];
        assert_eq!(parse_participants_ai(&p, &hdr(4, 0)), None);
        assert_eq!(parse_participants_ai(&[], &hdr(4, 0)), None);
    }

    #[test]
    fn car_telemetry_player0() {
        let mut p = vec![0u8; CAR_TELEM_STRIDE_2026 * 24];
        put_u16(&mut p, 0, 280);
        put_f32(&mut p, 2, 0.5);
        put_f32(&mut p, 6, -0.25);
        put_f32(&mut p, 10, 0.75);
        p[15] = 5; // gear i8
        put_u16(&mut p, 16, 11000);
        p[30..34].copy_from_slice(&[95, 96, 102, 103]); // surface temps RL RR FL FR
        p[34..38].copy_from_slice(&[90, 91, 92, 93]); // inner (carcass) temps
        let mut l = Latest::default();
        assert!(parse_car_telemetry(&p, &hdr(6, 0), &mut l).is_some());
        assert_eq!(l.speed_kmh, 280.0);
        assert!((l.throttle - 0.5).abs() < 1e-6);
        assert!((l.steer + 0.25).abs() < 1e-6);
        assert!((l.brake - 0.75).abs() < 1e-6);
        assert_eq!(l.gear, 5);
        assert_eq!(l.rpm, 11000);
        assert_eq!(l.tyre_surface_temps, [95, 96, 102, 103]);
        assert_eq!(l.tyre_inner_temps, [90, 91, 92, 93]);
    }

    #[test]
    fn car_telemetry_player1_uses_2026_stride() {
        let mut p = vec![0u8; CAR_TELEM_STRIDE_2026 * 24];
        let base = CAR_TELEM_STRIDE_2026; // player index 1
        put_u16(&mut p, base, 305);
        p[base + 15] = 7;
        p[base + 30] = 99; // surface RL — proves the stride offsets the temp arrays too
        let mut l = Latest::default();
        assert!(parse_car_telemetry(&p, &hdr(6, 1), &mut l).is_some());
        assert_eq!(l.speed_kmh, 305.0);
        assert_eq!(l.gear, 7);
        assert_eq!(l.tyre_surface_temps[0], 99);
    }

    #[test]
    fn motion_ex_front_forces_and_sideslip() {
        let mut p = vec![0u8; 200];
        // slipAngle @80: [RL, RR, FL, FR]
        put_f32(&mut p, 80 + 8, 0.10); // FL
        put_f32(&mut p, 80 + 12, 0.20); // FR
        put_f32(&mut p, 80 + 0, 0.04); // RL
        put_f32(&mut p, 80 + 4, 0.06); // RR
        // latForce @96
        put_f32(&mut p, 96 + 8, 3000.0); // FL
        put_f32(&mut p, 96 + 12, 4000.0); // FR
        // localVelocity X@132, Z@140
        put_f32(&mut p, 132, 2.0);
        put_f32(&mut p, 140, 50.0);
        let mut l = Latest::default();
        assert!(parse_motion_ex(&p, &mut l).is_some());
        assert!((l.front_slip_angle - 0.15).abs() < 1e-6);
        assert!((l.rear_slip_angle - 0.05).abs() < 1e-6);
        assert!((l.front_lat_force - 7000.0).abs() < 1e-3);
        assert!((l.sideslip - 2.0f32.atan2(50.0)).abs() < 1e-6);
    }

    #[test]
    fn session_fields_and_sector_starts() {
        let mut p = vec![0u8; 200];
        put_u16(&mut p, 4, 5303); // track length
        p[6] = 7; // session type Q3
        p[7] = 3; // track id
        p[14] = 1; // game paused
        let n = p.len();
        put_f32(&mut p, n - 8, 1700.0); // sector2 start
        put_f32(&mut p, n - 4, 3400.0); // sector3 start
        let mut l = Latest::default();
        assert_eq!(parse_session(&p, &mut l), Some(true));
        assert_eq!(l.track_length, 5303);
        assert_eq!(l.session_type, 7);
        assert_eq!(l.track_id, 3);
        assert!((l.sector2_start - 1700.0).abs() < 1e-3);
        assert!((l.sector3_start - 3400.0).abs() < 1e-3);
    }

    #[test]
    fn session_rejects_implausible_sector_starts() {
        let mut p = vec![0u8; 200];
        put_u16(&mut p, 4, 5303); // track length
        let n = p.len();
        // Tail decodes to out-of-order / off-track values (as it would if a future
        // format appended fields) → both starts must clear to the thirds fallback.
        put_f32(&mut p, n - 8, 9999.0); // "sector2" ≥ track length
        put_f32(&mut p, n - 4, 120.0); // "sector3" < sector2
        let mut l = Latest::default();
        l.sector2_start = 1700.0; // stale values from a previous circuit
        l.sector3_start = 3400.0;
        assert_eq!(parse_session(&p, &mut l), Some(false));
        assert_eq!(l.sector2_start, 0.0);
        assert_eq!(l.sector3_start, 0.0);
    }

    #[test]
    fn car_setups_player_slice_2026() {
        // Layout is format-identical (see parse_car_setups header comment); build a
        // player-1 slice and check the fields around the engine-braking byte, since
        // that offset is exactly where the old bridge's wrong "2026 drops it" claim
        // would have shifted every later field.
        let player = 1usize;
        let mut p = vec![0u8; CAR_SETUP_STRIDE * 24];
        let base = player * CAR_SETUP_STRIDE;
        p[base] = 6; // frontWing
        p[base + 27] = 54; // brakeBias
        p[base + 28] = 60; // engineBraking
        put_f32(&mut p, base + 29, 21.5); // rearLeftTyrePressure
        put_f32(&mut p, base + 41, 23.5); // frontRightTyrePressure
        p[base + 45] = 6; // ballast
        put_f32(&mut p, base + 46, 10.0); // fuelLoad
        let mut l = Latest::default();
        assert!(parse_car_setups(&p, &hdr(5, player as u8), &mut l).is_some());
        let s = l.setup.expect("setup parsed");
        assert_eq!(s.m_frontWing, 6);
        assert_eq!(s.m_brakeBias, 54);
        assert_eq!(s.m_engineBraking, 60);
        assert!((s.m_rearLeftTyrePressure - 21.5).abs() < 1e-6);
        assert!((s.m_frontRightTyrePressure - 23.5).abs() < 1e-6);
        assert_eq!(s.m_ballast, 6);
        assert!((s.m_fuelLoad - 10.0).abs() < 1e-6);
    }

    #[test]
    fn lap_data_ai_signals() {
        let mut p = vec![0u8; LAP_DATA_STRIDE * 24 + 2];
        put_f32(&mut p, 20, 1234.0); // lapDistance
        p[33] = 4; // currentLapNum
        p[34] = 1; // pitStatus → in pit
        p[44] = 3; // driverStatus out-lap
        p[45] = 2; // resultStatus active
        let mut l = Latest::default();
        let result_status = parse_lap_data(&p, &hdr(2, 0), &mut l).unwrap();
        assert_eq!(result_status, 2);
        assert_eq!(l.pit_status, 1);
        assert_eq!(l.driver_status, 3);
        assert!((l.lap_distance - 1234.0).abs() < 1e-3);
        assert_eq!(l.lap_number, 4);
    }
}
