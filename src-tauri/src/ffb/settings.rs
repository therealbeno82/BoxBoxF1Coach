//! FFB tunables + output signals. Ported from the C++ `FFBSettings`/`FFBSignals`
//! (`types.h:102-142`). serde camelCase keys match the original app's field names
//! so the React tab and its saved profiles speak the same vocabulary.

use serde::{Deserialize, Serialize};

// FFB output-rate bounds (C++ `FFB_MIN_HZ` / `FFB_MAX_HZ`).
pub const FFB_MIN_HZ: i32 = 30;
pub const FFB_MAX_HZ: i32 = 360;

// Re-arm delay after a freeze before force returns, and the event-driven keepalive.
pub const FFB_REARM_MS: i64 = 150;
pub const FFB_KEEPALIVE_MS: i64 = 22;

#[derive(Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct FfbSettings {
    pub overall_strength: f32,
    pub grip_loss_strength: f32,
    pub understeer_strength: f32,
    pub oversteer_strength: f32,
    pub peak_emphasis: f32,
    pub smoothing: f32,
    pub min_speed_kmh: f32,
    pub ffb_update_hz: i32,
    pub max_force_n: f32,
    pub invert_force: bool,
    pub lockup_strength: f32,
    pub lockup_hz: f32,
    pub wheelspin_strength: f32,
    pub wheelspin_hz: f32,
    pub scrub_strength: f32,
    pub scrub_hz: f32,
    pub braking_strength: f32,
    pub braking_invert: bool,
    pub max_output: f32,
    pub soft_start_sec: f32,
    pub tt_start_hold_sec: f32,
    pub run_up_release_m: f32,
    pub min_force: f32,
    pub load_sensitivity: f32,
    pub load_ref_n: f32,
    // Diagnostics (not persisted in profiles by convention, but accepted here).
    pub test_force: f32,
    pub test_rumble: f32,
}

impl Default for FfbSettings {
    fn default() -> Self {
        FfbSettings {
            overall_strength: 0.85,
            grip_loss_strength: 0.70,
            understeer_strength: 0.80,
            oversteer_strength: 0.90,
            peak_emphasis: 0.00,
            smoothing: 0.15,
            min_speed_kmh: 10.0,
            ffb_update_hz: 90,
            max_force_n: 12000.0,
            invert_force: false,
            lockup_strength: 0.60,
            lockup_hz: 28.0,
            wheelspin_strength: 0.40,
            wheelspin_hz: 10.0,
            scrub_strength: 0.50,
            scrub_hz: 45.0,
            braking_strength: 0.50,
            braking_invert: false,
            max_output: 1.00,
            soft_start_sec: 0.50,
            tt_start_hold_sec: 6.00,
            run_up_release_m: 500.0,
            min_force: 0.00,
            load_sensitivity: 0.00,
            load_ref_n: 8000.0,
            test_force: 0.0,
            test_rumble: 0.0,
        }
    }
}

/// FFB output signals (C++ `FFBSignals`).
#[derive(Clone, Copy)]
pub struct FfbSignals {
    pub torque: f32,   // -1..1 main wheel force
    pub friction: f32, //  0..1 damping
    pub rumble: f32,   //  0..1 vibration magnitude
    pub rumble_hz: f32,
}

impl Default for FfbSignals {
    fn default() -> Self {
        FfbSignals {
            torque: 0.0,
            friction: 0.0,
            rumble: 0.0,
            rumble_hz: 20.0,
        }
    }
}

/// Thin alias for `f32::clamp` — kept as a free function so the ~50 engine call
/// sites read `clampf(expr, lo, hi)` instead of wrapping every expression in
/// parens for a method call. Same NaN semantics as std (NaN passes through).
#[inline]
pub fn clampf(v: f32, lo: f32, hi: f32) -> f32 {
    v.clamp(lo, hi)
}

#[inline]
pub fn signf(v: f32) -> f32 {
    if v >= 0.0 {
        1.0
    } else {
        -1.0
    }
}
