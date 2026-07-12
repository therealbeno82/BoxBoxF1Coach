//! Force-feedback output to a DirectInput wheel via SDL2's haptic API. A direct
//! port of the C++ `WheelOutput` (`output/wheel_output.cpp`): a constant-force
//! effect (mandatory main torque) plus optional damper (friction) and sine
//! (rumble) effects, updated per frame.
//!
//! SDL is not thread-safe, so every function here runs on the single FFB thread
//! that owns the `WheelOutput` — it is never sent across threads.

use std::ffi::{CStr, CString};

use sdl2::sys as sys;

use super::settings::{clampf, FfbSignals};

const SDL_FORCE_MAX: i32 = 32767;
const LVL_UNSET: i32 = i32::MIN;

fn finite_or_zero(v: f32) -> f32 {
    if v.is_finite() {
        v
    } else {
        0.0
    }
}

fn sdl_error() -> String {
    unsafe {
        let p = sys::SDL_GetError();
        if p.is_null() {
            String::new()
        } else {
            CStr::from_ptr(p).to_string_lossy().into_owned()
        }
    }
}

#[derive(Clone, serde::Serialize)]
pub struct DeviceInfo {
    pub index: i32,
    pub name: String,
}

pub struct WheelOutput {
    inited: bool,
    haptic: *mut sys::SDL_Haptic,
    active_idx: i32,
    eff_constant: i32,
    eff_damper: i32,
    eff_sine: i32,
    last_damper_lvl: i32,
    last_sine_lvl: i32,
    last_sine_period: i32,
    devices: Vec<DeviceInfo>,
    error: String,
}

impl WheelOutput {
    pub fn new() -> WheelOutput {
        WheelOutput {
            inited: false,
            haptic: std::ptr::null_mut(),
            active_idx: -1,
            eff_constant: -1,
            eff_damper: -1,
            eff_sine: -1,
            last_damper_lvl: LVL_UNSET,
            last_sine_lvl: LVL_UNSET,
            last_sine_period: LVL_UNSET,
            devices: Vec::new(),
            error: String::new(),
        }
    }

    pub fn init(&mut self) -> bool {
        unsafe {
            sys::SDL_SetMainReady();
            let hint = CString::new("SDL_JOYSTICK_ALLOW_BACKGROUND_EVENTS").unwrap();
            let one = CString::new("1").unwrap();
            sys::SDL_SetHint(hint.as_ptr(), one.as_ptr());

            if sys::SDL_Init(sys::SDL_INIT_JOYSTICK | sys::SDL_INIT_HAPTIC) != 0 {
                self.error = format!("SDL_Init failed: {}", sdl_error());
                return false;
            }
            self.inited = true;
            self.enumerate();
            true
        }
    }

    /// Enumerate by haptic index. Many DD bases appear here even when the steering
    /// device reports non-haptic.
    pub fn enumerate(&mut self) {
        self.devices.clear();
        if !self.inited {
            return;
        }
        unsafe {
            sys::SDL_JoystickUpdate();
            let n = sys::SDL_NumHaptics();
            for i in 0..n {
                let nm = sys::SDL_HapticName(i);
                let name = if nm.is_null() {
                    "Unknown device".to_string()
                } else {
                    CStr::from_ptr(nm).to_string_lossy().into_owned()
                };
                self.devices.push(DeviceInfo { index: i, name });
            }
        }
    }

    pub fn devices(&self) -> Vec<DeviceInfo> {
        self.devices.clone()
    }

    pub fn active_index(&self) -> i32 {
        self.active_idx
    }

    pub fn device_name(&self) -> Option<String> {
        self.devices
            .iter()
            .find(|d| d.index == self.active_idx)
            .map(|d| d.name.clone())
    }

    pub fn last_error(&self) -> String {
        self.error.clone()
    }

    pub fn is_open(&self) -> bool {
        !self.haptic.is_null()
    }

    pub fn open_device(&mut self, index: i32) -> Result<String, String> {
        self.close_device();
        if index < 0 || index as usize >= self.devices.len() {
            self.error = "Invalid device index".to_string();
            return Err(self.error.clone());
        }
        let haptic_index = self.devices[index as usize].index;
        unsafe {
            let h = sys::SDL_HapticOpen(haptic_index);
            if h.is_null() {
                self.error = format!(
                    "Could not open force feedback: {}. Close your wheel's tuning software and any \
                     game using the wheel, set in-game FFB to 0%, then try again.",
                    sdl_error()
                );
                return Err(self.error.clone());
            }

            let caps = sys::SDL_HapticQuery(h);
            if caps & sys::SDL_HAPTIC_CONSTANT == 0 {
                self.error = "Device does not support constant-force FFB (required).".to_string();
                sys::SDL_HapticClose(h);
                return Err(self.error.clone());
            }

            sys::SDL_HapticSetAutocenter(h, 0);
            sys::SDL_HapticSetGain(h, 100);

            // ── Constant force (main torque) — mandatory ──
            let mut cf: sys::SDL_HapticEffect = std::mem::zeroed();
            cf.constant.type_ = sys::SDL_HAPTIC_CONSTANT as u16;
            cf.constant.direction.type_ = sys::SDL_HAPTIC_CARTESIAN as u8;
            cf.constant.direction.dir[0] = 1;
            cf.constant.length = sys::SDL_HAPTIC_INFINITY;
            cf.constant.level = 0;
            self.eff_constant = sys::SDL_HapticNewEffect(h, &mut cf);
            if self.eff_constant < 0 {
                self.error = format!("Failed to upload constant-force effect: {}", sdl_error());
                sys::SDL_HapticClose(h);
                return Err(self.error.clone());
            }
            if sys::SDL_HapticRunEffect(h, self.eff_constant, 1) < 0 {
                self.error = format!("Failed to start constant-force effect: {}", sdl_error());
                sys::SDL_HapticDestroyEffect(h, self.eff_constant);
                self.eff_constant = -1;
                sys::SDL_HapticClose(h);
                return Err(self.error.clone());
            }

            // ── Damper (friction) — optional ──
            if caps & sys::SDL_HAPTIC_DAMPER != 0 {
                let mut dp: sys::SDL_HapticEffect = std::mem::zeroed();
                dp.condition.type_ = sys::SDL_HAPTIC_DAMPER as u16;
                dp.condition.length = sys::SDL_HAPTIC_INFINITY;
                self.eff_damper = sys::SDL_HapticNewEffect(h, &mut dp);
                if self.eff_damper >= 0 {
                    sys::SDL_HapticRunEffect(h, self.eff_damper, 1);
                }
            }

            // ── Sine (lockup / wheelspin rumble) — optional ──
            if caps & sys::SDL_HAPTIC_SINE != 0 {
                let mut si: sys::SDL_HapticEffect = std::mem::zeroed();
                si.periodic.type_ = sys::SDL_HAPTIC_SINE as u16;
                si.periodic.direction.type_ = sys::SDL_HAPTIC_CARTESIAN as u8;
                si.periodic.direction.dir[0] = 1;
                si.periodic.period = 50; // 20 Hz
                si.periodic.magnitude = 0;
                si.periodic.length = sys::SDL_HAPTIC_INFINITY;
                self.eff_sine = sys::SDL_HapticNewEffect(h, &mut si);
                if self.eff_sine >= 0 {
                    sys::SDL_HapticRunEffect(h, self.eff_sine, 1);
                }
            }

            self.haptic = h;
            self.active_idx = index;
            self.error.clear();
            self.last_damper_lvl = LVL_UNSET;
            self.last_sine_lvl = LVL_UNSET;
            self.last_sine_period = LVL_UNSET;
        }
        Ok(self.device_name().unwrap_or_default())
    }

    fn release_effects(&mut self) {
        if self.haptic.is_null() {
            return;
        }
        unsafe {
            let drop_eff = |id: &mut i32| {
                if *id >= 0 {
                    sys::SDL_HapticStopEffect(self.haptic, *id);
                    sys::SDL_HapticDestroyEffect(self.haptic, *id);
                    *id = -1;
                }
            };
            drop_eff(&mut self.eff_constant);
            drop_eff(&mut self.eff_damper);
            drop_eff(&mut self.eff_sine);
        }
    }

    pub fn close_device(&mut self) {
        self.release_effects();
        if !self.haptic.is_null() {
            unsafe { sys::SDL_HapticClose(self.haptic) };
            self.haptic = std::ptr::null_mut();
        }
        self.active_idx = -1;
    }

    /// Per-frame send (called from the FFB loop).
    pub fn send(&mut self, sig: &FfbSignals) {
        if self.haptic.is_null() {
            return;
        }
        unsafe {
            // Constant force — main torque.
            if self.eff_constant >= 0 {
                let mut e: sys::SDL_HapticEffect = std::mem::zeroed();
                e.constant.type_ = sys::SDL_HAPTIC_CONSTANT as u16;
                e.constant.direction.type_ = sys::SDL_HAPTIC_CARTESIAN as u8;
                e.constant.direction.dir[0] = 1;
                e.constant.length = sys::SDL_HAPTIC_INFINITY;
                let lvl = (clampf(finite_or_zero(sig.torque), -1.0, 1.0) * SDL_FORCE_MAX as f32) as i32;
                e.constant.level = lvl.clamp(-SDL_FORCE_MAX, SDL_FORCE_MAX) as i16;
                if sys::SDL_HapticUpdateEffect(self.haptic, self.eff_constant, &mut e) < 0
                    && self.error.is_empty()
                {
                    self.error = format!("SDL_HapticUpdateEffect: {}", sdl_error());
                }
            }

            // Damper — friction. Skip the driver round-trip if unchanged.
            if self.eff_damper >= 0 {
                let coeff = (clampf(finite_or_zero(sig.friction), 0.0, 1.0) * SDL_FORCE_MAX as f32) as i32;
                if coeff != self.last_damper_lvl {
                    let mut e: sys::SDL_HapticEffect = std::mem::zeroed();
                    e.condition.type_ = sys::SDL_HAPTIC_DAMPER as u16;
                    e.condition.length = sys::SDL_HAPTIC_INFINITY;
                    for a in 0..3 {
                        e.condition.right_coeff[a] = coeff as i16;
                        e.condition.left_coeff[a] = coeff as i16;
                        e.condition.right_sat[a] = SDL_FORCE_MAX as u16;
                        e.condition.left_sat[a] = SDL_FORCE_MAX as u16;
                    }
                    sys::SDL_HapticUpdateEffect(self.haptic, self.eff_damper, &mut e);
                    self.last_damper_lvl = coeff;
                }
            }

            // Sine — rumble. Only re-latch the pitch when a rumble episode starts
            // (silent → audible); while audible, update magnitude only (re-sending a
            // changed period to a playing effect makes some drivers mute it).
            if self.eff_sine >= 0 {
                let mag = (clampf(finite_or_zero(sig.rumble), 0.0, 1.0) * SDL_FORCE_MAX as f32) as i32;
                let hzf = clampf(finite_or_zero(sig.rumble_hz), 5.0, 80.0);
                let period = ((1000.0 / hzf + 0.5) as i32).clamp(12, 200);
                if self.last_sine_period == LVL_UNSET || (mag > 0 && self.last_sine_lvl <= 0) {
                    self.last_sine_period = period;
                }
                if mag != self.last_sine_lvl {
                    let mut e: sys::SDL_HapticEffect = std::mem::zeroed();
                    e.periodic.type_ = sys::SDL_HAPTIC_SINE as u16;
                    e.periodic.direction.type_ = sys::SDL_HAPTIC_CARTESIAN as u8;
                    e.periodic.direction.dir[0] = 1;
                    e.periodic.period = self.last_sine_period as u16;
                    e.periodic.magnitude = mag as i16;
                    e.periodic.length = sys::SDL_HAPTIC_INFINITY;
                    if sys::SDL_HapticUpdateEffect(self.haptic, self.eff_sine, &mut e) < 0
                        && self.error.is_empty()
                    {
                        self.error = format!("SDL_HapticUpdateEffect (rumble): {}", sdl_error());
                    }
                    self.last_sine_lvl = mag;
                }
            }
        }
    }
}

impl Drop for WheelOutput {
    fn drop(&mut self) {
        self.close_device();
        if self.inited {
            unsafe {
                sys::SDL_QuitSubSystem(sys::SDL_INIT_JOYSTICK | sys::SDL_INIT_HAPTIC);
                sys::SDL_Quit();
            }
            self.inited = false;
        }
    }
}
