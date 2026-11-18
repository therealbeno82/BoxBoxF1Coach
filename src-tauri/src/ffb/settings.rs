//! FFB tunables + output signals. Ported from the C++ `FFBSettings`/`FFBSignals`
//! (`types.h:102-142`). serde camelCase keys match the original app's field names
//! so the React tab and its saved profiles speak the same vocabulary.

use serde::{Deserialize, Serialize};

// FFB output-rate bounds (C++ `FFB_MIN_HZ` / `FFB_MAX_HZ`). The engine's output
// loop free-runs at `ffb_update_hz`, independent of the game's ~60 Hz telemetry.
pub const FFB_MIN_HZ: i32 = 30;
pub const FFB_MAX_HZ: i32 = 360;

// Re-arm delay after a freeze before force returns.
pub const FFB_REARM_MS: i64 = 150;

/// How the fixed-rate output loop reconstructs the game's ~60 Hz physics
/// frames. `Linear` is the original blend (kept for A/B); `Cubic` is monotone
/// Hermite, which is C1 at every frame boundary and overshoot-free.
#[derive(Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default, Debug)]
#[serde(rename_all = "camelCase")]
pub enum InterpMode {
    Linear,
    #[default]
    Cubic,
}

#[derive(Clone, Copy, Serialize, Deserialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct FfbSettings {
    pub overall_strength: f32,
    pub grip_loss_strength: f32,
    pub understeer_strength: f32,
    pub oversteer_strength: f32,
    pub peak_emphasis: f32,
    pub smoothing: f32,
    pub interpolation: InterpMode,
    /// Fraction of a physics frame the reconstruction delays its input by
    /// (0.5 = the original half-frame delay). Larger is smoother and laggier.
    pub interp_delay_frac: f32,
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
    /// Scales the DirectInput damper (friction) effect. 1 = as computed from
    /// slip, 0 = off. DirectInput condition effects are rendered by the base
    /// from its own velocity estimate, which some direct-drive bases do coarsely
    /// at low speed — heard as grain/notchiness at centre. Exposed so that can be
    /// isolated (and removed) without recompiling.
    pub damping: f32,
    /// Optional slew-rate limit on the output torque, in full-scale units per
    /// second (0 = off). Caps how fast the force may change, which strips
    /// high-frequency grain WITHOUT reducing steady-state force — unlike a
    /// low-pass, which does both. The trade-off is slower genuine transients.
    pub slew_limit: f32,
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
            interpolation: InterpMode::Cubic,
            interp_delay_frac: 0.5,
            min_speed_kmh: 10.0,
            ffb_update_hz: 200,
            max_force_n: 12000.0,
            invert_force: false,
            lockup_strength: 0.60,
            lockup_hz: 28.0,
            wheelspin_strength: 0.40,
            wheelspin_hz: 10.0,
            scrub_strength: 0.50,
            scrub_hz: 45.0,
            damping: 1.00,
            slew_limit: 0.00,
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

impl FfbSettings {
    /// Every field forced into the range the FFB tab's sliders offer, and any
    /// non-finite number replaced by its default.
    ///
    /// `set_ffb_settings` used to store whatever arrived. The sliders can't go out
    /// of range, but an imported profile (a hand-editable JSON file) or a stale
    /// saved one can — and some out-of-range values are not merely odd but
    /// dangerous: `load_sensitivity` above ~1.67 drives the load multiplier
    /// negative and REVERSES the steering force, a NaN latches every filter, and a
    /// negative `max_output` defeats the safety cap. The bounds mirror FfbScreen's
    /// ROWS (and are a little wider nowhere).
    pub fn sanitized(self) -> FfbSettings {
        let d = FfbSettings::default();
        let f = |v: f32, lo: f32, hi: f32, def: f32| if v.is_finite() { v.clamp(lo, hi) } else { def };
        FfbSettings {
            overall_strength: f(self.overall_strength, 0.0, 1.0, d.overall_strength),
            grip_loss_strength: f(self.grip_loss_strength, 0.0, 2.0, d.grip_loss_strength),
            understeer_strength: f(self.understeer_strength, 0.0, 2.0, d.understeer_strength),
            oversteer_strength: f(self.oversteer_strength, 0.0, 1.0, d.oversteer_strength),
            peak_emphasis: f(self.peak_emphasis, 0.0, 1.0, d.peak_emphasis),
            smoothing: f(self.smoothing, 0.0, 0.5, d.smoothing),
            interpolation: self.interpolation,
            interp_delay_frac: f(self.interp_delay_frac, 0.5, 1.0, d.interp_delay_frac),
            min_speed_kmh: f(self.min_speed_kmh, 0.0, 100.0, d.min_speed_kmh),
            ffb_update_hz: self.ffb_update_hz.clamp(FFB_MIN_HZ, FFB_MAX_HZ),
            max_force_n: f(self.max_force_n, 1000.0, 30000.0, d.max_force_n),
            invert_force: self.invert_force,
            lockup_strength: f(self.lockup_strength, 0.0, 1.0, d.lockup_strength),
            lockup_hz: f(self.lockup_hz, 5.0, 80.0, d.lockup_hz),
            wheelspin_strength: f(self.wheelspin_strength, 0.0, 1.0, d.wheelspin_strength),
            wheelspin_hz: f(self.wheelspin_hz, 5.0, 80.0, d.wheelspin_hz),
            scrub_strength: f(self.scrub_strength, 0.0, 1.0, d.scrub_strength),
            scrub_hz: f(self.scrub_hz, 5.0, 80.0, d.scrub_hz),
            damping: f(self.damping, 0.0, 2.0, d.damping),
            slew_limit: f(self.slew_limit, 0.0, 20.0, d.slew_limit),
            braking_strength: f(self.braking_strength, 0.0, 1.0, d.braking_strength),
            braking_invert: self.braking_invert,
            max_output: f(self.max_output, 0.0, 1.0, d.max_output),
            soft_start_sec: f(self.soft_start_sec, 0.0, 2.0, d.soft_start_sec),
            tt_start_hold_sec: f(self.tt_start_hold_sec, 0.0, 10.0, d.tt_start_hold_sec),
            run_up_release_m: f(self.run_up_release_m, 0.0, 2000.0, d.run_up_release_m),
            min_force: f(self.min_force, 0.0, 0.3, d.min_force),
            load_sensitivity: f(self.load_sensitivity, 0.0, 1.0, d.load_sensitivity),
            load_ref_n: f(self.load_ref_n, 1000.0, 20000.0, d.load_ref_n),
            test_force: f(self.test_force, -1.0, 1.0, 0.0),
            test_rumble: f(self.test_rumble, 0.0, 1.0, 0.0),
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
