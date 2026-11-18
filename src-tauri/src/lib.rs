use std::sync::atomic::{AtomicBool, Ordering};
// Only the FFB commands' request/reply channels use this.
#[cfg(desktop)]
use std::sync::mpsc::sync_channel;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::{Emitter, Manager, RunEvent};

// FFB is desktop-only: it drives a wheel over SDL2, which has no Android
// counterpart and whose bundled C build can't cross-compile. The whole module —
// and every command, state struct and event that hangs off it — is gated out on
// mobile, which is what lets the `sdl2` dependency be gated out in Cargo.toml.
#[cfg(desktop)]
mod ffb;
mod telemetry;

#[cfg(desktop)]
use ffb::{DeviceInfo, FfbCommand, FfbGauges, FfbHandle, FfbSettings, FfbStatus, FfbSystem};
use telemetry::{now_ms, CoreStatus, TelemetryCore};

// Default UDP port the game broadcasts telemetry on.
const DEFAULT_UDP_PORT: u16 = 20777;

/// Holds the running telemetry core so commands can reach it and the app can shut
/// it down cleanly on exit.
struct CoreState {
    core: Mutex<TelemetryCore>,
}

/// Holds the running FFB system (thread) for shutdown on exit.
#[cfg(desktop)]
struct FfbState {
    system: Mutex<FfbSystem>,
}

/// Stop flag for the emitter thread, so it winds down on exit like the core and
/// FFB threads do (it wakes every ~33 ms, so no join is needed).
struct EmitterState {
    running: Arc<AtomicBool>,
}

// ── Telemetry commands ──────────────────────────────────────────────────────

/// Re-point the UDP listener at a different port (custom-port / rebroadcaster
/// setups). The core rebinds live.
#[tauri::command]
fn set_udp_port(port: u16, state: tauri::State<CoreState>) {
    if let Ok(core) = state.core.lock() {
        core.set_port(port);
    }
}

/// One of this machine's network addresses, surfaced to console players who run
/// the app on a second device: the game's telemetry output must target the PC's
/// LAN IP, and this is how the UI tells them which address to enter.
#[derive(serde::Serialize)]
struct LocalAddr {
    /// Interface name (e.g. "Wi-Fi", "Ethernet") — helps pick the right one.
    name: String,
    ip: String,
}

/// List this machine's non-loopback IPv4 addresses. Private LAN ranges
/// (192.168/10./172.16–31) sort first, since a console on the same network
/// reaches the PC through one of those.
#[tauri::command]
fn get_local_ips() -> Vec<LocalAddr> {
    use std::net::IpAddr;
    let mut out: Vec<LocalAddr> = local_ip_address::list_afinet_netifas()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|(name, ip)| match ip {
            // Drop loopback (127.x) and APIPA link-local (169.254.x) — neither is
            // reachable from another device.
            IpAddr::V4(v4) if !v4.is_loopback() && !v4.is_link_local() => {
                Some(LocalAddr { name, ip: v4.to_string() })
            }
            _ => None,
        })
        .collect();
    // RFC-1918 private ranges first — the addresses a LAN device would use.
    out.sort_by_key(|a| !a.ip.parse::<std::net::Ipv4Addr>().is_ok_and(|v4| v4.is_private()));
    out
}

/// Toggle synthetic-telemetry mode (a fake lap for testing with no game).
#[tauri::command]
fn set_fake_mode(enabled: bool, state: tauri::State<CoreState>) {
    if let Ok(core) = state.core.lock() {
        core.set_fake(enabled);
    }
}

/// The core's connection state — the same value the `core_status` event carries.
/// That event is only emitted when the state CHANGES, and the emitter starts in
/// `setup`, before the page has loaded and subscribed: with the game already
/// streaming at launch (or `F1_FAKE=1`), "receiving" went out to nobody, the UDP
/// pill sat on "waiting", the auto-switch to Live never fired and Android never
/// took its keep-awake. The page asks for the current value on mount instead.
#[tauri::command]
fn get_core_status(state: tauri::State<CoreState>) -> Option<CoreStatus> {
    let core = state.core.lock().ok()?;
    Some(core.shared.core_status(now_ms()))
}

/// Current synthetic-telemetry state. The Settings toggle reads this once on
/// boot so an `F1_FAKE=1` launch is reflected in the UI rather than being
/// silently overwritten by the saved preference.
#[tauri::command]
fn get_fake_mode(state: tauri::State<CoreState>) -> bool {
    state.core.lock().map(|core| core.is_fake()).unwrap_or(false)
}

// ── FFB commands (desktop only) ─────────────────────────────────────────────

// `async`: a plain (sync) Tauri command runs on the MAIN thread, and these two
// block on a reply from the FFB thread — up to 2 s to enumerate and 5 s to open a
// device. That froze the whole window (and every telemetry event) while SDL
// talked to the wheel. Marked async they run on the async runtime instead.
#[cfg(desktop)]
#[tauri::command(async)]
fn get_ffb_devices(handle: tauri::State<Arc<FfbHandle>>) -> Vec<DeviceInfo> {
    let (tx, rx) = sync_channel(1);
    if handle.cmd_tx.send(FfbCommand::Enumerate(tx)).is_err() {
        return vec![];
    }
    rx.recv_timeout(Duration::from_secs(2)).unwrap_or_default()
}

#[cfg(desktop)]
#[tauri::command(async)]
fn open_ffb_device(index: i32, handle: tauri::State<Arc<FfbHandle>>) -> Result<String, String> {
    let (tx, rx) = sync_channel(1);
    handle
        .cmd_tx
        .send(FfbCommand::Open(index, tx))
        .map_err(|_| "FFB engine offline".to_string())?;
    rx.recv_timeout(Duration::from_secs(5))
        .map_err(|_| "FFB engine timed out opening the device".to_string())?
}

#[cfg(desktop)]
#[tauri::command]
fn close_ffb_device(handle: tauri::State<Arc<FfbHandle>>) {
    let _ = handle.cmd_tx.send(FfbCommand::Close);
}

#[cfg(desktop)]
#[tauri::command]
fn set_ffb_settings(settings: FfbSettings, handle: tauri::State<Arc<FfbHandle>>) {
    // Clamped on the way in — see FfbSettings::sanitized for why the UI's own
    // slider ranges aren't enough (imported and stale profiles).
    handle.settings.store(Arc::new(settings.sanitized()));
}

/// The FFB status as it stands — `ffb_status` has the same emit-on-change gap as
/// `core_status` (see get_core_status), so an "SDL init failed" raised at startup
/// was lost before the page could listen.
#[cfg(desktop)]
#[tauri::command]
fn get_ffb_status(handle: tauri::State<Arc<FfbHandle>>) -> FfbStatus {
    handle.status.load().as_ref().clone()
}

/// The engine's default tuning — the single source of truth the UI seeds its
/// sliders / "Reset all" from (no hand-mirrored copy in JS).
#[cfg(desktop)]
#[tauri::command]
fn get_ffb_defaults() -> FfbSettings {
    FfbSettings::default()
}

#[cfg(desktop)]
#[tauri::command]
fn set_ffb_enabled(enabled: bool, handle: tauri::State<Arc<FfbHandle>>) {
    handle.enabled.store(enabled, Ordering::Relaxed);
}

/// Reset the "peak lateral force this session" tracker (Auto Max Force panel).
#[cfg(desktop)]
#[tauri::command]
fn reset_ffb_peak(handle: tauri::State<Arc<FfbHandle>>) {
    let _ = handle.cmd_tx.send(FfbCommand::ResetPeak);
}

/// Bounded history of the output the wheel actually received (reconstructed
/// input force and steer → final torque), recorded while a wheel is open.
/// Exported from the FFB tab and analysed offline with
/// `scripts/analyze-ffb-trace.mjs`.
#[cfg(desktop)]
#[tauri::command]
fn get_ffb_trace(handle: tauri::State<Arc<FfbHandle>>) -> ffb::TraceDump {
    // The configured rate is only a FALLBACK for a trace too short to measure —
    // `snapshot` derives the real rate from the samples' own timestamps, which is
    // what makes an A/B of two output rates label each export correctly.
    let fallback_hz = handle.settings.load().ffb_update_hz as f32;
    handle
        .trace
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .snapshot(fallback_hz)
}

// ── File export ───────────────────────────────────────────────────────────────

/// Write UTF-8 text to `path`, which the frontend obtained from the dialog
/// plugin's Save dialog. Writing here (rather than via the fs plugin) keeps the
/// destination unrestricted without opening an fs scope — the path is one the
/// user just picked, so it's exactly where they want the file.
#[tauri::command]
fn write_text_file(path: String, contents: String) -> Result<(), String> {
    std::fs::write(&path, contents).map_err(|e| format!("Couldn't save the file: {e}"))
}

// ── Emitter: bridge in-process state to the webview via Tauri events ─────────
// Samples the shared state at ~30 Hz but only emits what actually changed:
// every writer stores a fresh Arc, so Arc::ptr_eq against the last-emitted
// value is an exact "nothing new" test — an idle app costs no IPC. The FFB
// engine reads the shared telemetry directly at full rate — the UI event
// cadence never affects FFB latency.
/// Remember `cur` and report whether it differs (by pointer) from last time.
fn changed<T>(last: &mut Option<Arc<T>>, cur: &Arc<T>) -> bool {
    if last.as_ref().is_some_and(|p| Arc::ptr_eq(p, cur)) {
        return false;
    }
    *last = Some(cur.clone());
    true
}

/// The emitter's FFB half, factored out so the sampling loop below is byte-for-byte
/// the same on both platforms. On mobile there is no FFB engine, so this collapses
/// to a zero-sized no-op — better than a `#[cfg]` inside the loop, which would leave
/// two subtly different hot paths to keep in step.
#[cfg(desktop)]
struct FfbEmit {
    handle: Arc<FfbHandle>,
    last_gauges: Option<Arc<FfbGauges>>,
    last_status: Option<Arc<FfbStatus>>,
}

#[cfg(desktop)]
impl FfbEmit {
    fn new(app: &tauri::AppHandle) -> Self {
        FfbEmit {
            handle: app.state::<Arc<FfbHandle>>().inner().clone(),
            last_gauges: None,
            last_status: None,
        }
    }

    fn tick(&mut self, app: &tauri::AppHandle) {
        let gauges = self.handle.gauges.load_full();
        if changed(&mut self.last_gauges, &gauges) {
            let _ = app.emit("ffb_gauges", gauges.as_ref());
        }
        let status = self.handle.status.load_full();
        if changed(&mut self.last_status, &status) {
            let _ = app.emit("ffb_status", status.as_ref());
        }
    }
}

#[cfg(mobile)]
struct FfbEmit;

#[cfg(mobile)]
impl FfbEmit {
    fn new(_app: &tauri::AppHandle) -> Self {
        FfbEmit
    }
    fn tick(&mut self, _app: &tauri::AppHandle) {}
}

/// The car setup is emitted when it changes AND re-sent this often regardless:
/// a change that lands before the page has subscribed (a session already running
/// at launch) would otherwise never arrive. Half a kilobyte every few seconds.
const SETUP_RESEND: Duration = Duration::from_secs(3);

/// How often the emitter samples shared state and emits to the webview. The FFB
/// gauge producer is gated to the same period, so the two have to agree or a
/// publish is built and dropped unread.
const EMIT_PERIOD: Duration = Duration::from_millis(33);

fn spawn_emitter(app: tauri::AppHandle, running: Arc<AtomicBool>) {
    let shared = {
        let core = app.state::<CoreState>();
        let core = core.core.lock().unwrap_or_else(|e| e.into_inner());
        core.shared.clone()
    };
    let mut ffb = FfbEmit::new(&app);

    std::thread::spawn(move || {
        let mut last_core: Option<CoreStatus> = None;
        let mut last_snap = None;
        let mut last_setup = None;
        let mut setup_sent = std::time::Instant::now();
        while running.load(Ordering::Relaxed) {
            let tick_start = std::time::Instant::now();
            let now = now_ms();
            let got_packet = shared.got_packet.load(Ordering::Relaxed);
            let core = shared.core_status(now);
            if last_core.as_ref() != Some(&core) {
                let _ = app.emit("core_status", &core);
                last_core = Some(core);
            }
            if got_packet {
                let snap = shared.ui.load_full();
                if changed(&mut last_snap, &snap) {
                    let _ = app.emit("telemetry", snap.as_ref());
                }
                let setup = shared.setup.load_full();
                if changed(&mut last_setup, &setup) || setup_sent.elapsed() >= SETUP_RESEND {
                    let _ = app.emit("car_setup", setup.as_ref());
                    setup_sent = std::time::Instant::now();
                }
            }
            ffb.tick(&app);
            // Sleep to a DEADLINE, not for a fixed interval. `sleep(33)` plus this
            // loop's own work ran at ~29 Hz against a gauge producer gated at
            // exactly 33 ms, so a few percent of gauge publishes were built and
            // then dropped unread.
            let spent = tick_start.elapsed();
            if spent < EMIT_PERIOD {
                std::thread::sleep(EMIT_PERIOD - spent);
            }
        }
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Optional dev switch: F1_FAKE=1 starts the core in synthetic-telemetry mode.
    let fake = std::env::var("F1_FAKE").ok().as_deref() == Some("1");
    let core = TelemetryCore::start(DEFAULT_UDP_PORT, fake);

    #[cfg(desktop)]
    let ffb = FfbSystem::start(core.shared.clone());
    #[cfg(desktop)]
    let ffb_handle = ffb.handle.clone();

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(CoreState {
            core: Mutex::new(core),
        });

    // `generate_handler!` parses a plain path list and rejects `#[cfg]` on the
    // individual entries, so the platform split is two whole invocations rather
    // than one annotated list. Attributes on `let` are stable and `invoke_handler`
    // returns the builder, so shadowing keeps this a single chain.
    #[cfg(desktop)]
    let builder = builder
        .manage(FfbState {
            system: Mutex::new(ffb),
        })
        .manage(ffb_handle)
        .invoke_handler(tauri::generate_handler![
            set_udp_port,
            get_local_ips,
            set_fake_mode,
            get_fake_mode,
            get_core_status,
            get_ffb_status,
            get_ffb_devices,
            open_ffb_device,
            close_ffb_device,
            set_ffb_settings,
            get_ffb_defaults,
            set_ffb_enabled,
            reset_ffb_peak,
            get_ffb_trace,
            write_text_file,
        ]);

    // Android's own bridge: platform text-to-speech (the desktop build's Kokoro
    // model is stripped there), keep-screen-on, and the Wi-Fi multicast lock.
    #[cfg(mobile)]
    let builder = builder
        .plugin(tauri_plugin_f1android::init())
        .invoke_handler(tauri::generate_handler![
            set_udp_port,
            get_local_ips,
            set_fake_mode,
            get_fake_mode,
            get_core_status,
            write_text_file,
        ]);

    builder
        .setup(|app| {
            // Logging in EVERY build. It used to be debug-only, so in a shipped
            // build every `[core]` / `[ffb]` warning — a port that wouldn't bind,
            // a wheel that wouldn't open — went nowhere, and a driver's bug report
            // had nothing behind it. Release keeps warnings and errors only, in
            // the plugin's default targets (stdout + the app's log directory).
            app.handle().plugin(
                tauri_plugin_log::Builder::default()
                    .level(if cfg!(debug_assertions) {
                        log::LevelFilter::Info
                    } else {
                        log::LevelFilter::Warn
                    })
                    .build(),
            )?;
            let running = Arc::new(AtomicBool::new(true));
            app.manage(EmitterState { running: running.clone() });
            spawn_emitter(app.handle().clone(), running);
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if let RunEvent::Exit = event {
                if let Some(state) = app_handle.try_state::<EmitterState>() {
                    state.running.store(false, Ordering::Relaxed);
                }
                #[cfg(desktop)]
                if let Some(state) = app_handle.try_state::<FfbState>() {
                    if let Ok(mut sys) = state.system.lock() {
                        sys.stop();
                    }
                }
                if let Some(state) = app_handle.try_state::<CoreState>() {
                    if let Ok(mut core) = state.core.lock() {
                        core.stop();
                    }
                }
            }
        });
}
