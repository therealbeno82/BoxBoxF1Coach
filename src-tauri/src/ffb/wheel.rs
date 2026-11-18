//! Force-feedback output to a DirectInput wheel via SDL2's haptic API. A direct
//! port of the C++ `WheelOutput` (`output/wheel_output.cpp`): a constant-force
//! effect (mandatory main torque) plus optional damper (friction) and sine
//! (rumble) effects, updated per frame.
//!
//! SDL is not thread-safe, so every function here runs on the single FFB thread
//! that owns the `WheelOutput` — it is never sent across threads.
//!
//! **Another app can stop our effects without invalidating our handle, and
//! nothing here would otherwise notice.** SDL grabs the wheel `DISCL_EXCLUSIVE |
//! DISCL_BACKGROUND`; when the game boots and acquires it exclusively in the
//! FOREGROUND, Windows unacquires ours and DirectInput stops every effect that
//! was playing. `SDL_HapticUpdateEffect` then quietly unacquires, re-sets the
//! cooperative level, re-acquires and retries `SetParameters`
//! (`SDL_dinputhaptic.c:1016-1030`), so the per-frame `send` keeps returning
//! success — but nothing ever re-issues the `Start`, and `SDL_HapticRunEffect`
//! has no such retry. The wheel is left at zero force behind a live handle, an
//! empty error string and a green light in the UI, which is exactly the state
//! the driver had to fix by hand with a deselect/reselect. `poll_health` is the
//! missing half: it asks the device whether the effect is really playing, and
//! re-arms it when it isn't.

use std::ffi::CStr;
use std::time::{Duration, Instant};

use sdl2::sys as sys;

use super::settings::{clampf, FfbSignals};

const SDL_FORCE_MAX: i32 = 32767;
const LVL_UNSET: i32 = i32::MIN;

/// Consecutive re-arms the driver REFUSED before we stop trusting the handle
/// itself and reopen from a fresh enumeration.
const REFUSALS_BEFORE_REOPEN: u32 = 4;
/// Floor on how often a full reopen may be attempted. What it recovers from —
/// another app holding the wheel — can last a whole game boot, and hammering
/// `SDL_HapticOpen` through that would be pure driver churn.
const REOPEN_BACKOFF: Duration = Duration::from_secs(3);

/// The self-repair escalation policy, kept apart from the SDL calls so it can be
/// exercised without a wheel on the desk.
struct Repair {
    /// Does this device's driver answer `GetEffectStatus` truthfully? SDL flags
    /// every DirectInput device as supporting the query (`SDL_dinputhaptic.c:405`,
    /// "Status is always supported") without ever asking the driver, so a device
    /// that reports "stopped" for an effect we have just started is one whose
    /// query is broken. Acting on that answer would tear down a wheel that works
    /// perfectly — the opposite of the bug this exists to fix — so until the
    /// device gives one honest "playing" we take no repair action at all.
    trusted: bool,
    /// Consecutive re-arms the driver REFUSED. A refused `Start` means a stale
    /// handle (the base re-enumerated); a device that is merely unacquired
    /// accepts it, which is why a refusal is what escalates and a stopped
    /// effect on its own is not.
    refused: u32,
    last_reopen: Option<Instant>,
}

impl Repair {
    fn new() -> Repair {
        Repair { trusted: false, refused: 0, last_reopen: None }
    }

    /// Seed `trusted` from a probe taken when the answer is already known —
    /// right after a `Start` that returned OK.
    fn calibrate(&mut self, playing: bool) {
        self.trusted = playing;
        self.refused = 0;
    }

    /// The device reports its effect playing, which also proves the query works.
    fn alive(&mut self) {
        self.trusted = true;
        self.refused = 0;
    }

    /// Record a re-arm the driver refused. True when it is time to stop trusting
    /// the handle and reopen the device instead.
    fn refused_rearm(&mut self) -> bool {
        self.refused = self.refused.saturating_add(1);
        self.refused >= REFUSALS_BEFORE_REOPEN && self.may_reopen()
    }

    fn may_reopen(&self) -> bool {
        self.last_reopen.map_or(true, |t| t.elapsed() >= REOPEN_BACKOFF)
    }

    fn reopened(&mut self) {
        self.last_reopen = Some(Instant::now());
    }

    /// The driver deselected the wheel: forget everything learned about it.
    fn forget(&mut self) {
        *self = Repair::new();
    }
}

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
    last_constant_lvl: i32,
    last_damper_lvl: i32,
    last_sine_lvl: i32,
    last_sine_period: i32,
    devices: Vec<DeviceInfo>,
    error: String,
    /// The device the driver chose, remembered by NAME so an involuntary loss
    /// can be repaired without the UI doing anything. A name, not an index,
    /// because a base that re-enumerates comes back wherever the new list puts
    /// it. Cleared only by an explicit `release_device`.
    desired: Option<String>,
    /// Is the main effect actually playing? `is_open` only says the handle is
    /// non-null, which stays true right through a steal.
    healthy: bool,
    repair: Repair,
    /// Return code of the last constant-force update. SDL re-acquires inside
    /// that call, so a 0 here alongside a dead wheel is the signature of a base
    /// that is registered and listening but not producing force.
    last_send_rc: i32,
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
            last_constant_lvl: LVL_UNSET,
            last_damper_lvl: LVL_UNSET,
            last_sine_lvl: LVL_UNSET,
            last_sine_period: LVL_UNSET,
            devices: Vec::new(),
            error: String::new(),
            desired: None,
            healthy: false,
            repair: Repair::new(),
            last_send_rc: 0,
        }
    }

    pub fn init(&mut self) -> bool {
        unsafe {
            sys::SDL_SetMainReady();
            sys::SDL_SetHint(c"SDL_JOYSTICK_ALLOW_BACKGROUND_EVENTS".as_ptr(), c"1".as_ptr());

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

    /// Open AND actually producing force. The distinction is the whole point of
    /// `poll_health`: a stolen device stays "open" forever.
    pub fn is_healthy(&self) -> bool {
        !self.haptic.is_null() && self.healthy
    }

    pub fn open_device(&mut self, index: i32) -> Result<String, String> {
        self.close_device();
        // Drop the old choice before we know the new one takes — otherwise a
        // failed switch from A to B would leave the recovery path quietly
        // putting A back behind the driver's back.
        self.desired = None;
        if index < 0 || index as usize >= self.devices.len() {
            self.error = "Invalid device index".to_string();
            return Err(self.error.clone());
        }
        let haptic_index = self.devices[index as usize].index;
        let caps;
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

            caps = sys::SDL_HapticQuery(h);
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
            self.last_constant_lvl = LVL_UNSET;
            self.last_damper_lvl = LVL_UNSET;
            self.last_sine_lvl = LVL_UNSET;
            self.last_sine_period = LVL_UNSET;
            self.healthy = true;
        }
        // Calibrate the liveness probe while the answer is known: the constant
        // effect was started a few lines up and its `Start` returned OK, so a
        // device reporting it stopped is one whose driver doesn't implement the
        // query. A later positive re-promotes it, so a one-off false negative
        // here costs nothing permanent.
        let playing = self.effect_playing();
        self.repair.calibrate(playing);
        // Stamp the reopen clock on a deliberate open too, so a trigger that
        // fires moments later (telemetry waking up as the app starts) can't
        // immediately tear down a device the driver just chose.
        self.repair.reopened();
        self.desired = self.device_name();
        let name = self.device_name().unwrap_or_default();
        log::info!(
            "[ffb] opened \"{name}\": caps=0x{caps:08x} constant={} damper={} sine={} \
             statusAfterStart={} (trusted={})",
            self.eff_constant,
            self.eff_damper,
            self.eff_sine,
            self.effect_status(self.eff_constant),
            self.repair.trusted,
        );
        Ok(name)
    }

    /// What the DEVICE says about one effect: 1 = playing, 0 = stopped, -1 =
    /// the query failed (we hold the handle but are no longer acquired).
    fn effect_status(&self, id: i32) -> i32 {
        if self.haptic.is_null() || id < 0 {
            return -1;
        }
        let r = unsafe { sys::SDL_HapticGetEffectStatus(self.haptic, id) };
        if r < 0 {
            // A failed query leaves its reason in SDL's global error slot; wipe
            // it so `send`'s next error read can't mistake it for a send fault.
            unsafe { sys::SDL_ClearError() };
        }
        r
    }

    /// Only a positive counts as alive.
    fn effect_playing(&self) -> bool {
        self.effect_status(self.eff_constant) == 1
    }

    /// What the device reports right now, for the log: (constant, sine, trusted,
    /// last send rc). Every field is a raw driver answer, not our belief about
    /// it — the whole point is to see where the two diverge.
    pub fn diag(&self) -> (i32, i32, bool, i32) {
        (
            self.effect_status(self.eff_constant),
            self.effect_status(self.eff_sine),
            self.repair.trusted,
            self.last_send_rc,
        )
    }

    /// The programmatic equivalent of the driver deselecting the wheel and
    /// selecting it again: a full close, re-enumerate and reopen. Coarser than
    /// re-arming, and the only thing known to revive a base that another app has
    /// taken — a `Start` on the old handle is not enough on every device. The
    /// backoff keeps it from firing on the heels of a deliberate open.
    pub fn reacquire(&mut self, why: &str) -> bool {
        if self.desired.is_none() || !self.repair.may_reopen() {
            return false;
        }
        log::info!("[ffb] re-acquiring the wheel ({why})");
        self.reopen_desired();
        let ok = self.is_open();
        log::info!(
            "[ffb] re-acquire {}: open={} status={:?}",
            if ok { "done" } else { "FAILED" },
            ok,
            self.diag()
        );
        ok
    }

    /// Re-issue `Start` for every live effect. Cheap, idempotent, and the whole
    /// repair when the device was merely unacquired — by the time this runs the
    /// per-frame `send` has already driven SDL's re-acquire path, so the `Start`
    /// lands. Returns false only if the driver REFUSED it, which means the
    /// handle is stale rather than just unacquired.
    fn rearm(&mut self) -> bool {
        if self.haptic.is_null() {
            return false;
        }
        let mut ok = true;
        unsafe {
            for id in [self.eff_constant, self.eff_damper, self.eff_sine] {
                if id >= 0 && sys::SDL_HapticRunEffect(self.haptic, id, 1) < 0 {
                    ok = false;
                }
            }
            // Device-level properties do not survive a re-acquire — without
            // this the base comes back with ITS OWN autocentre spring fighting
            // our forces, which feels like the app is the thing misbehaving.
            sys::SDL_HapticSetAutocenter(self.haptic, 0);
            sys::SDL_HapticSetGain(self.haptic, 100);
        }
        // The constant/damper/sine sends skip the driver while their level is
        // unchanged; after a restart the device's copy is not what those caches
        // believe, so drop them and let the next frame re-push real values.
        self.last_constant_lvl = LVL_UNSET;
        self.last_damper_lvl = LVL_UNSET;
        self.last_sine_lvl = LVL_UNSET;
        self.last_sine_period = LVL_UNSET;
        ok
    }

    fn snapshot(&self) -> (bool, bool, i32) {
        (self.healthy, self.is_open(), self.active_idx)
    }

    /// Close and reopen the remembered device from a fresh enumeration — the
    /// only cure for a handle whose device re-enumerated underneath it.
    fn reopen_desired(&mut self) {
        let Some(name) = self.desired.clone() else {
            return;
        };
        self.repair.reopened();
        self.close_device();
        self.enumerate();
        match self.devices.iter().position(|d| d.name == name) {
            Some(pos) => {
                if self.open_device(pos as i32).is_err() {
                    // Keep the choice so the next probe tries again: whatever
                    // holds the wheel is usually just mid-boot, and the open
                    // succeeds a few seconds later on its own.
                    self.desired = Some(name.clone());
                    self.error = format!(
                        "Lost \"{name}\" to another app - retrying. If the game took the \
                         wheel, set its in-game FFB strength to 0%."
                    );
                }
            }
            None => {
                self.error = format!(
                    "Lost contact with \"{name}\" and it is no longer listed. Power-cycle \
                     the base, then click Rescan."
                );
            }
        }
    }

    /// Low-rate liveness probe + self-repair. Call it a couple of times a second
    /// from the FFB loop and always AFTER `send`, which is what drives SDL's
    /// re-acquire and so decides whether the `Start` in here can land. Returns
    /// true when the published status needs refreshing.
    pub fn poll_health(&mut self) -> bool {
        let before = self.snapshot();

        if self.haptic.is_null() {
            // Nothing to probe. If a device the driver chose was lost rather
            // than closed, keep trying to get it back — whatever took it is
            // usually just mid-boot and gives it up again.
            if self.desired.is_some() && self.repair.may_reopen() {
                self.reopen_desired();
            }
            return before != self.snapshot();
        }

        if self.effect_playing() {
            self.repair.alive();
            self.healthy = true;
            // `send` only ever records the FIRST failure since the last clear,
            // so an error sitting here while the device demonstrably plays is by
            // definition from an outage that has already passed.
            self.error.clear();
            return before != self.snapshot();
        }

        if !self.repair.trusted {
            return before != self.snapshot();
        }

        // The main effect has stopped while we still hold the handle: something
        // took the device, almost always the game acquiring it as it boots.
        self.healthy = false;
        if self.rearm() {
            if self.effect_playing() {
                self.repair.alive();
                self.healthy = true;
                self.error.clear();
            }
        } else if self.repair.refused_rearm() {
            self.reopen_desired();
        }
        before != self.snapshot()
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

    /// Close the handle but REMEMBER the choice, so `poll_health` can put it
    /// back. The driver-facing "turn this wheel off" is `release_device`.
    pub fn close_device(&mut self) {
        self.release_effects();
        if !self.haptic.is_null() {
            unsafe { sys::SDL_HapticClose(self.haptic) };
            self.haptic = std::ptr::null_mut();
        }
        self.active_idx = -1;
        self.healthy = false;
    }

    /// The driver deselected the wheel: close it and stop trying to get it back.
    pub fn release_device(&mut self) {
        self.desired = None;
        self.repair.forget();
        self.close_device();
    }

    /// Per-frame send (called from the FFB loop).
    pub fn send(&mut self, sig: &FfbSignals) {
        if self.haptic.is_null() {
            return;
        }
        unsafe {
            // Constant force — main torque. Skip the driver round-trip if the
            // quantised level is unchanged; a running effect holds its level.
            if self.eff_constant >= 0 {
                let lvl = (clampf(finite_or_zero(sig.torque), -1.0, 1.0) * SDL_FORCE_MAX as f32) as i32;
                let lvl = lvl.clamp(-SDL_FORCE_MAX, SDL_FORCE_MAX);
                if lvl != self.last_constant_lvl {
                    let mut e: sys::SDL_HapticEffect = std::mem::zeroed();
                    e.constant.type_ = sys::SDL_HAPTIC_CONSTANT as u16;
                    e.constant.direction.type_ = sys::SDL_HAPTIC_CARTESIAN as u8;
                    e.constant.direction.dir[0] = 1;
                    e.constant.length = sys::SDL_HAPTIC_INFINITY;
                    e.constant.level = lvl as i16;
                    self.last_send_rc = sys::SDL_HapticUpdateEffect(self.haptic, self.eff_constant, &mut e);
                    if self.last_send_rc < 0 && self.error.is_empty() {
                        self.error = format!("SDL_HapticUpdateEffect: {}", sdl_error());
                    }
                    // Only cache a level the device actually ACCEPTED. Caching a
                    // failed send is how a force gets stranded on the wheel: if
                    // the send that failed was the safety release (torque 0.0 →
                    // lvl 0) because the game had just stolen the device, the
                    // cache then claims 0, the base still holds its last level,
                    // and every later tick computes 0, matches the cache and
                    // skips the send — forever, since only rearm()/open_device()
                    // clear it and poll_health won't rearm an untrusted device.
                    if self.last_send_rc >= 0 {
                        self.last_constant_lvl = lvl;
                    }
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
                    // Same rule as the constant channel, and the return code was
                    // being discarded entirely here.
                    if sys::SDL_HapticUpdateEffect(self.haptic, self.eff_damper, &mut e) >= 0 {
                        self.last_damper_lvl = coeff;
                    } else if self.error.is_empty() {
                        self.error = format!("SDL_HapticUpdateEffect (damper): {}", sdl_error());
                    }
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
                    if sys::SDL_HapticUpdateEffect(self.haptic, self.eff_sine, &mut e) >= 0 {
                        self.last_sine_lvl = mag;
                    } else if self.error.is_empty() {
                        self.error = format!("SDL_HapticUpdateEffect (rumble): {}", sdl_error());
                    }
                }
            }
        }
    }
}

impl Drop for WheelOutput {
    fn drop(&mut self) {
        self.release_device();
        if self.inited {
            unsafe {
                sys::SDL_QuitSubSystem(sys::SDL_INIT_JOYSTICK | sys::SDL_INIT_HAPTIC);
                sys::SDL_Quit();
            }
            self.inited = false;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_device_whose_driver_lies_is_never_repaired() {
        // Calibration runs immediately after a `Start` that returned OK, so a
        // "stopped" answer there means the query is broken, not the wheel.
        // Repairing on it would close and reopen a working base every few
        // seconds — a far worse bug than the one being fixed.
        let mut r = Repair::new();
        r.calibrate(false);
        assert!(!r.trusted);
    }

    #[test]
    fn one_honest_answer_promotes_a_device_to_trusted() {
        // Calibration can miss if the wheel is taken in the window between
        // opening it and the first probe, so a later positive has to promote —
        // otherwise a one-off false negative disables repair for the session.
        let mut r = Repair::new();
        r.calibrate(false);
        r.alive();
        assert!(r.trusted);
    }

    #[test]
    fn reopening_waits_for_repeated_refusals() {
        let mut r = Repair::new();
        r.calibrate(true);
        for i in 1..REFUSALS_BEFORE_REOPEN {
            assert!(!r.refused_rearm(), "escalated after only {i} refusal(s)");
        }
        assert!(r.refused_rearm());
    }

    #[test]
    fn a_re_arm_that_takes_resets_the_escalation() {
        // Re-arms that keep working must never accumulate into a reopen: a
        // wheel repaired every time is a wheel that is fine.
        let mut r = Repair::new();
        r.calibrate(true);
        for _ in 0..REFUSALS_BEFORE_REOPEN * 3 {
            assert!(!r.refused_rearm());
            r.alive();
        }
    }

    #[test]
    fn the_backoff_holds_off_a_second_reopen() {
        let mut r = Repair::new();
        r.calibrate(true);
        assert!(r.may_reopen(), "the first attempt has nothing to wait for");
        r.reopened();
        assert!(!r.may_reopen());
        // Refusals keep arriving while another app holds the wheel; none of them
        // may trigger a second reopen until the backoff expires.
        for _ in 0..REFUSALS_BEFORE_REOPEN * 2 {
            assert!(!r.refused_rearm());
        }
    }
}
